import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardPaths, removeTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import type { BoardMeta, Ticket } from '../src/board/types.js';
import { DID_LINES, HIT_LINES, STOP_LINES, WAIT_ROW, harnessSeen } from '../src/engine/harness-seen.js';
import { harnessView } from '../src/engine/harness.js';

/**
 * Every number on the Harness page is real. These stories are made up, and each says what happened in the engine's own
 * words: a story counts once at a gate, however many times it was stopped there, and a gate with no record has no number.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

let tmp: string;
let bp: BoardPaths;
const meta = { id: 'p', layout: 2, project: 'Try', key: 'TR', nextNumber: 1, engine: 'live', user: { name: 'Sara', role: 'PM' }, roles: {}, tools: [], speed: 1, map: [], lessons: [], commands: { test: 'npm test', lint: 'npm run lint' }, git: { base: 'main', remote: '' } } as unknown as BoardMeta;

function story(id: string, lines: [number, string][], more: Partial<Ticket> = {}): Ticket {
  const t = { id, title: `Story ${id}`, ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'implement', status: '', waiting: null, createdAt: ago(40), createdBy: 'Sara', activity: lines.map(([d, text]) => ({ at: ago(d), who: 'squad', text })), ...more } as Ticket;
  writeTicket(bp, t);
  return t;
}
const seen = () => harnessSeen(bp, meta, NOW);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-seen-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  writeMeta(bp, meta);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('a story counts once', () => {
  it('stopped by a gate many times, with its card and what you went past: one story', () => {
    story('TR-1', [[1, 'Checks failed: test (try 3 of 3)'], [1, 'Checks failed: test (try 2 of 3)'], [2, 'Checks failed: test (try 1 of 3)']], {
      waiting: { kind: 'stuck', summary: 'Stuck' },
      stuck: { gate: 'checks', question: 'They still fail', options: [] },
      overrides: [{ gate: 'checks', reason: 'known', by: 'Sara', at: ago(1) }],
    });
    const c = seen().rows.checks!;
    expect(c).toMatchObject({ stopped: 1, week: 1, passed: 0, last: { id: 'TR-1' } });
  });

  it('a retake does not count twice, and is no pass', () => {
    story('TR-2', [[1, 'Could not show "done when" 1 on a screen after 2 more tries'], [1, 'The screenshots do not show "done when" 1 clearly yet, so the Tester takes it again (try 2 of 2)'], [1, 'The screenshots do not show "done when" 1 clearly yet, so the Tester takes it again (try 1 of 2)']], { gates: { checks: 'pass', review: 'pass', proof: 'fail' } });
    const s = seen();
    expect(s.rows['not-shown']).toMatchObject({ stopped: 1 });
    expect(s.rows.proof).toBeUndefined();
  });

  it('one it stopped is not also a pass, whatever came after', () => {
    story('TR-3', [[1, 'All checks pass: tests'], [2, 'Checks failed: test (try 1 of 3)']], { gates: { checks: 'pass', review: 'pending', proof: 'pending' } });
    story('TR-4', [[1, 'All checks pass: tests']], { gates: { checks: 'pass', review: 'pending', proof: 'pending' } });
    expect(seen().rows.checks).toMatchObject({ passed: 1, stopped: 1 });
  });

  it('two stories stopped this week show as one gate on the tile, and two on its stage', () => {
    story('TR-5', [[1, 'Checks failed: test (try 1 of 3)']]);
    story('TR-6', [[2, 'Checks failed: lint (try 1 of 3)']]);
    const v = harnessView(meta, bp);
    expect(v.tiles.stopped).toBe(1);
    expect(v.stages.find((s) => s.id === 'checks')!.stopped).toBe(2);
    expect(v.stages.find((s) => s.id === 'review')!.stopped).toBe(0);
  });

  it('one story stopped by two gates of a stage counts once on the stage', () => {
    story('TR-36', [[1, 'Checks failed: test (try 1 of 3)'], [1, 'Stopped before the checks: the tests were made weaker']]);
    const v = harnessView(meta, bp);
    expect(v.tiles.stopped).toBe(2);
    expect(v.stages.find((s) => s.id === 'checks')!.stopped).toBe(1);
  });
});

describe('only what is on record', () => {
  it('an empty project shows no numbers and no error', () => {
    const v = harnessView(meta, bp);
    expect(v.range.stories).toBe(0);
    expect(v.tiles).toMatchObject({ stopped: 0, needs: [] });
    expect([...v.stages.flatMap((s) => s.gates), ...v.alwaysOn].filter((r) => r.seen)).toEqual([]);
    expect(v.stages.every((s) => s.stopped === 0)).toBe(true);
    expect(v.limits.filter((l) => l.hit)).toEqual([]);
  });

  it('an old story with no lines breaks nothing, and a gate state alone is no number', () => {
    const old = { id: 'TR-7', title: 'Old', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'review', status: '', waiting: null, createdAt: ago(1), createdBy: 'Sara', activity: [], gates: { checks: 'pass', review: 'pass', proof: 'pass' } } as unknown as Ticket;
    writeTicket(bp, old);
    const s = seen();
    expect(s.stories).toBe(1);
    expect(s.rows).toEqual({});
  });

  it('a stop on an old story counts by its card, or by what you went past', () => {
    story('TR-8', [[1, 'Worked on it']], { waiting: { kind: 'stuck', summary: 'x' }, stuck: { gate: 'checks', kind: 'weakened', question: 'y', options: [] } });
    story('TR-9', [[3, 'Worked on it']], { overrides: [{ gate: 'hooks', reason: 'known', by: 'Sara', at: ago(2) }] });
    story('TR-10', [[3, 'Worked on it']], { overrides: [{ gate: 'checks', weakened: ['a test'], reason: 'known', by: 'Sara', at: ago(2) }] });
    const s = seen();
    expect(s.rows.weakened).toMatchObject({ stopped: 2 });
    expect(s.rows.hook).toMatchObject({ stopped: 1 });
    expect(s.rows['ways-out']?.did).toBe('You went past a check on 2 stories');
    expect(s.rows.checks).toBeUndefined();
  });

  it('"no screens to show" passes the gate and is no pass here: only a picture is', () => {
    story('TR-11', [[1, 'No screens to show, so the checks are the proof']], { gates: { checks: 'pass', review: 'pass', proof: 'pass' } });
    story('TR-12', [[1, 'Saved 1 screenshot']], { gates: { checks: 'pass', review: 'pass', proof: 'pass' }, proof: [{ criterion: 'x', before: '', after: 'a.png', beforeLabel: '', afterLabel: 'After' }] });
    expect(seen().rows.proof).toMatchObject({ passed: 1, stopped: 0 });
  });

  it('counts the last 30 days, and this week is the last 7', () => {
    story('TR-13', [[40, 'Checks failed: test (try 1 of 3)']]);
    story('TR-14', [[20, 'Checks failed: test (try 1 of 3)']]);
    story('TR-15', [[3, 'Checks failed: test (try 1 of 3)']]);
    const s = seen();
    expect(s.rows.checks).toMatchObject({ stopped: 2, week: 1, last: { id: 'TR-15' } });
    expect(s.weekIds.checks).toEqual(['TR-15']);
    expect(s.stories).toBe(2);
  });

  it('what a person typed never counts, nor the words of an agent inside another line', () => {
    story('TR-16', [[1, 'Added a note: Checks failed: test'], [1, 'Message to the Builder: Stopped before the checks: the tests were made weaker'], [1, 'Approved: Reaching example.com was blocked: fine']]);
    expect(seen().rows).toEqual({});
  });

  it('says when a limit was reached, on the newest story', () => {
    story('TR-17', [[5, 'Checks failed: test (try 3 of 3)']]);
    story('TR-18', [[2, 'Checks failed: test (try 3 of 3)'], [2, 'Still asks for 2 fixes after 2 rounds: a b']]);
    story('TR-19', [[1, 'Checks failed: test (try 2 of 3)']]);
    const s = seen();
    expect(s.hits.MAX_CHECK_TRIES).toMatchObject({ id: 'TR-18' });
    expect(s.hits.MAX_REVIEW_ROUNDS).toMatchObject({ id: 'TR-18' });
    expect(s.hits.MAX_RETAKES).toBeUndefined();
  });
});

describe('a story that went', () => {
  it('a deleted story leaves no count and no link, and the next one takes its place', () => {
    story('TR-20', [[3, 'Checks failed: test (try 1 of 3)']]);
    story('TR-21', [[1, 'Checks failed: test (try 1 of 3)']], { waiting: { kind: 'stuck', summary: 'x' }, stuck: { gate: 'checks', question: 'y', options: [] } });
    removeTicket(bp, 'TR-21');
    const s = seen();
    expect(s.rows.checks).toMatchObject({ stopped: 1, last: { id: 'TR-20' } });
    expect(s.needs).toEqual([]);
    removeTicket(bp, 'TR-20');
    expect(seen().rows).toEqual({});
  });

  it('one being deleted counts as gone already', () => {
    story('TR-22', [[1, 'Checks failed: test (try 1 of 3)']], { waiting: { kind: 'stuck', summary: 'x' }, stuck: { gate: 'checks', question: 'y', options: [] }, deleting: { by: 'Sara', at: ago(0) } as Ticket['deleting'] });
    const s = seen();
    expect(s.rows).toEqual({});
    expect(s.needs).toEqual([]);
  });

  it('an archived story still counts', () => {
    story('TR-23', [[1, 'Checks failed: test (try 1 of 3)']], { archived: { by: 'Sara', at: ago(0) } });
    expect(seen().rows.checks).toMatchObject({ stopped: 1 });
  });
});

describe('what waits and where', () => {
  it('leads to the row of what the story waits for', () => {
    story('TR-24', [[1, 'Stopped before the checks: the tests were made weaker']], { stage: 'test', waiting: { kind: 'stuck', summary: 'The tests were made weaker' }, stuck: { gate: 'checks', kind: 'weakened', question: 'y', options: [] } });
    story('TR-25', [], { stage: 'review', waiting: { kind: 'proof', summary: 'The proof is ready' } });
    const s = seen();
    expect(s.needs).toEqual([
      { id: 'TR-24', summary: 'The tests were made weaker', row: 'weakened', proof: false },
      { id: 'TR-25', summary: 'The proof is ready', row: 'looks-right', proof: true },
    ]);
    const v = harnessView(meta, bp);
    expect(v.tiles.needs).toHaveLength(2);
    expect(v.stages.flatMap((x) => x.gates).find((g) => g.id === 'weakened')!.needs![0]!.id).toBe('TR-24');
  });

  it('every kind of wait has a row', () => {
    const v = harnessView(meta, bp);
    const ids = new Set([...v.stages.flatMap((x) => x.gates), ...v.alwaysOn].map((r) => r.id));
    expect(Object.values(WAIT_ROW).filter((r) => !ids.has(r))).toEqual([]);
  });
});

describe('it stays true', () => {
  const engine = ['src/engine', 'src/board'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.ts') && !f.startsWith('demo') && !f.startsWith('harness')).map((f) => fs.readFileSync(path.join(ROOT, d, f), 'utf8'))).join('\n');

  /** The plain words of a pattern, which the engine must still write: a reworded line would count nothing without a word. */
  const words = (re: RegExp) => re.source.replace(/\\([.()])/g, '$1').split(/\.\*|\\d\+|\\w\+|\\S\+|\\1|\(\\d\+\)|\[\^|[|()^$?]/).map((w) => w.replace(/\\/g, '').trim()).filter((w) => w.length > 5);

  it('the engine still writes every line these numbers are read from', () => {
    const all: [string, RegExp][] = [...Object.entries(STOP_LINES), ...Object.entries(DID_LINES).map(([k, [re]]) => [k, re] as [string, RegExp]), ...Object.entries(HIT_LINES)];
    const gone = all.flatMap(([k, re]) => words(re).filter((w) => !engine.includes(w)).map((w) => `${k}: ${w}`));
    expect(gone).toEqual([]);
    expect(words(STOP_LINES.weakened!)).toEqual(['Stopped before the checks: the tests were made weaker']);
  });

  it('every row with a number is a row on the page', () => {
    const v = harnessView(meta, bp);
    const ids = new Set([...v.stages.flatMap((x) => x.gates), ...v.alwaysOn].map((r) => r.id));
    expect([...Object.keys(STOP_LINES), ...Object.keys(DID_LINES)].filter((r) => !ids.has(r))).toEqual([]);
    const limits = new Set(v.limits.map((l) => l.id));
    expect(Object.keys(HIT_LINES).filter((l) => !limits.has(l))).toEqual([]);
  });

  it('every row opens what really runs, with the real commands and a file that is there', () => {
    const v = harnessView(meta, bp);
    const rows = [...v.stages.flatMap((x) => x.gates), ...v.alwaysOn];
    for (const r of rows) {
      const where = r.d?.find(([k]) => k === 'In the code')?.[1];
      expect(where, r.id).toBeTruthy();
      expect(fs.existsSync(path.join(ROOT, where!)), `${r.id}: ${where}`).toBe(true);
    }
    expect(rows.find((r) => r.id === 'checks')!.d).toContainEqual(['Runs', 'npm test, npm run lint']);
  });

  it('counts only what the working gates are: one that is off here is no gate working', () => {
    const v = harnessView(meta, bp);
    const all = [...v.stages.flatMap((x) => x.gates), ...v.alwaysOn].length;
    expect(v.tiles.working).toBeLessThanOrEqual(all);
    expect(v.tiles.working).toBeGreaterThanOrEqual(all - 2);
  });
});

describe('compare tracks', () => {
  const v = () => harnessView(meta, bp);
  const cell = (id: string) => v().stages.flatMap((s) => s.gates).find((g) => g.id === id)!.cells!;

  it('comes from the engine: a gate a track skips happens by itself there', () => {
    expect(cell('plan')).toEqual({ full: { word: 'You' }, express: { word: 'By itself' }, auto: { word: 'By itself' } });
    expect(cell('spec').auto).toEqual({ word: 'By itself', note: 'Approved with the breakdown.' });
    expect(cell('looks-right').full.word).toBe('You');
    expect(cell('looks-right').auto.word).toBe('By itself');
  });

  it('a stage a track does not use says so, and a gate that always runs reads the same on all three', () => {
    expect(cell('brd-approve')).toEqual({ full: { word: 'Not used' }, express: { word: 'Not used' }, auto: { word: 'You' } });
    expect(cell('checks')).toEqual({ full: { word: 'Runs' }, express: { word: 'Runs' }, auto: { word: 'Runs' } });
    expect(cell('merge').auto.note).toContain('3 tries');
  });

  it('every skip and note on a gate shows in a cell', () => {
    for (const s of v().stages) {
      for (const g of s.gates) {
        for (const t of ['full', 'express', 'auto'] as const) {
          if (g.skip?.includes(t)) expect(g.cells![t].word, `${g.id} on ${t}`).toBe('By itself');
          if (g.note?.[t]) expect(g.cells![t].note, `${g.id} on ${t}`).toBe(g.note[t]);
        }
      }
    }
  });
});

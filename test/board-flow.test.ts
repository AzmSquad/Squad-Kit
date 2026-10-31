import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, draftRelease, listDecisions, listReleases, readMeta, readTicket, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { tick } from '../src/board/engine.js';
import * as actions from '../src/board/actions.js';
import type { Ticket } from '../src/board/types.js';

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-board-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Runs the demo squad until the ticket reaches the state, like the console does on its timer. */
async function until(id: string, done: (t: Ticket) => boolean): Promise<Ticket> {
  for (let i = 0; i < 500; i += 1) {
    tick(bp);
    const t = readTicket(bp, id)!;
    if (done(t)) return t;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`${id} never reached the expected state`);
}

describe('board flow', () => {
  it('seeds a board with something waiting for each kind of stop', () => {
    expect(actions.inbox(bp).map((t) => `${t.id}:${t.waiting!.kind}`)).toEqual([
      'SK-139:proof',
      'SK-148:questions',
      'SK-150:stuck',
    ]);
  });

  it('takes a ticket from questions to release, saving the decision on the way', async () => {
    actions.askAbout(bp, 'SK-148', 'q3', 'What do you mean by tech?');
    const asked = await until('SK-148', (t) => t.questions!.find((q) => q.id === 'q3')!.thinking === false);
    expect(asked.questions!.find((q) => q.id === 'q3')!.thread!.at(-1)!.who).toBe('architect');

    actions.answerQuestions(bp, 'SK-148', {
      q1: { choice: 'Night shift staff' },
      q2: { choice: 'Yes' },
      q3: { choice: 'Yes:', value: 'Angular Material' },
      q4: { choice: 'Yes, shared desks' },
    });
    // Full track: the spec first (the what), then the design (the how), each approved on its own.
    const specced = await until('SK-148', (t) => t.waiting?.kind === 'spec');
    expect(specced.story).toBeTruthy();
    expect(specced.criteria?.length).toBeGreaterThan(0);
    expect(specced.decision).toBeUndefined();
    actions.approve(bp, 'SK-148');
    expect(readTicket(bp, 'SK-148')!.specApproved?.by).toBe('Momen');
    const planned = await until('SK-148', (t) => t.waiting?.kind === 'plan');
    expect(planned.story).toBe(specced.story);
    expect(planned.decision?.title).toBe("Save each person's theme in their account");

    actions.approve(bp, 'SK-148');
    expect(listDecisions(bp)[0]).toMatchObject({ id: 'ADR-012', from: 'SK-148' });

    const proven = await until('SK-148', (t) => t.waiting?.kind === 'proof');
    expect(proven.gates).toMatchObject({ checks: 'pass', review: 'pass', proof: 'pass' });
    expect(listDecisions(bp)[0]!.checkedBy?.passing).toBe(true);

    actions.approve(bp, 'SK-148');
    expect(draftRelease(bp)?.tickets).toContain('SK-148');

    const release = await actions.releaseVersion(bp);
    expect(release.version).toBe('v2.4.0');
    expect(readTicket(bp, 'SK-148')!.stage).toBe('done');
  });

  it('turns a bug into a ticket linked to the release and records a lesson', async () => {
    const bug = actions.reportBug(bp, { what: 'Table text is hard to read', severity: 'annoying' });
    expect(bug.foundIn).toBe('v2.3.1');
    expect(listReleases(bp).find((r) => r.version === 'v2.3.1')!.bugs).toContain(bug.id);
    await until(bug.id, (t) => t.waiting?.kind === 'spec');
    actions.approve(bp, bug.id);
    await until(bug.id, (t) => t.waiting?.kind === 'plan');
    actions.approve(bp, bug.id);
    await until(bug.id, (t) => t.waiting?.kind === 'proof');
    expect(readMeta(bp).lessons[0]!.from).toBe(bug.id);
  });

  it('resumes a stuck ticket from the step it stopped on', async () => {
    actions.decideStuck(bp, 'SK-150', 1);
    const t = await until('SK-150', (x) => x.waiting?.kind === 'proof');
    const finished = t.activity.filter((a) => a.text.startsWith('Finished step 1'));
    expect(finished).toHaveLength(0);
  });

  it('explains person mistakes in plain words', () => {
    expect(() => actions.approve(bp, 'SK-148')).toThrow(/needs answers first/);
    expect(() => actions.answerQuestions(bp, 'SK-148', {})).toThrow(/still needs an answer/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, listDecisions, readMeta, writeMeta } from '../src/board/store.js';
import { ensureLiveBoard, setupProject } from '../src/engine/setup.js';
import { cleanOverview, overviewDoc, overviewFile, parseOverviewDoc, readOverview, writeOverview, type Overview } from '../src/board/overview.js';
import { overviewView } from '../src/board/first-run.js';
import { answerProblem, partsProblem, scanProblem } from '../src/engine/answers.js';
import { SCAN_SCHEMA, BLUEPRINT_SCHEMA, scanPrompt } from '../src/engine/prompts.js';
import { saveScan } from '../src/engine/onboard.js';
import { saveBlueprintParts } from '../src/engine/onboard-live.js';

/**
 * The read's new fields: who uses the project, what it can do, what is worth knowing, three ticket ideas and the parts
 * of the code with their links. Their shape and checks, their file in .squad/knowledge, and a project read by an older
 * squad-kit that has none of them.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-overview-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function liveBoard() {
  const dir = path.join(tmp, 'p');
  fs.mkdirSync(dir);
  setupProject(dir);
  return ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'p').bp;
}

const full: Overview = {
  users: 'Office staff who book rooms. They pick their name from a list; there are no accounts.',
  can: ['Book a room in 15-minute steps', '- starts like a list item', '# starts like a heading'],
  worth: ['The login screen checks no password.'],
  ideas: [
    { title: 'Check a real password at login', why: 'Anyone can open the booking page.', ticket: 'RO-1' },
    { title: 'Let people change a booking', why: 'A booking can be cancelled\nbut not changed.' },
  ],
  parts: [
    { id: 'staff', name: 'Staff', what: 'In a web browser', files: [], kind: 'people' },
    { id: 'pages', name: 'Pages', what: 'Login page and booking page', files: ['static/', 'app.py'], kind: 'screens' },
    { id: 'db', name: 'Database (one file)', what: 'One SQLite file', files: ['roomflow.db'] },
  ],
  links: [
    { from: 'staff', to: 'pages', label: 'uses' },
    { from: 'pages', to: 'db', label: 'stores in' },
  ],
  readAt: '2026-11-03T07:10:00.000Z',
  approved: { by: 'Momen', at: '2026-11-03T07:20:00.000Z' },
};

describe('the overview in .squad/knowledge', () => {
  it('is Markdown a person can read, and reads back the same', () => {
    const text = overviewDoc(full);
    expect(text).toContain('## Who uses it\n\nOffice staff who book rooms.');
    expect(text).toContain('## What it can do today\n\n- Book a room in 15-minute steps');
    expect(text).toContain('### Pages\n\n- Id: pages\n- Kind: screens\n- Files: static/ | app.py\n- Links to: db (stores in)');
    const back = parseOverviewDoc(text);
    expect(back).toEqual({ ...full, ideas: [full.ideas[0], { title: 'Let people change a booking', why: 'A booking can be cancelled but not changed.' }] });
  });

  it('keeps an answer to what fits: unique parts, links between parts that exist, three ideas at most', () => {
    const o = cleanOverview({
      users: '  Staff  ',
      can: ['One', 2, '', 'Two'],
      ideas: [{ title: 'A', why: 'a' }, { title: 'B' }, { title: 'C', why: 'c' }, { title: 'D', why: 'd' }, { why: 'no title' }],
      parts: [
        { id: 'a', name: 'A', what: 'first', files: ['a/'], kind: 'server' },
        { id: 'a', name: 'A again', what: 'same id', files: [] },
        { id: 'b', name: 'B', what: 'second', files: [], kind: 'not a kind' },
      ],
      links: [
        { from: 'a', to: 'b', label: 'calls' },
        { from: 'a', to: 'nowhere' },
        { from: 'b', to: 'b' },
        { from: 'a', to: 'b' },
      ],
    });
    expect(o.users).toBe('Staff');
    expect(o.can).toEqual(['One', 'Two']);
    expect(o.ideas.map((i) => i.title)).toEqual(['A', 'B', 'C']);
    expect(o.parts).toEqual([
      { id: 'a', name: 'A', what: 'first', files: ['a/'], kind: 'server' },
      { id: 'b', name: 'B', what: 'second', files: [] },
    ]);
    expect(o.links).toEqual([{ from: 'a', to: 'b', label: 'calls' }]);
    // An answer from before these fields: everything empty, nothing breaks.
    expect(cleanOverview({})).toEqual({ can: [], worth: [], ideas: [], parts: [], links: [] });
  });

  it('a project read by an older squad-kit still loads: its summary and map, and a way to read it again', () => {
    const bp = liveBoard();
    // What 1.1 wrote: knowledge/project.md with the summary and the map, and no overview.md.
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', at: '2026-10-01T10:00:00.000Z', summary: 'A booking app.' }, setup: undefined, map: [{ area: 'Server', detail: 'app.py' }] });
    fs.rmSync(overviewFile(bp), { force: true });
    expect(readOverview(bp)).toEqual({ can: [], worth: [], ideas: [], parts: [], links: [] });
    const v = overviewView(bp);
    expect(v).toMatchObject({ old: true, summary: 'A booking app.', map: [{ area: 'Server', detail: 'app.py' }], handover: 'none', parts: [], ideas: [] });
    // A broken file reads as none at all.
    fs.mkdirSync(path.dirname(overviewFile(bp)), { recursive: true });
    fs.writeFileSync(overviewFile(bp), '---\n: not yaml [\n---\n');
    expect(() => overviewView(bp)).not.toThrow();
  });

  it('the picture of the parts follows a later read of the code, after a merge', () => {
    const bp = liveBoard();
    writeOverview(bp, full);
    saveBlueprintParts(bp, { map: [], stack: [], patterns: [], parts: [{ id: 'x', name: 'X', what: 'new', files: ['x/'] }], links: [] });
    const o = readOverview(bp);
    expect(o.parts.map((p) => p.id)).toEqual(['x']);
    expect(o.users).toBe(full.users);
    expect(o.refreshedAt).toBeTruthy();
    // A read with no parts leaves the picture as it was.
    saveBlueprintParts(bp, { map: [], stack: [], patterns: [] });
    expect(readOverview(bp).parts.map((p) => p.id)).toEqual(['x']);
  });
});

describe("the read's answer checks", () => {
  const base = { empty: false, summary: 's', map: [], decisions: [], commands: {} };
  const parts = { users: 'u', can: [], worth: [], ideas: [], parts: [{ id: 'a', name: 'A', what: '', files: [] }], links: [{ from: 'a', to: 'a' }] };

  it('the shape takes the new fields, and an answer in the older shape still fits it', () => {
    expect(answerProblem(SCAN_SCHEMA, base)).toBeNull();
    expect(answerProblem(SCAN_SCHEMA, { ...base, ...parts })).toBeNull();
    expect(answerProblem(SCAN_SCHEMA, { ...base, ideas: [{ title: 't' }] })).toBe('ideas[0].why is missing');
    expect(answerProblem(SCAN_SCHEMA, { ...base, ideas: [1, 2, 3, 4].map((n) => ({ title: `${n}`, why: '' })) })).toBe('ideas has more than 3 items');
    expect(answerProblem(SCAN_SCHEMA, { ...base, parts: [{ id: 'a', name: 'A', what: '', files: [], kind: 'robots' }] })).toContain('parts[0].kind is not one of people');
    // The code's picture comes with a later read too, but it may be left out.
    expect(answerProblem(BLUEPRINT_SCHEMA, { map: [], stack: [], patterns: [] })).toBeNull();
  });

  it('asks once more for what the overview needs when the project has code, and checks the links', () => {
    expect(scanProblem(base)).toBe('users is missing');
    expect(scanProblem({ ...base, empty: true })).toBeNull();
    expect(scanProblem({ ...base, ...parts })).toBeNull();
    expect(scanProblem({ ...base, ...parts, links: [{ from: 'a', to: 'b' }] })).toBe('links[0].to names no part ("b")');
    expect(partsProblem({ parts: [{ id: 'a' }, { id: 'a' }], links: [] })).toBe('two parts have the id "a"');
  });

  it('the read asks for every new field, and for a read again, carries what the person said as data', () => {
    const bp = liveBoard();
    const p = scanPrompt(readMeta(bp), [], undefined, '- The login does check passwords');
    for (const word of ['users:', 'can:', 'worth:', 'ideas:', 'parts:', 'links:']) expect(p).toContain(`- ${word}`);
    expect(p).toContain('<data>\n- The login does check passwords\n</data>');
    expect(scanPrompt(readMeta(bp), [])).not.toContain('<data>');
  });

  it('saving the read keeps a choice found before, and drops a proposal the new read no longer finds', () => {
    const bp = liveBoard();
    const answer = { ...base, decisions: [{ title: 'Python 3.10', why: 'pyproject says so' }, { title: 'SQLite', why: 'roomflow.db' }], ...parts };
    saveScan(bp, answer, []);
    expect(listDecisions(bp).map((d) => [d.title, d.proposed])).toEqual(expect.arrayContaining([['Python 3.10', true], ['SQLite', true]]));
    saveScan(bp, { ...answer, decisions: [{ title: 'Python 3.10', why: 'still' }] }, []);
    expect(listDecisions(bp).map((d) => d.title)).toEqual(['Python 3.10']);
  });
});

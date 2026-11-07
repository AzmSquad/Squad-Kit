import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boardPaths, updateTicket, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import * as actions from '../src/board/actions.js';
import { openInEditor, splitDiff, ticketChanges } from '../src/engine/changes.js';

let tmp: string;
let repo: string;
let bp: BoardPaths;
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-changes-')));
  repo = path.join(tmp, 'app');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@t');
  g(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'bye\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-qm', 'start');
  bp = boardPaths(path.join(repo, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function ticketWithCopy() {
  const base = g(repo, 'rev-parse', 'HEAD');
  const copy = path.join(tmp, 'copy');
  g(repo, 'worktree', 'add', '-q', '-b', 'squad/sk-1', copy);
  const t = actions.createTicket(bp, { title: 'Change things' });
  updateTicket(bp, t.id, (x) => {
    x.worktree = copy;
    x.branch = 'squad/sk-1';
    x.baseCommit = base;
  });
  return { id: t.id, copy };
}

describe('the Changes tab', () => {
  it('shows nothing before the build starts', async () => {
    const t = actions.createTicket(bp, { title: 'New' });
    expect(await ticketChanges(bp, t.id)).toEqual({ from: 'none', files: [] });
  });

  it("reads changed, deleted and new files from the ticket's copy", async () => {
    const { id, copy } = ticketWithCopy();
    fs.writeFileSync(path.join(copy, 'a.txt'), 'one\nTWO\n');
    fs.rmSync(path.join(copy, 'gone.txt'));
    fs.mkdirSync(path.join(copy, 'src'));
    fs.writeFileSync(path.join(copy, 'src', 'new.ts'), 'export const x = 1;\n');
    const c = await ticketChanges(bp, id);
    expect(c.from).toBe('copy');
    const byPath = Object.fromEntries(c.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toMatchObject({ status: 'changed', added: 1, removed: 1 });
    expect(byPath['a.txt']!.patch).toContain('+TWO');
    expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', removed: 1 });
    expect(byPath['src/new.ts']).toMatchObject({ status: 'added', added: 1 });
    expect(byPath['src/new.ts']!.patch).toContain('+export const x = 1;');
  });

  it('reads the branch once the copy is gone', async () => {
    const { id, copy } = ticketWithCopy();
    fs.writeFileSync(path.join(copy, 'a.txt'), 'one\nthree\n');
    g(copy, 'commit', '-qam', 'change');
    g(repo, 'worktree', 'remove', '--force', copy);
    const c = await ticketChanges(bp, id);
    expect(c.from).toBe('branch');
    expect(c.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('splits a rename', () => {
    const raw = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';
    expect(splitDiff(raw)).toEqual([{ path: 'old.ts → new.ts', status: 'renamed', added: 0, removed: 0, patch: '' }]);
  });
});

describe('Open in editor', () => {
  it('opens the copy in the first editor found', () => {
    const { id, copy } = ticketWithCopy();
    const opened: string[][] = [];
    const r = openInEditor(bp, id, undefined, { has: (b) => b === 'code', launch: (b, d) => opened.push([b, d]) });
    expect(r).toEqual({ editor: 'VS Code', folder: copy });
    expect(opened).toEqual([['code', copy]]);
  });

  it('says how to fix it when no editor command is found', () => {
    const { id, copy } = ticketWithCopy();
    expect(() => openInEditor(bp, id, undefined, { has: () => false, launch: () => undefined })).toThrow(copy);
  });
});

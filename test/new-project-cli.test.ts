import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProjects } from '../src/commands/projects.js';
import { readProjects } from '../src/core/projects.js';
import { boardPaths, readMeta } from '../src/board/store.js';
import { listBreakdowns } from '../src/board/requirements.js';

/** `squad projects --new`: the same New project as the button, with no app running. Its squad starts when the app opens. */

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-cli-')));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('squad projects --new', () => {
  it('makes a project from an idea and adds it to the list', async () => {
    await runProjects({ new: 'From an idea', where: tmp, idea: 'A visitor log' });
    const root = path.join(tmp, 'From an idea');
    expect(readProjects().map((p) => p.root)).toContain(root);
    expect(readMeta(boardPaths(path.join(root, '.squad'))).scan?.status).toBe('pending');
  });

  it('makes a project from a BRD file, which goes to the Analyst', async () => {
    const file = path.join(tmp, 'brd.md');
    fs.writeFileSync(file, '# Visitor log\n\nPeople sign in.\n');
    await runProjects({ new: 'From a BRD', where: tmp, brd: file });
    const bp = boardPaths(path.join(tmp, 'From a BRD', '.squad'));
    expect(listBreakdowns(bp)).toHaveLength(1);
    expect(readMeta(bp).scan).toMatchObject({ status: 'done', empty: true });
  });

  it('says plainly when the file is not there, and makes nothing', async () => {
    await expect(runProjects({ new: 'Nope', where: tmp, brd: path.join(tmp, 'none.pdf') })).rejects.toThrow('There is no file at');
    expect(fs.existsSync(path.join(tmp, 'Nope'))).toBe(false);
  });
});

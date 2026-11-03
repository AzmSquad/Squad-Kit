import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DEFAULT_CONFIG, saveConfig } from '../src/core/config.js';
import { firstLook } from '../src/engine/first-look.js';
import { prepareProject } from '../src/engine/setup.js';
import { setupView } from '../src/board/first-run.js';

/** Add project says what it found before the person confirms, and what happens next, for every kind of folder. */

let tmp: string;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'ignore' });
const put = (file: string, text = 'x\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const commit = (dir: string) => sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first', dir);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-look-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("what Add project says it found", () => {
  it('existing code with git: the language, the files, the tests and the branch, and that the code is not changed', () => {
    const dir = path.join(tmp, 'roomflow');
    put(path.join(dir, 'app.py'), 'from http.server import HTTPServer\n');
    put(path.join(dir, 'store.py'));
    put(path.join(dir, 'static', 'index.html'));
    put(path.join(dir, 'tests', 'test_store.py'));
    commit(dir);
    const look = firstLook(dir);
    expect(look).toMatchObject({ kind: 'repo', title: 'Existing code, new to squad-kit', language: 'Python', web: true, tests: true, branch: 'main', unsaved: 0, files: 4 });
    expect(look.found).toBe('A Python web app with 4 files and tests, on git branch main.');
    expect(look.next).toBe('squad-kit will read it, find how to test and run it, then show you what it understood.');
    expect(look.safe).toBe("Your code is not changed. squad-kit only adds a .squad folder for the project's memory.");
    expect(look.takes).toBe('Takes about 3 to 5 minutes. You can keep working meanwhile.');

    // Changes not saved in git are named: squad-kit works from what is saved.
    put(path.join(dir, 'store.py'), 'changed\n');
    expect(firstLook(dir).found).toContain('1 change is not saved in git yet');
  });

  it('code without git: it goes into git first, with secrets and built folders left out', () => {
    const dir = path.join(tmp, 'old-site');
    put(path.join(dir, 'src', 'main.ts'));
    put(path.join(dir, 'node_modules', 'x', 'index.js'));
    const look = firstLook(dir);
    expect(look).toMatchObject({ kind: 'files', title: 'Code without git', language: 'TypeScript', files: 1 });
    expect(look.found).toBe('A TypeScript project with 1 file, not in git yet.');
    expect(look.next).toContain('puts the files in git first');
    expect(look.safe).toContain('.env');
  });

  it('an empty folder: a new project, started from an idea', () => {
    const dir = path.join(tmp, 'new-idea');
    fs.mkdirSync(dir);
    expect(firstLook(dir)).toMatchObject({
      kind: 'empty',
      title: 'An empty folder',
      found: 'Nothing here yet: a new project.',
      next: 'Start from an idea. squad-kit makes a git repo here, and the Architect proposes the stack for you to approve.',
      takes: 'Takes a few seconds.',
    });
  });

  it('several repos: names them, and says how squad-kit reads them', () => {
    const dir = path.join(tmp, 'portal');
    for (const r of ['web', 'api', 'mobile']) {
      put(path.join(dir, r, 'index.js'));
      commit(path.join(dir, r));
    }
    const look = firstLook(dir);
    expect(look).toMatchObject({ kind: 'repos', title: 'Several code repos', repos: ['api', 'mobile', 'web'] });
    expect(look.found).toBe('A folder with 3 code repos inside: api, mobile and web.');
    expect(look.next).toContain('how they fit together');
  });

  it('an older squad-kit: its files move to the new layout, and nothing is lost', () => {
    const dir = path.join(tmp, 'legacy');
    fs.mkdirSync(path.join(dir, '.squad'), { recursive: true });
    saveConfig(path.join(dir, '.squad', 'config.yaml'), { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: 'legacy' } });
    put(path.join(dir, '.squad', 'stories', 'login', '1', 'intake.md'));
    put(path.join(dir, 'index.ts'));
    commit(dir);
    const look = firstLook(dir);
    expect(look).toMatchObject({ kind: 'older', title: 'An older squad-kit project' });
    expect(look.found).toBe('squad-kit 0.x files are here, with 1 story, in a TypeScript project with 1 file, on git branch main.');
    expect(look.next).toContain('Nothing is lost');

    // A board from before the two homes of ADR-001 is an older squad-kit too.
    const one = path.join(tmp, 'one-board');
    put(path.join(one, '.squad', 'board', 'board.yaml'), 'project: one\n');
    expect(firstLook(one).kind).toBe('older');
  });

  it('a squad-kit project: adding it only opens it', () => {
    const dir = path.join(tmp, 'ready');
    put(path.join(dir, 'index.ts'));
    commit(dir);
    prepareProject(dir);
    expect(firstLook(dir)).toMatchObject({ kind: 'project', title: 'A squad-kit project', found: 'This folder has squad-kit already, with 0 tickets.', next: 'Adding it opens its board. Nothing is set up again.' });
  });

  it('the setup Add starts remembers the kind of folder', () => {
    const repo = path.join(tmp, 'repo');
    put(path.join(repo, 'index.ts'));
    commit(repo);
    expect(setupView(prepareProject(repo).bp)?.kind).toBe('repo');
    const files = path.join(tmp, 'files');
    put(path.join(files, 'index.ts'));
    expect(setupView(prepareProject(files).bp)?.kind).toBe('files');
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    expect(setupView(prepareProject(empty).bp)?.kind).toBe('empty');
    const older = path.join(tmp, 'older');
    fs.mkdirSync(path.join(older, '.squad'), { recursive: true });
    saveConfig(path.join(older, '.squad', 'config.yaml'), { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: 'older' } });
    put(path.join(older, '.squad', 'plans', 'p1.md'));
    put(path.join(older, 'index.ts'));
    commit(older);
    expect(setupView(prepareProject(older).bp)?.kind).toBe('older');
  });
});

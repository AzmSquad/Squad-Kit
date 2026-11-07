import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DEFAULT_CONFIG, saveConfig } from '../src/core/config.js';
import { addAsk, firstLook } from '../src/engine/first-look.js';
import { runConsole } from '../src/commands/console.js';
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

describe('a folder inside something bigger', () => {
  const settings = (dir: string, more: object = {}) => {
    fs.mkdirSync(path.join(dir, '.squad'), { recursive: true });
    saveConfig(path.join(dir, '.squad', 'config.yaml'), { ...DEFAULT_CONFIG, ...more });
  };

  it('a subfolder of a repo is not called existing code: it names the top folder', async () => {
    const dir = path.join(tmp, 'shop');
    put(path.join(dir, 'app.py'));
    put(path.join(dir, 'web', 'index.html'));
    commit(dir);
    const look = await firstLook(path.join(dir, 'web'));
    expect(look.title).toBe('Part of a bigger project');
    expect(look.ask).toMatchObject({ kind: 'inside-repo', root: dir, name: 'shop' });
    expect(look.found).toBe(`This folder is part of a bigger project, shop, in ${dir}. Its tests and app run from the top folder, so squad-kit works from there too. Add the top folder instead.`);
    expect(look.found).not.toMatch(/\bgit\b|repo\b/);
    expect(addAsk(dir)).toBeNull();
  });

  it('a project in a subfolder of its repo: its own folders open it with no question', () => {
    const repo = path.join(tmp, 'mono');
    const web = path.join(repo, 'apps', 'web');
    put(path.join(web, 'src', 'a.ts'));
    commit(repo);
    settings(web);
    expect(addAsk(path.join(web, 'src'))).toBeNull();
  });

  it('a fresh clone under a project it is no part of: says which folder it found, and asks', async () => {
    const workspace = path.join(tmp, 'workspace');
    settings(workspace);
    const clone = path.join(workspace, 'clone');
    put(path.join(clone, 'a.ts'));
    put(path.join(clone, '.squad', 'README.md'));
    commit(clone);
    const look = await firstLook(clone);
    expect(look.ask).toMatchObject({ kind: 'inside-project', root: workspace, name: 'workspace' });
    expect(look.found).toBe(`This folder sits inside another squad-kit project, in ${workspace}. Open that project, or add this folder on its own?`);
  });

  it('a project whose .squad sits above several repos keeps working: its repos and their folders belong to it', () => {
    const workspace = path.join(tmp, 'workspace');
    for (const r of ['api', 'web']) {
      put(path.join(workspace, r, 'a.ts'));
      commit(path.join(workspace, r));
    }
    settings(workspace, { board: { repos: [{ path: 'api' }, { path: 'web' }] } });
    expect(addAsk(path.join(workspace, 'api'))).toBeNull();
    put(path.join(workspace, 'web', 'src', 'x.ts'));
    expect(addAsk(path.join(workspace, 'web', 'src'))).toBeNull();
    // A new clone beside them, that the project does not list, is not taken for one of them.
    put(path.join(workspace, 'other', 'a.ts'));
    commit(path.join(workspace, 'other'));
    expect(addAsk(path.join(workspace, 'other'))?.kind).toBe('inside-project');
    expect(addAsk(workspace)).toBeNull();
  });

  it('in the terminal: squad console says the same, and never sets anything up with nobody to ask', async () => {
    const workspace = path.join(tmp, 'workspace');
    settings(workspace);
    const before = fs.readFileSync(path.join(workspace, '.squad', 'config.yaml'), 'utf8');
    const clone = path.join(workspace, 'clone');
    put(path.join(clone, 'a.ts'));
    commit(clone);
    const was = process.cwd();
    process.chdir(clone);
    try {
      await expect(runConsole({ open: false } as never)).rejects.toThrow(`This folder sits inside another squad-kit project, in ${workspace}.`);
    } finally {
      process.chdir(was);
    }
    expect(fs.readFileSync(path.join(workspace, '.squad', 'config.yaml'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(clone, '.squad'))).toBe(false);
  });

  it("a project's own subfolder is that project, with no question", () => {
    const dir = path.join(tmp, 'shop');
    put(path.join(dir, 'src', 'a.ts'));
    commit(dir);
    settings(dir);
    expect(addAsk(path.join(dir, 'src'))).toBeNull();
  });

  it('a folder with its own project is its own, whatever is above it; so is a folder in no repo under no project', () => {
    const outer = path.join(tmp, 'outer');
    settings(outer);
    const inner = path.join(outer, 'inner');
    settings(inner);
    expect(addAsk(inner)).toBeNull();
    put(path.join(tmp, 'plain', 'a.txt'));
    expect(addAsk(path.join(tmp, 'plain'))).toBeNull();
  });

  it('a project set up in a subfolder before this stays out of the person\'s changes', () => {
    const dir = path.join(tmp, 'shop');
    put(path.join(dir, 'app.py'));
    put(path.join(dir, 'web', 'index.html'));
    commit(dir);
    prepareProject(path.join(dir, 'web'));
    expect(execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' })).not.toContain('.squad');
  });
});

describe("what Add project says it found", () => {
  it('existing code with git: the language, the files, the tests and the branch, and that the code is not changed', async () => {
    const dir = path.join(tmp, 'roomflow');
    put(path.join(dir, 'app.py'), 'from http.server import HTTPServer\n');
    put(path.join(dir, 'store.py'));
    put(path.join(dir, 'static', 'index.html'));
    put(path.join(dir, 'tests', 'test_store.py'));
    commit(dir);
    const look = await firstLook(dir);
    expect(look).toMatchObject({ kind: 'repo', title: 'Existing code, new to squad-kit', language: 'Python', web: true, tests: true, branch: 'main', unsaved: 0, files: 4 });
    expect(look.found).toBe('A Python web app with 4 files and tests.');
    expect(look.next).toBe('squad-kit will read it, find how to test and run it, then show you what it understood.');
    expect(look.safe).toBe("Your code is not changed. squad-kit only adds a .squad folder for the project's memory.");
    expect(look.takes).toBe('Takes about 3 to 5 minutes. You can keep working meanwhile.');

    // Changes not saved in git are named: squad-kit works from what is saved.
    put(path.join(dir, 'store.py'), 'changed\n');
    expect((await firstLook(dir)).found).toContain('1 change is not saved in git yet');
  });

  it('code without git: it goes into git first, with secrets and built folders left out', async () => {
    const dir = path.join(tmp, 'old-site');
    put(path.join(dir, 'src', 'main.ts'));
    put(path.join(dir, 'node_modules', 'x', 'index.js'));
    const look = await firstLook(dir);
    expect(look).toMatchObject({ kind: 'files', title: 'Code without git', language: 'TypeScript', files: 1 });
    expect(look.found).toBe('A TypeScript project with 1 file, not in git yet.');
    expect(look.next).toContain('puts the files in git first');
    expect(look.safe).toContain('.env');
  });

  it('an empty folder: a new project, started from an idea', async () => {
    const dir = path.join(tmp, 'new-idea');
    fs.mkdirSync(dir);
    expect(await firstLook(dir)).toMatchObject({
      kind: 'empty',
      title: 'An empty folder',
      found: 'Nothing here yet: a new project.',
      next: 'Start from an idea: squad-kit makes a git repo here, and asks what you want to build.',
      takes: 'Takes a few seconds.',
    });
  });

  it('several repos: names them, and says how squad-kit reads them', async () => {
    const dir = path.join(tmp, 'portal');
    for (const r of ['web', 'api', 'mobile']) {
      put(path.join(dir, r, 'index.js'));
      commit(path.join(dir, r));
    }
    const look = await firstLook(dir);
    expect(look).toMatchObject({ kind: 'repos', title: 'Several code folders', repos: ['api', 'mobile', 'web'] });
    expect(look.found).toBe('A folder with 3 code folders inside: api, mobile and web.');
    expect(look.next).toContain('how they fit together');
  });

  it('an older squad-kit: it says what really happens to its files', async () => {
    const dir = path.join(tmp, 'legacy');
    fs.mkdirSync(path.join(dir, '.squad'), { recursive: true });
    saveConfig(path.join(dir, '.squad', 'config.yaml'), { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: 'legacy' } });
    put(path.join(dir, '.squad', 'stories', 'login', '1', 'intake.md'));
    put(path.join(dir, 'index.ts'));
    commit(dir);
    const look = await firstLook(dir);
    expect(look).toMatchObject({ kind: 'older', title: 'An older squad-kit project' });
    expect(look.found).toBe('squad-kit 0.x files are here, with 1 story, in a TypeScript project with 1 file.');
    // Nothing moves and no copy is made: every old file stays, notes it would write over get a new name, sign-ins move out.
    expect(look.next).toContain('Your specs, plans and decisions stay where they are.');
    expect(look.next).toContain('moves sign-ins out of the project');
    expect(look.next).not.toMatch(/new layout|full copy/);
    expect(look.safe).toBe("Your code is not changed. squad-kit only works in the project's .squad folder.");

    // A board from before the two homes of ADR-001 is an older squad-kit too, and that one really is moved, with a copy.
    const one = path.join(tmp, 'one-board');
    put(path.join(one, '.squad', 'board', 'board.yaml'), 'project: one\n');
    expect(await firstLook(one)).toMatchObject({ kind: 'older' });
    expect((await firstLook(one)).next).toContain('a full copy is kept first');
  });

  it('a squad-kit project: adding it only opens it', async () => {
    const dir = path.join(tmp, 'ready');
    put(path.join(dir, 'index.ts'));
    commit(dir);
    prepareProject(dir);
    expect(await firstLook(dir)).toMatchObject({ kind: 'project', title: 'A squad-kit project', found: 'This folder has squad-kit already, with 0 tickets.', next: 'Adding it opens its board. Nothing is set up again.' });
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

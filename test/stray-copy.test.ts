import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { addWorktree, git, worktreeRoot } from '../src/engine/git.js';
import { clearStrayCopy, setAsideStrayCopy } from '../src/engine/stray-copy.js';

let tmp: string;
let project: string;
const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();

function freshRepo(file: string): void {
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  sh(project, 'git init -q -b main && git config user.email t@t && git config user.name t && git config commit.gpgsign false');
  fs.writeFileSync(path.join(project, file), 'x\n');
  sh(project, `git add . && git commit -qm first`);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stray-')));
  process.env.SQUAD_KIT_HOME = path.join(tmp, 'home');
  project = path.join(tmp, 'test-laravel-project');
});
afterEach(() => {
  delete process.env.SQUAD_KIT_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a copy left from an earlier set-up of the project (#34)', () => {
  it('is moved aside, never reused, and a new copy of this repo is made in its place', async () => {
    freshRepo('MysqlStorageTest.php');
    const old = await addWorktree(project, 'TLP-1', 'main');
    expect(fs.existsSync(path.join(old.dir, 'MysqlStorageTest.php'))).toBe(true);
    // The project is set up again in the same folder: its git starts over, and the old copy's link points at nothing.
    freshRepo('SqliteStorageTest.php');
    expect(git(old.dir, ['rev-parse', '--git-dir'], { allowFail: true })).toBe('');

    const aside = await clearStrayCopy(project, 'TLP-1');
    expect(aside).toBeTruthy();
    const made = await addWorktree(project, 'TLP-1', 'main');
    expect(made.dir).toBe(old.dir);
    expect(fs.existsSync(path.join(aside!, 'MysqlStorageTest.php'))).toBe(true);
    expect(fs.existsSync(path.join(made.dir, 'SqliteStorageTest.php'))).toBe(true);
    expect(fs.existsSync(path.join(made.dir, 'MysqlStorageTest.php'))).toBe(false);
    expect(git(made.dir, ['rev-parse', '--git-dir'], { allowFail: true })).not.toBe('');
    expect(path.dirname(path.dirname(aside!))).toBe(worktreeRoot(project));
  });

  it("leaves this repo's own copy where it is", async () => {
    freshRepo('a.txt');
    const wt = await addWorktree(project, 'TLP-2', 'main');
    expect(setAsideStrayCopy(project, wt.dir)).toBeNull();
    expect(await clearStrayCopy(project, 'TLP-2')).toBeNull();
  });
});

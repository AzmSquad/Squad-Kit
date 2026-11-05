import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { netGit } from '../src/engine/git.js';

/**
 * squad-kit's pushes run no hook of the project's, so git-lfs's own `pre-push` does not run either. Its large files must
 * still reach the remote, or a teammate gets pointers to files nobody uploaded. A fake git-lfs stands in for the real one.
 */

let tmp: string;
let repo: string;
let remote: string;
let bin: string;
let said: string;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const env = () => ({ PATH: `${bin}${path.delimiter}${process.env.PATH}` });
const push = () => netGit(repo, ['push', 'origin', 'main'], { env: env() });
const onRemote = () => sh('git rev-parse main', remote);

function fakeLfs(exit = 0): void {
  const file = path.join(bin, 'git-lfs');
  fs.writeFileSync(file, `#!/bin/sh\necho "args: $*" >> "${said}"\ncat >> "${said}"\nexit ${exit}\n`);
  fs.chmodSync(file, 0o755);
}

function useLfs(): void {
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm "track large files"', repo);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-lfs-')));
  repo = path.join(tmp, 'app');
  remote = path.join(tmp, 'remote.git');
  bin = path.join(tmp, 'bin');
  said = path.join(tmp, 'said.txt');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  sh(`git init -q --bare -b main "${remote}"`, tmp);
  sh('git init -q -b main', repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', repo);
  sh(`git remote add origin "${remote}"`, repo);
  fakeLfs();
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('a push and Git LFS', () => {
  it('a project that uses Git LFS gets its files uploaded, for exactly what is being pushed', () => {
    useLfs();
    push();
    const words = fs.readFileSync(said, 'utf8');
    expect(words).toContain(`args: pre-push origin ${remote}`);
    expect(words).toContain(`refs/heads/main ${sh('git rev-parse HEAD', repo)}`);
    expect(onRemote()).toBe(sh('git rev-parse HEAD', repo));
  });

  it('when the upload fails nothing is pushed, so no pointer reaches the remote without its file', () => {
    useLfs();
    fakeLfs(1);
    expect(push).toThrow();
    expect(() => onRemote()).toThrow();
  });

  it('a project without it never starts git-lfs', () => {
    push();
    expect(fs.existsSync(said)).toBe(false);
    expect(onRemote()).toBe(sh('git rev-parse HEAD', repo));
  });

  it("the project's own pre-push still does not run", () => {
    useLfs();
    const planted = path.join(tmp, 'planted.txt');
    const hook = path.join(repo, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${planted}"\nexit 1\n`);
    fs.chmodSync(hook, 0o755);
    push();
    expect(fs.existsSync(planted)).toBe(false);
    expect(onRemote()).toBe(sh('git rev-parse HEAD', repo));
  });
});

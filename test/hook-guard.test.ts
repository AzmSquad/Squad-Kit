import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * A commit hook is the project's own code, so it runs in the project's guard, and no agent may rewrite it. A Stop ends a
 * hook that is running, and never ends in a merge. Real git, real hooks, the real guard where this computer has one.
 */

// Real commits with real hooks in every test: slow on a busy computer, and no test here is about time.
vi.setConfig({ testTimeout: 60_000 });

let work: ((cwd: string) => void) | null = null;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    work?.(opts.cwd);
    return { ok: true, structured: { summary: 'Built it' }, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' };
  },
}));

const { boardPaths, readMeta, readRelease, readTicket, updateTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const auto = await import('../src/board/auto.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { bringHookRunner, commitHooks } = await import('../src/engine/git.js');
const { addWorktree } = await import('./support/copy.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { GUARD_BLOCKED_DOCKER, guardSupport, commitGuard, buildGuard, profileText, bubblewrapArgs } = await import('../src/engine/project-guard.js');
const { HOOK_FILES, hookFiles, isHookFile } = await import('../src/engine/hook-files.js');
const { checkLane, watchLane } = await import('../src/engine/lane.js');
const { squadHome } = await import('../src/core/home.js');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// Bubblewrap opens the whole temp folder again, which holds this test's fake squad-kit folder: only a Mac can show it here.
const guarded = () => process.platform === 'darwin' && guardSupport().on;

function ticket(id: string, extra: Record<string, unknown> = {}): string {
  const wt = addWorktree(project, id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'limit.txt'), 'limit = 3\n');
  writeTicket(bp, {
    id,
    title: 'Raise the limit',
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'review',
    status: '',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    track: 'auto',
    proof: [],
    ...extra,
  } as never);
  return wt.dir;
}

function huskyStyle(body: string) {
  fs.mkdirSync(path.join(project, '.husky'));
  fs.writeFileSync(path.join(project, '.husky', 'pre-commit'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  sh('git add .husky && git -c user.name=t -c user.email=t@t commit -qm hook', project);
  sh('git config core.hooksPath .husky', project);
}

beforeEach(() => {
  work = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hg-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', project);
  setupProject(project);
  bp = ensureLiveBoard(boardPaths(path.join(project, '.squad')), 'App').bp;
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false }, runner: 'direct', commands: {}, git: { base: 'main', remote: '' } });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a hook runs in the project guard', () => {
  it("a hook a Builder replaced cannot read squad-kit's folder or its token", async () => {
    if (!guarded()) return;
    const secret = path.join(squadHome(), 'app.json');
    fs.writeFileSync(secret, '{"token":"THE BOARD TOKEN"}');
    huskyStyle('exit 1');
    const dir = ticket('AP-1');
    // What a Builder can do with its own tools: the hook in its own copy.
    fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), `#!/bin/sh\ncat "${secret}" > "${tmp}/leak" 2>&1\nenv > "${tmp}/env"\nexit 0\n`, { mode: 0o755 });
    process.env.SQUAD_SECRET_FOR_TEST = 'A SQUAD VARIABLE';
    try {
      await auto.acceptByItselfBeside(bp, 'AP-1');
    } finally {
      delete process.env.SQUAD_SECRET_FOR_TEST;
    }
    expect(fs.readFileSync(path.join(tmp, 'leak'), 'utf8')).toMatch(/not permitted/i);
    expect(fs.readFileSync(path.join(tmp, 'env'), 'utf8')).not.toContain('A SQUAD VARIABLE');
  });

  it('a hook cannot plant a hook, change git settings, or move another branch; its own commit works', async () => {
    if (!guarded()) return;
    const git = path.join(project, '.git');
    const out = path.join(tmp, 'tries');
    fs.mkdirSync(path.join(git, 'hooks'), { recursive: true });
    const script = [
      `{ echo planted > "${git}/hooks/post-merge"; } 2>> "${out}" || echo PLANT-REFUSED >> "${out}"`,
      `{ echo '[core]' >> "${git}/config"; } 2>> "${out}" || echo CONFIG-REFUSED >> "${out}"`,
      `git update-ref refs/heads/main HEAD~0 2>> "${out}" && echo MAIN-SAME >> "${out}"`,
      `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_EXEC_PATH "$(git --exec-path)/git" update-ref refs/heads/stolen HEAD 2>> "${out}" || echo BRANCH-REFUSED >> "${out}"`,
      `git worktree list > /dev/null 2>> "${out}"`,
      'exit 0',
    ].join('\n');
    fs.writeFileSync(path.join(git, 'hooks', 'pre-commit'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    ticket('AP-1', { waiting: { kind: 'proof', summary: '' }, track: undefined });
    const before = sh('git rev-parse main', project);
    fs.writeFileSync(path.join(project, 'side.txt'), 'x');
    const t = await actions.approveBeside(bp, 'AP-1');
    const said = fs.readFileSync(out, 'utf8');
    expect(said).toContain('PLANT-REFUSED');
    expect(said).toContain('CONFIG-REFUSED');
    expect(said).toContain('BRANCH-REFUSED');
    expect(fs.existsSync(path.join(git, 'hooks', 'post-merge'))).toBe(false);
    expect(fs.readFileSync(path.join(git, 'config'), 'utf8')).not.toMatch(/\[core\]\n$/);
    expect(sh('git rev-parse --verify -q refs/heads/stolen || echo none', project)).toBe('none');
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git rev-list --count ' + before + '..main', project)).not.toBe('0');
  });

  it('a hook that needs a file the guard hides says which, for engineers only', async () => {
    if (!guarded()) return;
    const hidden = path.join(squadHome(), 'needed.txt');
    fs.writeFileSync(hidden, 'x');
    huskyStyle(`cat "${hidden}" || exit 1`);
    ticket('AP-1');
    const t = await auto.acceptByItselfBeside(bp, 'AP-1');
    expect(t.stuck?.kind).toBe('hook');
    expect(t.stuck?.question).not.toContain('needed.txt');
    expect(t.stuck?.detail).toContain(`squad-kit's guard blocked ${hidden}`);
  });

  const NO_DOCKER = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

  it('a check that tries Docker stops with one plain sentence that says so, not a raw error', async () => {
    if (!guarded()) return;
    ticket('AP-1', { stage: 'implement' });
    writeMeta(bp, { ...readMeta(bp), commands: { test: `echo "${NO_DOCKER}"; exit 1` } });
    await (new LiveSquad(bp) as unknown as { step(id: string, phase: string): Promise<void> }).step('AP-1', 'test');
    const t = readTicket(bp, 'AP-1')!;
    expect(t.stuck?.kind).toBe('guard');
    expect(t.stuck?.question).toBe(GUARD_BLOCKED_DOCKER);
    expect(t.status).toBe('Stopped: Docker was blocked');
    expect(t.waiting?.summary).toContain('Docker');
    expect(t.stuck?.options.map((o) => o.do)).toEqual(['retry', 'plan']);
    expect(t.stuck?.detail).toContain('Docker is not open');
    expect(t.stuck?.detail).toContain('/var/run/docker.sock');
    expect(t.activity.some((a) => a.text.includes('tried to use Docker'))).toBe(true);
  });

  it('a setup that tries Docker says so too, not a raw error', async () => {
    if (!guarded()) return;
    writeMeta(bp, { ...readMeta(bp), commands: { setup: `echo "${NO_DOCKER}"; exit 1` } });
    const t0 = actions.createTicket(bp, { title: 'Needs setup', track: 'express' });
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'implement';
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    });
    const err = await (new LiveSquad(bp) as unknown as { workspace(id: string): Promise<unknown> }).workspace(t0.id).catch((e: unknown) => e);
    expect((err as Error).message).toBe(GUARD_BLOCKED_DOCKER);
  });

  it('a hook that says no while a merge is being finished: Try again runs it again, as it never said yes', async () => {
    const dir = ticket('AP-1', { waiting: { kind: 'proof', summary: '' }, track: undefined });
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm mine', dir);
    fs.writeFileSync(path.join(project, 'theirs.txt'), 'theirs\n');
    sh('git add theirs.txt && git -c user.name=t -c user.email=t@t commit -qm theirs', project);
    sh('git merge --no-commit --no-ff main', dir);
    const runs = path.join(tmp, 'runs');
    fs.mkdirSync(path.join(project, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho run >> "${runs}"\nexit 1\n`, { mode: 0o755 });
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    expect(readTicket(bp, 'AP-1')!.hookOwed).toBe(true);
    const first = fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length;
    updateTicket(bp, 'AP-1', (x) => {
      x.waiting = { kind: 'proof', summary: '' };
      delete x.stuck;
    });
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    expect(fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(first);
    expect(readTicket(bp, 'AP-1')!.mergedAt).toBeUndefined();
  });

  it('a hook that tries Docker gets the usual hook card, with the same words for engineers', async () => {
    if (!guarded()) return;
    huskyStyle(`echo "${NO_DOCKER}"; exit 1`);
    ticket('AP-1');
    const t = await auto.acceptByItselfBeside(bp, 'AP-1');
    expect(t.stuck?.kind).toBe('hook');
    expect(t.stuck?.detail).toContain('Docker is not open');
  });

  it("a person's signed commits stay signed: the signature comes after the hooks, outside the guard", async () => {
    if (!guarded()) return;
    const gpg = path.join(tmp, 'fake-gpg');
    fs.writeFileSync(gpg, `#!/bin/sh\ncat > /dev/null\nprintf '[GNUPG:] SIG_CREATED ' >&2\necho "-----BEGIN PGP SIGNATURE-----"\necho x\necho "-----END PGP SIGNATURE-----"\n`, { mode: 0o755 });
    sh(`git config commit.gpgsign true && git config gpg.program "${gpg}"`, project);
    fs.mkdirSync(path.join(project, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > "${tmp}/ran"\n`, { mode: 0o755 });
    const dir = ticket('AP-1', { waiting: { kind: 'proof', summary: '' }, track: undefined });
    await actions.approveBeside(bp, 'AP-1');
    expect(fs.existsSync(path.join(tmp, 'ran'))).toBe(true);
    expect(sh('git cat-file commit squad/ap-1', project)).toContain('gpgsig');
    void dir;
  });

  it('the guard keeps the shape on both systems: all of git\'s folder read only, and only the throwaway one opened', () => {
    const common = path.join(tmp, 'repo', '.git');
    const own = path.join(common, 'worktrees', 'ap-1');
    const home = path.join(tmp, 'home');
    const gitDir = path.join(squadHome(), 'hook-git', 'ap-1-abc', 'git-xyz');
    const spec = commitGuard(buildGuard({ cwd: path.join(tmp, 'copy'), root: path.join(tmp, 'repo'), home, platform: 'darwin' }), { common, own, gitDir });
    expect(spec.noWrite).toEqual(expect.arrayContaining([common, own]));
    const text = profileText(spec);
    const deny = text.lastIndexOf(`(deny file-write* (subpath "${common}"))`);
    expect(deny).toBeGreaterThan(-1);
    expect(text.lastIndexOf(`(deny file-write* (subpath "${own}"))`)).toBeGreaterThan(-1);
    // squad-kit's folder stays hidden, and the throwaway folder comes back, to read and to write, after every deny.
    expect(text.indexOf(`(deny file-read* (subpath "${squadHome()}"))`)).toBeGreaterThan(-1);
    expect(text.lastIndexOf(`(allow file-read* (subpath "${gitDir}"))`)).toBeGreaterThan(text.indexOf(`(deny file-read* (subpath "${squadHome()}"))`));
    expect(text.lastIndexOf(`(allow file-write* (subpath "${gitDir}"))`)).toBeGreaterThan(deny);
    // Nothing of git's folder comes back. A hook's write there has no way in the profile.
    for (const shut of ['objects', 'refs', 'refs/heads', 'refs/stash', 'refs/stash.lock', 'logs', 'packed-refs.lock', 'config', 'hooks', 'worktrees']) {
      expect(text).not.toContain(`(allow file-write* (subpath "${path.join(common, shut)}"))`);
      expect(text).not.toContain(`(allow file-write* (literal "${path.join(common, shut)}"))`);
    }
    expect(text).not.toContain(`(allow file-write* (subpath "${own}"))`);
    // Later mounts win in bubblewrap: git's folder read only, the throwaway folder last, and no mount of git's folder after that.
    const args = bubblewrapArgs(spec, 'x');
    const at = (flag: string, place: string) => args.findIndex((a, i) => a === place && args[i - 1] === flag);
    const ro = at('--ro-bind-try', common);
    expect(ro).toBeGreaterThan(-1);
    expect(at('--ro-bind-try', own)).toBeGreaterThan(-1);
    const hidden = fs.realpathSync(squadHome());
    expect(at('--tmpfs', hidden)).toBeGreaterThan(-1);
    const open = at('--bind', gitDir);
    expect(open).toBeGreaterThan(at('--tmpfs', hidden));
    expect(open).toBeGreaterThan(ro);
    expect(args.some((a, i) => a.startsWith(common) && /^--bind/.test(args[i - 1] ?? ''))).toBe(false);
    expect(args.slice(-3)).toEqual(['/bin/sh', '-c', 'x']);
  });
});

describe('a hook runner in a folder git ignores', () => {
  function husky9(body: string) {
    fs.mkdirSync(path.join(project, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(project, '.husky', 'pre-commit'), `${body}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(project, '.husky', '_', '.gitignore'), '*');
    // What the hook manager's generated runner does: it starts the project's own script of that name.
    fs.writeFileSync(path.join(project, '.husky', '_', 'h'), '#!/bin/sh\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ ! -f "$s" ] && exit 0\nsh -e "$s"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(project, '.husky', '_', 'pre-commit'), '#!/bin/sh\n. "$(dirname "$0")/h"\n', { mode: 0o755 });
    sh('git add .husky && git -c user.name=t -c user.email=t@t commit -qm hook', project);
    sh('git config core.hooksPath .husky/_', project);
  }

  it('a new copy has none, and without it git would skip every hook without a word', async () => {
    husky9('echo "lint says no"; exit 1');
    const dir = ticket('AP-1');
    expect(fs.existsSync(path.join(dir, '.husky', '_', 'h'))).toBe(false);
    const t = await auto.acceptByItselfBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeUndefined();
    expect(t.stuck?.kind).toBe('hook');
    expect(t.stuck?.detail).toContain('lint says no');
  });

  it("a release's own commit has no packages to run it with, so no red line on every release", async () => {
    husky9('exit 0');
    fs.writeFileSync(path.join(project, 'CHANGELOG.md'), '# Changelog\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit --no-verify -qm log', project);
    ticket('AP-1', { waiting: { kind: 'proof', summary: '' }, track: undefined });
    const t = await actions.approveBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    // A fresh copy of the base, with no packages: the project's check would say no there, whatever is in it.
    fs.writeFileSync(path.join(project, '.husky', 'pre-commit'), 'echo "lint-staged: command not found"; exit 127\n', { mode: 0o755 });
    sh('git add -A && git -c user.name=t -c user.email=t@t commit --no-verify -qm refuse', project);
    const r = await actions.releaseVersion(bp, t.release!);
    expect(r.status).toBe('released');
    expect(readRelease(bp, r.version)!.log!.some((l) => l.text.includes('own check'))).toBe(false);
  });

  it('comes from the person\'s checkout, over whatever a step left in the copy', () => {
    husky9('exit 0');
    const dir = ticket('AP-1');
    fs.mkdirSync(path.join(dir, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.husky', '_', 'h'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    bringHookRunner(dir);
    expect(fs.readFileSync(path.join(dir, '.husky', '_', 'h'), 'utf8')).toContain('basename');
    expect(commitHooks(dir)).toEqual(['pre-commit']);
    expect(sh('git status --porcelain -- .husky', dir)).toBe('');
  });
});

describe('no agent changes the check', () => {
  type Squad = { runBuilder(id: string, prompt: string, resume: boolean, step?: string): Promise<void> };

  it('a Builder step that rewrites the hooks and their settings gets them put back, and says so', async () => {
    huskyStyle('exit 1');
    fs.writeFileSync(path.join(project, '.lintstagedrc.json'), '{"*.ts":"eslint"}\n');
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', commitlint: { extends: ['x'] } }, null, 2) + '\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit --no-verify -qm settings', project);
    const dir = ticket('AP-1', { track: undefined, stage: 'implement', sessions: { build: 's' } });
    work = (cwd) => {
      fs.writeFileSync(path.join(cwd, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n');
      fs.writeFileSync(path.join(cwd, '.husky', 'pre-push'), '#!/bin/sh\nexit 0\n');
      fs.writeFileSync(path.join(cwd, '.lintstagedrc.json'), '{}\n');
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ ...pkg, version: '2.0.0', commitlint: {}, 'lint-staged': { '*': 'true' } }, null, 2) + '\n');
      fs.writeFileSync(path.join(cwd, 'real.txt'), 'the work\n');
    };
    await (new LiveSquad(bp) as unknown as Squad).runBuilder('AP-1', 'do it', true, 'build');
    expect(fs.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8')).toContain('exit 1');
    expect(sh('git show HEAD:.husky/pre-commit', dir)).toBe(fs.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8').trim());
    expect(fs.existsSync(path.join(dir, '.husky', 'pre-push'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.lintstagedrc.json'), 'utf8')).toBe('{"*.ts":"eslint"}\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg.commitlint).toEqual({ extends: ['x'] });
    expect(pkg['lint-staged']).toBeUndefined();
    // The rest of package.json is the Builder's work.
    expect(pkg.version).toBe('2.0.0');
    expect(fs.existsSync(path.join(dir, 'real.txt'))).toBe(true);
    const line = readTicket(bp, 'AP-1')!.activity.map((a) => a.text).find((a) => a.includes('own check'))!;
    expect(line).toContain("The Builder changed the project's own check");
    expect(line).toContain('Changing that check stays with you or an engineer');
    expect(line).toContain('.husky/pre-commit');
  });

  it('the folder git really runs hooks from counts, wherever the project keeps it', async () => {
    sh('git config core.hooksPath tools/git-hooks', project);
    fs.mkdirSync(path.join(project, 'tools', 'git-hooks'), { recursive: true });
    fs.writeFileSync(path.join(project, 'tools', 'git-hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    sh('git add -A && git -c user.name=t -c user.email=t@t commit --no-verify -qm hooks', project);
    const dir = ticket('AP-1');
    expect(hookFiles(dir)).toContain('/tools/git-hooks/pre-commit');
    const lane = await watchLane(dir, hookFiles(dir));
    fs.writeFileSync(path.join(dir, 'tools', 'git-hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    expect((await checkLane(lane)).restored).toEqual(['tools/git-hooks/pre-commit']);
    expect(fs.readFileSync(path.join(dir, 'tools', 'git-hooks', 'pre-commit'), 'utf8')).toContain('exit 1');
  });

  it('knows a hook file from any other, and a person\'s own fix in the copy stands', async () => {
    expect(isHookFile('.husky/pre-commit')).toBe(true);
    expect(isHookFile('packages/web/.husky/pre-commit')).toBe(true);
    expect(isHookFile('commitlint.config.cjs')).toBe(true);
    expect(isHookFile('package.json (lint-staged)')).toBe(true);
    expect(isHookFile('src/husky.ts')).toBe(false);
    expect(HOOK_FILES).toContain('.pre-commit-config.yaml');
    huskyStyle('exit 1');
    const dir = ticket('AP-1');
    // Fix it yourself, before the next step: that step starts from the person's fix.
    fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), '#!/bin/sh\necho fixed\n');
    const lane = await watchLane(dir, hookFiles(dir));
    expect((await checkLane(lane)).restored).toEqual([]);
    expect(fs.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8')).toContain('fixed');
  });

  it('the checks run the Builder\'s code: what they change in the hooks goes back too', async () => {
    huskyStyle('exit 1');
    const dir = ticket('AP-1', { track: undefined, stage: 'test' });
    writeMeta(bp, { ...readMeta(bp), commands: { test: `printf '#!/bin/sh\\nexit 0\\n' > .husky/pre-commit` } });
    await (new LiveSquad(bp) as unknown as { checks(id: string): Promise<void> }).checks('AP-1');
    expect(fs.readFileSync(path.join(dir, '.husky', 'pre-commit'), 'utf8')).toContain('exit 1');
    expect(readTicket(bp, 'AP-1')!.activity.map((a) => a.text).join('\n')).toContain("The project's checks changed the check that runs on every save (.husky/pre-commit); squad-kit put it back");
  });
});

describe('Stop while a hook runs', () => {
  const tick = (s: unknown) => (s as { tick(): void }).tick();
  const settle = async (s: unknown) => {
    const running = (s as { running: Set<string> }).running;
    for (let i = 0; i < 200 && running.size; i += 1) await new Promise((r) => setTimeout(r, 50));
  };
  async function until(check: () => boolean) {
    for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(check()).toBe(true);
  }

  function slowHook() {
    fs.mkdirSync(path.join(project, '.git', 'hooks'), { recursive: true });
    // It says it started, then runs far longer than this test may: only a Stop can end it in time.
    fs.writeFileSync(path.join(project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho $$ > "${tmp}/started"\nsleep 120\necho finished > "${tmp}/finished"\n`, { mode: 0o755 });
  }

  it('ends the hook at once and never merges; Carry on goes on from there', async () => {
    slowHook();
    ticket('AP-3', { live: true, squad: { phase: 'accept', nextAt: new Date(Date.now() - 1000).toISOString() } });
    const squad = new LiveSquad(bp);
    tick(squad);
    await until(() => fs.existsSync(path.join(tmp, 'started')));
    actions.stopTicket(bp, 'AP-3');
    tick(squad);
    await settle(squad);
    tick(squad);
    const t = readTicket(bp, 'AP-3')!;
    // Ended by the Stop: it never got to the line after its long sleep.
    expect(fs.existsSync(path.join(tmp, 'finished'))).toBe(false);
    expect(t.mergedAt).toBeUndefined();
    expect(t.stage).not.toBe('release');
    expect(sh('git show main:limit.txt', project)).toBe('limit = 2');
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.options[0]?.name).toBe('Carry on');
    expect(t.stuck?.kind).not.toBe('hook');
    expect(t.retryPhase).toBe('accept');
  });

  it('a Stop that came just after the hook passed still never merges', async () => {
    fs.mkdirSync(path.join(project, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(project, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    ticket('AP-4');
    updateTicket(bp, 'AP-4', (x) => (x.stopRequested = true));
    const t = await auto.acceptByItselfBeside(bp, 'AP-4');
    expect(t.mergedAt).toBeUndefined();
    expect(sh('git show main:limit.txt', project)).toBe('limit = 2');
  });

  it('a delete that came while it ran never merges either', async () => {
    // It runs until the test lets it end, once the delete has come.
    fs.mkdirSync(path.join(project, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho x > "${tmp}/started"\nwhile [ ! -e "${tmp}/go" ]; do sleep 0.05; done\nexit 0\n`, { mode: 0o755 });
    ticket('AP-5');
    const going = auto.acceptByItselfBeside(bp, 'AP-5');
    await until(() => fs.existsSync(path.join(tmp, 'started')));
    updateTicket(bp, 'AP-5', (x) => (x.deleting = { by: 'Momen', at: new Date().toISOString(), scope: 'here' } as never));
    fs.writeFileSync(path.join(tmp, 'go'), '');
    const t = await going;
    expect(t.mergedAt).toBeUndefined();
    expect(sh('git show main:limit.txt', project)).toBe('limit = 2');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * How the engine runs git, with real git and real hooks. One place starts git, with hooks and every program a repo can
 * name turned off; exactly one path runs the project's hooks, in their guard. What a hook or a check does there stays
 * there: it reaches no real branch and no setting, and nothing it planted ever runs outside the guard.
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

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const auto = await import('../src/board/auto.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { CommitStopped, HookRefused, changedFiles, commitAll, commitChecked, commitWithoutHooks, conventionalWords, git, netGitLater, settleCopy, stageAll } = await import('../src/engine/git.js');
const { addWorktree } = await import('./support/copy.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { guardSupport, guardBlockedPath, spawnProject, ticketGuard } = await import('../src/engine/project-guard.js');
const { runCommand } = await import('../src/engine/checks.js');
const { sandboxAsk } = await import('../src/engine/sandbox.js');
const { claudeSandbox } = await import('../src/modules/claude/sandbox.js');
const { claudeRunOptions } = await import('../src/modules/claude/index.js');
const { hookFiles } = await import('../src/engine/hook-files.js');
const { checkLane, watchLane } = await import('../src/engine/lane.js');
const { squadHome } = await import('../src/core/home.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir: string, words: string) => sh(`git add -A && git -c core.hooksPath=/dev/null commit -qm "${words}"`, dir);
// Bubblewrap opens the whole temp folder again, which holds this test's fake squad-kit folder: only a Mac can show it here.
const guarded = () => process.platform === 'darwin' && guardSupport().on;
const guardOf = (dir: string, id = 'AP-1') => ticketGuard(bp, { cwd: dir, id });
const exists = (file: string) => fs.existsSync(file);

function script(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
const hook = (name: string, body: string) => script(path.join(project, '.git', 'hooks', name), body);

function newRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git init -q -b main', dir);
  fs.writeFileSync(path.join(dir, 'limit.txt'), 'limit = 2\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  commit(dir, 'start');
}

function setup(dir: string) {
  project = dir;
  setupProject(dir);
  bp = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'App').bp;
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false }, runner: 'direct', commands: {}, git: { base: 'main', remote: '' } });
}

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
    waiting: { kind: 'proof', summary: '' },
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    proof: [],
    ...extra,
  } as never);
  return wt.dir;
}

function theToken(): string {
  const file = path.join(squadHome(), 'app.json');
  fs.writeFileSync(file, '{"token":"THE BOARD TOKEN"}');
  return file;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 800 && !check(); i += 1) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
}

beforeEach(() => {
  work = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-gs-')));
  const dir = path.join(tmp, 'app');
  newRepo(dir);
  setup(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('finding 1: nothing a hook planted runs outside its guard', () => {
  it('a script the commit hook calls plants a pre-push hook; the push does not run it', async () => {
    const secret = theToken();
    const remote = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main "${remote}"`, tmp);
    sh(`git remote add origin "${remote}"`, project);
    script(path.join(project, '.githooks', 'pre-commit'), 'sh scripts/lint.sh');
    script(path.join(project, 'scripts', 'lint.sh'), 'exit 0');
    commit(project, 'hooks');
    sh('git config core.hooksPath .githooks', project);
    sh('git -c core.hooksPath=/dev/null push -q origin main', project);
    const dir = ticket('AP-1');
    const leak = path.join(tmp, 'leak');
    // The Builder's change: lint.sh is the project's own code.
    fs.writeFileSync(path.join(dir, 'scripts', 'lint.sh'), `#!/bin/sh\nprintf '#!/bin/sh\\ncat "${secret}" > "${leak}"\\n' > .githooks/pre-push\nchmod +x .githooks/pre-push\nexit 0\n`);
    stageAll(dir);
    await commitChecked(dir, 'Work', 'feat: work', 60_000, guardSupport().on ? { guard: guardOf(dir) } : {});
    // What it planted in the copy is not the check, so it does not stay; and were one there, the push would still not run it.
    expect(exists(path.join(dir, '.githooks', 'pre-push'))).toBe(false);
    script(path.join(dir, '.githooks', 'pre-push'), `cat "${secret}" > "${leak}"`);
    await netGitLater(dir, ['push', 'origin', 'squad/ap-1:refs/heads/squad/ap-1']);
    expect(exists(leak)).toBe(false);
    expect(sh('git rev-parse squad/ap-1', remote)).toBe(sh('git rev-parse squad/ap-1', project));
  });

  it('no engine git runs a hook: commit, merge, a new copy', () => {
    const ran = path.join(tmp, 'ran');
    for (const name of ['prepare-commit-msg', 'post-commit', 'pre-commit', 'commit-msg', 'post-merge', 'post-checkout', 'pre-merge-commit', 'reference-transaction']) hook(name, `echo ${name} >> "${ran}"`);
    const dir = addWorktree(project, 'AP-1', 'main').dir;
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
    stageAll(dir);
    commitWithoutHooks(dir, 'Work');
    git(dir, ['merge', '--ff-only', 'main']);
    git(project, ['merge', '--no-ff', '-m', 'in', 'squad/ap-1']);
    expect(exists(ran) ? fs.readFileSync(ran, 'utf8') : '').toBe('');
  });

  it('only the engine\'s one place starts git: a new spawn of it elsewhere fails this test', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name);
        if (e.isDirectory()) walk(file);
        else if (e.name.endsWith('.ts')) {
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (/\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*'git'/.test(line) && !/gitArgs\(|PROGRAMS_OFF|'--version'|trialArgs/.test(line)) offenders.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
          }
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    // The one runner itself, which gets its arguments from gitArgs.
    expect(offenders.filter((l) => !l.startsWith(path.join('src', 'engine', 'git.ts')) || !l.includes("('git', full"))).toEqual([]);
  });

  it('every way git could stage everything goes through the one that leaves nested repos out', () => {
    for (const file of ['engine/release.ts', 'engine/live.ts', 'engine/lane.ts', 'engine/depends.ts', 'engine/handover.ts', 'engine/git.ts']) {
      const text = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8').replace(/git(Later)?\(dir, \['add', '-A', \.\.\.\(out\.length[^\n]*/g, '');
      expect(text, file).not.toMatch(/\['add', '-A'/);
    }
  });
});

describe('finding 2: a command in the guard cannot repoint git, and git starts nothing a repo names', () => {
  it('a check cannot swap the copy\'s .git for a fake repo', async () => {
    if (!guarded()) return;
    const secret = theToken();
    const dir = ticket('AP-1');
    const was = fs.readFileSync(path.join(dir, '.git'), 'utf8');
    const leak = path.join(tmp, 'leak');
    script(path.join(dir, 'evil.sh'), `cat "${secret}" > "${leak}" 2>&1\nexit 0`);
    const swap = ['git init -q .fake', `printf '[core]\\n\\tfsmonitor = "${dir}/evil.sh"\\n' >> .fake/.git/config`, `printf 'gitdir: ${dir}/.fake/.git\\n' > .git`].join(' && ');
    const r = await runCommand(dir, swap, 30_000, { guard: guardOf(dir) });
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.git'), 'utf8')).toBe(was);
    await changedFiles(dir, sh('git rev-parse main', project));
    expect(exists(leak)).toBe(false);
    // And the engineer's line can say what happened.
    expect(guardBlockedPath(r.output, guardOf(dir))).toBeTruthy();
  });

  it('a hook cannot rewrite where its copy\'s git folder is: commondir, gitdir, config.worktree', async () => {
    if (!guarded()) return;
    const secret = theToken();
    const dir = ticket('AP-1');
    const leak = path.join(tmp, 'leak');
    const evil = path.join(tmp, 'evil-common');
    script(path.join(tmp, 'evil.sh'), `cat "${secret}" > "${leak}" 2>&1\nexit 0`);
    const out = path.join(tmp, 'tries');
    hook('pre-commit', [
      `D="${sh('git rev-parse --absolute-git-dir', dir)}"`,
      `C="${path.join(project, '.git')}"`,
      `cp -R "$C" "${evil}" 2>/dev/null`,
      `printf '[core]\\n\\tfsmonitor = "${tmp}/evil.sh"\\n' >> "${evil}/config"`,
      `printf '${evil}\\n' > "$D/commondir" 2>> "${out}" || echo COMMONDIR-REFUSED >> "${out}"`,
      `printf 'x\\n' > "$D/gitdir" 2>> "${out}" || echo GITDIR-REFUSED >> "${out}"`,
      `printf '[core]\\n' > "$D/config.worktree" 2>> "${out}" || echo WORKTREE-CONFIG-REFUSED >> "${out}"`,
      'exit 0',
    ].join('\n'));
    stageAll(dir);
    await commitChecked(dir, 'Work', 'feat: work', 60_000, { guard: guardOf(dir) });
    const said = fs.readFileSync(out, 'utf8');
    expect(said).toContain('COMMONDIR-REFUSED');
    expect(said).toContain('GITDIR-REFUSED');
    expect(said).toContain('WORKTREE-CONFIG-REFUSED');
    await changedFiles(dir, sh('git rev-parse main', project));
    expect(exists(leak)).toBe(false);
  });

  it('a project command in the person\'s own checkout cannot write in its .git', async () => {
    if (!guarded()) return;
    const out = path.join(tmp, 'tries');
    const r = await runCommand(project, `echo '[core]' >> .git/config 2>> "${out}" || echo CONFIG-REFUSED >> "${out}"; echo x > .git/hooks/pre-commit 2>> "${out}" || echo HOOK-REFUSED >> "${out}"`, 30_000, { guard: guardOf(project) });
    expect(r.ok).toBe(true);
    const said = fs.readFileSync(out, 'utf8');
    expect(said).toContain('CONFIG-REFUSED');
    expect(said).toContain('HOOK-REFUSED');
  });

  it('the file monitor a repo names never starts, on any engine git', async () => {
    const dir = ticket('AP-1');
    const ran = path.join(tmp, 'ran');
    script(path.join(tmp, 'evil.sh'), `echo ran >> "${ran}"\nexit 0`);
    sh(`git config core.fsmonitor "${tmp}/evil.sh"`, project);
    await changedFiles(dir, sh('git rev-parse main', project));
    stageAll(dir);
    git(dir, ['status', '--porcelain']);
    sh('git config --unset core.fsmonitor', project);
    expect(exists(ran)).toBe(false);
  });

  it('a diff program a repo names never starts, and the Changes tab still reads real diffs', () => {
    const dir = ticket('AP-1');
    const ran = path.join(tmp, 'ran');
    script(path.join(tmp, 'evil.sh'), `echo ran >> "${ran}"\nexit 0`);
    sh(`git config diff.external "${tmp}/evil.sh"`, project);
    const diff = git(dir, ['diff', sh('git rev-parse main', project)]);
    sh('git config --unset diff.external', project);
    expect(diff).toContain('+limit = 3');
    expect(exists(ran)).toBe(false);
  });

  it('a nested repo with a program in its own settings: the engine never looks inside it, and it never goes in the commit', async () => {
    const dir = ticket('AP-1');
    const ran = path.join(tmp, 'ran');
    script(path.join(tmp, 'evil.sh'), `echo ran >> "${ran}"\ncat`);
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, '.gitattributes'), '* filter=x\n');
    fs.writeFileSync(path.join(sub, 'f.txt'), 'one\n');
    sh(`git init -q && git config filter.x.clean "${tmp}/evil.sh" && git add -A && git commit -qm x`, sub);
    fs.rmSync(ran, { force: true });
    // It is in the ticket's copy, as a hook or a Builder could leave it, and changed since its own last commit.
    fs.writeFileSync(path.join(sub, 'f.txt'), 'two\n');
    stageAll(dir);
    expect(sh('git ls-files --stage', dir)).not.toContain('160000');
    git(dir, ['status', '--porcelain']);
    await changedFiles(dir, sh('git rev-parse main', project));
    const saved = await commitAll(dir, 'Work', 'chore: work');
    expect(saved.commit).toBeTruthy();
    expect(sh('git show --stat --format= HEAD', dir)).not.toContain('sub');
    // Already in the index, as a hook could stage it: still nothing runs.
    sh('git add sub', dir);
    fs.writeFileSync(path.join(sub, 'f.txt'), 'three\n');
    git(dir, ['status', '--porcelain']);
    await changedFiles(dir, sh('git rev-parse main', project));
    stageAll(dir);
    expect(exists(ran)).toBe(false);
  });

  it('a Builder step that rewrites the .git link gets it put back first, and stops', async () => {
    const dir = ticket('AP-1', { stage: 'implement', sessions: { build: 's' } });
    const was = fs.readFileSync(path.join(dir, '.git'), 'utf8');
    work = (cwd) => fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${tmp}/fake\n`);
    await expect((new LiveSquad(bp) as unknown as { runBuilder(id: string, prompt: string, resume: boolean, step?: string): Promise<void> }).runBuilder('AP-1', 'do it', true, 'build')).rejects.toThrow(/squad-kit stopped it/);
    expect(fs.readFileSync(path.join(dir, '.git'), 'utf8')).toBe(was);
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('squad/ap-1');
  });

  it('an agent\'s sandbox keeps the copy\'s .git and git\'s folder read only as well', () => {
    const dir = ticket('AP-1');
    const ask = sandboxAsk({ cwd: dir, root: project, read: [], proof: path.join(tmp, 'proof'), secrets: [] });
    expect(ask.noWrite).toContain(path.join(dir, '.git'));
    expect(ask.noWrite).toContain(path.join(project, '.git'));
    expect(claudeSandbox(ask).filesystem.denyWrite).toEqual(ask.noWrite);
  });
});

describe('finding 3: a hook refusal always has a way out', () => {
  const WAYS = ['retry', 'yourself', 'save-again', 'skip-hooks', 'plan'];

  it.each(['cannot lock ref for the report', 'unable to create report, 3 rules failed', 'index.lock is what the linter says', 'gpg failed, says the hook', 'nothing to commit, says the hook'])('Looks right, a hook that says "%s": the hook card, not "press again"', async (words) => {
    hook('pre-commit', `echo "${words}"\nexit 1`);
    ticket('AP-1');
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.stuck?.kind).toBe('hook');
    expect(t.stuck?.options.map((o) => o.do)).toEqual(WAYS);
    expect(t.stuck?.detail).toContain(words);
  });

  it('Builds by itself, the same words: the hook card, with the way past it', async () => {
    hook('pre-commit', 'echo "error: cannot lock ref for the report"\nexit 1');
    ticket('AP-1', { track: 'auto', waiting: null });
    const t = await auto.acceptByItselfBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeUndefined();
    expect(t.stuck?.kind).toBe('hook');
    expect(t.stuck?.options.map((o) => o.do)).toContain('skip-hooks');
  });

  it('a hook that fetches, which the guard stops writing: the hook card, and Save without this check goes through', async () => {
    if (!guarded()) return;
    const remote = path.join(tmp, 'r.git');
    sh(`git init -q --bare -b main "${remote}"`, tmp);
    sh(`git remote add origin "${remote}" && git -c core.hooksPath=/dev/null push -q origin main`, project);
    const mate = path.join(tmp, 'mate');
    sh(`git clone -q "${remote}" "${mate}"`, tmp);
    fs.writeFileSync(path.join(mate, 'm.txt'), 'm');
    commit(mate, 'm');
    sh('git -c core.hooksPath=/dev/null push -q origin main', mate);
    hook('pre-commit', 'git fetch origin 2>&1 || { echo "cannot check the base"; exit 1; }\nexit 0');
    ticket('AP-1');
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    let t = readTicket(bp, 'AP-1')!;
    expect(t.stuck?.kind).toBe('hook');
    // Its folder has no remote, as it has none of the repo's settings. Past it, the real one is read only.
    expect(t.stuck?.detail).toContain('cannot check the base');
    expect(sh('git for-each-ref refs/remotes', project)).toBe(sh('git rev-parse main', project) + ' commit\trefs/remotes/origin/main');
    t = actions.decideStuck(bp, 'AP-1', t.stuck!.options.findIndex((o) => o.do === 'skip-hooks'), { reason: 'the check needs the network' });
    expect(t.mergedAt).toBeTruthy();
  });

  it('git\'s own trouble is seen directly: a lock that is really there is no hook card; a dead one is cleared', async () => {
    const dir = ticket('AP-1');
    hook('pre-commit', 'exit 0');
    const lock = path.join(sh('git rev-parse --absolute-git-dir', dir), 'index.lock');
    fs.writeFileSync(lock, '');
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toThrow(/could not save the change/);
    expect(readTicket(bp, 'AP-1')!.stuck).toBeUndefined();
    expect(readTicket(bp, 'AP-1')!.waiting?.kind).toBe('proof');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    expect((await actions.approveBeside(bp, 'AP-1')).mergedAt).toBeTruthy();
  });
});

describe('finding 4: only the real hooks in a repo\'s hook folder are the check', () => {
  function withHooksIn(folder: string) {
    script(path.join(project, folder, 'pre-commit'), 'exit 0');
    fs.mkdirSync(path.join(project, 'src', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'hooks', 'useAuth.ts'), 'old\n');
    fs.writeFileSync(path.join(project, folder, 'deploy.sh'), 'old\n');
    commit(project, 'code');
    sh(`git config core.hooksPath ${folder}`, project);
    return addWorktree(project, 'AP-1', 'main').dir;
  }

  it.each(['hooks', 'scripts', 'tools/git-hooks'])('core.hooksPath=%s keeps the Builder\'s work, and still guards the hook', async (folder) => {
    const dir = withHooksIn(folder);
    const lane = await watchLane(dir, hookFiles(dir));
    fs.writeFileSync(path.join(dir, 'src', 'hooks', 'useAuth.ts'), 'NEW WORK\n');
    fs.writeFileSync(path.join(dir, 'src', 'hooks', 'useBooking.ts'), 'NEW FILE\n');
    fs.writeFileSync(path.join(dir, folder, 'deploy.sh'), 'NEW WORK\n');
    fs.writeFileSync(path.join(dir, folder, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    fs.writeFileSync(path.join(dir, folder, 'pre-push'), '#!/bin/sh\nexit 1\n');
    const c = await checkLane(lane);
    expect(c.restored).toEqual([`${folder}/pre-commit`, `${folder}/pre-push`]);
    expect(fs.readFileSync(path.join(dir, 'src', 'hooks', 'useAuth.ts'), 'utf8')).toBe('NEW WORK\n');
    expect(exists(path.join(dir, 'src', 'hooks', 'useBooking.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, folder, 'deploy.sh'), 'utf8')).toBe('NEW WORK\n');
    expect(fs.readFileSync(path.join(dir, folder, 'pre-commit'), 'utf8')).toContain('exit 0');
  });

  it('a hook put back can still run, and a hook only made unable to run goes back too: git would skip it without a word', async () => {
    const dir = withHooksIn('hooks');
    const ran = path.join(tmp, 'ran');
    const hookFile = path.join(dir, 'hooks', 'pre-commit');
    fs.writeFileSync(hookFile, `#!/bin/sh\necho ran >> "${ran}"\nexit 0\n`, { mode: 0o755 });
    let lane = await watchLane(dir, hookFiles(dir));
    fs.writeFileSync(hookFile, '#!/bin/sh\nexit 0\n');
    expect((await checkLane(lane)).restored).toEqual(['hooks/pre-commit']);
    expect(fs.statSync(hookFile).mode & 0o111).not.toBe(0);
    lane = await watchLane(dir, hookFiles(dir));
    fs.chmodSync(hookFile, 0o644);
    expect((await checkLane(lane)).restored).toEqual(['hooks/pre-commit']);
    expect(fs.statSync(hookFile).mode & 0o111).not.toBe(0);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
    stageAll(dir);
    await commitChecked(dir, 'Work', 'feat: work', 60_000);
    expect(exists(ran)).toBe(true);
  });

  it('an agent\'s own file tools are told the same, and never get the .git link', () => {
    const { disallowedTools } = claudeRunOptions({ cwd: tmp, prompt: 'x', permissions: ['edit'], protectedFiles: ['/hooks/pre-commit', '.git', '.husky/'] } as never);
    expect(disallowedTools).toContain('Edit(**/hooks/pre-commit)');
    expect(disallowedTools).toContain('Edit(**/.git)');
    expect(disallowedTools).toContain('Edit(**/.husky/**)');
    expect((disallowedTools ?? []).join(' ')).not.toContain('//hooks');
  });

  it('core.hooksPath=. is no folder of hooks: every change stays, and ignored files are not listed', async () => {
    const dir = addWorktree(project, 'AP-1', 'main').dir;
    sh('git config core.hooksPath .', project);
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'x');
    const lane = await watchLane(dir, hookFiles(dir));
    expect([...lane.kept.keys()]).toEqual([]);
    fs.writeFileSync(path.join(dir, 'limit.txt'), 'NEW WORK\n');
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'y');
    expect((await checkLane(lane)).restored).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'limit.txt'), 'utf8')).toBe('NEW WORK\n');
    expect(fs.readFileSync(path.join(dir, 'node_modules', 'x.js'), 'utf8')).toBe('y');
  });

  it('a story that changes package.json scripts or dependencies keeps them: only the hook keys go back', async () => {
    fs.writeFileSync(path.join(project, 'package.json'), `${JSON.stringify({ name: 'a', scripts: { test: 'x' }, 'lint-staged': { '*.js': 'eslint' }, dependencies: { a: '1' } }, null, 4)}\n`);
    commit(project, 'pkg');
    const dir = addWorktree(project, 'AP-1', 'main').dir;
    const lane = await watchLane(dir, hookFiles(dir));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ ...pkg, scripts: { test: 'vitest' }, 'lint-staged': {}, dependencies: { a: '1', zod: '3' } }, null, 4)}\n`);
    expect((await checkLane(lane)).restored).toEqual(['package.json (lint-staged)']);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(after.scripts.test).toBe('vitest');
    expect(after.dependencies.zod).toBe('3');
    expect(after['lint-staged']).toEqual({ '*.js': 'eslint' });
  });
});

describe('finding 5: hook debt with the copy gone', () => {
  const REFUSES = 'if git diff --cached --name-only | grep -q limit.txt; then echo "lint errors in limit.txt"; exit 1; fi; exit 0';

  async function owed(id: string): Promise<string> {
    hook('pre-commit', REFUSES);
    const dir = ticket(id);
    expect((await commitAll(dir, 'Work so far', 'chore: work so far')).hookSaid).toContain('lint errors');
    updateTicket(bp, id, (x) => (x.hookOwed = true));
    return dir;
  }

  it('the copy is made again from the branch, and the hook sees the whole change: it says no, and nothing merges', async () => {
    const dir = await owed('AP-1');
    sh(`git worktree remove --force "${dir}"`, project);
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.mergedAt).toBeUndefined();
    expect(t.hookOwed).toBe(true);
    expect(t.stuck?.kind).toBe('hook');
    expect(exists(dir)).toBe(true);
    expect(sh('git show main:limit.txt', project)).toBe('limit = 2');
  });

  it('with the hook happy it merges, and nothing is owed', async () => {
    const dir = await owed('AP-1');
    sh(`git worktree remove --force "${dir}"`, project);
    hook('pre-commit', 'exit 0');
    const t = await actions.approveBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(t.hookOwed).toBeUndefined();
    expect(sh('git show main:limit.txt', project)).toBe('limit = 3');
  });

  it('the branch gone too: a card with a way out, never a merge of nothing', async () => {
    const dir = await owed('AP-1');
    sh(`git worktree remove --force "${dir}" && git branch -D squad/ap-1`, project);
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.mergedAt).toBeUndefined();
    expect(t.stuck?.kind).toBe('hook');
    expect(t.stuck?.options.map((o) => o.do)).toContain('skip-hooks');
  });
});

describe('finding 6: the commit guard opens nothing of the real git folder', () => {
  it('a hook reaches no real branch, no other copy, no replacement, no other store of objects', async () => {
    if (!guarded()) return;
    // git as a tool could reach it, past the throwaway folder: it finds the real one from the copy.
    const real = 'env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_EXEC_PATH "$(git --exec-path)/git"';
    const a = ticket('AP-1');
    const b = ticket('AP-2');
    fs.writeFileSync(path.join(b, 'b.txt'), 'b work\n');
    commit(b, 'work of B');
    const before = sh('git rev-parse squad/ap-2', project);
    const mine = sh('git rev-parse squad/ap-1', project);
    const out = path.join(tmp, 'tries');
    const common = path.join(project, '.git');
    hook('pre-commit', [
      `${real} update-ref -d refs/heads/squad/ap-2 2>> "${out}" || echo DELETE-B-REFUSED >> "${out}"`,
      `${real} update-ref refs/heads/squad/ap-2 ${mine} 2>> "${out}" || echo MOVE-B-REFUSED >> "${out}"`,
      `${real} update-ref refs/heads/squad/ap-1 ${mine}~0 2>> "${out}"; echo x > "${common}/refs/heads/squad/ap-1" 2>> "${out}" || echo MOVE-MINE-REFUSED >> "${out}"`,
      `${real} update-ref refs/heads/main ${before} 2>> "${out}" || echo MOVE-MAIN-REFUSED >> "${out}"`,
      `${real} symbolic-ref HEAD refs/heads/main 2>> "${out}" || echo HEAD-REFUSED >> "${out}"`,
      `${real} replace ${mine} ${before} 2>> "${out}" || echo REPLACE-REFUSED >> "${out}"`,
      `echo /elsewhere > "${common}/objects/info/alternates" 2>> "${out}" || echo ALTERNATES-REFUSED >> "${out}"`,
      `${real} update-ref refs/tags/v9 ${mine} 2>> "${out}" || echo TAG-REFUSED >> "${out}"`,
      `echo x > "${common}/packed-refs" 2>> "${out}" || echo PACKED-REFUSED >> "${out}"`,
      `echo x > "${common}/shallow" 2>> "${out}" || echo SHALLOW-REFUSED >> "${out}"`,
      'exit 0',
    ].join('\n'));
    stageAll(a);
    await commitChecked(a, 'Work', 'feat: work', 60_000, { guard: guardOf(a) });
    const said = fs.readFileSync(out, 'utf8');
    for (const word of ['DELETE-B', 'MOVE-B', 'MOVE-MINE', 'MOVE-MAIN', 'HEAD', 'REPLACE', 'ALTERNATES', 'TAG', 'PACKED', 'SHALLOW']) expect(said).toContain(`${word}-REFUSED`);
    expect(sh('git rev-parse squad/ap-2', project)).toBe(before);
    expect(sh('git for-each-ref refs/replace', project)).toBe('');
    expect(exists(path.join(common, 'objects', 'info', 'alternates'))).toBe(false);
    // And its own commit went in.
    expect(sh('git log -1 --format=%s squad/ap-1', project)).toBe('Work');
  });

  it('what lint-staged needs still works in the guard: its backup with git\'s stash, and a formatter staging its fix', async () => {
    const dir = ticket('AP-1');
    hook('pre-commit', [
      'set -e',
      'S=$(git stash create "backup")',
      '[ -n "$S" ] || S=$(git rev-parse HEAD)',
      'git stash store -m "automatic backup" "$S"',
      'echo formatted >> limit.txt',
      'git add limit.txt',
      'git diff --cached --name-only | grep -q limit.txt',
      'git stash drop -q',
    ].join('\n'));
    stageAll(dir);
    await commitChecked(dir, 'Work', 'feat: work', 60_000, guardSupport().on ? { guard: guardOf(dir) } : {});
    expect(sh('git show squad/ap-1:limit.txt', project)).toContain('formatted');
    expect(sh('git stash list', dir)).toBe('');
    expect(sh('git status --porcelain', dir)).toBe('');
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('squad/ap-1');
    expect(sh('git for-each-ref refs/heads/squad/saving', project)).toBe('');
  });
});

describe('finding 7: a hook never holds up the app, and ends with all it started', () => {
  it('saving the work so far runs beside everything else', async () => {
    const dir = ticket('AP-1');
    hook('pre-commit', 'sleep 1.5\nexit 0');
    let beats = 0;
    const t = setInterval(() => (beats += 1), 50);
    await commitAll(dir, 'Work so far', 'chore: work so far');
    clearInterval(t);
    expect(beats).toBeGreaterThan(5);
  });

  it('a Stop ends it there too, with its children, and nothing is saved on the real branch', async () => {
    const dir = ticket('AP-1');
    const tip = sh('git rev-parse squad/ap-1', project);
    hook('pre-commit', `sleep 30 &\necho $! > "${tmp}/pid"\nwait`);
    const stop = new AbortController();
    const saving = commitAll(dir, 'Work so far', 'chore: work so far', { ...(guardSupport().on ? { guard: guardOf(dir) } : {}), signal: stop.signal });
    await until(() => exists(path.join(tmp, 'pid')));
    stop.abort();
    await expect(saving).rejects.toBeInstanceOf(CommitStopped);
    const pid = Number(fs.readFileSync(path.join(tmp, 'pid'), 'utf8'));
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(sh('git rev-parse squad/ap-1', project)).toBe(tip);
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('squad/ap-1');
  });

  it('at its limit, in the guard, the same', async () => {
    const dir = ticket('AP-1');
    stageAll(dir);
    hook('pre-commit', `sleep 30 &\necho $! > "${tmp}/pid"\nwait`);
    await expect(commitChecked(dir, 'm', 'chore: m', 800, guardSupport().on ? { guard: guardOf(dir) } : {})).rejects.toMatchObject({ timedOut: true });
    const pid = Number(fs.readFileSync(path.join(tmp, 'pid'), 'utf8'));
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});

describe('finding 8: a crash while the hooks look at the whole change', () => {
  it('the branch never moved: the next push goes forward, and the next start puts the copy back', async () => {
    const remote = path.join(tmp, 'remote.git');
    sh(`git init -q --bare -b main "${remote}"`, tmp);
    sh(`git remote add origin "${remote}" && git -c core.hooksPath=/dev/null push -q origin main`, project);
    const dir = ticket('AP-1');
    commit(dir, 'work so far 1');
    fs.writeFileSync(path.join(dir, 'two.txt'), 'two\n');
    commit(dir, 'work so far 2');
    sh('git -c core.hooksPath=/dev/null push -q origin squad/ap-1', dir);
    const tip = sh('git rev-parse HEAD', dir);
    const base = sh('git rev-parse main', project);
    hook('pre-commit', `echo $$ > "${tmp}/hook"\nexec sleep 120`);
    const run = path.join(tmp, 'whole.mts');
    fs.writeFileSync(run, [`import { commitChecked } from ${JSON.stringify(path.join(ROOT, 'src/engine/git.ts'))};`, 'await commitChecked(process.argv[2]!, "Whole", "feat: whole", 110000, { from: process.argv[3]! });'].join('\n'));
    const child = spawn(process.execPath, ['--import', 'tsx', run, dir, base], { cwd: ROOT, stdio: 'ignore', env: process.env });
    const ended = new Promise<void>((r) => child.on('exit', () => r()));
    await until(() => exists(path.join(tmp, 'hook')));
    process.kill(child.pid!, 'SIGKILL');
    await ended;
    const hookPid = Number(fs.readFileSync(path.join(tmp, 'hook'), 'utf8'));
    // It writes its number just before it becomes the sleep: on a slow computer, a look can fall in between.
    await until(() => sh(`ps -o command= -p ${hookPid}`, tmp).includes('sleep 120'));
    process.kill(hookPid, 'SIGKILL');
    // The real branch is where it was, whatever the copy's HEAD says.
    expect(sh('git rev-parse squad/ap-1', project)).toBe(tip);
    sh('git -c core.hooksPath=/dev/null push -q origin squad/ap-1', project);
    settleCopy(dir);
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('squad/ap-1');
    expect(sh('git rev-parse HEAD', dir)).toBe(tip);
    expect(sh('git status --porcelain', dir)).toBe('');
    expect(sh('git for-each-ref refs/heads/squad/saving', project)).toBe('');
    // And the work goes on as if nothing happened.
    hook('pre-commit', 'exit 0');
    updateTicket(bp, 'AP-1', (x) => (x.hookOwed = true));
    const t = await actions.approveBeside(bp, 'AP-1');
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git merge-base --is-ancestor ' + tip + ' main && echo yes', project)).toBe('yes');
  });

  it('a board that starts again puts a copy on its stand-in back', async () => {
    const dir = ticket('AP-1');
    const tip = sh('git rev-parse squad/ap-1', project);
    sh(`git update-ref refs/heads/squad/saving/squad/ap-1/now ${tip} && git symbolic-ref HEAD refs/heads/squad/saving/squad/ap-1/now`, dir);
    const stop = new LiveSquad(bp).start(60_000);
    stop();
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('squad/ap-1');
    expect(sh('git for-each-ref refs/heads/squad/saving', project)).toBe('');
  });

  it('a refusal and a Stop on the whole change leave HEAD on the real branch', async () => {
    const dir = ticket('AP-1');
    commit(dir, 'work so far');
    const tip = sh('git rev-parse HEAD', dir);
    const base = sh('git rev-parse main', project);
    hook('pre-commit', 'echo no\nexit 1');
    await expect(commitChecked(dir, 'Whole', 'feat: whole', 60_000, { from: base })).rejects.toBeInstanceOf(HookRefused);
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('squad/ap-1');
    expect(sh('git rev-parse HEAD', dir)).toBe(tip);
    hook('pre-commit', `echo x > "${tmp}/go"\nexec sleep 120`);
    const stop = new AbortController();
    const saving = commitChecked(dir, 'Whole', 'feat: whole', 110_000, { from: base, signal: stop.signal });
    await until(() => exists(path.join(tmp, 'go')));
    expect(sh('git rev-parse squad/ap-1', project)).toBe(tip);
    stop.abort();
    await expect(saving).rejects.toBeInstanceOf(CommitStopped);
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('squad/ap-1');
    expect(sh('git rev-parse HEAD', dir)).toBe(tip);
  });
});

describe('finding 9: a project that is a submodule', () => {
  it('its generated hook runner is found, so the hook runs and says no', async () => {
    const lib = path.join(tmp, 'libsrc');
    newRepo(lib);
    const parent = path.join(tmp, 'super');
    newRepo(parent);
    sh(`git -c protocol.file.allow=always submodule add -q "${lib}" proj`, parent);
    commit(parent, 'add sub');
    const p = path.join(parent, 'proj');
    fs.mkdirSync(path.join(p, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(p, '.husky', '_', '.gitignore'), '*');
    script(path.join(p, '.husky', 'pre-commit'), `echo ran >> "${tmp}/ran"\nexit 1`);
    script(path.join(p, '.husky', '_', 'pre-commit'), 'exec sh "$(dirname "$(dirname "$0")")/pre-commit"');
    commit(p, 'hooks');
    sh('git config core.hooksPath .husky/_', p);
    setup(p);
    const dir = addWorktree(p, 'AP-1', 'main').dir;
    fs.writeFileSync(path.join(dir, 'limit.txt'), 'limit = 3\n');
    stageAll(dir);
    await expect(commitChecked(dir, 'Work', 'feat: work', 60_000, guardSupport().on ? { guard: guardOf(dir) } : {})).rejects.toBeInstanceOf(HookRefused);
    expect(exists(path.join(tmp, 'ran'))).toBe(true);
  });
});

describe('finding 10: a signature that fails', () => {
  it('never leaves an unsigned commit behind, so no press merges one', async () => {
    const gpg = path.join(tmp, 'no-gpg');
    script(gpg, 'exit 1');
    sh(`git config commit.gpgsign true && git config gpg.program "${gpg}"`, project);
    const dir = ticket('AP-1');
    const tip = sh('git rev-parse squad/ap-1', project);
    hook('pre-commit', 'exit 0');
    for (let press = 1; press <= 2; press += 1) {
      await expect(actions.approveBeside(bp, 'AP-1')).rejects.toThrow(/could not save the change/);
      const t = readTicket(bp, 'AP-1')!;
      expect(t.mergedAt).toBeUndefined();
      expect(t.waiting?.kind).toBe('proof');
    }
    expect(sh('git rev-parse squad/ap-1', project)).toBe(tip);
    expect(sh('git show main:limit.txt', project)).toBe('limit = 2');
    // The work is safe, staged.
    expect(sh('git status --porcelain', dir)).toContain('limit.txt');
    // Once it signs, it goes in, signed.
    fs.writeFileSync(gpg, `#!/bin/sh\ncat > /dev/null\nprintf '[GNUPG:] SIG_CREATED ' >&2\necho "-----BEGIN PGP SIGNATURE-----"\necho x\necho "-----END PGP SIGNATURE-----"\n`);
    expect((await actions.approveBeside(bp, 'AP-1')).mergedAt).toBeTruthy();
    expect(sh('git cat-file commit squad/ap-1', project)).toContain('gpgsig');
  });
});

describe('finding 11: a copy with no packages', () => {
  it('a blocked write counts as the guard, in npm\'s words and in git\'s, and a path it may write does not', () => {
    const dir = ticket('AP-1');
    const g = guardOf(dir);
    const npx = '/opt/someone/.npm/_npx/abc';
    expect(guardBlockedPath(`npm error code EPERM\nnpm error syscall mkdir\nnpm error path ${npx}\nnpm error errno EPERM\nnpm error Your cache folder contains root-owned files`, g)).toBe(npx);
    expect(guardBlockedPath(`Error: EPERM: operation not permitted, mkdir '${npx}'`, g)).toBe(npx);
    expect(guardBlockedPath(`Error: EROFS: read-only file system, mkdir '${npx}'`, g)).toBe(npx);
    expect(guardBlockedPath(`error: cannot lock ref 'refs/x': Unable to create '/opt/x/.git/refs/x.lock': Operation not permitted`, g)).toBe('/opt/x/.git/refs/x.lock');
    expect(guardBlockedPath(`touch: ${path.join(g.cwd, 'x')}: Operation not permitted`, g)).toBeNull();
    expect(guardBlockedPath('kill: (123): Operation not permitted', g)).toBeNull();
    expect(guardBlockedPath('AssertionError: expected 1 to equal 2', g)).toBeNull();
  });

  it('the engineer\'s line starts with the guard, not with what npm suggests', async () => {
    if (!guarded()) return;
    const dir = ticket('AP-1');
    const blocked = path.join(project, '.git', 'no-such-folder');
    hook('pre-commit', `mkdir "${blocked}" 2>&1 || { echo "npm error Your cache folder contains root-owned files"; exit 1; }`);
    stageAll(dir);
    const err = (await commitChecked(dir, 'Work', 'feat: work', 60_000, { guard: guardOf(dir) }).catch((e: unknown) => e)) as InstanceType<typeof HookRefused>;
    expect(err).toBeInstanceOf(HookRefused);
    expect(err.said.startsWith(`squad-kit's guard blocked ${blocked}`)).toBe(true);
    expect(exists(blocked)).toBe(false);
  });

  it('npm and npx get a writable cache of the copy\'s own: what npx downloads goes there', async () => {
    if (!guarded()) return;
    const dir = ticket('AP-1');
    const out = path.join(tmp, 'cache');
    const child = spawnProject(`mkdir -p "$npm_config_cache/_npx/abc" && echo ok > "$npm_config_cache/_npx/abc/x" && echo "$npm_config_cache" > "${out}"`, { cwd: dir, guard: guardOf(dir) });
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code).toBe(0);
    const cache = fs.readFileSync(out, 'utf8').trim();
    expect(cache.startsWith(fs.realpathSync(squadHome())) || cache.startsWith(squadHome())).toBe(true);
    expect(exists(path.join(cache, '_npx', 'abc', 'x'))).toBe(true);
  });
});

describe('finding 12: closing the board while a Looks right hook runs', () => {
  it('ends the hook, and nothing is merged after it', async () => {
    const dir = ticket('AP-1');
    hook('pre-commit', `echo x > "${tmp}/started"\nsleep 120\necho y > "${tmp}/finished"`);
    const squad = new LiveSquad(bp);
    const stop = squad.start(60_000);
    const started = Date.now();
    const saving = actions.approveBeside(bp, 'AP-1');
    await until(() => exists(path.join(tmp, 'started')));
    stop();
    await expect(saving).rejects.toBeInstanceOf(CommitStopped);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(exists(path.join(tmp, 'finished'))).toBe(false);
    const t = readTicket(bp, 'AP-1')!;
    expect(t.mergedAt).toBeUndefined();
    expect(t.waiting?.kind).toBe('proof');
    expect(sh('git show main:limit.txt', project)).toBe('limit = 2');
    expect(sh('git rev-parse --abbrev-ref HEAD', dir)).toBe('squad/ap-1');
  });
});

describe('words and false alarms', () => {
  it('an install that makes a hook manager\'s generated folder is no one changing the check', async () => {
    script(path.join(project, '.husky', 'pre-commit'), 'exit 0');
    commit(project, 'hooks');
    sh('git config core.hooksPath .husky', project);
    const dir = addWorktree(project, 'AP-1', 'main').dir;
    const lane = await watchLane(dir, hookFiles(dir));
    fs.mkdirSync(path.join(dir, '.husky', '_'));
    fs.writeFileSync(path.join(dir, '.husky', '_', '.gitignore'), '*');
    script(path.join(dir, '.husky', '_', 'husky.sh'), 'exit 0');
    expect((await checkLane(lane)).restored).toEqual([]);
    expect(exists(path.join(dir, '.husky', '_', 'husky.sh'))).toBe(true);
    // The check itself still goes back.
    const again = await watchLane(dir, hookFiles(dir));
    fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    expect((await checkLane(again)).restored).toEqual(['.husky/pre-commit']);
  });

  it('the card and the ticket use plain words: no commit, no path', async () => {
    hook('pre-commit', 'echo no\nexit 1');
    ticket('AP-1');
    await expect(actions.approveBeside(bp, 'AP-1')).rejects.toBeInstanceOf(actions.HookStopped);
    const t = readTicket(bp, 'AP-1')!;
    for (const words of [t.status, t.waiting!.summary, t.stuck!.question, t.stuck!.options.map((o) => `${o.name} ${o.note}`).join(' ')]) {
      expect(words).not.toMatch(/commit check|commit hook|\/Users|refs\//);
    }
  });
});

describe('what stays as it was', () => {
  it('a path with spaces and Arabic', async () => {
    const dir = path.join(tmp, 'مشروع جديد', 'app');
    newRepo(dir);
    setup(dir);
    hook('pre-commit', `echo ran >> "${tmp}/ran"`);
    const copy = ticket('AP-1');
    stageAll(copy);
    await commitChecked(copy, `It's (AP-1) "quoted"`, 'feat: w', 60_000, guardSupport().on ? { guard: guardOf(copy) } : {});
    expect(exists(path.join(tmp, 'ran'))).toBe(true);
    expect(sh('git log -1 --format=%s', copy)).toBe(`It's (AP-1) "quoted"`);
  });

  it('a project that is a linked worktree', async () => {
    const main = path.join(tmp, 'main');
    newRepo(main);
    const p = path.join(tmp, 'proj');
    sh(`git worktree add -q -b dev "${p}"`, main);
    setup(p);
    writeMeta(bp, { ...readMeta(bp), git: { base: 'dev', remote: '' } });
    script(path.join(main, '.git', 'hooks', 'pre-commit'), `echo ran >> "${tmp}/ran"`);
    const wt = addWorktree(p, 'AP-1', 'dev');
    fs.writeFileSync(path.join(wt.dir, 'limit.txt'), 'limit = 3\n');
    stageAll(wt.dir);
    await commitChecked(wt.dir, 'W (AP-1)', 'feat: w', 60_000, guardSupport().on ? { guard: guardOf(wt.dir) } : {});
    expect(exists(path.join(tmp, 'ran'))).toBe(true);
    expect(sh('git log -1 --format=%s', wt.dir)).toBe('W (AP-1)');
  });

  it('a merge that is not finished goes in with the hooks looking at all of it', async () => {
    const dir = ticket('AP-1');
    commit(dir, 'mine');
    fs.writeFileSync(path.join(project, 'theirs.txt'), 'theirs\n');
    commit(project, 'theirs');
    git(dir, ['merge', '--no-commit', '--no-ff', 'main']);
    hook('pre-commit', `git diff --cached --name-only >> "${tmp}/saw"\nexit 0`);
    await commitChecked(dir, 'Finish', conventionalWords('feat', 'finish'), 60_000, guardSupport().on ? { guard: guardOf(dir) } : {});
    expect(fs.readFileSync(path.join(tmp, 'saw'), 'utf8')).toContain('theirs.txt');
    expect(sh('git rev-parse -q --verify MERGE_HEAD || echo none', dir)).toBe('none');
    expect(sh('git log -1 --format=%s', dir)).toBe('Finish');
    expect(sh('git merge-base --is-ancestor main HEAD && echo yes', dir)).toBe('yes');
  });
});

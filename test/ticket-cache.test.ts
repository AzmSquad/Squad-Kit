import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { SandboxSupport } from '../src/modules/ai-tool/types.js';

/**
 * A ticket's own package cache: the Builder and the Tester download NuGet, Maven, Gradle and Ruby packages into it,
 * never into the person's own caches. It is outside the ticket's copy, only sandboxed steps get it, and it goes when
 * the copy goes: after the release, and on Delete.
 */

const h = vi.hoisted(() => ({
  support: { available: true, why: "Claude Code's sandbox (macOS Seatbelt)" } as SandboxSupport,
  calls: [] as RunOptions[],
}));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    h.calls.push(opts);
    // A build that downloads a package into the cache it was given.
    if (opts.env?.NUGET_PACKAGES) {
      fs.mkdirSync(opts.env.NUGET_PACKAGES, { recursive: true });
      fs.writeFileSync(path.join(opts.env.NUGET_PACKAGES, 'newtonsoft.json.nupkg'), 'pkg');
    }
    return { ok: true, structured: { summary: 'Built it', approved: true, comments: [] }, sessionId: opts.resume ?? opts.sessionId ?? 's-1', text: '' };
  },
}));

vi.mock('../src/modules/claude/sandbox.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/sandbox.js')>()),
  claudeSandboxSupport: () => h.support,
}));

const { boardPaths, readRelease, readTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('../src/engine/git.js');
const actions = await import('../src/board/actions.js');
const { deletePlan, deleteTicket } = await import('../src/engine/delete.js');
const { packageCacheEnv, ticketCacheDir } = await import('../src/engine/sandbox.js');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
type Squad = { runBuilder(id: string, prompt: string, resume: boolean, step?: string): Promise<void>; review(id: string): Promise<void> };

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, cwd);
const squad = () => new LiveSquad(bp) as unknown as Squad;
const cacheOf = (id: string) => ticketCacheDir(bp, id);

beforeEach(() => {
  h.calls.length = 0;
  h.support = { available: true, why: "Claude Code's sandbox (macOS Seatbelt)" };
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cache-')));
  project = path.join(tmp, 'app');
  const remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(project);
  sh(`git init -q --bare -b main ${remote}`, tmp);
  sh(`git init -q -b main && git remote add origin ${remote}`, project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'app', version: '1.4.2' }, null, 2));
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  commit(project, 'start');
  sh('git push -q origin main', project);
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 9,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A ticket being built, with its copy of the code. */
function building(id: string, file: string): string {
  const wt = addWorktree(project, id, 'main');
  fs.writeFileSync(path.join(wt.dir, file), `${file}\n`);
  writeTicket(bp, {
    id,
    title: `Add ${file}`,
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: '',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
    sessions: { build: `${id.toLowerCase()}-build-1`, review: `${id.toLowerCase()}-review-1` },
    gates: { checks: 'pass', review: 'pass', proof: 'pass' },
  });
  return wt.dir;
}

describe("the Builder's package downloads", () => {
  it("go into the ticket's own cache: outside its copy, writable in the sandbox, with the person's Maven options kept", async () => {
    vi.stubEnv('MAVEN_OPTS', '-Xmx2g');
    const wt = building('AP-1', 'one.txt');
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    const cache = cacheOf('AP-1');
    const run = h.calls[0]!;
    expect(run.env).toEqual(packageCacheEnv(cache));
    expect(run.env).toMatchObject({
      NUGET_PACKAGES: path.join(cache, 'nuget', 'packages'),
      MAVEN_OPTS: `-Xmx2g -Dmaven.repo.local=${path.join(cache, 'maven', 'repository')}`,
      GRADLE_USER_HOME: path.join(cache, 'gradle'),
      GEM_HOME: path.join(cache, 'ruby', 'gems'),
      BUNDLE_PATH: path.join(cache, 'ruby', 'bundle'),
    });
    expect(run.sandbox!.filesystem.allowWrite).toContain(cache);
    expect(run.sandbox!.filesystem.allowRead).toContain(cache);
    // On this computer with the project's other files, never in the copy git sees.
    expect(cache.startsWith(bp.localDir)).toBe(true);
    expect(path.relative(wt, cache).startsWith('..')).toBe(true);
    expect(fs.existsSync(path.join(cache, 'nuget', 'packages', 'newtonsoft.json.nupkg'))).toBe(true);
    expect(sh('git status --porcelain', wt)).toBe('?? one.txt');
  });

  it('are left alone in steps without the sandbox: steps that only read, and a computer without one', async () => {
    building('AP-1', 'one.txt');
    await squad().review('AP-1').catch(() => undefined);
    expect(h.calls[0]!.env).toBeUndefined();
    h.support = { available: false, why: 'socat is not installed' };
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    expect(h.calls.at(-1)!.env).toBeUndefined();
    expect(fs.existsSync(cacheOf('AP-1'))).toBe(false);
  });
});

describe("a ticket's own package cache goes with its copy", () => {
  it('after the release, and only the released tickets\' caches', async () => {
    building('AP-1', 'one.txt');
    building('AP-2', 'two.txt');
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    await squad().runBuilder('AP-2', 'Build it', false, 'build');
    expect(fs.existsSync(cacheOf('AP-1'))).toBe(true);
    writeTicket(bp, { ...readTicket(bp, 'AP-1')!, stage: 'review', status: 'Proof ready to check', waiting: { kind: 'proof', summary: 'The proof is ready for you to check' } });
    actions.approve(bp, 'AP-1');
    const release = await actions.releaseVersion(bp);
    expect(readRelease(bp, release.version)).toMatchObject({ status: 'released', tickets: ['AP-1'] });
    expect(fs.existsSync(readTicket(bp, 'AP-1')!.worktree!)).toBe(false);
    expect(fs.existsSync(cacheOf('AP-1'))).toBe(false);
    // AP-2 is still being built: its copy and its cache stay.
    expect(fs.existsSync(cacheOf('AP-2'))).toBe(true);
  }, 30_000);

  it('on Delete, which says so first', async () => {
    building('AP-1', 'one.txt');
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    expect(deletePlan(bp, 'AP-1').removes).toContain('The packages its Builder and Tester downloaded for it');
    await deleteTicket(bp, 'AP-1', { waitMs: 5000 });
    expect(readTicket(bp, 'AP-1')).toBeNull();
    expect(fs.existsSync(cacheOf('AP-1'))).toBe(false);
  }, 30_000);
});

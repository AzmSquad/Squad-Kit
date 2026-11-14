import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { boardPaths, writeMeta, type BoardPaths } from '../src/board/store.js';
import { loadConfig, saveConfig } from '../src/core/config.js';
import { buildPaths } from '../src/core/paths.js';
import { cancelSignIn, connectionsOf, disconnect, signInNow, startSignIn } from '../src/engine/connections.js';
import { mountConnectionsApi } from '../src/console/api/connections.js';
import { forgetGhConnect, useConnectPace } from '../src/modules/github/connect.js';
import { fakeGitHub, pathWithoutGh, type FakeGitHub } from './support/fake-github.js';

/**
 * The Connections page's GitHub row: Sign in runs GitHub's own tool, `gh auth login`, reads its one-time code and page
 * from what it prints, and waits until the person approves it on GitHub. Cancel stops that one gh process; Disconnect
 * signs gh out for the account signed in. gh here is made up: it prints what the real gh 2.98 prints when no terminal
 * is attached, and waits for a file that stands for the person's approval. Nothing reaches GitHub.
 */

let tmp = '';
let bin = '';
let before: string | undefined;
let gh: FakeGitHub | undefined;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const GH = `#!/bin/sh
D="$(dirname "$0")"
echo "$*" >> "$D/calls.log"
case "$1 $2" in
  "--version "*) echo "gh version 2.98.0 (2026-08-20)"; exit 0;;
  "auth token") if [ -f "$D/signed-in" ]; then echo "test-token"; exit 0; fi; echo "no oauth token" >&2; exit 1;;
  "config get") if [ -f "$D/protocol" ]; then cat "$D/protocol"; else echo "https"; fi; exit 0;;
  "auth login")
    echo "NO_COLOR=$NO_COLOR GH_PROMPT_DISABLED=$GH_PROMPT_DISABLED GH_FORCE_TTY=\${GH_FORCE_TTY:-unset} CLICOLOR_FORCE=\${CLICOLOR_FORCE:-unset}" > "$D/env.log"
    if [ -f "$D/silent" ]; then i=0; while [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; exit 1; fi
    echo "" >&2
    echo "! First copy your one-time code: AB12-CD34" >&2
    echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
    i=0
    while [ ! -f "$D/approve" ]; do sleep 0.05; i=$((i+1)); if [ $i -gt 400 ]; then echo "error: the code expired" >&2; exit 1; fi; done
    touch "$D/signed-in"
    echo "✓ Logged in as sara" >&2
    exit 0;;
  "auth logout") rm -f "$D/signed-in"; exit 0;;
esac
exit 0
`;

/** A project whose remote is on GitHub, with the made-up gh first on the PATH. */
function project(opts: { signedIn?: boolean; projects?: boolean; self?: boolean } = {}): BoardPaths {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-connect-')));
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), GH, { mode: 0o755 });
  if (opts.signedIn) fs.writeFileSync(path.join(bin, 'signed-in'), '');
  before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before ?? ''}`;
  forgetGhConnect();
  const dir = path.join(tmp, 'app');
  fs.mkdirSync(dir);
  sh('git init -q -b main', dir);
  const pkg = opts.self
    ? { name: 'squad-kit', bin: { squad: './dist/cli.js' }, repository: { type: 'git', url: 'https://github.com/AzmSquad/squad-kit' } }
    : { name: 'app' };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  sh(`git remote add origin https://github.com/sara/${opts.self ? 'squad-kit' : 'app'}.git`, dir);
  const bp = boardPaths(path.join(dir, '.squad'));
  writeMeta(bp, {
    project: 'app',
    key: 'AP',
    nextNumber: 1,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Sara', role: 'Developer' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
  if (opts.projects) {
    const file = buildPaths(dir).configFile;
    const c = loadConfig(file);
    saveConfig(file, { ...c, tracker: { type: 'github', workspace: 'sara', project: 'app', options: { from: 'project' } } as typeof c.tracker });
  }
  gh = fakeGitHub((c) => (c.method === 'GET' && c.path === '/user' ? { body: { login: 'sara' } } : undefined));
  return bp;
}

const calls = () => (fs.existsSync(path.join(bin, 'calls.log')) ? fs.readFileSync(path.join(bin, 'calls.log'), 'utf8').trim().split('\n') : []);
const approve = () => fs.writeFileSync(path.join(bin, 'approve'), '');
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(ok()).toBe(true);
};
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  const f = signInNow('github');
  if (f?.state === 'waiting') cancelSignIn('github');
  useConnectPace(null);
  for (const v of ['GH_FORCE_TTY', 'CLICOLOR_FORCE']) delete process.env[v];
  gh?.done();
  gh = undefined;
  process.env.PATH = before;
  forgetGhConnect();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Connections: GitHub sign-in through its own tool', () => {
  it("Sign in gives gh's one-time code and page, then the person approves on GitHub and it is connected", async () => {
    const bp = project();
    const f = await startSignIn(bp, 'github');
    expect(f).toMatchObject({ state: 'waiting', code: 'AB12-CD34', url: 'https://github.com/login/device' });
    expect(f.pid).toBeGreaterThan(0);
    expect(calls()).toContain('auth login --hostname github.com --web --git-protocol https');
    // Asked again while it waits: the same sign-in, not a second gh.
    expect((await startSignIn(bp, 'github')).pid).toBe(f.pid);
    expect((await connectionsOf(bp)).rows[0]).toMatchObject({ name: 'github', state: 'not-connected', flow: { state: 'waiting', code: 'AB12-CD34' } });
    approve();
    await until(() => signInNow('github')?.state === 'done');
    const row = (await connectionsOf(bp)).rows[0]!;
    expect(row).toMatchObject({ state: 'connected', account: 'sara' });
    expect(row.actions.map((a) => [a.id, a.command])).toEqual([
      ['disconnect', 'squad disconnect github'],
      ['check', 'squad connect --status'],
    ]);
  });

  it('asks gh for the Projects right only when the stories come from a GitHub Project', async () => {
    const bp = project({ projects: true });
    await startSignIn(bp, 'github');
    expect(calls()).toContain('auth login --hostname github.com --web --git-protocol https --scopes project');
    // The install step has a command on a Mac only; elsewhere it points at the Tools page.
    const install = process.platform === 'darwin' ? 'brew install gh' : undefined;
    expect((await connectionsOf(bp)).rows[0]!.steps.map((s) => s.command)).toEqual([install, 'gh auth login --web', 'gh auth refresh -s project']);
  });

  it('Cancel stops that gh process, and nothing is signed in', async () => {
    const bp = project();
    const f = await startSignIn(bp, 'github');
    expect(running(f.pid!)).toBe(true);
    expect(cancelSignIn('github')).toMatchObject({ state: 'cancelled', pid: f.pid });
    await until(() => !running(f.pid!));
    expect(signInNow('github')?.state).toBe('cancelled');
    expect(fs.existsSync(path.join(bin, 'signed-in'))).toBe(false);
    expect((await connectionsOf(bp, { again: true })).rows[0]!.state).toBe('not-connected');
  });

  it('gh says no (the code expired): the sign-in failed, in plain words', async () => {
    const bp = project();
    fs.writeFileSync(path.join(bin, 'gh'), GH.replace('    touch "$D/signed-in"\n    echo "✓ Logged in as sara" >&2\n    exit 0;;', '    echo "error: the code expired" >&2\n    exit 1;;'), { mode: 0o755 });
    approve();
    await startSignIn(bp, 'github');
    await until(() => signInNow('github')?.state === 'failed');
    expect(signInNow('github')?.line).toBe('GitHub did not finish the sign-in: error: the code expired. Try again.');
  });

  it('gh is not on this computer: the row says so with the steps and no Sign in, and a sign-in from the terminal says to install it first', async () => {
    const bp = project();
    fs.rmSync(path.join(bin, 'gh'));
    process.env.PATH = pathWithoutGh(bin);
    forgetGhConnect();
    const row = (await connectionsOf(bp)).rows[0]!;
    expect(row.state).toBe('missing');
    expect(row.steps[0]).toMatchObject({ page: '/tools#gh' });
    expect(row.steps[0]!.done).toBeUndefined();
    // With no gh, the button cannot work: no Sign in, the guide instead (the board opens it).
    expect(row.actions.map((a) => a.id)).toEqual(['check']);
    const f = await startSignIn(bp, 'github');
    expect(f).toMatchObject({ state: 'failed', line: "GitHub's tool, gh, is not on this computer. Install it from the Tools page first." });
  });

  it('Disconnect signs gh out for the account signed in, on this computer', async () => {
    const bp = project({ signedIn: true });
    expect((await connectionsOf(bp)).rows[0]).toMatchObject({ state: 'connected', account: 'sara' });
    expect((await disconnect(bp, 'github')).line).toBe('GitHub is signed out on this computer, as sara. Every app that uses its tool here is signed out too.');
    expect(calls()).toContain('auth logout --hostname github.com --user sara');
    expect((await connectionsOf(bp)).rows[0]!.state).toBe('not-connected');
    await expect(disconnect(bp, 'github')).rejects.toThrow('GitHub is not signed in on this computer.');
  });

  it('every row: GitHub with what it is for, Jira coming next with no button, Azure DevOps signing in with Microsoft or a token', async () => {
    const bp = project({ signedIn: true, self: true });
    const rows = (await connectionsOf(bp)).rows;
    // The test's own az answers nothing, so Microsoft's tool counts as not on this computer here.
    expect(rows.map((r) => [r.name, r.how, r.state])).toEqual([
      ['github', 'sign-in', 'connected'],
      ['jira', 'soon', 'soon'],
      ['azure', 'sign-in', 'missing'],
    ]);
    expect(rows[0]!.for).toEqual({ repo: 'sara/squad-kit', into: 'AzmSquad/squad-kit', self: true });
    expect(rows[0]!.steps[1]!.done).toEqual({ en: 'Signed in as sara', ar: 'مسجّل باسم sara' });
    expect(rows[1]!.actions).toEqual([]);
    expect(rows[1]!.next?.en).toBe('Sign in with Atlassian');
    expect(rows[2]).toMatchObject({ tracker: 'azure', codePage: { name: 'Microsoft' }, ownSignIn: true });
    expect(rows[2]!.next).toBeUndefined();
    expect(rows[2]!.actions.map((a) => a.id)).toEqual(['check']);
    await expect(startSignIn(bp, 'jira')).rejects.toThrow('Signing in to Jira comes in a next version.');
  });

  it('each button is one REST call: sign in, where it stands, cancel, disconnect', async () => {
    const bp = project();
    const app = new Hono();
    mountConnectionsApi(app, { paths: buildPaths(bp.root) });
    const post = (p: string) => app.request(p, { method: 'POST' });
    // Nothing started yet: `none`, which the board says with Try again.
    expect(await (await app.request('/api/v1/connections/github/sign-in')).json()).toEqual({ state: 'none' });
    const started = (await (await post('/api/v1/connections/github/sign-in')).json()) as Record<string, unknown>;
    expect(started).toMatchObject({ state: 'waiting', code: 'AB12-CD34' });
    // The tool's process id stays in the engine: the board never gets it.
    expect(started).not.toHaveProperty('pid');
    const now = (await (await app.request('/api/v1/connections/github/sign-in')).json()) as Record<string, unknown>;
    expect(now).toMatchObject({ state: 'waiting' });
    expect(now).not.toHaveProperty('pid');
    const listed = (await (await app.request('/api/v1/connections')).json()) as { rows: { flow?: Record<string, unknown> }[] };
    expect(listed.rows[0]!.flow).toMatchObject({ state: 'waiting' });
    expect(listed.rows[0]!.flow).not.toHaveProperty('pid');
    expect(await (await post('/api/v1/connections/github/sign-in/cancel')).json()).toMatchObject({ state: 'cancelled' });
    const list = (await (await app.request('/api/v1/connections?again=1')).json()) as { rows: { name: string }[] };
    expect(list.rows.map((r) => r.name)).toEqual(['github', 'jira', 'azure']);
    const res = await post('/api/v1/connections/github/disconnect');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'GitHub is not signed in on this computer.' });
    expect(await (await post('/api/v1/connections/nope/sign-in')).json()).toEqual({ error: 'squad-kit has no connection called nope. squad connect --status lists them.' });
  });

  it("keeps the person's git protocol: an ssh setup signs in with ssh, and gh runs with no colors and no questions", async () => {
    const bp = project();
    fs.writeFileSync(path.join(bin, 'protocol'), 'ssh\n');
    process.env.GH_FORCE_TTY = '1';
    process.env.CLICOLOR_FORCE = '1';
    await startSignIn(bp, 'github');
    expect(calls()).toContain('config get git_protocol --host github.com');
    expect(calls()).toContain('auth login --hostname github.com --web --git-protocol ssh');
    expect(fs.readFileSync(path.join(bin, 'env.log'), 'utf8').trim()).toBe('NO_COLOR=1 GH_PROMPT_DISABLED=1 GH_FORCE_TTY=unset CLICOLOR_FORCE=unset');
  });

  it('gh gives no code in time: the sign-in failed in plain words, and that gh is stopped', async () => {
    const bp = project();
    fs.writeFileSync(path.join(bin, 'silent'), '');
    useConnectPace({ codeWaitMs: 300 });
    const f = await startSignIn(bp, 'github');
    expect(f).toMatchObject({ state: 'failed', line: "GitHub's tool gave no sign-in code. Try again, or sign in step by step." });
    await until(() => !running(f.pid!));
  });

  it('a code nobody approves stops after its time (15 minutes for real), and gh with it', async () => {
    const bp = project();
    useConnectPace({ lifeMs: 300 });
    const f = await startSignIn(bp, 'github');
    expect(f.state).toBe('waiting');
    await until(() => signInNow('github')?.state === 'failed');
    expect(signInNow('github')?.line).toBe('The code expired after 15 minutes. Try again.');
    await until(() => !running(f.pid!));
  });
});

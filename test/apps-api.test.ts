import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import type { BoardPaths } from '../src/board/store.js';

/**
 * Your apps through the board's REST API: every button is one call. Looks right merges a ticket, the sidebar offers
 * the new version, and Run the new version restarts the app on it. Closing the board stops the app. Each project's
 * squad is replaced by a quiet one here, so no agent ever starts.
 */

vi.mock('../src/engine/live.js', async (orig) => {
  const actual = await orig<typeof import('../src/engine/live.js')>();
  class QuietSquad {
    start() {
      return () => undefined;
    }
    ticketsRunning() {
      return 0;
    }
  }
  return { ...actual, LiveSquad: QuietSquad };
});
vi.mock('../src/planner/runtimes/auth-probe.js', async (orig) => ({
  ...(await orig<typeof import('../src/planner/runtimes/auth-probe.js')>()),
  probeClaudeAuth: async () => ({ ok: true }),
}));

const { buildPaths } = await import('../src/core/paths.js');
const { boardPaths, readMeta, writeMeta, writeTicket } = await import('../src/board/store.js');
const { startConsoleServer } = await import('../src/console/server.js');
const { addWorktree } = await import('../src/engine/git.js');

const TOKEN = 'f'.repeat(64);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmp: string;
let project: string;
let bp: BoardPaths;
let port: number;
let server: Awaited<ReturnType<typeof startConsoleServer>> | null;
let api: string;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

interface App {
  name: string;
  state: string;
  address?: string;
  error?: string;
  fresh?: { id: string; base: string; release?: string };
  includes?: { id: string }[];
}

const call = async <T>(method: string, p: string, body?: unknown): Promise<{ status: number; data: T }> => {
  const res = await fetch(`${api}${p}`, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: (await res.json()) as T };
};
const apps = async () => (await call<{ apps: App[]; live: boolean }>('GET', '/apps')).data;
async function settled(): Promise<App> {
  for (;;) {
    const a = (await apps()).apps[0]!;
    if (a.state !== 'starting') return a;
    await sleep(200);
  }
}
const served = () => fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) }).then((r) => r.text(), () => null);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-apps-api-'));
  project = path.join(tmp, 'roomflow');
  fs.mkdirSync(project);
  port = await freePort();
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'server.js'), `require('http').createServer((q, r) => r.end(require('fs').readFileSync('button.txt', 'utf8').trim())).listen(${port}, '127.0.0.1');\n`);
  fs.writeFileSync(path.join(project, 'button.txt'), 'Log in\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.squad\n');
  sh('git add -A && git commit -qm start', project);
  const paths = buildPaths(project);
  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.writeFileSync(paths.configFile, yaml.dump({ version: 1, project: { name: 'roomflow', primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }));
  bp = boardPaths(paths.squadDir);
  writeMeta(bp, {
    project: 'roomflow',
    key: 'RO',
    nextNumber: 6,
    engine: 'live',
    documentsInGit: false,
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: '' },
    scan: { status: 'done', empty: false },
  });
  server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
  api = `http://127.0.0.1:${server.port}/p/${encodeURIComponent(bp.projectId)}/api/v1`;
});

afterEach(async () => {
  await server?.close();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** RO-5 changes the button, and waits for the person's Looks right. */
function proofReady(): void {
  const wt = addWorktree(project, 'RO-5', 'main');
  fs.writeFileSync(path.join(wt.dir, 'button.txt'), 'Sign in\n');
  writeTicket(bp, {
    id: 'RO-5',
    title: 'Sign in',
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
  });
}

describe('your apps on the board', () => {
  it('an unknown start command can be typed in; then Start, Restart and Stop are one call each', async () => {
    const first = await apps();
    expect(first.live).toBe(true);
    expect(first.apps).toMatchObject([{ name: 'roomflow', state: 'not-running' }]);
    expect((await call<{ error: string }>('POST', '/apps/roomflow/start')).data.error).toMatch(/does not know how to start roomflow yet/);

    // "Type it" saves it in the project's settings.
    const typed = await call<App>('PUT', '/apps/roomflow/commands', { start: 'node server.js', url: `http://localhost:${port}` });
    expect(typed.status).toBe(200);
    expect(readMeta(bp).commands).toMatchObject({ start: 'node server.js', url: `http://localhost:${port}` });

    expect((await call<App>('POST', '/apps/roomflow/start')).data.state).toBe('starting');
    expect(await settled()).toMatchObject({ state: 'running', address: `http://localhost:${port}` });
    expect(await served()).toBe('Log in');
    expect((await call<{ error: string }>('POST', '/apps/roomflow/start')).data.error).toBe(`roomflow is already running at http://localhost:${port}.`);
    const out = await call<{ lines: string[]; start: string }>('GET', '/apps/roomflow/output');
    expect(out.data.lines.join('\n')).toContain('$ node server.js');

    await call('POST', '/apps/roomflow/restart');
    expect((await settled()).state).toBe('running');
    expect((await call<App>('POST', '/apps/roomflow/stop')).data.state).toBe('stopped');
    expect(await served()).toBeNull();
  }, 40_000);

  it('after Looks right merges a ticket, Run the new version restarts the app on the new main', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { start: 'node server.js', url: `http://localhost:${port}` } });
    await call('POST', '/apps/roomflow/start');
    expect((await settled()).state).toBe('running');
    expect(await served()).toBe('Log in');

    proofReady();
    expect((await call('POST', '/tickets/RO-5/approve')).status).toBe(200);
    const offered = await settled();
    expect(offered.fresh).toEqual({ id: 'RO-5', title: 'Sign in', base: 'main', release: 'v0.1.0' });
    // The old version still runs until the person asks.
    expect(await served()).toBe('Log in');

    await call('POST', '/apps/roomflow/restart');
    const now = await settled();
    expect(now.state).toBe('running');
    expect(now.fresh).toBeUndefined();
    expect(now.includes).toEqual([{ id: 'RO-5', title: 'Sign in' }]);
    expect(await served()).toBe('Sign in');
  }, 40_000);

  it('Not now hides the new version until the next merge', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { start: 'node server.js', url: `http://localhost:${port}` } });
    proofReady();
    await call('POST', '/tickets/RO-5/approve');
    expect((await apps()).apps[0]!.fresh?.id).toBe('RO-5');
    await call('POST', '/apps/roomflow/not-now', { ticket: 'RO-5' });
    expect((await apps()).apps[0]!.fresh).toBeUndefined();
  }, 30_000);

  it('closing the board stops the app it started', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { start: 'node server.js', url: `http://localhost:${port}` } });
    await call('POST', '/apps/roomflow/start');
    expect((await settled()).state).toBe('running');
    await server!.close();
    server = null;
    const until = Date.now() + 8000;
    while ((await served()) !== null && Date.now() < until) await sleep(200);
    expect(await served()).toBeNull();
  }, 30_000);
});

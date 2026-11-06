import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { BoardPaths } from '../src/board/store.js';

/**
 * New project through the app: the button's one call, and what Home shows after it. Each project's squad is replaced by
 * a quiet one here, so no agent starts.
 */

const squads = vi.hoisted(() => ({ started: [] as string[], meta: [] as unknown[] }));
vi.mock('../src/engine/live.js', async (orig) => {
  const actual = await orig<typeof import('../src/engine/live.js')>();
  const { readMeta } = await import('../src/board/store.js');
  class QuietSquad {
    constructor(private bp: BoardPaths) {}
    start() {
      squads.started.push(this.bp.root);
      // What the squad finds when it starts: what the person gave must be in by then, or it reads without it.
      squads.meta.push(readMeta(this.bp).engine === 'live' ? readMeta(this.bp).scan : null);
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
const { boardPaths } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { startConsoleServer } = await import('../src/console/server.js');
const { readProjects } = await import('../src/core/projects.js');

const TOKEN = 'f'.repeat(64);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let tmp: string;
let server: Awaited<ReturnType<typeof startConsoleServer>>;
let base: string;
let alpha: BoardPaths;

const post = (body: unknown, headers: Record<string, string> = auth) => fetch(`${base}/api/v1/app/projects/new`, { method: 'POST', headers, body: JSON.stringify(body) });

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-api-')));
  const paths = buildPaths(path.join(tmp, 'alpha'));
  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.writeFileSync(paths.configFile, yaml.dump({ version: 1, project: { name: 'Alpha', primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }));
  alpha = boardPaths(paths.squadDir);
  seedDemoBoard(alpha, { speed: 0.001, project: 'Alpha' });
  server = await startConsoleServer({ paths, app: true, requestedPort: 0, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('New project in the app', () => {
  it('needs the token, as every other write does', async () => {
    expect((await post({ name: 'Nope', where: tmp, idea: 'x' }, { 'content-type': 'application/json' })).status).toBe(401);
    expect(fs.existsSync(path.join(tmp, 'Nope'))).toBe(false);
  });

  it('from an idea: the idea is in before the squad starts, and the person lands on the setup', async () => {
    const res = await post({ name: 'Idea one', where: tmp, idea: 'A visitor log' });
    expect(res.status).toBe(200);
    const row = (await res.json()) as { id: string; url: string; opens: string; root: string; name: string };
    expect(row).toMatchObject({ name: 'Idea one', opens: '/setup', root: path.join(tmp, 'Idea one') });
    expect(squads.started.at(-1)).toBe(row.root);
    const talk = JSON.parse(fs.readFileSync(path.join(boardPaths(path.join(row.root, '.squad')).localDir, 'overview-talk.json'), 'utf8')) as { idea: string; reread: boolean };
    expect(talk).toMatchObject({ idea: 'A visitor log', reread: true });
    expect(readProjects().map((p) => p.root)).toContain(row.root);
    // Its own address answers.
    const board = await fetch(`${base}/p/${encodeURIComponent(row.id)}/api/v1/setup`, { headers: auth });
    expect(board.status).toBe(200);
  });

  it('from a BRD: the squad starts with nothing to read, and Home points at the BRD', async () => {
    const data = Buffer.from('# Visitor log\n\nPeople sign in.\n').toString('base64');
    const res = await post({ name: 'سجل الزوار', where: tmp, file: { name: 'visitors.md', data } });
    expect(res.status).toBe(200);
    const row = (await res.json()) as { id: string; opens: string; root: string; setup: { approved: boolean; brd: { id: string; title: string } } };
    expect(row.opens).toBe(`/requirements/${row.setup.brd.id}`);
    expect(row.setup).toMatchObject({ approved: true, brd: { title: 'visitors' } });
    expect(squads.meta.at(-1)).toMatchObject({ status: 'done', empty: true });
    expect(execSync('git log --oneline', { cwd: row.root, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
    const view = await fetch(`${base}/p/${encodeURIComponent(row.id)}${row.opens.replace('/requirements', '/api/v1/requirements')}`, { headers: auth });
    expect(view.status).toBe(200);
  });

  it('says what is wrong in plain words, starts no squad and leaves no folder', async () => {
    const started = squads.started.length;
    const bad = await post({ name: 'Bad one', where: tmp, file: { name: 'visitors.exe', data: 'AAAA' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('squad-kit reads PDF, Word');
    expect(fs.existsSync(path.join(tmp, 'Bad one'))).toBe(false);
    const taken = await post({ name: 'Idea one', where: tmp, idea: 'Again' });
    expect(((await taken.json()) as { error: string }).error).toContain('is there already');
    const inside = await post({ name: 'Inner', where: alpha.root, idea: 'Inside' });
    expect(((await inside.json()) as { error: string }).error).toContain('inside the project');
    const odd = await post({ name: 42, where: tmp, idea: ['x'] });
    expect(((await odd.json()) as { error: string }).error).toBe('Give the project a name.');
    expect(squads.started.length).toBe(started);
  });

  it('the folder browser says where a new project goes, and where it cannot', async () => {
    const free = (await (await fetch(`${base}/api/v1/app/folders?path=${encodeURIComponent(tmp)}`, { headers: auth })).json()) as { place: string; notHere?: string };
    expect(free.place).toBeTruthy();
    expect(free.notHere).toBeUndefined();
    const inside = (await (await fetch(`${base}/api/v1/app/folders?path=${encodeURIComponent(alpha.root)}`, { headers: auth })).json()) as { notHere?: string };
    expect(inside.notHere).toContain('inside the project');
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import type { BoardPaths } from '../src/board/store.js';

/**
 * One app, many projects (ADR-001): every project's API under /p/<project id>/, the routes one board always had
 * unchanged; the app's own API for the projects, Add project, the folder browser and one Waiting for you list.
 * Each project's squad is replaced by a quiet one here, so no agent ever starts.
 */

const squads = vi.hoisted(() => ({ started: [] as string[], stopped: [] as string[] }));
vi.mock('../src/engine/live.js', async (orig) => {
  const actual = await orig<typeof import('../src/engine/live.js')>();
  class QuietSquad {
    constructor(private bp: BoardPaths) {}
    start() {
      squads.started.push(this.bp.root);
      return () => void squads.stopped.push(this.bp.root);
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
const { boardPaths, listTickets } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { readConsoleInfo } = await import('../src/board/console-info.js');
const { readProjects, rememberProject, findProject } = await import('../src/core/projects.js');
const { startConsoleServer } = await import('../src/console/server.js');
const { isOwnFolder } = await import('../src/engine/setup.js');

const TOKEN = 'e'.repeat(64);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let tmp: string;
let server: Awaited<ReturnType<typeof startConsoleServer>>;
let base: string;
let alpha: BoardPaths;
let beta: BoardPaths;

function demoProject(name: string): BoardPaths {
  const root = path.join(tmp, name.toLowerCase());
  const paths = buildPaths(root);
  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.writeFileSync(paths.configFile, yaml.dump({ version: 1, project: { name, primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }));
  seedDemoBoard(boardPaths(paths.squadDir), { speed: 0.001, project: name });
  return boardPaths(paths.squadDir);
}

const get = (p: string, headers: Record<string, string> = auth) => fetch(`${base}${p}`, { headers });
const call = (method: string, p: string, body: unknown = {}) => fetch(`${base}${p}`, { method, headers: auth, body: JSON.stringify(body) });
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-one-app-server-')));
  alpha = demoProject('Alpha');
  beta = demoProject('Beta');
  server = await startConsoleServer({ paths: buildPaths(alpha.root), app: true, requestedPort: 0, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('one app, many projects', () => {
  it('adds a project from its folder and serves each one under its own address', async () => {
    const added = await json<{ id: string; url: string; added: boolean; name: string }>(call('POST', '/api/v1/app/projects', { folder: beta.root }));
    expect(added).toMatchObject({ id: beta.projectId, name: 'Beta', url: `/p/${beta.projectId}/board`, added: true });
    expect(squads.started).toEqual([alpha.root, beta.root]);

    const a = await json<{ meta: { project: string } }>(get(`/p/${alpha.projectId}/api/v1/board`));
    const b = await json<{ meta: { project: string } }>(get(`/p/${beta.projectId}/api/v1/board`));
    expect([a.meta.project, b.meta.project]).toEqual(['Alpha', 'Beta']);
    // The project the app opened first still answers at the old address.
    expect((await json<{ meta: { project: string } }>(get('/api/v1/board'))).meta.project).toBe('Alpha');

    const list = await json<{ projects: { id: string; open: boolean; engine: string; waiting: number }[] }>(get('/api/v1/app/projects'));
    expect(list.projects.map((p) => p.id)).toEqual([alpha.projectId, beta.projectId]);
    expect(list.projects.every((p) => p.open && p.engine === 'demo' && p.waiting > 0)).toBe(true);
    expect(readProjects().map((p) => p.root)).toEqual([alpha.root, beta.root]);
    // The app's link is written for each project, so `squad console` there finds it.
    expect(readConsoleInfo(beta)).toMatchObject({ pid: process.pid, port: server.port, token: TOKEN });
  });

  it('sends a request with its body to the project it names, and checks the token there', async () => {
    const res = await call('POST', `/p/${beta.projectId}/api/v1/tickets`, { title: 'Only for Beta' });
    expect(res.status).toBe(200);
    expect(listTickets(beta).some((t) => t.title === 'Only for Beta')).toBe(true);
    expect(listTickets(alpha).some((t) => t.title === 'Only for Beta')).toBe(false);

    expect((await get(`/p/${beta.projectId}/api/v1/board`, {})).status).toBe(401);
    expect((await get(`/p/${beta.projectId}/api/v1/board?t=${TOKEN}`, {})).status).toBe(200);
    expect((await get('/api/v1/app/projects', {})).status).toBe(401);
    const missing = await get('/p/no-such-project/api/v1/board');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain('not open in the app');
  });

  it('lists everything waiting for the person, in every project', async () => {
    const { items } = await json<{ items: { project: { id: string; name: string }; ticket: { id: string; waiting: unknown } }[] }>(get('/api/v1/app/waiting'));
    const names = new Set(items.map((i) => i.project.name));
    expect(names).toEqual(new Set(['Alpha', 'Beta']));
    expect(items.length).toBeGreaterThanOrEqual(4);
  });

  it('adds an empty folder as a new project: a new repo, and the Architect reads it first', async () => {
    const dir = path.join(tmp, 'coffee-shop');
    fs.mkdirSync(dir);
    const res = await json<{ id: string; did: string[]; setup: { status: string; line: string }; added: boolean; url: string }>(call('POST', '/api/v1/app/projects', { folder: dir }));
    expect(res.did).toContain('Git: made a new repo for the project');
    expect(res.setup).toMatchObject({ status: 'pending', ready: false, approved: false });
    expect(res.setup.line).toMatch(/^Getting to know the project: step 2 of 7 · Checking /);
    expect(res.added).toBe(true);
    expect(squads.started).toContain(dir);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect((await json<{ meta: { scan: { status: string } } }>(get(`${res.url.replace(/\/board$/, '')}/api/v1/board`))).meta.scan.status).toBe('pending');

    // Again, or from a folder inside it: the same project, nothing set up twice.
    fs.mkdirSync(path.join(dir, 'src'));
    const again = await json<{ id: string; added: boolean; did: string[] }>(call('POST', '/api/v1/app/projects', { folder: path.join(dir, 'src') }));
    expect(again).toMatchObject({ id: res.id, added: false, did: [] });
  });

  it('refuses a folder that is not there, or a project whose board runs in another squad-kit', async () => {
    const gone = await call('POST', '/api/v1/app/projects', { folder: path.join(tmp, 'nope') });
    expect(gone.status).toBe(400);
    expect(((await gone.json()) as { error: string }).error).toContain('There is no folder');

    const other = demoProject('Gamma');
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    try {
      fs.mkdirSync(other.localDir, { recursive: true });
      fs.writeFileSync(other.consoleFile, JSON.stringify({ pid: sleeper.pid, port: 1, token: 'x', startedAt: '', version: '', build: 0 }));
      const res = await call('POST', '/api/v1/app/projects', { folder: other.root });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('open in another squad-kit');
    } finally {
      sleeper.kill();
    }
    expect(isOwnFolder(os.homedir())).toBe(false);
    expect(isOwnFolder('/')).toBe(false);
    expect(isOwnFolder(tmp)).toBe(true);
  });

  it('browses folders, says what each one is, and makes a new one', async () => {
    const at = path.join(tmp, 'browse');
    for (const d of ['plain', 'repo/.git', 'proj/.squad', '.hidden', 'node_modules']) fs.mkdirSync(path.join(at, d), { recursive: true });
    fs.writeFileSync(path.join(at, 'proj', '.squad', 'config.yaml'), 'version: 1\n');
    const l = await json<{ path: string; kind: string; repos: number; canAdd: boolean; parent: string; folders: { name: string; kind: string }[] }>(
      get(`/api/v1/app/folders?path=${encodeURIComponent(at)}`),
    );
    expect(l).toMatchObject({ path: at, kind: 'repos', repos: 1, canAdd: true, parent: tmp });
    expect(l.folders.map((f) => [f.name, f.kind])).toEqual([
      ['plain', 'folder'],
      ['proj', 'project'],
      ['repo', 'repo'],
    ]);

    const made = await json<{ path: string; kind: string; folders: unknown[] }>(call('POST', '/api/v1/app/folders', { parent: at, name: 'New shop' }));
    expect(made).toMatchObject({ path: path.join(at, 'New shop'), kind: 'empty', folders: [] });
    for (const name of ['../escape', '.secret', '']) expect((await call('POST', '/api/v1/app/folders', { parent: at, name })).status).toBe(400);
    expect((await call('POST', '/api/v1/app/folders', { parent: at, name: 'plain' })).status).toBe(400);
  });

  it('keeps one limit of tickets at once for every project, in the person’s settings', async () => {
    expect(await json(get('/api/v1/app/settings'))).toEqual({ parallel: 2, max: 5, running: 0 });
    expect(await json(call('PUT', '/api/v1/app/settings', { parallel: 4 }))).toMatchObject({ parallel: 4 });
    const file = yaml.load(fs.readFileSync(path.join(process.env.SQUAD_KIT_HOME!, 'settings.yaml'), 'utf8')) as { parallel: number };
    expect(file.parallel).toBe(4);
    expect((await call('PUT', '/api/v1/app/settings', { parallel: 0 })).status).toBe(400);
  });

  it('takes a project out of the app: its squad stops, its files stay', async () => {
    const res = await fetch(`${base}/api/v1/app/projects/${beta.projectId}`, { method: 'DELETE', headers: auth });
    expect(res.status).toBe(200);
    expect(squads.stopped).toContain(beta.root);
    expect((await get(`/p/${beta.projectId}/api/v1/board`)).status).toBe(404);
    expect(readProjects().some((p) => p.id === beta.projectId)).toBe(false);
    expect(fs.existsSync(beta.configFile)).toBe(true);
    expect(readConsoleInfo(beta)?.pid).toBeNull();
  });

  it('opens every project on its list when it starts again, and names the project in every board address', async () => {
    await server.close();
    expect(readConsoleInfo(alpha)?.pid).toBeNull();
    server = await startConsoleServer({ app: true, requestedPort: 0, token: TOKEN });
    base = `http://127.0.0.1:${server.port}`;
    const list = await json<{ projects: { id: string; open: boolean }[] }>(get('/api/v1/app/projects'));
    expect(list.projects.filter((p) => p.open).map((p) => p.id)).toContain(alpha.projectId);
    expect(list.projects.map((p) => p.id)).not.toContain(beta.projectId);
    // With no project opened first, an address without a project has nothing to answer.
    const bare = await get('/api/v1/board');
    expect(bare.status).toBe(404);
    expect((await get(`/p/${alpha.projectId}/api/v1/board`)).status).toBe(200);
  });
});

describe("the app's list of projects", () => {
  it('keeps one entry per project, follows a moved folder, and finds a project by name, id or folder', () => {
    const home = process.env.SQUAD_KIT_HOME!;
    fs.rmSync(path.join(home, 'projects.json'), { force: true });
    const one = demoProject('Delta Shop');
    rememberProject(one.projectId, one.root);
    rememberProject(one.projectId, one.root);
    expect(readProjects()).toHaveLength(1);
    expect(findProject(one.projectId)).toBe(one.root);
    expect(findProject('delta shop')).toBe(one.root);
    expect(findProject('delta-shop')).toBe(one.root);
    expect(findProject(path.join(one.root, '.squad'))).toBe(one.root);
    expect(() => findProject('nothing-like-it')).toThrow(/No project called "nothing-like-it". Your projects: Delta Shop/);

    const moved = path.join(tmp, 'moved-delta');
    fs.renameSync(one.root, moved);
    rememberProject(one.projectId, moved);
    expect(readProjects()).toEqual([expect.objectContaining({ id: one.projectId, root: moved })]);
  });
});

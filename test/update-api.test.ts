import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import yaml from 'js-yaml';
import type { InstalledPackage } from '../src/core/package-info.js';
import type { InstallResult } from '../src/core/update.js';
import { buildPaths } from '../src/core/paths.js';
import { boardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { startConsoleServer } from '../src/console/server.js';

/**
 * The app's Update API, served by the real app with a fake registry, a fake installer and a fake restart: what the
 * banner, the updating view and Settings › About read and press.
 */

const TOKEN = 'u'.repeat(64);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let tmp: string;
let base: string;
let server: Awaited<ReturnType<typeof startConsoleServer>>;
let restarts = 0;
let install: () => Promise<InstallResult>;
let ua: string | undefined;

const installed = (): InstalledPackage => ({ name: 'squad-kit', version: '1.0.1', root: '/usr/local/lib/node_modules/squad-kit', repositoryUrl: 'https://github.com/AzmSquad/squad-kit', isDevInstall: false });
const registry = (async (url: string) =>
  url.startsWith('https://registry.npmjs.org/')
    ? Response.json({ 'dist-tags': { latest: '1.0.2' }, versions: { '1.0.2': {} } })
    : url.includes('/releases/tags/v1.0.2')
      ? Response.json({ body: '- Delete a ticket from the board', html_url: 'https://github.com/AzmSquad/squad-kit/releases/tag/v1.0.2' })
      : new Response('', { status: 404 })) as unknown as typeof fetch;

const get = (p: string, headers: Record<string, string> = auth) => fetch(`${base}${p}`, { headers });
const call = (method: string, p: string, body: unknown = {}) => fetch(`${base}${p}`, { method, headers: auth, body: JSON.stringify(body) });
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;
type Status = { current: string; latest: string; newer: boolean; command: string; daily: boolean; later: string | null; notes?: string[]; progress: { state: string; reason?: string; permission?: boolean } };

async function until(check: () => Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}

beforeAll(async () => {
  ua = process.env.npm_config_user_agent;
  delete process.env.npm_config_user_agent;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-update-api-')));
  const paths = buildPaths(path.join(tmp, 'roomflow'));
  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.writeFileSync(paths.configFile, yaml.dump({ version: 1, project: { name: 'roomflow', primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }));
  seedDemoBoard(boardPaths(paths.squadDir), { speed: 0.001, project: 'roomflow' });
  server = await startConsoleServer({
    paths,
    app: true,
    requestedPort: 0,
    token: TOKEN,
    update: { fetch: registry, installed, install: () => install(), restart: () => void (restarts += 1) },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  if (ua !== undefined) process.env.npm_config_user_agent = ua;
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  restarts = 0;
  install = async () => ({ ok: true, code: 0, output: '', timedOut: false });
  await call('DELETE', '/api/v1/app/update');
});

describe('the Update API', () => {
  it('needs the token, like every app call', async () => {
    expect((await get('/api/v1/app/update', {})).status).toBe(401);
    expect((await call('POST', '/api/v1/app/update/check')).status).toBe(200);
  });

  it('checks npm, says what is new, and keeps the daily setting and Later', async () => {
    const s = await json<Status>(call('POST', '/api/v1/app/update/check'));
    expect(s).toMatchObject({ current: '1.0.1', latest: '1.0.2', newer: true, notes: ['Delete a ticket from the board'], command: 'npm install -g squad-kit@1.0.2' });
    expect(await json<Status>(get('/api/v1/app/update'))).toMatchObject({ latest: '1.0.2', daily: false, progress: { state: 'idle' } });
    expect(await json<Status>(call('PUT', '/api/v1/app/update', { daily: true, later: '1.0.2' }))).toMatchObject({ daily: true, later: '1.0.2' });
    expect(await json<Status>(call('PUT', '/api/v1/app/update', { daily: false, later: null }))).toMatchObject({ daily: false, later: null });
  });

  it('Update now installs and restarts the app through the keeper', async () => {
    await call('POST', '/api/v1/app/update/check');
    const res = await call('POST', '/api/v1/app/update', {});
    expect(res.status).toBe(200);
    await until(async () => (await json<Status>(get('/api/v1/app/update'))).progress.state === 'restarting');
    expect(restarts).toBe(1);
  });

  it('a failed install shows the command and a plain reason; Restart then restarts', async () => {
    install = async () => ({ ok: false, code: 243, output: 'npm ERR! code EACCES', timedOut: false });
    await call('POST', '/api/v1/app/update', {});
    await until(async () => (await json<Status>(get('/api/v1/app/update'))).progress.state === 'failed');
    const s = await json<Status>(get('/api/v1/app/update'));
    expect(s.progress).toMatchObject({ permission: true, reason: 'This computer needs your permission to install.' });
    expect(s.command).toBe('npm install -g squad-kit@1.0.2');
    expect(restarts).toBe(0);
    expect((await json<Status>(call('POST', '/api/v1/app/update/restart'))).progress.state).toBe('restarting');
    expect(restarts).toBe(1);
  });

  it('says why in plain words when there is nothing to do', async () => {
    const res = await call('POST', '/api/v1/app/update/restart');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('no update to restart for');
  });
});

describe('the restart after an install', () => {
  it('goes through the same restart as the board, so the keeper starts a fresh app', async () => {
    const own = await startConsoleServer({
      app: true,
      requestedPort: 0,
      token: TOKEN,
      update: { fetch: registry, installed, install: async () => ({ ok: true, code: 0, output: '', timedOut: false }) },
    });
    try {
      const at = `http://127.0.0.1:${own.port}`;
      await fetch(`${at}/api/v1/app/update/check`, { method: 'POST', headers: auth });
      expect((await fetch(`${at}/api/v1/app/update`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(200);
      await own.done;
      expect(own.restartRequested()).toBe(true);
    } finally {
      await own.close().catch(() => undefined);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { BoardPaths } from '../src/board/store.js';
import { runParts } from '../src/commands/parts.js';

/** What the product is made of, through the API Settings uses and through `squad parts`: one list, the same rules. */

const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { buildPaths } = await import('../src/core/paths.js');
const { startConsoleServer } = await import('../src/console/server.js');

const TOKEN = 'e'.repeat(64);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let tmp: string;
let bp: BoardPaths;
let server: Awaited<ReturnType<typeof startConsoleServer>>;
let base: string;

const call = (method: string, url: string, body?: unknown) => fetch(`${base}${url}`, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) });

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-parts-api-')));
  const paths = buildPaths(tmp);
  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.writeFileSync(paths.configFile, yaml.dump({ version: 1, project: { name: 'Rooms', primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }));
  bp = boardPaths(paths.squadDir);
  seedDemoBoard(bp, { speed: 0.001, project: 'Rooms' });
  for (const r of ['web-ui', 'api-server']) fs.mkdirSync(path.join(tmp, r), { recursive: true });
  const meta = readMeta(bp);
  writeMeta(bp, { ...meta, repos: ['web-ui', 'api-server'].map((p) => ({ path: p, base: 'main', remote: '', commands: {} })) });
  server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the parts through the API', () => {
  it('lists one part for each repo before any read', async () => {
    const r = await call('GET', '/api/v1/parts');
    expect(r.status).toBe(200);
    const v = (await r.json()) as { parts: { id: string }[]; repos: string[]; several: boolean };
    expect(v.parts.map((p) => p.id)).toEqual(['web-ui', 'api-server']);
    expect(v.repos).toEqual(['web-ui', 'api-server']);
    expect(v.several).toBe(true);
  });

  it('adds, corrects and takes out, and says plainly what is wrong', async () => {
    expect((await call('POST', '/api/v1/parts', { name: 'Database', shared: true })).status).toBe(200);
    const saved = await call('PUT', '/api/v1/parts/api-server', { name: 'API', needs: ['database'], url: 'http://localhost:5180' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ name: 'API', needs: ['database'] });

    const bad = await call('PUT', '/api/v1/parts/api-server', { url: 'nope' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('is not a web address');
    expect((await call('PUT', '/api/v1/parts/ghost', { name: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/v1/parts', {})).status).toBe(400);

    // Types the form never sends are ignored, not saved.
    const odd = await call('PUT', '/api/v1/parts/web-ui', { name: 7, needs: 'x', off: 'yes' });
    expect(odd.status).toBe(200);
    expect(await odd.json()).toMatchObject({ name: 'Web ui', needs: [] });

    expect((await call('POST', '/api/v1/parts/database/remove')).status).toBe(200);
    const after = (await (await call('GET', '/api/v1/parts')).json()) as { parts: { id: string; needs: string[] }[] };
    expect(after.parts.find((p) => p.id === 'database')).toBeUndefined();
    expect(after.parts.find((p) => p.id === 'api-server')?.needs).toEqual([]);
  });

  it('needs the token', async () => {
    expect((await fetch(`${base}/api/v1/parts`)).status).toBe(401);
  });
});

describe('squad parts', () => {
  it('does what the form does', async () => {
    const cwd = process.cwd();
    const printed: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      printed.push(String(s));
      return true;
    });
    process.chdir(tmp);
    try {
      await runParts({ add: 'Redis', shared: true });
      await runParts({ set: 'web-ui', name: 'Web app', needs: 'api-server,redis', url: 'http://localhost:3000' });
      await runParts({ off: 'redis' });
      await runParts({ on: 'redis' });
      await runParts({ set: 'web-ui', needs: 'redis' });
      printed.length = 0;
      await runParts({});
      const text = printed.join('');
      expect(text).toContain('Web app');
      expect(text).toContain('needs Redis');
      expect(text).toContain('shared by the parts');
      expect(text).toContain('http://localhost:3000');
      await runParts({ remove: 'redis' });
      await expect(runParts({ off: 'ghost' })).rejects.toThrow('There is no part "ghost"');
    } finally {
      process.chdir(cwd);
      spy.mockRestore();
    }
    expect(readMeta(bp).parts?.some((p) => p.id === 'redis')).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { BoardPaths } from '../src/board/store.js';
import { runFiles } from '../src/commands/files.js';

/** The files agents may not touch, through the API Settings uses and through `squad files`: what a file holds never comes back. */

const { boardPaths, readMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { buildPaths } = await import('../src/core/paths.js');
const { startConsoleServer } = await import('../src/console/server.js');

const TOKEN = 'd'.repeat(64);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const REAL = 'REAL-VALUE-3390';
let tmp: string;
let bp: BoardPaths;
let server: Awaited<ReturnType<typeof startConsoleServer>>;
let base: string;

const call = (method: string, url: string, body?: unknown) => fetch(`${base}${url}`, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) });
const sh = (cmd: string) => execSync(cmd, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-files-api-')));
  sh('git init -q -b main');
  fs.writeFileSync(path.join(tmp, '.gitignore'), '.env.dev\n.squad/\n');
  fs.writeFileSync(path.join(tmp, 'docker-compose.yml'), 'services: {}\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start');
  fs.writeFileSync(path.join(tmp, '.env.dev'), `KEY=${REAL}\n`);
  const paths = buildPaths(tmp);
  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.writeFileSync(paths.configFile, yaml.dump({ version: 1, project: { name: 'Rooms', primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }));
  bp = boardPaths(paths.squadDir);
  seedDemoBoard(bp, { speed: 0.001, project: 'Rooms' });
  server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('through the API', () => {
  it('needs the token', async () => {
    expect((await fetch(`${base}/api/v1/project-files`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/project-files/local`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('adds, starts the values, locks and takes off, and never sends back what a file holds', async () => {
    expect((await call('POST', '/api/v1/project-files/local', { repo: '.', path: '.env.dev' })).status).toBe(200);
    const mine = await call('POST', '/api/v1/project-files/use-mine', { repo: '.', path: '.env.dev' });
    expect(mine.status).toBe(200);
    expect(await mine.text()).not.toContain(REAL);
    const got = await call('GET', '/api/v1/project-files');
    const text = await got.text();
    expect(text).not.toContain(REAL);
    expect(JSON.parse(text)).toMatchObject({ local: [{ path: '.env.dev', ready: true, inFolder: true }], docker: [{ path: 'docker-compose.yml' }] });
    expect((await call('POST', '/api/v1/project-files/lock-docker')).status).toBe(200);
    expect(readMeta(bp).lockedFiles).toEqual([{ repo: '.', path: 'docker-compose.yml' }]);
    expect((await call('POST', '/api/v1/project-files/remove', { repo: '.', path: 'docker-compose.yml' })).status).toBe(200);
    expect(readMeta(bp).lockedFiles).toBeUndefined();
  });

  it('says plainly what is wrong, also for fields of the wrong type', async () => {
    const outside = await call('POST', '/api/v1/project-files/local', { repo: '.', path: '../../etc/passwd' });
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { error: string }).error).toContain('must be inside the repo');
    expect((await call('POST', '/api/v1/project-files/local', { repo: '.', path: 7 })).status).toBe(400);
    expect((await call('POST', '/api/v1/project-files/use-mine', { repo: '.', path: 'nope.txt' })).status).toBe(400);
  });
});

describe('squad files', () => {
  it('does what the form does', async () => {
    const cwd = process.cwd();
    const printed: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      printed.push(String(s));
      return true;
    });
    process.chdir(tmp);
    try {
      await runFiles({ remove: '.env.dev' });
      await runFiles({ local: '.env.dev' });
      await runFiles({ lock: 'docker-compose.yml' });
      printed.length = 0;
      await runFiles({});
      let text = printed.join('');
      expect(text).toContain('.env.dev');
      expect(text).toContain('no values for stories yet');
      expect(text).toContain('docker-compose.yml');
      await runFiles({ useMine: '.env.dev' });
      printed.length = 0;
      await runFiles({});
      text = printed.join('');
      expect(text).toContain('ready');
      expect(text).not.toContain(REAL);
      await runFiles({ remove: 'docker-compose.yml' });
      await runFiles({ lockDocker: true });
      expect(readMeta(bp).lockedFiles).toEqual([{ repo: '.', path: 'docker-compose.yml' }]);
      await expect(runFiles({ local: 'docker-compose.yml' })).rejects.toThrow('is in git');
    } finally {
      process.chdir(cwd);
      spy.mockRestore();
    }
  });
});

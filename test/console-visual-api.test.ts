import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { buildPaths } from '../src/core/paths.js';
import { startConsoleServer, type ConsoleServer } from '../src/console/server.js';

const TOKEN = 'e'.repeat(64);
let server: ConsoleServer;
let baseUrl: string;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'squad-viz-'));
  const paths = buildPaths(root);
  await mkdir(paths.squadDir, { recursive: true });
  await mkdir(paths.storiesDir, { recursive: true });
  await mkdir(paths.plansDir, { recursive: true });
  await writeFile(
    paths.configFile,
    yaml.dump({
      version: 1,
      project: { name: 'viz', primaryLanguage: 'ts', projectRoots: ['.'] },
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: ['a1'],
    }),
    'utf8',
  );
  await writeFile(
    paths.secretsFile,
    yaml.dump({
      planner: { anthropic: 'sk-test-key-very-long' },
    }),
    'utf8',
  );
  server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

async function authed(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
}

describe('console visual editors API', () => {
  it('PUT /api/config rejects nested secret key', async () => {
    const res = await authed('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        project: { name: 'bad' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
        planner: { token: 'nope' },
      }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe('invalid_config');
  });

  it('PUT /api/config round-trips a good config', async () => {
    const get0 = (await (await authed('/api/config')).json()) as Record<string, unknown>;
    get0.project = { name: 'roundtrip', primaryLanguage: 'ts' };
    const put = await authed('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(get0),
    });
    expect(put.status).toBe(200);
    const get1 = (await (await authed('/api/config')).json()) as { project: { name: string }; agents: string[] };
    expect(get1.project.name).toBe('roundtrip');
    expect(get1.agents).toEqual(['a1']);
  });

  it('GET /api/secrets is masked; no plaintext for planner key', async () => {
    const res = await authed('/api/secrets');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { planner: { anthropic: string | null } };
    expect(j.planner.anthropic).toBeDefined();
    expect(j.planner.anthropic).toMatch(/[•…]/);
    expect(j.planner.anthropic).not.toContain('sk-test');
  });

  it('PUT /api/secrets merges; GET remains masked', async () => {
    const r = await authed('/api/secrets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planner: { openai: 'ok-openai' } }),
    });
    expect(r.status).toBe(200);
    const j = (await (await authed('/api/secrets')).json()) as { planner: { openai: string | null } };
    expect(j.planner.openai).toMatch(/[•…]/);
  });

  it('POST /api/secrets/test/anthropic returns 200 with ok boolean (live model list or HTTP error from provider)', async () => {
    const res = await authed('/api/secrets/test/anthropic', { method: 'POST' });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; modelCount?: number; status?: number; detail?: string };
    expect(typeof j.ok).toBe('boolean');
  });

  it('GET /api/tracker/search with tracker none returns 400', async () => {
    const res = await authed('/api/tracker/search?q=');
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string; detail: string };
    expect(j.error).toBe('unsupported-tracker');
    expect(j.detail).toBeTruthy();
  });

  it('GET /api/doctor returns checks and summary', async () => {
    const res = await authed('/api/doctor');
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      checks: { status: string }[];
      summary: { ok: number; warn: number; fail: number; skip: number };
    };
    expect(Array.isArray(j.checks)).toBe(true);
    expect(j.checks.length).toBeGreaterThan(3);
    expect(j.summary.ok + j.summary.warn + j.summary.fail + j.summary.skip).toBe(j.checks.length);
  });
});

describe('GET / with UI dist and API smoke', () => {
  it('server healthz', async () => {
    const r = await fetch(`${baseUrl}/healthz`);
    expect(r.status).toBe(200);
  });
});

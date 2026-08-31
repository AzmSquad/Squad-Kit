import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { buildPaths } from '../src/core/paths.js';
import { startConsoleServer, type ConsoleServer } from '../src/console/server.js';
import { resetPlannerAuthProbeCache } from '../src/console/api/planner-auth.js';

/**
 * The suite deletes `CI` (see `test/support/env-isolation.ts`), so nothing else stops
 * `probeClaudeAuth` from spawning a real Agent SDK subprocess against the developer's live Claude
 * login. Every console test therefore runs against this stub. It is a plain function rather than a
 * `vi.fn()` on purpose: `restoreMocks: true` would strip a `vi.fn()`'s implementation before each
 * test and turn a leaked probe into an obscure `undefined` crash instead of an obvious failure.
 */
const probeStub = vi.hoisted(() => ({
  calls: 0,
  result: { ok: true as const } as unknown,
}));
vi.mock('../src/planner/runtimes/auth-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/planner/runtimes/auth-probe.js')>();
  return {
    ...actual,
    probeClaudeAuth: async () => {
      probeStub.calls += 1;
      return probeStub.result;
    },
  };
});

let server: ConsoleServer;
let baseUrl: string;
const TOKEN = 'a'.repeat(64);

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'squad-console-'));
  const paths = buildPaths(root);
  await mkdir(paths.squadDir, { recursive: true });
  await mkdir(paths.storiesDir, { recursive: true });
  await mkdir(paths.plansDir, { recursive: true });
  await writeFile(
    paths.configFile,
    yaml.dump({
      version: 1,
      project: { name: 'console-test', primaryLanguage: 'typescript' },
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: [],
    }),
    'utf8',
  );
  // one feature/story
  const storyDir = path.join(paths.storiesDir, 'demo', '01-pull');
  await mkdir(storyDir, { recursive: true });
  await writeFile(
    path.join(storyDir, 'intake.md'),
    '# Demo\n\n> **Title hint (from CLI):** demo story\n',
    'utf8',
  );

  server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe('console server', () => {
  it('GET /healthz is public and reports the bound port', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; port: number };
    expect(body.ok).toBe(true);
    expect(body.port).toBe(server.port);
  });

  it('GET /api/* requires the token', async () => {
    const noToken = await fetch(`${baseUrl}/api/meta`);
    expect(noToken.status).toBe(401);

    const wrongToken = await fetch(`${baseUrl}/api/meta`, {
      headers: { authorization: 'Bearer ' + 'b'.repeat(64) },
    });
    expect(wrongToken.status).toBe(401);

    const queryToken = await fetch(`${baseUrl}/api/meta?t=${TOKEN}`);
    expect(queryToken.status).toBe(200);

    const headerToken = await fetch(`${baseUrl}/api/meta`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(headerToken.status).toBe(200);
  });

  it('GET /api/stories returns the list', async () => {
    const res = await fetch(`${baseUrl}/api/stories`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const stories = (await res.json()) as { feature: string; id: string; titleHint: string }[];
    expect(stories).toHaveLength(1);
    expect(stories[0]!.feature).toBe('demo');
    expect(stories[0]!.id).toBe('01-pull');
    expect(stories[0]!.titleHint).toBe('demo story');
  });

  it('GET /api/stories/:feature/:id returns the intake content', async () => {
    const res = await fetch(`${baseUrl}/api/stories/demo/01-pull`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intakeContent: string };
    expect(body.intakeContent).toContain('Title hint (from CLI)');
  });

  it('GET /api/copy-plan-prompt returns composed markdown', async () => {
    const res = await fetch(`${baseUrl}/api/copy-plan-prompt?feature=demo&storyId=01-pull`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt: string; bytes: number; feature: string; storyId: string };
    expect(body.feature).toBe('demo');
    expect(body.storyId).toBe('01-pull');
    expect(body.bytes).toBeGreaterThan(100);
    expect(body.prompt).toContain('Title hint (from CLI)');
    expect(body.prompt.length).toBeGreaterThan(500);
  });

  it('GET /api/copy-plan-prompt returns 400 without query params', async () => {
    const res = await fetch(`${baseUrl}/api/copy-plan-prompt`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/config returns config without throwing on the default fixture', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { name: string } };
    expect(body.project.name).toBe('console-test');
  });

  it('GET /api/doctor exposes the auth checks the CLI has', async () => {
    const res = await fetch(`${baseUrl}/api/doctor`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: { id: string; status: string }[] };
    const ids = body.checks.map((c) => c.id);
    // The console renders whatever the registry produces; parity is the point of the assertion.
    expect(ids).toContain('planner-auth-mode');
    expect(ids).toContain('planner-auth-runtime-fit');
    expect(ids).toContain('planner-cred');
    expect(ids).toContain('planner-model');
  });

  it('rejects path-traversal attempts on plans', async () => {
    const res = await fetch(`${baseUrl}/api/plans/${encodeURIComponent('../..')}/etc-passwd`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect([403, 404]).toContain(res.status);
  });

  it('GET /api/dashboard returns aggregator shape', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: { name: string };
      planner: { provider: string; enabled: boolean } | null;
      tracker: { type: string };
      runs: unknown[];
      storyCounts: { total: number; planned: number; unplanned: number };
      stories: { feature: string; id: string }[];
      root: string;
    };
    expect(body.project.name).toBe('console-test');
    expect(body.tracker.type).toBe('none');
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.storyCounts.total).toBeGreaterThanOrEqual(1);
    expect(body.stories.some((s) => s.feature === 'demo' && s.id === '01-pull')).toBe(true);
  });
});

describe('console server stories & plans crud', () => {
  let server: ConsoleServer;
  let baseUrl: string;
  const TOKEN = 'c'.repeat(64);
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'squad-crud-'));
    const paths = buildPaths(root);
    await mkdir(paths.squadDir, { recursive: true });
    await mkdir(paths.storiesDir, { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
    await writeFile(
      paths.configFile,
      yaml.dump({
        version: 1,
        project: { name: 'crud', primaryLanguage: 'ts' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
      }),
      'utf8',
    );
    server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('POST /api/stories creates a story and GET finds it', async () => {
    const res = await fetch(`${baseUrl}/api/stories`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'api-feat', title: 'alpha' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { feature: string; id: string; intakePath: string; storyDir: string };
    expect(created.feature).toBe('api-feat');
    expect(created.id).toBe('alpha');
    expect(fs.existsSync(created.intakePath)).toBe(true);
    expect(created.storyDir).toBe(path.join(root, '.squad', 'stories', 'api-feat', 'alpha'));
  });

  it('POST /api/stories with invalid body returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/stories`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/stories updates intake; 404 for unknown', async () => {
    const patch = await fetch(`${baseUrl}/api/stories/api-feat/alpha`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ intakeContent: '# ok\n' }),
    });
    expect(patch.status).toBe(200);
    const get = await fetch(`${baseUrl}/api/stories/api-feat/alpha`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await get.json()) as { intakeContent: string };
    expect(body.intakeContent).toContain('# ok');

    const miss = await fetch(`${baseUrl}/api/stories/api-feat/nope`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ intakeContent: 'x' }),
    });
    expect(miss.status).toBe(404);
  });

  it('PATCH with forbidden feature slug returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/stories/${encodeURIComponent('..%2F..')}/x`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ intakeContent: 'bad' }),
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /api/stories with trash=1; second delete 404', async () => {
    const del1 = await fetch(`${baseUrl}/api/stories/api-feat/alpha?trash=1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(del1.status).toBe(200);
    const del2 = await fetch(`${baseUrl}/api/stories/api-feat/alpha?trash=1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(del2.status).toBe(404);
  });

  it('GET /api/plans/diff returns changes for two plan files', async () => {
    const fdir = path.join(root, '.squad', 'plans', 'demo');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'a.md'), 'line1\n', 'utf8');
    fs.writeFileSync(path.join(fdir, 'b.md'), 'line2\n', 'utf8');
    const res = await fetch(
      `${baseUrl}/api/plans/diff?feature=demo&a=${encodeURIComponent('a.md')}&b=${encodeURIComponent('b.md')}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { changes: { added?: boolean; value: string }[] };
    expect(j.changes.some((c) => c.added && c.value.includes('2'))).toBe(true);
  });

  it('DELETE /api/plans/:feature/:planFile', async () => {
    const p = path.join(root, '.squad', 'plans', 'demo', 'z.md');
    fs.writeFileSync(p, 'z', 'utf8');
    const res = await fetch(`${baseUrl}/api/plans/demo/z.md?trash=0`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe('console server static UI', () => {
  let server: ConsoleServer;
  let baseUrl: string;
  const TOKEN_UI = 'd'.repeat(64);
  let uiDist: string;
  let prevUiDist: string | undefined;

  beforeAll(async () => {
    prevUiDist = process.env.SQUAD_CONSOLE_UI_DIST;
    uiDist = await mkdtemp(path.join(tmpdir(), 'squad-console-ui-dist-'));
    await mkdir(path.join(uiDist, 'assets'), { recursive: true });
    await writeFile(
      path.join(uiDist, 'index.html'),
      '<!doctype html><html><body><div id="root"></div></body></html>',
      'utf8',
    );
    await writeFile(path.join(uiDist, 'assets', 'main-abc123.js'), 'export {}\n', 'utf8');
    process.env.SQUAD_CONSOLE_UI_DIST = uiDist;

    const root = await mkdtemp(path.join(tmpdir(), 'squad-console-static-'));
    const paths = buildPaths(root);
    await mkdir(paths.squadDir, { recursive: true });
    await mkdir(paths.storiesDir, { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
    await writeFile(
      paths.configFile,
      yaml.dump({
        version: 1,
        project: { name: 'static-ui', primaryLanguage: 'typescript' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
      }),
      'utf8',
    );

    server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN_UI });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    if (prevUiDist === undefined) delete process.env.SQUAD_CONSOLE_UI_DIST;
    else process.env.SQUAD_CONSOLE_UI_DIST = prevUiDist;
  });

  it('GET / returns 200 with SPA HTML and no-store', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.includes('text/html')).toBe(true);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    const html = await res.text();
    expect(html).toContain('<div id="root">');
  });

  it('GET /assets/* returns hashed asset with immutable cache and correct content-type', async () => {
    const res = await fetch(`${baseUrl}/assets/main-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
  });

  it('rejects path traversal under /assets', async () => {
    // `fetch` normalizes `.`/`..` in the URL path before sending; use raw HTTP so the server sees `/assets/...`.
    const u = new URL(baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: '/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd', method: 'GET' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe('console server planner auth', () => {
  let server: ConsoleServer;
  let baseUrl: string;
  let paths: ReturnType<typeof buildPaths>;
  const TOKEN = 'd'.repeat(64);
  const FAKE_KEY = 'sk-ant-fake-api-key-for-this-test-only';
  const FAKE_TOKEN = 'sk-ant-oat01-fake-oauth-token-for-this-test-only';

  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'squad-auth-api-'));
    paths = buildPaths(root);
    await mkdir(paths.squadDir, { recursive: true });
    await mkdir(paths.storiesDir, { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
    await writeFile(
      paths.configFile,
      yaml.dump({
        version: 1,
        project: { name: 'auth-api', primaryLanguage: 'ts' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
        planner: { enabled: true, provider: 'anthropic' },
      }),
      'utf8',
    );
    await writeFile(
      paths.secretsFile,
      yaml.dump({ planner: { anthropic: FAKE_KEY, anthropicOauthToken: FAKE_TOKEN } }),
      'utf8',
    );
    server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    probeStub.calls = 0;
    probeStub.result = { ok: true as const };
    resetPlannerAuthProbeCache();
  });

  const auth = () => ({ authorization: `Bearer ${TOKEN}` });

  it('GET /api/planner-auth returns the offline shape without probing or leaking a credential', async () => {
    const res = await fetch(`${baseUrl}/api/planner-auth`, { headers: auth() });
    expect(res.status).toBe(200);
    const raw = await res.text();
    // The whole point of the endpoint: it describes the credential, it never carries it.
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).not.toContain(FAKE_TOKEN);

    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.provider).toBe('anthropic');
    expect(body.configuredMode).toBe('auto');
    expect(body.account).toBeNull();
    expect(body.apiKeySource).toBeNull();
    expect(body.probe).toBeNull();
    expect(body.loginCommand).toBe('squad auth login');
    expect(body.runtime).toBe('agent-sdk');
    expect(body.binary).toHaveProperty('found');
    expect(body.login).toHaveProperty('present');
    expect(body.login).not.toHaveProperty('token');
    expect(body.resolved).not.toBeNull();
    expect(body.error).toBeNull();
    expect(probeStub.calls).toBe(0);
  });

  it('GET /api/planner-auth?probe=1 fills account, and caches the probe for the next request', async () => {
    probeStub.result = {
      ok: true as const,
      apiKeySource: 'oauth',
      account: { email: 'dev@example.com', organization: 'Acme', subscriptionType: 'max' },
    };

    const first = await fetch(`${baseUrl}/api/planner-auth?probe=1`, { headers: auth() });
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      account: { email?: string } | null;
      apiKeySource: string | null;
      probe: { ran: boolean; ok: boolean } | null;
    };
    expect(body.account?.email).toBe('dev@example.com');
    expect(body.apiKeySource).toBe('oauth');
    expect(body.probe).toEqual({ ran: true, ok: true });
    expect(probeStub.calls).toBe(1);

    const second = await fetch(`${baseUrl}/api/planner-auth?probe=1`, { headers: auth() });
    const secondBody = (await second.json()) as { account: { email?: string } | null };
    expect(secondBody.account?.email).toBe('dev@example.com');
    expect(probeStub.calls).toBe(1);
  });

  it('POST /api/planner-auth/mode persists a valid mode and 400s on an invalid one', async () => {
    const ok = await fetch(`${baseUrl}/api/planner-auth/mode`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'subscription' }),
    });
    expect(ok.status).toBe(200);
    const written = yaml.load(fs.readFileSync(paths.configFile, 'utf8')) as {
      planner: { auth: { anthropic: string } };
    };
    expect(written.planner.auth.anthropic).toBe('subscription');

    const bad = await fetch(`${baseUrl}/api/planner-auth/mode`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'browser' }),
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string; detail: string };
    expect(badBody.error).toBe('invalid_auth_mode');
    // Same sentence `squad config set planner` prints, straight from `normalizeAuthMode`.
    expect(badBody.detail).toContain('must be subscription, api-key, auto');
    expect(badBody.detail).toContain('squad config set planner');
  });

  it('GET /api/secrets masks the stored OAuth token, and PUT with an empty value clears it', async () => {
    const before = await fetch(`${baseUrl}/api/secrets`, { headers: auth() });
    const beforeBody = (await before.json()) as { planner: { anthropicOauthToken: string | null } };
    expect(beforeBody.planner.anthropicOauthToken).not.toBeNull();
    expect(beforeBody.planner.anthropicOauthToken).not.toContain('oat01-fake');

    const cleared = await fetch(`${baseUrl}/api/secrets`, {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ planner: { anthropicOauthToken: '' } }),
    });
    expect(cleared.status).toBe(200);

    const after = await fetch(`${baseUrl}/api/secrets`, { headers: auth() });
    const afterBody = (await after.json()) as {
      planner: { anthropicOauthToken: string | null; anthropic: string | null };
    };
    expect(afterBody.planner.anthropicOauthToken).toBeNull();
    // Clearing the token must not take the API key with it.
    expect(afterBody.planner.anthropic).not.toBeNull();
  });

  it('PUT /api/secrets stores a Notion token and GET returns it masked', async () => {
    const put = await fetch(`${baseUrl}/api/secrets`, {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ tracker: { notion: { token: 'secret_notion_fake_value' } } }),
    });
    expect(put.status).toBe(200);

    const res = await fetch(`${baseUrl}/api/secrets`, { headers: auth() });
    const body = (await res.json()) as { tracker: { notion: { token: string | null } } };
    expect(body.tracker.notion.token).not.toBeNull();
    expect(body.tracker.notion.token).not.toContain('secret_notion_fake_value');
  });

  it('POST /api/runs returns auth_unavailable when subscription mode has no credential', async () => {
    await writeFile(
      paths.configFile,
      yaml.dump({
        version: 1,
        project: { name: 'auth-api', primaryLanguage: 'ts' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
        planner: { enabled: true, provider: 'openai', auth: { anthropic: 'api-key' } },
      }),
      'utf8',
    );
    await writeFile(paths.secretsFile, yaml.dump({ planner: {} }), 'utf8');

    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'demo', storyId: '01-pull' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; mode: string; detail: string };
    expect(body.error).toBe('auth_unavailable');
    expect(body.detail).toContain('No openai API key available');

    const authRes = await fetch(`${baseUrl}/api/planner-auth`, { headers: auth() });
    const authBody = (await authRes.json()) as { resolved: unknown; error: string | null };
    expect(authBody.resolved).toBeNull();
    expect(authBody.error).toContain('No openai API key available');
  });
});

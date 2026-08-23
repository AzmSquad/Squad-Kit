import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { buildPaths } from '../src/core/paths.js';
import { startConsoleServer, type ConsoleServer } from '../src/console/server.js';

const runPlannerMock = vi.hoisted(() => vi.fn());

vi.mock('../src/planner/loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/planner/loop.js')>();
  return { ...actual, runPlanner: runPlannerMock };
});

describe('console runs API', () => {
  let server: ConsoleServer;
  let baseUrl: string;
  const TOKEN = 'e'.repeat(64);
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'squad-runs-api-'));
    const paths = buildPaths(root);
    await mkdir(paths.squadDir, { recursive: true });
    await mkdir(paths.storiesDir, { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
    await writeFile(
      paths.configFile,
      yaml.dump({
        version: 1,
        project: { name: 'runs-api', primaryLanguage: 'typescript' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
        planner: {
          enabled: true,
          provider: 'anthropic',
          mode: 'auto',
          budget: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
        },
      }),
      'utf8',
    );
    const storyDir = path.join(paths.storiesDir, 'demo', '01-pull');
    await mkdir(storyDir, { recursive: true });
    await writeFile(path.join(storyDir, 'intake.md'), '# Demo\n\nStory.\n', 'utf8');
    await writeFile(
      path.join(paths.squadDir, 'secrets.yaml'),
      'planner:\n  anthropic: test-key-for-console-runs\n',
      'utf8',
    );

    server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('POST /api/runs returns 400 when planner is disabled', async () => {
    const soloRoot = await mkdtemp(path.join(tmpdir(), 'squad-runs-off-'));
    const paths = buildPaths(soloRoot);
    await mkdir(paths.squadDir, { recursive: true });
    await mkdir(paths.storiesDir, { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
    await writeFile(
      paths.configFile,
      yaml.dump({
        version: 1,
        project: { name: 'x', primaryLanguage: 'ts' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
      }),
      'utf8',
    );
    const s = await startConsoleServer({ paths, requestedPort: 0, token: 'f'.repeat(64) });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${'f'.repeat(64)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'demo', storyId: '01-pull' }),
      });
      expect(res.status).toBe(400);
      const j = (await res.json()) as { error: string };
      expect(j.error).toBe('planner_disabled');
    } finally {
      await s.close();
    }
  });

  it('POST /api/runs returns 400 auth_unavailable when no credential resolves', async () => {
    const soloRoot = await mkdtemp(path.join(tmpdir(), 'squad-runs-noauth-'));
    const paths = buildPaths(soloRoot);
    await mkdir(paths.squadDir, { recursive: true });
    await mkdir(paths.storiesDir, { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
    await writeFile(
      paths.configFile,
      yaml.dump({
        version: 1,
        project: { name: 'x', primaryLanguage: 'ts' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
        planner: {
          enabled: true,
          provider: 'anthropic',
          mode: 'auto',
          // Pinned so the assertion does not depend on whether the host has a Claude login.
          auth: { anthropic: 'api-key' },
          budget: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
        },
      }),
      'utf8',
    );
    const s = await startConsoleServer({ paths, requestedPort: 0, token: 'g'.repeat(64) });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${'g'.repeat(64)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'demo', storyId: '01-pull' }),
      });
      expect(res.status).toBe(400);
      const j = (await res.json()) as { error: string; mode: string; detail: string };
      expect(j.error).toBe('auth_unavailable');
      expect(j.mode).toBe('api-key');
      expect(j.detail).toContain('squad auth login');
      expect(j.detail).toContain('ANTHROPIC_API_KEY');
    } finally {
      await s.close();
    }
  });

  it('POST /api/runs returns 202 and stream includes started, done, closed', async () => {
    runPlannerMock.mockImplementation(async (opts) => {
      opts.events?.emit({
        kind: 'started',
        runId: opts.runId!,
        provider: 'anthropic',
        model: opts.modelId,
        cacheEnabled: true,
      });
      opts.events?.emit({
        kind: 'runtime_info',
        runId: opts.runId!,
        provider: 'anthropic',
        model: opts.modelId,
        runtimeKind: 'vercel',
        cacheEnabled: true,
        scoutEnabled: true,
        validationEnabled: true,
        budgetCaps: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
      });
      await new Promise((r) => setTimeout(r, 200));
      return {
        planText: '# Plan\n',
        budgetExhausted: false,
        timedOut: false,
        finishedNormally: true,
        iterations: 1,
        stats: {
          turns: 1,
          inputTokens: 3,
          outputTokens: 4,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cacheHitRatio: 0,
          durationMs: 2,
        },
      };
    });

    const post = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'demo', storyId: '01-pull' }),
    });
    expect(post.status).toBe(202);
    const body = (await post.json()) as { runId: string; eventStream: string };
    expect(body.runId).toMatch(/^[0-9a-z]+-[0-9a-f]+$/);
    expect(body.eventStream).toContain(body.runId);

    const stream = await fetch(`${baseUrl}${body.eventStream}?t=${encodeURIComponent(TOKEN)}`);
    expect(stream.ok).toBe(true);
    const text = await stream.text();
    expect(text).toContain('event: started');
    expect(text).toContain('event: runtime_info');
    expect(text).toContain('event: done');
    expect(text).toContain('event: closed');
  });

  it('SSE on rate-limit abort: rate_limit aborted then done without error event', async () => {
    runPlannerMock.mockImplementation(async (opts) => {
      opts.events?.emit({
        kind: 'rate_limit',
        runId: opts.runId!,
        turn: 1,
        retryAfterSec: 600,
        waitSec: 600,
        capSec: 90,
        phase: 'aborted',
        provider: 'anthropic',
        rawBody: 'anthropic 429',
      });
      await new Promise<void>((r) => setTimeout(r, 80));
      throw new Error('anthropic rate limit hit — provider asked us to wait 600s');
    });

    const post = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'demo', storyId: '01-pull' }),
    });
    expect(post.status).toBe(202);
    const body = (await post.json()) as { runId: string; eventStream: string };

    const streamP = fetch(`${baseUrl}${body.eventStream}?t=${encodeURIComponent(TOKEN)}`).then((r) => r.text());
    const text = await streamP;

    expect(text).toContain('event: rate_limit');
    expect(text).toContain('"phase":"aborted"');
    expect(text).toContain('event: done');
    expect(text).toContain('"success":false');
    expect(text).toContain('"partial":true');
    expect(text).not.toContain('event: error');
    expect(text).toContain('event: closed');
  });

  it('SSE when runPlanner succeeds after rate_limit retrying mock emits only structured rate_limit', async () => {
    runPlannerMock.mockImplementation(async (opts) => {
      opts.events?.emit({
        kind: 'rate_limit',
        runId: opts.runId!,
        turn: 1,
        retryAfterSec: 30,
        waitSec: 30,
        capSec: 90,
        phase: 'retrying',
        provider: 'anthropic',
        rawBody: '429',
      });
      await new Promise<void>((r) => setTimeout(r, 80));
      return {
        planText: '# Plan\n',
        budgetExhausted: false,
        timedOut: false,
        finishedNormally: true,
        iterations: 1,
        stats: {
          turns: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cacheHitRatio: 0,
          durationMs: 1,
        },
      };
    });

    const post = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'demo', storyId: '01-pull' }),
    });
    expect(post.status).toBe(202);
    const { eventStream } = (await post.json()) as { runId: string; eventStream: string };

    const streamP = fetch(`${baseUrl}${eventStream}?t=${encodeURIComponent(TOKEN)}`).then((r) => r.text());
    const text = await streamP;
    expect(text).toContain('event: rate_limit');
    expect(text).toContain('"phase":"retrying"');
    expect(text).toContain('event: done');
    expect(text).toContain('"success":true');
    expect(text).not.toContain('event: error');
  });

  it('SSE replays a finished run from JSONL once the active slot is cleared', async () => {
    runPlannerMock.mockImplementation(async (opts) => {
      opts.events?.emit({
        kind: 'started',
        runId: opts.runId!,
        provider: 'anthropic',
        model: opts.modelId,
        cacheEnabled: true,
      });
      await new Promise((r) => setTimeout(r, 80));
      return {
        planText: '# Plan\n',
        budgetExhausted: false,
        timedOut: false,
        finishedNormally: true,
        iterations: 1,
        stats: {
          turns: 1,
          inputTokens: 3,
          outputTokens: 4,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cacheHitRatio: 0,
          durationMs: 2,
        },
      };
    });

    const post = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'demo', storyId: '01-pull' }),
    });
    expect(post.status).toBe(202);
    const { runId } = (await post.json()) as { runId: string };

    const waitStart = Date.now();
    while (Date.now() - waitStart < 10_000) {
      const r = await fetch(`${baseUrl}/api/runs/active`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const rows = (await r.json()) as { runId: string }[];
      if (!rows.some((row) => row.runId === runId)) break;
      await new Promise((res) => setTimeout(res, 25));
    }

    const runsDir = path.join(root, '.squad', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const diskLines = [
      JSON.stringify({
        kind: 'started',
        runId,
        provider: 'anthropic',
        model: 'replay-m',
        cacheEnabled: true,
      }),
      JSON.stringify({
        kind: 'done',
        runId,
        success: true,
        planFile: null,
        partial: false,
        stats: {
          turns: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cacheHitRatio: 0,
          durationMs: 1,
        },
        durationMs: 1,
      }),
    ];
    fs.writeFileSync(path.join(runsDir, `${runId}.events.jsonl`), `${diskLines.join('\n')}\n`, 'utf8');

    const stream = await fetch(`${baseUrl}/api/runs/${runId}/stream?t=${encodeURIComponent(TOKEN)}`);
    expect(stream.ok).toBe(true);
    const text = await stream.text();
    expect(text).toContain('event: started');
    expect(text).toContain('"replay-m"');
    expect(text).toContain('event: done');
    expect(text).toContain('event: closed');
    expect(text).not.toContain('unknown run');
  });

  it('DELETE /api/runs/:id aborts and stream eventually closes', async () => {
    runPlannerMock.mockImplementation(async (opts) => {
      opts.events?.emit({
        kind: 'started',
        runId: opts.runId!,
        provider: 'anthropic',
        model: opts.modelId,
        cacheEnabled: true,
      });
      await new Promise<void>((resolve) => {
        const id = setInterval(() => {
          if (opts.abort?.aborted) {
            clearInterval(id);
            resolve();
          }
        }, 5);
      });
      opts.events?.emit({ kind: 'cancelled', runId: opts.runId! });
      return {
        planText: 'partial',
        budgetExhausted: false,
        timedOut: false,
        finishedNormally: false,
        iterations: 1,
        userCancelled: true,
        stats: {
          turns: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cacheHitRatio: 0,
          durationMs: 5,
        },
      };
    });

    const post = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'demo', storyId: '01-pull' }),
    });
    expect(post.status).toBe(202);
    const { runId, eventStream } = (await post.json()) as { runId: string; eventStream: string };

    const ac = new AbortController();
    const streamP = fetch(`${baseUrl}${eventStream}?t=${encodeURIComponent(TOKEN)}`, {
      signal: ac.signal,
    }).then((r) => r.text());

    await new Promise((r) => setTimeout(r, 30));
    const del = await fetch(`${baseUrl}/api/runs/${runId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(del.status).toBe(200);

    const text = await streamP;
    expect(text).toContain('event: cancelled');
    expect(text).toContain('event: done');
    expect(text).toContain('event: closed');
  });
});

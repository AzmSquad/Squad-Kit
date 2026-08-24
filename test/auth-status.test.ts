import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuthStatus, buildPayload } from '../src/commands/auth/status.js';
import { saveConfig, type SquadConfig } from '../src/core/config.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import type { PlannerAuthMode } from '../src/core/planner-auth.js';

const OAUTH_TOKEN = 'sk-ant-oat01-never-print-me-0123456789';
const API_KEY = 'sk-ant-api03-never-print-me-0123456789';

let tmp: string;
let previousCwd: string;
const prevEnv = { ...process.env };

function config(mode: PlannerAuthMode): SquadConfig {
  return {
    version: 1,
    project: { name: 'n', projectRoots: ['.'] },
    tracker: { type: 'none' },
    naming: { includeTrackerId: false, globalSequence: true },
    agents: [],
    planner: {
      enabled: true,
      provider: 'anthropic',
      mode: 'auto',
      auth: { anthropic: mode },
      budget: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
    },
  };
}

/** `--offline` keeps the probe out of it, so these never spawn the Agent SDK. */
async function statusJson(mode: PlannerAuthMode): Promise<{ raw: string; payload: Record<string, unknown> }> {
  saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), config(mode));
  let raw = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    raw += String(chunk);
    return true;
  });
  await runAuthStatus({ json: true, offline: true });
  spy.mockRestore();
  return { raw, payload: JSON.parse(raw) as Record<string, unknown> };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-auth-status-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, SQUAD_DIR), { recursive: true });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SQUAD_PLANNER_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...prevEnv };
  vi.restoreAllMocks();
});

describe('squad auth status --json', () => {
  it('reports subscription mode and never prints the OAuth token', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = OAUTH_TOKEN;

    const { raw, payload } = await statusJson('subscription');

    expect(payload.mode).toBe('subscription');
    expect(payload.credentialHint).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(payload.runtime).toBe('agent-sdk');
    expect(payload.loggedIn).toBe(true);
    expect(raw).not.toContain(OAUTH_TOKEN);
  });

  it('reports api-key mode and never prints the key', async () => {
    process.env.ANTHROPIC_API_KEY = API_KEY;

    const { raw, payload } = await statusJson('api-key');

    expect(payload.mode).toBe('api-key');
    expect(payload.credentialHint).toBe('ANTHROPIC_API_KEY');
    expect(raw).not.toContain(API_KEY);
  });

  it('keeps a stable key set so scripts can rely on the shape', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = OAUTH_TOKEN;

    const { payload } = await statusJson('subscription');

    // account/apiKeySource are probe-only and absent offline; the rest are always present.
    expect(Object.keys(payload).sort()).toEqual(['credentialHint', 'loggedIn', 'mode', 'reason', 'runtime']);
  });
});

describe('buildPayload', () => {
  const subscription = { mode: 'subscription', reason: 'explicit-config', credentialHint: 'Claude login (macOS Keychain)' } as const;

  it('lets a live probe decide loggedIn and carries the account through', () => {
    const payload = buildPayload({
      auth: subscription,
      provider: 'anthropic',
      planner: undefined,
      probe: { ok: true, apiKeySource: 'oauth', account: { email: 'dev@example.com', subscriptionType: 'max' } },
      fallbackLoggedIn: false,
    });

    expect(payload.loggedIn).toBe(true);
    expect(payload.apiKeySource).toBe('oauth');
    expect(payload.account).toEqual({ email: 'dev@example.com', subscriptionType: 'max' });
  });

  it('reports loggedIn false and omits the account when the probe says not-logged-in', () => {
    const payload = buildPayload({
      auth: subscription,
      provider: 'anthropic',
      planner: undefined,
      probe: { ok: false, kind: 'not-logged-in', detail: 'run squad auth login' },
      fallbackLoggedIn: true,
    });

    expect(payload.loggedIn).toBe(false);
    expect(payload.account).toBeUndefined();
    expect(payload.apiKeySource).toBeUndefined();
  });

  it('falls back to the local resolution when no probe ran', () => {
    expect(
      buildPayload({ auth: subscription, provider: 'anthropic', planner: undefined, probe: undefined, fallbackLoggedIn: true })
        .loggedIn,
    ).toBe(true);
  });
});

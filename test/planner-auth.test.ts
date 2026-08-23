import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeAuth,
  detectClaudeLogin,
  resolvePlannerAuth,
  PlannerAuthUnavailableError,
  type LoginProbe,
  type PlannerAuthMode,
  type PlannerAuthReason,
  type ResolvedPlannerAuth,
} from '../src/core/planner-auth.js';
import type { CredentialSource } from '../src/core/planner-models.js';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/core/config.js';

const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-auth-'));
  file = path.join(tmp, 'config.yaml');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
});

function writeConfig(plannerLines: string[]): void {
  fs.writeFileSync(
    file,
    [
      'version: 1',
      'project: { name: x, projectRoots: ["."] }',
      'tracker: { type: none }',
      'naming: { includeTrackerId: false, globalSequence: true }',
      'agents: []',
      'planner:',
      '  enabled: true',
      '  provider: anthropic',
      ...plannerLines,
    ].join('\n'),
    'utf8',
  );
}

// ── 1. Merge defaults ────────────────────────────────────────────────────────

describe('planner.auth merge', () => {
  it('defaults planner.auth.anthropic to auto when the block is absent', () => {
    writeConfig([]);
    expect(loadConfig(file).planner?.auth).toEqual({ anthropic: 'auto' });
  });

  it('round-trips an explicit subscription through saveConfig → loadConfig', () => {
    writeConfig(['  auth:', '    anthropic: subscription']);
    const loaded = loadConfig(file);
    expect(loaded.planner?.auth?.anthropic).toBe('subscription');

    const out = path.join(tmp, 'saved.yaml');
    saveConfig(out, loaded);
    expect(loadConfig(out).planner?.auth?.anthropic).toBe('subscription');
  });

  it('normalises a capitalised / padded mode', () => {
    writeConfig(['  auth:', '    anthropic: "  Subscription  "']);
    expect(loadConfig(file).planner?.auth?.anthropic).toBe('subscription');
  });

  it('silently drops unknown keys under auth', () => {
    writeConfig(['  auth:', '    openai: subscription']);
    expect(loadConfig(file).planner?.auth).toEqual({ anthropic: 'auto' });
  });

  it('leaves planner undefined when there is no planner block at all', () => {
    saveConfig(file, DEFAULT_CONFIG);
    expect(loadConfig(file).planner).toBeUndefined();
  });

  // ── 2. Invalid mode ────────────────────────────────────────────────────────
  it('rejects an unknown mode, naming the accepted values and the fix command', () => {
    writeConfig(['  auth:', '    anthropic: browser']);
    let message = '';
    try {
      loadConfig(file);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/planner\.auth\.anthropic/);
    expect(message).toMatch(/subscription/);
    expect(message).toMatch(/api-key/);
    expect(message).toMatch(/auto/);
    expect(message).toMatch(/squad config set planner/);
    expect(message).toContain(file);
  });

  it('rejects a non-string mode', () => {
    writeConfig(['  auth:', '    anthropic: 42']);
    expect(() => loadConfig(file)).toThrow(/planner\.auth\.anthropic/);
  });
});

// ── 3–5. Resolver ────────────────────────────────────────────────────────────

const KEY: CredentialSource = { value: 'sk-ant-key', source: 'env', detail: 'ANTHROPIC_API_KEY' };

const LOGINS = {
  none: { present: false, hint: 'none', detail: 'no Claude login detected' } as LoginProbe,
  store: { present: true, hint: 'credential-store', detail: 'macOS Keychain' } as LoginProbe,
  token: {
    present: true,
    hint: 'oauth-token-env',
    detail: 'CLAUDE_CODE_OAUTH_TOKEN',
    token: 'oat-abc',
  } as LoginProbe,
};

type LoginName = keyof typeof LOGINS;
type Expected = { mode: 'subscription' | 'api-key'; reason: PlannerAuthReason } | 'throws';

const MATRIX: Array<[PlannerAuthMode, LoginName, boolean, Expected]> = [
  // configuredMode = subscription — never throws, the SDK is the authority.
  ['subscription', 'none', false, { mode: 'subscription', reason: 'explicit-config' }],
  ['subscription', 'none', true, { mode: 'subscription', reason: 'explicit-config' }],
  ['subscription', 'store', false, { mode: 'subscription', reason: 'explicit-config' }],
  ['subscription', 'store', true, { mode: 'subscription', reason: 'explicit-config' }],
  ['subscription', 'token', false, { mode: 'subscription', reason: 'explicit-config' }],
  ['subscription', 'token', true, { mode: 'subscription', reason: 'explicit-config' }],
  // configuredMode = api-key — the login is irrelevant; no key is a hard failure.
  ['api-key', 'none', false, 'throws'],
  ['api-key', 'none', true, { mode: 'api-key', reason: 'explicit-config' }],
  ['api-key', 'store', false, 'throws'],
  ['api-key', 'store', true, { mode: 'api-key', reason: 'explicit-config' }],
  ['api-key', 'token', false, 'throws'],
  ['api-key', 'token', true, { mode: 'api-key', reason: 'explicit-config' }],
  // configuredMode = auto — subscription wins over a present key.
  ['auto', 'none', false, 'throws'],
  ['auto', 'none', true, { mode: 'api-key', reason: 'auto-fallback-api-key' }],
  ['auto', 'store', false, { mode: 'subscription', reason: 'auto-login-detected' }],
  ['auto', 'store', true, { mode: 'subscription', reason: 'auto-login-detected' }],
  ['auto', 'token', false, { mode: 'subscription', reason: 'auto-oauth-token' }],
  ['auto', 'token', true, { mode: 'subscription', reason: 'auto-oauth-token' }],
];

describe('resolvePlannerAuth — anthropic matrix', () => {
  it.each(MATRIX)('mode=%s login=%s apiKey=%s', (configuredMode, loginName, hasKey, expected) => {
    const call = () =>
      resolvePlannerAuth({
        provider: 'anthropic',
        configuredMode,
        apiKey: hasKey ? KEY : undefined,
        login: LOGINS[loginName],
      });

    if (expected === 'throws') {
      expect(call).toThrow(PlannerAuthUnavailableError);
      return;
    }
    const auth = call();
    expect(auth.mode).toBe(expected.mode);
    expect(auth.reason).toBe(expected.reason);
  });

  it('covers all 18 mode × login × apiKey combinations', () => {
    expect(MATRIX).toHaveLength(18);
  });

  it('treats an undefined configuredMode as auto', () => {
    const auth = resolvePlannerAuth({ provider: 'anthropic', apiKey: KEY, login: LOGINS.none });
    expect(auth).toMatchObject({ mode: 'api-key', reason: 'auto-fallback-api-key' });
  });

  it('carries the token and its source when a setup-token login was found', () => {
    const auth = resolvePlannerAuth({ provider: 'anthropic', configuredMode: 'auto', login: LOGINS.token });
    expect(auth).toEqual({
      mode: 'subscription',
      reason: 'auto-oauth-token',
      oauthToken: 'oat-abc',
      oauthTokenSource: 'env',
      loginHint: 'oauth-token-env',
    });
  });

  it('omits the token for a credential-store login', () => {
    const auth = resolvePlannerAuth({ provider: 'anthropic', configuredMode: 'auto', login: LOGINS.store });
    expect(auth).toEqual({
      mode: 'subscription',
      reason: 'auto-login-detected',
      loginHint: 'credential-store',
    });
  });

  it('names both recovery paths when nothing resolves', () => {
    let message = '';
    try {
      resolvePlannerAuth({ provider: 'anthropic', configuredMode: 'auto', login: LOGINS.none });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/squad auth login/);
    expect(message).toMatch(/squad config set planner/);
    expect(message).toMatch(/ANTHROPIC_API_KEY/);
  });
});

// ── 4. Explicit subscription with no detected login ─────────────────────────

describe('resolvePlannerAuth — explicit subscription without a detected login', () => {
  it('does not throw and reports loginHint "assumed"', () => {
    const auth = resolvePlannerAuth({
      provider: 'anthropic',
      configuredMode: 'subscription',
      login: LOGINS.none,
    });
    expect(auth).toEqual({ mode: 'subscription', reason: 'explicit-config', loginHint: 'assumed' });
  });
});

// ── 5. Non-Anthropic providers ──────────────────────────────────────────────

describe('resolvePlannerAuth — non-Anthropic providers', () => {
  it.each(['openai', 'google'] as const)('%s resolves api-key and ignores a login', (provider) => {
    const auth = resolvePlannerAuth({
      provider,
      configuredMode: 'subscription',
      apiKey: { value: 'k', source: 'secrets', detail: '.squad/secrets.yaml' },
      login: LOGINS.store,
    });
    expect(auth).toMatchObject({ mode: 'api-key', reason: 'provider-is-api-key-only' });
  });

  it.each(['openai', 'google'] as const)('%s throws without a key even when logged in', (provider) => {
    let message = '';
    try {
      resolvePlannerAuth({ provider, configuredMode: 'subscription', login: LOGINS.store });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/squad config set planner/);
    expect(message).not.toMatch(/squad auth login/);
  });
});

// ── 6. detectClaudeLogin precedence ─────────────────────────────────────────

describe('detectClaudeLogin', () => {
  const envKeys = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] as const;
  let savedEnv: Record<string, string | undefined>;
  let savedPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    for (const k of envKeys) delete process.env[k];
    savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
  });

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  it('prefers the env token over a secrets token and the credential store', () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValue('');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-env';
    const probe = detectClaudeLogin({ planner: { anthropicOauthToken: 'oat-file' } });
    expect(probe).toEqual({
      present: true,
      hint: 'oauth-token-env',
      detail: 'CLAUDE_CODE_OAUTH_TOKEN',
      token: 'oat-env',
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('prefers the secrets token over the credential store', () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValue('');
    const probe = detectClaudeLogin({ planner: { anthropicOauthToken: 'oat-file' } });
    expect(probe).toMatchObject({ present: true, hint: 'oauth-token-secrets', token: 'oat-file' });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('ignores an empty-string env token and falls through', () => {
    setPlatform('darwin');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '   ';
    execFileSyncMock.mockReturnValue('');
    const probe = detectClaudeLogin({ planner: { anthropicOauthToken: 'oat-file' } });
    expect(probe.hint).toBe('oauth-token-secrets');
  });

  it('ignores an empty-string secrets token', () => {
    setPlatform('darwin');
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(detectClaudeLogin({ planner: { anthropicOauthToken: '' } })).toMatchObject({
      present: false,
      hint: 'none',
    });
  });

  it('reports the macOS Keychain when the security lookup exits 0', () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValue('');
    expect(detectClaudeLogin()).toEqual({
      present: true,
      hint: 'credential-store',
      detail: 'macOS Keychain',
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      { stdio: 'ignore', timeout: 2000 },
    );
  });

  it('never asks the Keychain to print the secret', () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValue('');
    detectClaudeLogin();
    const args = execFileSyncMock.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('-w');
    expect(args).not.toContain('-g');
  });

  it('returns none when the security binary is missing', () => {
    setPlatform('darwin');
    execFileSyncMock.mockImplementation(() => {
      const err = new Error('spawnSync security ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(detectClaudeLogin()).toMatchObject({ present: false, hint: 'none' });
  });

  it('finds .credentials.json under CLAUDE_CONFIG_DIR on linux', () => {
    setPlatform('linux');
    const dir = path.join(tmp, 'claude-home');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8');
    process.env.CLAUDE_CONFIG_DIR = dir;
    expect(detectClaudeLogin()).toMatchObject({ present: true, hint: 'credential-store' });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('resolves a relative CLAUDE_CONFIG_DIR against process.cwd()', () => {
    setPlatform('linux');
    const previousCwd = process.cwd();
    try {
      fs.mkdirSync(path.join(tmp, 'rel'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'rel', '.credentials.json'), '{}', 'utf8');
      process.chdir(tmp);
      process.env.CLAUDE_CONFIG_DIR = 'rel';
      expect(detectClaudeLogin()).toMatchObject({ present: true, hint: 'credential-store' });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('returns none on linux when the credentials file is absent', () => {
    setPlatform('linux');
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'nope');
    expect(detectClaudeLogin()).toEqual({
      present: false,
      hint: 'none',
      detail: 'no Claude login detected',
    });
  });

  it('returns none when os.homedir() throws', () => {
    setPlatform('linux');
    vi.spyOn(os, 'homedir').mockImplementation(() => {
      throw new Error('no home');
    });
    expect(detectClaudeLogin()).toMatchObject({ present: false, hint: 'none' });
  });
});

// ── 7. describeAuth never leaks ─────────────────────────────────────────────

describe('describeAuth', () => {
  const secrets = Array.from({ length: 25 }, (_, i) =>
    `sk-ant-${i}-${Math.random().toString(36).slice(2)}${'x'.repeat(i)}`,
  );

  it('never serialises the key or the token', () => {
    for (const secret of secrets) {
      const candidates: ResolvedPlannerAuth[] = [
        { mode: 'api-key', reason: 'explicit-config', key: secret, source: 'env', detail: 'ANTHROPIC_API_KEY' },
        { mode: 'api-key', reason: 'auto-fallback-api-key', key: secret, source: 'secrets', detail: '.squad/secrets.yaml' },
        { mode: 'subscription', reason: 'auto-oauth-token', oauthToken: secret, oauthTokenSource: 'env', loginHint: 'oauth-token-env' },
        { mode: 'subscription', reason: 'auto-oauth-token', oauthToken: secret, oauthTokenSource: 'secrets', loginHint: 'oauth-token-secrets' },
      ];
      for (const auth of candidates) {
        const serialized = JSON.stringify(describeAuth(auth));
        expect(serialized).not.toContain(secret);
        expect(Object.keys(describeAuth(auth))).toEqual(['mode', 'reason', 'credentialHint']);
      }
    }
  });

  it('reports a human credential hint per source', () => {
    expect(
      describeAuth({ mode: 'api-key', reason: 'explicit-config', key: 'k', source: 'env', detail: 'ANTHROPIC_API_KEY' }),
    ).toEqual({ mode: 'api-key', reason: 'explicit-config', credentialHint: 'ANTHROPIC_API_KEY' });

    expect(
      describeAuth({ mode: 'subscription', reason: 'explicit-config', loginHint: 'assumed' }).credentialHint,
    ).toMatch(/assumed/);

    expect(
      describeAuth({ mode: 'subscription', reason: 'auto-login-detected', loginHint: 'credential-store' }).credentialHint,
    ).toMatch(/Claude login/);
  });
});

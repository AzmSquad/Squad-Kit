import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResolvedPlannerAuth } from '../src/core/planner-auth.js';

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('../src/core/claude-binary.js', () => ({ resolveClaudeBinary: () => binary }));

let binary: { path: string; source: 'bundled' | 'path' } | undefined;

const { probeClaudeAuth } = await import('../src/planner/runtimes/auth-probe.js');

const SUBSCRIPTION: ResolvedPlannerAuth = {
  mode: 'subscription',
  reason: 'explicit-config',
  loginHint: 'credential-store',
};

/** Minimal stand-in for the SDK `Query`: an async iterable that also exposes `accountInfo()`. */
function fakeQuery(accountInfo: () => Promise<unknown>) {
  return {
    accountInfo,
    async *[Symbol.asyncIterator]() {
      /* the probe never drains the stream */
    },
    return: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  binary = { path: '/fake/claude', source: 'bundled' };
  queryMock.mockReset();
});

describe('probeClaudeAuth', () => {
  it('reports the account and apiKeySource without consuming a model turn', async () => {
    queryMock.mockReturnValue(
      fakeQuery(async () => ({
        email: 'dev@example.com',
        organization: 'Acme',
        subscriptionType: 'max',
        apiKeySource: 'oauth',
      })),
    );

    const res = await probeClaudeAuth(SUBSCRIPTION);

    expect(res).toEqual({
      ok: true,
      apiKeySource: 'oauth',
      account: { email: 'dev@example.com', organization: 'Acme', subscriptionType: 'max' },
    });
    // The prompt must be a stream that never yields, so no user turn is ever written to stdin.
    const passed = queryMock.mock.calls[0]?.[0] as { prompt: AsyncIterable<unknown> };
    expect(passed.prompt[Symbol.asyncIterator]).toBeTypeOf('function');
  });

  it('refuses to call a subscription credential ok when no account comes back', async () => {
    // `accountInfo()` resolves off the subprocess `initialize` response, which succeeds even for an
    // invalid or expired token. An empty answer must not render as "signed in".
    queryMock.mockReturnValue(fakeQuery(async () => ({})));

    const res = await probeClaudeAuth(SUBSCRIPTION);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.detail).toMatch(/could not be verified/i);
    expect(res.detail).toMatch(/squad auth login/);
  });

  it('reports a token credential as resolved-but-unverifiable rather than invalid', async () => {
    // Measured against SDK 0.2.126: CLAUDE_CODE_OAUTH_TOKEN auth returns {tokenSource, apiProvider}
    // and never an account — for a VALID token as much as a bogus one. Failing here would flag
    // every healthy `squad auth login`.
    queryMock.mockReturnValue(
      fakeQuery(async () => ({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' })),
    );

    const res = await probeClaudeAuth(SUBSCRIPTION);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.credentialSource).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(res.unverifiable).toMatch(/only be confirmed by an actual planning run/);
    expect(res.account).toBeUndefined();
  });

  it('treats a real account payload as verified, with no caveat', async () => {
    queryMock.mockReturnValue(
      fakeQuery(async () => ({ email: 'dev@example.com', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' })),
    );

    const res = await probeClaudeAuth(SUBSCRIPTION);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.unverifiable).toBeUndefined();
    expect(res.account).toEqual({ email: 'dev@example.com', subscriptionType: 'Claude Pro' });
  });

  it('still accepts api-key auth with no account, which legitimately has none', async () => {
    queryMock.mockReturnValue(fakeQuery(async () => ({})));

    const res = await probeClaudeAuth({
      mode: 'api-key',
      reason: 'explicit-config',
      key: 'sk-ant-test',
      source: 'env',
      detail: 'ANTHROPIC_API_KEY',
    });

    expect(res.ok).toBe(true);
  });

  it('maps authentication_failed to not-logged-in', async () => {
    queryMock.mockImplementation(() => {
      throw new Error('stream error: authentication_failed');
    });

    const res = await probeClaudeAuth(SUBSCRIPTION);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.kind).toBe('not-logged-in');
    expect(res.detail).toMatch(/squad auth login/);
  });

  it('maps an expiry-flavoured authentication_failed to expired', async () => {
    queryMock.mockImplementation(() => {
      throw new Error('authentication_failed: the credential has expired, refresh required');
    });

    const res = await probeClaudeAuth(SUBSCRIPTION);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.kind).toBe('expired');
  });

  it('maps oauth_org_not_allowed to org-not-allowed', async () => {
    queryMock.mockImplementation(() => {
      throw new Error('oauth_org_not_allowed');
    });

    const res = await probeClaudeAuth(SUBSCRIPTION);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.kind).toBe('org-not-allowed');
  });

  it('times out inside the configured budget instead of hanging', async () => {
    queryMock.mockReturnValue(fakeQuery(() => new Promise(() => {})));

    const started = Date.now();
    const res = await probeClaudeAuth(SUBSCRIPTION, { timeoutMs: 60 });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('short-circuits with no-binary and never touches the SDK', async () => {
    binary = undefined;

    const res = await probeClaudeAuth(SUBSCRIPTION);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.kind).toBe('no-binary');
    expect(queryMock).not.toHaveBeenCalled();
  });
});

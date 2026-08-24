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

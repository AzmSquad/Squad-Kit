import { describe, it, expect } from 'vitest';
import {
  AUTH_SHAPED_SDK_ERRORS,
  authErrorContextFrom,
  authErrorMessage,
  detectAuthShapedSdkError,
  type AuthShapedSdkError,
} from '../../src/planner/auth-errors.js';
import { apiKeyAuth, subscriptionAuth } from '../support/planner-auth-fixtures.js';

describe('detectAuthShapedSdkError', () => {
  it('recognises every auth-shaped signal from an assistant `error` field', () => {
    for (const signal of AUTH_SHAPED_SDK_ERRORS) {
      expect(detectAuthShapedSdkError(signal)).toBe(signal);
    }
  });

  it('recognises a signal inside a result message `errors` array', () => {
    expect(detectAuthShapedSdkError(['something went wrong: authentication_failed'])).toBe(
      'authentication_failed',
    );
  });

  it('ignores non-auth signals so retry/turn handling stays unchanged', () => {
    for (const other of ['invalid_request', 'server_error', 'unknown', 'max_output_tokens', undefined, 42]) {
      expect(detectAuthShapedSdkError(other)).toBeUndefined();
    }
  });
});

describe('authErrorMessage', () => {
  const cases: Array<{
    signal: AuthShapedSdkError;
    mode: 'subscription' | 'api-key';
    contains: string[];
    excludes?: string[];
  }> = [
    {
      signal: 'authentication_failed',
      mode: 'subscription',
      contains: ['Claude login failed or expired', 'squad auth login'],
    },
    {
      signal: 'authentication_failed',
      mode: 'api-key',
      contains: ['API key', 'squad config set planner', 'ANTHROPIC_API_KEY'],
      excludes: ['squad auth login'],
    },
    {
      signal: 'oauth_org_not_allowed',
      mode: 'subscription',
      contains: ['organization is not allowed', 'Ask your admin', 'squad config set planner'],
    },
    {
      signal: 'oauth_org_not_allowed',
      mode: 'api-key',
      contains: ['organization is not allowed'],
    },
    {
      signal: 'billing_error',
      mode: 'subscription',
      contains: ['Your Claude plan cannot run this request', 'claude.ai/settings'],
    },
    {
      signal: 'billing_error',
      mode: 'api-key',
      contains: ['billing', 'console.anthropic.com'],
    },
    {
      signal: 'rate_limit',
      mode: 'subscription',
      contains: ['usage limit reached', 'same limits as Claude and Claude Code', 'switch to an API key'],
      excludes: ['Full runbook'],
    },
    {
      signal: 'rate_limit',
      mode: 'api-key',
      // Unchanged 0.11.0 copy, straight from `rateLimitMessage`.
      contains: ['anthropic rate limit hit', 'Recovery options', 'Full runbook'],
    },
  ];

  for (const c of cases) {
    it(`maps ${c.signal} in ${c.mode} mode`, () => {
      const msg = authErrorMessage(c.signal, { mode: c.mode });
      for (const needle of c.contains) expect(msg).toContain(needle);
      for (const needle of c.excludes ?? []) expect(msg).not.toContain(needle);
    });
  }

  it('points a stale stored token at `squad auth logout` as well as login', () => {
    const msg = authErrorMessage('authentication_failed', {
      mode: 'subscription',
      oauthTokenSource: 'secrets',
    });
    expect(msg).toContain('squad auth logout');
    expect(msg).toContain('squad auth login');
    expect(msg).toContain('.squad/secrets.yaml');
  });

  it('tells an env-supplied token holder to unset the variable', () => {
    const msg = authErrorMessage('authentication_failed', {
      mode: 'subscription',
      oauthTokenSource: 'env',
    });
    expect(msg).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(msg).toContain('squad auth login');
  });

  it('never leaks credential material', () => {
    for (const signal of AUTH_SHAPED_SDK_ERRORS) {
      for (const auth of [
        apiKeyAuth('sk-super-secret'),
        subscriptionAuth({ oauthToken: 'oauth-super-secret', source: 'secrets' }),
      ]) {
        const msg = authErrorMessage(signal, authErrorContextFrom(auth));
        expect(msg).not.toContain('sk-super-secret');
        expect(msg).not.toContain('oauth-super-secret');
      }
    }
  });
});

describe('authErrorContextFrom', () => {
  it('carries the oauth token source for subscription auth', () => {
    expect(authErrorContextFrom(subscriptionAuth({ oauthToken: 't', source: 'env' }))).toEqual({
      mode: 'subscription',
      oauthTokenSource: 'env',
    });
    expect(authErrorContextFrom(subscriptionAuth())).toEqual({ mode: 'subscription' });
    expect(authErrorContextFrom(apiKeyAuth())).toEqual({ mode: 'api-key' });
  });
});

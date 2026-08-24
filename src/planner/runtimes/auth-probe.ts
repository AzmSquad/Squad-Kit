import type { ResolvedPlannerAuth } from '../../core/planner-auth.js';
import { resolveClaudeBinary } from '../../core/claude-binary.js';
import { authErrorContextFrom, authErrorMessage, detectAuthShapedSdkError } from '../auth-errors.js';
import { buildSdkEnv } from './sdk-env.js';

export interface ProbeAccount {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}

export type ProbeClaudeAuthResult =
  | {
      ok: true;
      apiKeySource?: string;
      account?: ProbeAccount;
      /**
       * Set when the SDK resolved a credential *source* but could not confirm the credential
       * works. Token auth always lands here — see `probeClaudeAuth`. Callers should report
       * "signed in, not verifiable" rather than either "verified" or "invalid".
       */
      unverifiable?: string;
      /** e.g. `CLAUDE_CODE_OAUTH_TOKEN` — which source the SDK says it is using. */
      credentialSource?: string;
    }
  | {
      ok: false;
      kind: 'not-logged-in' | 'expired' | 'org-not-allowed' | 'no-binary' | 'timeout' | 'unknown';
      detail: string;
    };

/** Default hard ceiling. `squad auth status` and `squad doctor` must never hang on a wedged login. */
export const DEFAULT_AUTH_PROBE_TIMEOUT_MS = 10_000;

type SdkQuery = AsyncIterable<unknown> & {
  accountInfo?: () => Promise<unknown>;
  return?: (value?: unknown) => Promise<unknown>;
};

function readAccount(raw: unknown): {
  account?: ProbeAccount;
  apiKeySource?: string;
  tokenSource?: string;
  apiProvider?: string;
} {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const account: ProbeAccount = {};
  if (typeof o.email === 'string') account.email = o.email;
  if (typeof o.organization === 'string') account.organization = o.organization;
  if (typeof o.subscriptionType === 'string') account.subscriptionType = o.subscriptionType;
  const apiKeySource = typeof o.apiKeySource === 'string' ? o.apiKeySource : undefined;
  const tokenSource = typeof o.tokenSource === 'string' ? o.tokenSource : undefined;
  const apiProvider = typeof o.apiProvider === 'string' ? o.apiProvider : undefined;
  return {
    account: Object.keys(account).length > 0 ? account : undefined,
    apiKeySource,
    tokenSource,
    apiProvider,
  };
}

const EXPIRED_HINT = /expire|refresh|revoked|no longer valid/i;
const NO_BINARY_HINT = /native cli binary|executable not found|claude code executable/i;

function mapProbeFailure(err: unknown, auth: ResolvedPlannerAuth): ProbeClaudeAuthResult {
  const message = err instanceof Error ? err.message : String(err);
  const signal = detectAuthShapedSdkError(message);
  if (signal === 'authentication_failed') {
    return {
      ok: false,
      kind: EXPIRED_HINT.test(message) ? 'expired' : 'not-logged-in',
      // Reuse story 15's mapper rather than writing a second one: the copy a failed probe prints
      // must match the copy a failed run prints, or the two disagree about the same credential.
      detail: authErrorMessage('authentication_failed', authErrorContextFrom(auth)),
    };
  }
  if (signal === 'oauth_org_not_allowed') {
    return {
      ok: false,
      kind: 'org-not-allowed',
      detail: authErrorMessage('oauth_org_not_allowed', authErrorContextFrom(auth)),
    };
  }
  if (signal) {
    return { ok: false, kind: 'unknown', detail: authErrorMessage(signal, authErrorContextFrom(auth)) };
  }
  if (NO_BINARY_HINT.test(message)) {
    return { ok: false, kind: 'no-binary', detail: message.slice(0, 300) };
  }
  return { ok: false, kind: 'unknown', detail: message.slice(0, 300) };
}

/**
 * Ask the Agent SDK who we are, without spending anything.
 *
 * `Query.accountInfo()` is `(await this.initialization).account` — it resolves from the
 * control-protocol `initialize` response the subprocess emits on startup, and its `AccountInfo`
 * already carries `apiKeySource` alongside `email` / `organization` / `subscriptionType`. So the
 * plan's option (a) (drive `query()` to the `system`/`init` message and abort) is unnecessary:
 * option (b) alone yields everything and provably consumes no model turn.
 *
 * The prompt is a stream that never yields. In streaming-input mode the SDK writes nothing to the
 * subprocess's stdin until the iterable produces a message, so no user turn is ever sent — this is
 * the difference between "we aborted fast enough" and "no request existed". The environment comes
 * from the same `buildSdkEnv()` the runtime uses, so the probe sees exactly the credential a real
 * run would see.
 */
export async function probeClaudeAuth(
  auth: ResolvedPlannerAuth,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeClaudeAuthResult> {
  if (!resolveClaudeBinary()) {
    return {
      ok: false,
      kind: 'no-binary',
      detail:
        'No `claude` executable found. Reinstall squad-kit so the Agent SDK platform binary is present, ' +
        'or install Claude Code and put `claude` on your PATH.',
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTH_PROBE_TIMEOUT_MS;

  let releaseInput: () => void = () => {};
  const inputClosed = new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
  async function* neverSends(): AsyncGenerator<never, void, unknown> {
    await inputClosed;
  }

  let q: SdkQuery | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    q = (query as unknown as (a: unknown) => SdkQuery)({
      prompt: neverSends(),
      options: {
        tools: [] as string[],
        settingSources: [] as [],
        persistSession: false,
        maxTurns: 1,
        env: buildSdkEnv(auth),
      },
    });

    const timedOut = Symbol('timeout');
    const info = await Promise.race([
      typeof q.accountInfo === 'function' ? q.accountInfo() : Promise.resolve(undefined),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);

    if (info === timedOut) {
      return {
        ok: false,
        kind: 'timeout',
        detail: `The Claude auth check did not answer within ${timeoutMs}ms.`,
      };
    }

    const { account, apiKeySource, tokenSource, apiProvider } = readAccount(info);
    const base = { ...(apiKeySource ? { apiKeySource } : {}), ...(account ? { account } : {}) };

    /*
     * What `accountInfo()` can and cannot tell us. It resolves from the subprocess's `initialize`
     * response, which succeeds whether or not the credential is any good — the CLI does not
     * validate it until a real request. Measured against 0.2.126:
     *
     *   valid keychain login -> { email, organization, subscriptionType, apiProvider }
     *   CLAUDE_CODE_OAUTH_TOKEN, *valid or bogus* -> { tokenSource, apiProvider }
     *
     * So token auth NEVER reports an account, and the payload cannot separate a good token from a
     * bad one. Claiming "verified" there would be a lie; claiming "invalid or expired" would flag
     * every healthy `squad auth login`. Report it as what it is: a resolved source we cannot check.
     */
    if (auth.mode !== 'subscription') return { ok: true, ...base };

    if (account) return { ok: true, ...base };

    if (tokenSource || apiProvider) {
      return {
        ok: true,
        ...base,
        ...(tokenSource ? { credentialSource: tokenSource } : {}),
        unverifiable:
          `The Agent SDK resolved ${tokenSource ?? 'a credential'}, but token auth reports no account, ` +
          'so its validity can only be confirmed by an actual planning run.',
      };
    }

    // Nothing at all came back — not even a credential source. That is genuinely suspicious.
    return {
      ok: false,
      kind: 'unknown',
      detail:
        'The Claude login reported neither an account nor a credential source, so it could not be ' +
        'verified. Run `squad auth login` to sign in again.',
    };
  } catch (err) {
    return mapProbeFailure(err, auth);
  } finally {
    if (timer) clearTimeout(timer);
    releaseInput();
    try {
      await q?.return?.();
    } catch {
      // Closing a query that already errored is not interesting.
    }
  }
}

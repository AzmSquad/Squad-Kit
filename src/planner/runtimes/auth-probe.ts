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
  | { ok: true; apiKeySource?: string; account?: ProbeAccount }
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

function readAccount(raw: unknown): { account?: ProbeAccount; apiKeySource?: string } {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const account: ProbeAccount = {};
  if (typeof o.email === 'string') account.email = o.email;
  if (typeof o.organization === 'string') account.organization = o.organization;
  if (typeof o.subscriptionType === 'string') account.subscriptionType = o.subscriptionType;
  const apiKeySource = typeof o.apiKeySource === 'string' ? o.apiKeySource : undefined;
  return {
    account: Object.keys(account).length > 0 ? account : undefined,
    apiKeySource,
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

    const { account, apiKeySource } = readAccount(info);

    // `accountInfo()` resolves from the subprocess's `initialize` response, which succeeds whether or
    // not the credential is any good — the CLI does not validate it until a real request. A working
    // subscription login answers with an email/organization/plan; an invalid or expired one answers
    // with nothing. Reporting that as `ok` would tell the user they are signed in right up until
    // their next planning run fails. API-key mode legitimately has no claude.ai account attached, so
    // this only applies to subscription auth.
    if (auth.mode === 'subscription' && !account && !apiKeySource) {
      return {
        ok: false,
        kind: 'unknown',
        detail:
          'The Claude login did not report an account, so it could not be verified. The credential may be ' +
          'invalid or expired — run `squad auth login` to sign in again.',
      };
    }

    return { ok: true, ...(apiKeySource ? { apiKeySource } : {}), ...(account ? { account } : {}) };
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

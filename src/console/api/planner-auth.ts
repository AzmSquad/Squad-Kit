import { z } from 'zod';
import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { loadConfig, saveConfig, type SquadConfig } from '../../core/config.js';
import { loadSecrets } from '../../core/secrets.js';
import {
  describeAuth,
  detectClaudeLogin,
  PlannerAuthUnavailableError,
  type PlannerAuthMode,
  type ResolvedPlannerAuth,
} from '../../core/planner-auth.js';
import { resolvePlannerAuthForPaths } from '../../core/planner-models.js';
import { resolveClaudeBinary } from '../../core/claude-binary.js';
import { probeClaudeAuth, type ProbeClaudeAuthResult } from '../../planner/runtimes/auth-probe.js';
import { buildPayload } from '../../commands/auth/status.js';
import { credentialPresent, runtimeNameFor } from '../../commands/auth/shared.js';
import { plannerAuthRuntimeMismatchMessage } from '../../planner/runtimes/auth-runtime-mismatch.js';
import type { PlannerConfig, ProviderName } from '../../planner/types.js';

/**
 * The command the console tells the user to run. There is deliberately no login endpoint:
 * the console cannot complete a browser OAuth callback on the user's behalf.
 */
export const PLANNER_AUTH_LOGIN_COMMAND = 'squad auth login';

/**
 * Wire shape of `GET /api/planner-auth`.
 *
 * The vocabulary (`mode`, `reason`, `credentialHint`, `account`, `apiKeySource`, `runtime`) is
 * produced by {@link buildPayload} — the same function `squad auth status --json` uses — so the
 * console and the CLI can never disagree about the same workspace. Nothing here is a credential:
 * `describeAuth` guarantees `credentialHint` is a hint, and `login.token` is dropped on purpose.
 */
export interface ConsolePlannerAuthPayload {
  provider: ProviderName;
  configuredMode: PlannerAuthMode;
  resolved: { mode: 'subscription' | 'api-key'; reason: string; credentialHint: string } | null;
  /** `PlannerAuthUnavailableError` message when nothing resolved; null otherwise. */
  error: string | null;
  login: { present: boolean; hint: string; detail: string };
  account: { email?: string; organization?: string; subscriptionType?: string } | null;
  apiKeySource: string | null;
  runtime: 'agent-sdk' | 'vercel';
  binary: { found: boolean; source: 'bundled' | 'path' | null };
  loginCommand: string;
  /**
   * Offline "a credential resolved" answer, upgraded to the live answer when a probe ran.
   * Same field, same meaning, as `AuthStatusPayload.loggedIn`.
   */
  loggedIn: boolean;
  /**
   * Present only when `?probe=1` was requested. The UI needs to tell "probe failed" apart from
   * "not signed in" — rendering a failed probe as signed-out sends users to fix a non-problem.
   */
  probe: { ran: true; ok: boolean; kind?: string; detail?: string } | null;
  /**
   * Non-null when subscription auth is impossible for this provider/runtime pair — independent of
   * the configured mode, so the Config page can warn about a mode the user is *about* to pick.
   * The text is `plannerAuthRuntimeMismatchMessage`, the same copy the CLI and doctor print.
   */
  runtimeConflict: string | null;
}

const PROBE_CACHE_TTL_MS = 60_000;

type ProbeSuccess = Extract<ProbeClaudeAuthResult, { ok: true }>;

/**
 * Module-level so two browser tabs (and a re-render storm) share one answer. Only successful
 * probes are cached: a failure is usually transient (cold subprocess, wedged login) and caching
 * it would keep the console wrong for a minute after the user fixed it.
 */
let probeCache: { key: string; at: number; result: ProbeSuccess } | undefined;

function probeCacheKey(auth: ResolvedPlannerAuth): string {
  const described = describeAuth(auth);
  return `${described.mode}:${described.credentialHint}`;
}

async function probeWithCache(auth: ResolvedPlannerAuth, now: number): Promise<ProbeClaudeAuthResult> {
  const key = probeCacheKey(auth);
  if (probeCache && probeCache.key === key && now - probeCache.at < PROBE_CACHE_TTL_MS) {
    return probeCache.result;
  }
  const result = await probeClaudeAuth(auth);
  if (result.ok) probeCache = { key, at: now, result };
  return result;
}

/** Test seam. The cache is process-wide, so a suite that exercises it has to be able to clear it. */
export function resetPlannerAuthProbeCache(): void {
  probeCache = undefined;
}

/**
 * "Would subscription auth work here?" — asked without reference to the configured mode so the
 * console can render the conflict against an unsaved draft selection, which is the only moment
 * the warning can still stop a bad save.
 */
function subscriptionRuntimeConflict(provider: ProviderName, planner: PlannerConfig | undefined): string | null {
  if (provider !== 'anthropic') return plannerAuthRuntimeMismatchMessage(provider);
  if (runtimeNameFor(provider, planner) === 'vercel') return plannerAuthRuntimeMismatchMessage(provider);
  return null;
}

export function mountPlannerAuthApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/planner-auth', async (c) => {
    const config = loadConfig(opts.paths.configFile);
    const planner = config.planner;
    const provider: ProviderName = planner?.provider ?? 'anthropic';
    const configuredMode: PlannerAuthMode = planner?.auth?.anthropic ?? 'auto';

    // `detectClaudeLogin` reads the OS credential store for *existence* only and never returns
    // the token to this handler's response — `login.token` is deliberately not copied below.
    const loginProbe = detectClaudeLogin(loadSecrets(opts.paths.secretsFile));
    const binary = resolveClaudeBinary();

    let auth: ResolvedPlannerAuth | undefined;
    let error: string | null = null;
    try {
      auth = resolvePlannerAuthForPaths(opts.paths, provider, planner);
    } catch (err) {
      if (!(err instanceof PlannerAuthUnavailableError)) throw err;
      error = err.message;
    }

    // The probe spawns an Agent SDK subprocess. It runs only when explicitly asked for, so a
    // page load is always instant and never costs a process.
    const wantProbe = c.req.query('probe') === '1' && provider === 'anthropic' && auth !== undefined;
    const probe = wantProbe ? await probeWithCache(auth!, Date.now()) : undefined;

    const status = auth
      ? buildPayload({
          auth: describeAuth(auth),
          provider,
          planner,
          probe,
          fallbackLoggedIn: credentialPresent(auth),
        })
      : undefined;

    const payload: ConsolePlannerAuthPayload = {
      provider,
      configuredMode,
      resolved: status
        ? { mode: status.mode, reason: status.reason, credentialHint: status.credentialHint }
        : null,
      error,
      login: { present: loginProbe.present, hint: loginProbe.hint, detail: loginProbe.detail },
      account: status?.account ?? null,
      apiKeySource: status?.apiKeySource ?? null,
      runtime: runtimeNameFor(provider, planner) === 'vercel' ? 'vercel' : 'agent-sdk',
      binary: { found: Boolean(binary), source: binary?.source ?? null },
      loginCommand: PLANNER_AUTH_LOGIN_COMMAND,
      loggedIn: status?.loggedIn ?? false,
      probe: probe ? { ran: true, ok: probe.ok, ...(probe.ok ? {} : { kind: probe.kind, detail: probe.detail }) } : null,
      runtimeConflict: subscriptionRuntimeConflict(provider, planner),
    };
    return c.json(payload);
  });

  const ModeBody = z.object({ mode: z.string() });

  app.post('/api/planner-auth/mode', async (c) => {
    const parsed = ModeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

    const config = loadConfig(opts.paths.configFile);
    const next: SquadConfig = {
      ...config,
      planner: {
        ...(config.planner ?? {}),
        auth: { ...(config.planner?.auth ?? {}), anthropic: parsed.data.mode as PlannerAuthMode },
      } as PlannerConfig,
    };
    try {
      // `saveConfig` round-trips through `parseConfig`, so an invalid mode fails with the exact
      // message `squad config set planner` prints. No second copy of the validation lives here.
      saveConfig(opts.paths.configFile, next);
    } catch (err) {
      return c.json({ error: 'invalid_auth_mode', detail: (err as Error).message }, 400);
    }
    // A mode change can change which credential resolves; drop the cached probe rather than
    // letting the account card describe the previous mode for up to a minute.
    resetPlannerAuthProbeCache();
    return c.json({ ok: true, mode: parsed.data.mode });
  });
}

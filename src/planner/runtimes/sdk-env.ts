import type { ResolvedPlannerAuth } from '../../core/planner-auth.js';

/**
 * Cleared from the child environment in subscription mode. Both outrank the login credential in
 * Claude Code's precedence order, so an inherited one would silently bill API credits instead.
 * Compared case-insensitively — Windows env vars are case-insensitive but a `{...process.env}`
 * copy is a plain object, so `delete env.ANTHROPIC_API_KEY` would miss `Anthropic_Api_Key`.
 */
export const SUBSCRIPTION_WITHHELD_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * Environment handed to an Agent SDK subprocess.
 *
 * In subscription mode the point is what is *absent*: `ANTHROPIC_API_KEY` and
 * `ANTHROPIC_AUTH_TOKEN` both outrank the `/login` credential in Claude Code's precedence order,
 * so an inherited one would silently bill API credits. `SQUAD_PLANNER_API_KEY` is left alone —
 * it is squad-kit's own variable and the SDK never reads it.
 *
 * Lives in its own module (rather than as a private method on `AgentSdkRuntime`) because
 * `probeClaudeAuth` must spawn through byte-identical environment semantics without constructing
 * a runtime; two copies of this logic would drift and the probe would report a state the planner
 * does not experience.
 */
export function buildSdkEnv(auth: ResolvedPlannerAuth): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (auth.mode === 'api-key') {
    env.ANTHROPIC_API_KEY = auth.key;
    return env;
  }
  for (const key of Object.keys(env)) {
    if (SUBSCRIPTION_WITHHELD_ENV_KEYS.includes(key.toUpperCase())) delete env[key];
  }
  if (auth.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = auth.oauthToken;
  return env;
}

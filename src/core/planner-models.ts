import fs from 'node:fs';
import { findSquadRoot, buildPaths } from './paths.js';
import { loadSecrets, type SquadSecrets } from './secrets.js';
import type { PlannerModelOverride, PlannerPhase, ProviderName } from '../planner/types.js';

export interface PlannerPhaseModels {
  plan: string;
  execute: string;
}

/**
 * Pinned model IDs for the planner. Anthropic Opus uses the **Claude API ID** from Anthropic’s
 * model overview (versioned id; Haiku uses an explicit dated snapshot). Aliases such as
 * `claude-haiku-4-5` without a date are intentionally NOT used for execute because they can
 * roll forward silently. Update when a provider deprecates a pin; run `pnpm verify:models` after edits.
 *
 * Last verified against Anthropic docs: 2026-04-23 — https://platform.claude.com/docs/en/about-claude/models/overview
 */
export const PLANNER_MODEL_MAP: Record<ProviderName, PlannerPhaseModels> = {
  anthropic: {
    plan: 'claude-opus-4-7',
    execute: 'claude-haiku-4-5-20251001',
  },
  openai: {
    // Unverified for 0.2.0. 0.2.1 will pin to dated snapshots once a maintainer can probe.
    plan: 'gpt-5.3-thinking',
    execute: 'gpt-5.3-mini',
  },
  google: {
    // Unverified for 0.2.0. 0.2.1 will pin to dated snapshots once a maintainer can probe.
    plan: 'gemini-3-pro-latest',
    execute: 'gemini-3-flash-latest',
  },
};

export function modelFor(
  provider: ProviderName,
  phase: PlannerPhase,
  override?: PlannerModelOverride,
): string {
  if (phase === 'plan' && override?.[provider]) return override[provider]!;
  return PLANNER_MODEL_MAP[provider][phase];
}

export function providerEnvVar(provider: ProviderName): string {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'google':
      return 'GOOGLE_API_KEY';
  }
}

export interface CredentialSource {
  value: string;
  source: 'env' | 'secrets' | 'fallback-env';
  detail: string; // human-friendly hint, e.g. "ANTHROPIC_API_KEY" or ".squad/secrets.yaml"
}

export function resolveProviderKey(provider: ProviderName): CredentialSource | undefined {
  const envVar = providerEnvVar(provider);
  const envValue = process.env[envVar];
  if (envValue) return { value: envValue, source: 'env', detail: envVar };

  const fallback = process.env.SQUAD_PLANNER_API_KEY;
  if (fallback) return { value: fallback, source: 'fallback-env', detail: 'SQUAD_PLANNER_API_KEY' };

  const root = findSquadRoot();
  if (root) {
    const paths = buildPaths(root);
    if (fs.existsSync(paths.secretsFile)) {
      const secrets = loadSecrets(paths.secretsFile);
      const fromFile = secrets.planner?.[provider];
      if (fromFile) return { value: fromFile, source: 'secrets', detail: '.squad/secrets.yaml' };
    }
  }
  return undefined;
}

/** Backwards-compatible wrapper; returns only the value. Existing callers continue to work. */
export function readProviderKey(provider: ProviderName): string | undefined {
  return resolveProviderKey(provider)?.value;
}

export interface TrackerCredentialLookup {
  envVars: string[]; // primary env vars, in order
  fallbackEnv: 'SQUAD_TRACKER_API_KEY';
  fromSecrets: (s: SquadSecrets) => string | undefined; // extracts the relevant field
}

export function resolveTrackerCredential(
  lookup: TrackerCredentialLookup,
): CredentialSource | undefined {
  for (const ev of lookup.envVars) {
    const v = process.env[ev];
    if (v) return { value: v, source: 'env', detail: ev };
  }
  const fb = process.env[lookup.fallbackEnv];
  if (fb) return { value: fb, source: 'fallback-env', detail: lookup.fallbackEnv };

  const root = findSquadRoot();
  if (!root) return undefined;
  const paths = buildPaths(root);
  if (!fs.existsSync(paths.secretsFile)) return undefined;
  const secrets = loadSecrets(paths.secretsFile);
  const fromFile = lookup.fromSecrets(secrets);
  if (fromFile) return { value: fromFile, source: 'secrets', detail: '.squad/secrets.yaml' };
  return undefined;
}

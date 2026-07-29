import fs from 'node:fs';
import yaml from 'js-yaml';
import type { PlannerConfig, PlannerModelOverride, ProviderName } from '../planner/types.js';
import { PLANNER_AUTH_MODES, type PlannerAuthMode } from './planner-auth.js';

export type TrackerType = 'none' | 'github' | 'jira' | 'azure' | 'notion';

export interface SquadConfig {
  version: number;
  project: {
    name: string;
    primaryLanguage?: string;
    projectRoots?: string[];
  };
  tracker: {
    type: TrackerType;
    workspace?: string;
    project?: string;
  };
  naming: {
    includeTrackerId: boolean;
    globalSequence: boolean;
  };
  agents: string[];
  planner?: PlannerConfig;
}

export const DEFAULT_CONFIG: SquadConfig = {
  version: 1,
  project: {
    name: 'my-project',
    primaryLanguage: 'typescript',
    projectRoots: ['.'],
  },
  tracker: { type: 'none' },
  naming: { includeTrackerId: false, globalSequence: true },
  agents: [],
  planner: undefined,
};

/**
 * Matched against a lowercased key name **exactly**, not as a substring: `planner.maxOutputTokens`
 * is a legitimate config key and must keep loading. New credential-shaped keys are listed here
 * by name — `anthropicOauthToken` belongs in .squad/secrets.yaml only.
 */
const FORBIDDEN_KEYS = [
  'apikey',
  'api_key',
  'token',
  'oauthtoken',
  'anthropicoauthtoken',
  'secret',
  'credential',
  'credentials',
];

/** Default max completion tokens per planner API round (was 8192; long Opus plans truncated). */
export const DEFAULT_PLANNER_MAX_OUTPUT_TOKENS = 16384;
const MIN_PLANNER_MAX_OUTPUT_TOKENS = 1024;
const MAX_PLANNER_MAX_OUTPUT_TOKENS = 128_000;

function clampPlannerMaxOut(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_PLANNER_MAX_OUTPUT_TOKENS;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PLANNER_MAX_OUTPUT_TOKENS;
  return Math.min(
    MAX_PLANNER_MAX_OUTPUT_TOKENS,
    Math.max(MIN_PLANNER_MAX_OUTPUT_TOKENS, Math.round(n)),
  );
}

function rejectSecretsInYaml(node: unknown, configFile: string, path: string[] = []): void {
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      throw new Error(
        `Refusing to load ${configFile}: key "${[...path, key].join('.')}" looks like a secret. ` +
          `Run \`squad config set planner\` or \`squad config set tracker\` to save it to .squad/secrets.yaml, then remove the key from config.yaml. ` +
          `Provider keys also work via ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY.`,
      );
    }
    if (typeof value === 'object') rejectSecretsInYaml(value, configFile, [...path, key]);
  }
}

/** `planner.auth.anthropic` is a mode, not a secret — lowercased and trimmed before matching. */
function normalizeAuthMode(raw: unknown, configFile: string): PlannerAuthMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if ((PLANNER_AUTH_MODES as readonly string[]).includes(value)) return value as PlannerAuthMode;
  throw new Error(
    `Invalid planner.auth.anthropic ${JSON.stringify(raw)} in ${configFile}: must be ${PLANNER_AUTH_MODES.join(', ')}. ` +
      `Run \`squad config set planner\` to fix it.`,
  );
}

function mergePlanner(
  base: PlannerConfig | undefined,
  override: Partial<PlannerConfig> | undefined,
  configFile: string,
): PlannerConfig | undefined {
  if (!override) return base;
  const merged: PlannerConfig = {
    enabled: override.enabled ?? base?.enabled ?? false,
    provider: (override.provider ?? base?.provider ?? 'anthropic') as ProviderName,
    mode: override.mode ?? base?.mode ?? 'auto',
    auth: {
      anthropic: normalizeAuthMode(override.auth?.anthropic ?? base?.auth?.anthropic, configFile) ?? 'auto',
    },
    budget: {
      maxFileReads: override.budget?.maxFileReads ?? base?.budget?.maxFileReads ?? 25,
      maxContextBytes: override.budget?.maxContextBytes ?? base?.budget?.maxContextBytes ?? 50_000,
      maxDurationSeconds: override.budget?.maxDurationSeconds ?? base?.budget?.maxDurationSeconds ?? 180,
    },
    modelOverride: {
      ...(base?.modelOverride ?? {}),
      ...(override.modelOverride ?? {}),
    },
    cache: {
      enabled: override.cache?.enabled ?? base?.cache?.enabled ?? true,
    },
    maxOutputTokens: clampPlannerMaxOut(override.maxOutputTokens ?? base?.maxOutputTokens),
    stages: {
      scout: {
        enabled: override.stages?.scout?.enabled ?? base?.stages?.scout?.enabled ?? true,
        modelOverride: override.stages?.scout?.modelOverride ?? base?.stages?.scout?.modelOverride,
        maxFiles: override.stages?.scout?.maxFiles ?? base?.stages?.scout?.maxFiles ?? 12,
        maxOutputTokens: override.stages?.scout?.maxOutputTokens ?? base?.stages?.scout?.maxOutputTokens ?? 2048,
      },
    },
    tools: {
      grep: override.tools?.grep ?? base?.tools?.grep ?? true,
      listDir: override.tools?.listDir ?? base?.tools?.listDir ?? true,
      rangedRead: override.tools?.rangedRead ?? base?.tools?.rangedRead ?? true,
    },
    validation: {
      enabled: override.validation?.enabled ?? base?.validation?.enabled ?? true,
      strict: override.validation?.strict ?? base?.validation?.strict ?? false,
    },
    runtime: {
      anthropic: override.runtime?.anthropic ?? base?.runtime?.anthropic ?? 'agent-sdk',
    },
    providerOptions: {
      anthropic: {
        thinking:
          override.providerOptions?.anthropic?.thinking ?? base?.providerOptions?.anthropic?.thinking ?? 'adaptive',
        effort: override.providerOptions?.anthropic?.effort ?? base?.providerOptions?.anthropic?.effort ?? 'medium',
        effortByPhase: {
          scout:
            override.providerOptions?.anthropic?.effortByPhase?.scout ??
            base?.providerOptions?.anthropic?.effortByPhase?.scout ??
            'minimal',
          draft:
            override.providerOptions?.anthropic?.effortByPhase?.draft ??
            base?.providerOptions?.anthropic?.effortByPhase?.draft ??
            'medium',
        },
        thinkingBudget:
          override.providerOptions?.anthropic?.thinkingBudget ?? base?.providerOptions?.anthropic?.thinkingBudget,
      },
    },
  };
  // Normalise: drop undefined/null entries; remove modelOverride entirely if nothing left (clean YAML).
  if (merged.modelOverride) {
    const pruned = Object.fromEntries(
      Object.entries(merged.modelOverride).filter(([, v]) => v !== undefined && v !== null),
    ) as PlannerModelOverride;
    if (Object.keys(pruned).length === 0) {
      delete merged.modelOverride;
    } else {
      merged.modelOverride = pruned;
    }
  }
  return merged;
}

function validateModelOverride(mo: PlannerModelOverride | undefined, configFile: string): void {
  if (!mo) return;
  for (const key of ['anthropic', 'openai', 'google'] as const) {
    const v = mo[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error(
        `Invalid planner.modelOverride.${key} in ${configFile}: must be a non-empty string when set. ` +
          `Run \`squad config set planner\` to fix it.`,
      );
    }
  }
}

/**
 * Parse and validate config YAML the same way as reading from disk. Used by `loadConfig` and `saveConfig` (round-trip check).
 */
export function parseConfig(raw: string, configFile: string): SquadConfig {
  let parsed: Partial<SquadConfig> | undefined;
  try {
    parsed = yaml.load(raw) as Partial<SquadConfig> | undefined;
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${configFile}: ${(err as Error).message}. ` +
        `Run \`squad doctor\` to review, or fix the file, or \`squad init --force\` to replace it.`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `Invalid config at ${configFile}: expected a YAML object. Run \`squad doctor\` to review, or fix the file and try again.`,
    );
  }
  rejectSecretsInYaml(parsed, configFile);
  const merged = mergeConfig(DEFAULT_CONFIG, parsed, configFile);
  validateModelOverride(merged.planner?.modelOverride, configFile);
  if (merged.planner?.cache !== undefined) {
    const c = merged.planner.cache;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      throw new Error(
        `planner.cache in ${configFile} must be an object with \`enabled: true\` or \`false\`. ` +
          `Run \`squad config set planner\` to set prompt caching.`,
      );
    }
    const ce = c.enabled;
    if (typeof ce !== 'boolean') {
      throw new Error(
        `planner.cache.enabled in ${configFile} must be a boolean (not a quoted string). ` +
          `Run \`squad config set planner\` to set prompt caching, or use \`true\` or \`false\` unquoted in YAML.`,
      );
    }
  }
  if (merged.planner?.enabled) {
    if (!['anthropic', 'openai', 'google'].includes(merged.planner.provider)) {
      throw new Error(
        `Unsupported planner.provider "${merged.planner.provider}". ` +
          `Run \`squad config set planner\` and pick anthropic | openai | google.`,
      );
    }
    if (merged.planner.budget.maxFileReads <= 0) {
      throw new Error(
        'planner.budget.maxFileReads must be > 0. Run `squad config set planner` to fix planner.budget values.',
      );
    }
    if (merged.planner.budget.maxContextBytes <= 0) {
      throw new Error(
        'planner.budget.maxContextBytes must be > 0. Run `squad config set planner` to fix planner.budget values.',
      );
    }
    if (merged.planner.budget.maxDurationSeconds <= 0) {
      throw new Error(
        'planner.budget.maxDurationSeconds must be > 0. Run `squad config set planner` to fix planner.budget values.',
      );
    }
    const ar = merged.planner.runtime?.anthropic;
    if (ar !== undefined && ar !== 'agent-sdk' && ar !== 'vercel') {
      throw new Error(
        'planner.runtime.anthropic must be agent-sdk or vercel. Run `squad config set planner` to fix it.',
      );
    }
  }
  return merged;
}

export function loadConfig(configFile: string): SquadConfig {
  const raw = fs.readFileSync(configFile, 'utf8');
  return parseConfig(raw, configFile);
}

export function serializeConfig(config: SquadConfig): string {
  return yaml.dump(config, { lineWidth: 100, noRefs: true, sortKeys: false });
}

export function saveConfig(configFile: string, config: SquadConfig): void {
  const body = serializeConfig(config);
  parseConfig(body, configFile);
  fs.writeFileSync(configFile, body, 'utf8');
}

function mergeConfig(base: SquadConfig, override: Partial<SquadConfig>, configFile: string): SquadConfig {
  return {
    version: override.version ?? base.version,
    project: { ...base.project, ...(override.project ?? {}) },
    tracker: { ...base.tracker, ...(override.tracker ?? {}) },
    naming: { ...base.naming, ...(override.naming ?? {}) },
    agents: override.agents ?? base.agents,
    planner: mergePlanner(base.planner, override.planner as Partial<PlannerConfig> | undefined, configFile),
  };
}

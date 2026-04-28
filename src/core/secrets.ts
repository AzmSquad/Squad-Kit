import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface TrackerJiraSecrets {
  host?: string; // e.g. "mycompany.atlassian.net" (without scheme)
  email?: string;
  token?: string;
}

export interface TrackerAzureSecrets {
  organization?: string;
  project?: string;
  pat?: string;
}

export interface TrackerGitHubSecrets {
  host?: string; // optional GHES hostname (e.g. "ghes.example.com"); defaults to api.github.com
  pat?: string;
}

export interface SquadSecrets {
  planner?: {
    anthropic?: string;
    openai?: string;
    google?: string;
  };
  tracker?: {
    jira?: TrackerJiraSecrets;
    azure?: TrackerAzureSecrets;
    github?: TrackerGitHubSecrets;
  };
}

const EMPTY: SquadSecrets = {};

export function loadSecrets(secretsFile: string): SquadSecrets {
  if (!fs.existsSync(secretsFile)) return EMPTY;
  let raw: string;
  try {
    raw = fs.readFileSync(secretsFile, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read ${secretsFile}: ${(err as Error).message}. ` +
        `Run \`squad doctor\` to diagnose, or delete the file and run \`squad config set planner\` or \`squad config set tracker\` to re-enter credentials.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${secretsFile}: ${(err as Error).message}. ` +
        `Run \`squad doctor\` to review paths and permissions, or fix the file, or delete it and run \`squad config set planner\` / \`squad config set tracker\` to re-enter secrets.`,
    );
  }
  if (parsed === null || parsed === undefined) return EMPTY;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid ${secretsFile}: expected a YAML object at the top level. ` +
        `Run \`squad config set planner\` or \`squad config set tracker\` after fixing or replacing the file.`,
    );
  }
  return parsed as SquadSecrets;
}

export function saveSecrets(secretsFile: string, secrets: SquadSecrets): void {
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  const body = yaml.dump(secrets, { lineWidth: 100, noRefs: true, sortKeys: false });
  fs.writeFileSync(secretsFile, body, 'utf8');
  tightenPermissions(secretsFile);
}

function tightenPermissions(file: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort; some filesystems (e.g. NTFS mounts on Linux) may refuse chmod
  }
}

/**
 * Structural merge. New values win over existing ones; undefined/empty-string values are ignored
 * so callers can partial-update a single provider without clobbering siblings.
 */
export function mergeSecrets(base: SquadSecrets, patch: SquadSecrets): SquadSecrets {
  return {
    planner: { ...(base.planner ?? {}), ...filterEmpty(patch.planner ?? {}) },
    tracker: {
      jira: {
        ...(base.tracker?.jira ?? {}),
        ...filterEmpty((patch.tracker?.jira ?? {}) as Record<string, unknown>),
      },
      azure: {
        ...(base.tracker?.azure ?? {}),
        ...filterEmpty((patch.tracker?.azure ?? {}) as Record<string, unknown>),
      },
      github: {
        ...(base.tracker?.github ?? {}),
        ...filterEmpty((patch.tracker?.github ?? {}) as Record<string, unknown>),
      },
    },
  };
}

function filterEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out as Partial<T>;
}

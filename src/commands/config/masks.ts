import type { SquadSecrets } from '../../core/secrets.js';

export function maskStringKey(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length <= 4) return '***';
  const lead = value.slice(0, Math.min(5, value.length - 4));
  const tail = value.slice(-4);
  return `${lead}…${tail}`;
}

export function maskPlannerCredentials(planner: SquadSecrets['planner']): {
  anthropic?: string;
  openai?: string;
  google?: string;
} {
  return {
    anthropic: planner?.anthropic ? maskStringKey(planner.anthropic) : undefined,
    openai: planner?.openai ? maskStringKey(planner.openai) : undefined,
    google: planner?.google ? maskStringKey(planner.google) : undefined,
  };
}

export function maskTrackerForShow(secrets: SquadSecrets): {
  jira?: { host?: string; email?: string; token: string };
  azure?: { organization?: string; project?: string; pat: string };
} {
  const j = secrets.tracker?.jira;
  const a = secrets.tracker?.azure;
  return {
    jira: j
      ? {
          host: j.host,
          email: j.email,
          token: j.token && j.token.length > 0 ? '***' : 'not set',
        }
      : undefined,
    azure: a
      ? {
          organization: a.organization,
          project: a.project,
          pat: a.pat && a.pat.length > 0 ? '***' : 'not set',
        }
      : undefined,
  };
}

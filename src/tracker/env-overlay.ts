import type { SquadSecrets } from '../core/secrets.js';

/**
 * Build a SquadSecrets from env vars. Values present in `base` are preserved
 * unless the corresponding env var is set, in which case env wins (documented
 * precedence: env > secrets.yaml).
 */
export function overlayTrackerEnv(base: SquadSecrets): SquadSecrets {
  const jiraHost = process.env.JIRA_HOST;
  const jiraEmail = process.env.JIRA_EMAIL;
  const jiraToken = process.env.JIRA_API_TOKEN ?? process.env.SQUAD_TRACKER_API_KEY;

  const azOrg = process.env.AZURE_DEVOPS_ORG;
  const azProj = process.env.AZURE_DEVOPS_PROJECT;
  const azPat = process.env.AZURE_DEVOPS_PAT ?? process.env.SQUAD_TRACKER_API_KEY;

  return {
    ...base,
    tracker: {
      jira: {
        host: jiraHost ?? base.tracker?.jira?.host,
        email: jiraEmail ?? base.tracker?.jira?.email,
        token: jiraToken ?? base.tracker?.jira?.token,
      },
      azure: {
        organization: azOrg ?? base.tracker?.azure?.organization,
        project: azProj ?? base.tracker?.azure?.project,
        pat: azPat ?? base.tracker?.azure?.pat,
      },
    },
  };
}

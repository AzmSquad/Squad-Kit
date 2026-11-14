import type { SquadSecrets } from '../core/secrets.js';
import { siteOf } from './jira-site.js';

/**
 * Build a SquadSecrets from env vars. Values present in `base` are preserved
 * unless the corresponding env var is set, in which case env wins (documented
 * precedence: env > secrets.yaml).
 */
export function overlayTrackerEnv(base: SquadSecrets): SquadSecrets {
  // A Jira token and its host come from the same place: JIRA_API_TOKEN (or SQUAD_TRACKER_API_KEY) only with a JIRA_HOST
  // that is a site, else the file's token with the file's host. Never one's token with the other's host.
  const file = base.tracker?.jira ?? {};
  const envSite = siteOf(process.env.JIRA_HOST);
  const envToken = process.env.JIRA_API_TOKEN ?? process.env.SQUAD_TRACKER_API_KEY;
  const jiraEmail = process.env.JIRA_EMAIL ?? file.email;
  const jira = envSite && envToken ? { host: envSite, email: jiraEmail, token: envToken } : { host: file.host, email: jiraEmail, token: file.token };

  const azOrg = process.env.AZURE_DEVOPS_ORG;
  const azProj = process.env.AZURE_DEVOPS_PROJECT;
  const azPat = process.env.AZURE_DEVOPS_PAT ?? process.env.SQUAD_TRACKER_API_KEY;

  const ghHost = process.env.GITHUB_HOST;
  const ghPat = process.env.GITHUB_TOKEN ?? process.env.SQUAD_TRACKER_API_KEY;

  return {
    ...base,
    tracker: {
      jira,
      azure: {
        organization: azOrg ?? base.tracker?.azure?.organization,
        project: azProj ?? base.tracker?.azure?.project,
        pat: azPat ?? base.tracker?.azure?.pat,
      },
      github: {
        host: ghHost ?? base.tracker?.github?.host,
        pat: ghPat ?? base.tracker?.github?.pat,
      },
    },
  };
}

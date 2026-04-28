import type { SquadConfig } from '../core/config.js';
import type { SquadSecrets } from '../core/secrets.js';
import { AzureDevOpsClient } from './azure.js';
import { GitHubClient } from './github.js';
import { JiraClient } from './jira.js';
import type { TrackerClient } from './types.js';

export * from './types.js';
export { JiraClient } from './jira.js';
export { AzureDevOpsClient } from './azure.js';
export { GitHubClient } from './github.js';
export { sanitizeFilename } from './attachments.js';
export { overlayTrackerEnv } from './env-overlay.js';

export interface ClientResolutionError {
  kind: 'unsupported-tracker' | 'missing-credentials';
  message: string;
  detail: string; // actionable hint (env-var name or secrets.yaml path)
}

export interface ClientResolution {
  client?: TrackerClient;
  error?: ClientResolutionError;
}

/**
 * Given the current workspace config + secrets, return a ready-to-use TrackerClient
 * or a structured error that the caller can surface verbatim to the user.
 *
 * NEVER throws. NEVER reads env vars directly. The caller is responsible for merging
 * env-var-sourced credentials into `secrets` before calling, OR for using the
 * `resolveTrackerCredential` helper and passing the resolved value here.
 */
export function clientFor(config: SquadConfig, secrets: SquadSecrets): ClientResolution {
  switch (config.tracker.type) {
    case 'jira': {
      const jira = secrets.tracker?.jira ?? {};
      const host = jira.host ?? config.tracker.workspace;
      if (!host || !jira.email || !jira.token) {
        return {
          error: {
            kind: 'missing-credentials',
            message: 'Jira credentials are incomplete.',
            detail:
              'Run `squad config set tracker` to enter host, email, and token, or set JIRA_HOST / JIRA_EMAIL / JIRA_API_TOKEN. Run `squad doctor` to verify the connection.',
          },
        };
      }
      return { client: new JiraClient({ host, email: jira.email, token: jira.token }) };
    }

    case 'azure': {
      const az = secrets.tracker?.azure ?? {};
      const organization = az.organization ?? config.tracker.workspace;
      const project = az.project ?? config.tracker.project;
      if (!organization || !project || !az.pat) {
        return {
          error: {
            kind: 'missing-credentials',
            message: 'Azure DevOps credentials are incomplete.',
            detail:
              'Run `squad config set tracker` to enter organization, project, and PAT, or set AZURE_DEVOPS_ORG / AZURE_DEVOPS_PROJECT / AZURE_DEVOPS_PAT. Run `squad doctor` to verify the connection.',
          },
        };
      }
      return { client: new AzureDevOpsClient({ organization, project, pat: az.pat }) };
    }

    case 'github': {
      const gh = secrets.tracker?.github ?? {};
      const owner = config.tracker.workspace;
      const repo = config.tracker.project;
      if (!owner || !repo || !gh.pat) {
        return {
          error: {
            kind: 'missing-credentials',
            message: 'GitHub credentials are incomplete.',
            detail:
              'Set tracker.workspace (owner) and tracker.project (repo) in .squad/config.yaml, then run `squad config set tracker` to enter the PAT, or set GITHUB_TOKEN (and optionally GITHUB_HOST for GHES). Run `squad doctor` to verify the connection.',
          },
        };
      }
      return { client: new GitHubClient({ owner, repo, pat: gh.pat, host: gh.host }) };
    }

    case 'none':
    default:
      return {
        error: {
          kind: 'unsupported-tracker',
          message: `Tracker type "${config.tracker.type}" does not support auto-fetch in 0.2.0.`,
          detail:
            'Run `squad config set tracker` to use jira, azure, or github for fetch, or pass `--no-fetch` on new-story. Run `squad doctor` to review tracker setup.',
        },
      };
  }
}

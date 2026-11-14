import fs from 'node:fs';
import { buildPaths } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { loadSecrets } from '../../core/secrets.js';
import { overlayTrackerEnv } from '../../tracker/env-overlay.js';
import { writeLog } from '../../core/app-log.js';
import { Azure, parseAzureRemote, type AzureTarget } from './client.js';
import { bearerFor, signedInWithMicrosoft } from './token.js';

/**
 * Which sign-in an Azure DevOps call uses (ADR-011). A token saved for the project (Settings, or AZURE_DEVOPS_PAT) wins:
 * it is the person's own choice for this project. Without one, squad-kit's own Microsoft sign-in is used, with a fresh
 * token for the organization each time.
 */

/** The project's Azure settings: organization and project, and its saved token when there is one. */
export function azurePlace(root: string): { organization?: string; project?: string; pat?: string } | null {
  const paths = buildPaths(root);
  if (!fs.existsSync(paths.configFile)) return null;
  const config = loadConfig(paths.configFile);
  if (config.tracker.type !== 'azure') return null;
  const az = overlayTrackerEnv(loadSecrets(paths.secretsFile)).tracker?.azure;
  return { organization: az?.organization ?? config.tracker.workspace, project: az?.project ?? config.tracker.project, pat: az?.pat };
}

/** The sign-in for one organization: the saved token, else the Microsoft sign-in, else none. */
export function signInFor(organization: string, pat?: string): Pick<AzureTarget, 'pat' | 'bearer'> | null {
  if (pat) return { pat };
  return signedInWithMicrosoft() ? { bearer: (fresh) => bearerFor(organization, fresh) } : null;
}

/** The Azure client for a project folder, when its tracker is Azure and it has a sign-in. */
export function azureForProject(root: string): Azure | null {
  const p = azurePlace(root);
  if (!p?.organization || !p.project) return null;
  const auth = signInFor(p.organization, p.pat);
  return auth ? new Azure({ organization: p.organization, project: p.project, ...auth }) : null;
}

/**
 * Env vars that let git push and fetch sign in to Azure Repos, without writing anything to a git config file or putting
 * it on the command line: the token's Basic header, or the Microsoft token as a bearer header (Microsoft's documented
 * `http.extraheader`). With the Microsoft sign-in, the person's own git helpers are set aside for that host, so git
 * never falls back to their own Azure sign-in; with no token to be had, git then stops with a plain sign-in failure.
 */
export async function gitAuthEnv(auth: Pick<AzureTarget, 'pat' | 'bearer'>, remoteUrl: string): Promise<Record<string, string>> {
  if (!/^https:\/\//i.test(remoteUrl) || !parseAzureRemote(remoteUrl)) return {};
  const host = new URL(remoteUrl).host;
  if (auth.pat) {
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${Buffer.from(`:${auth.pat}`).toString('base64')}`,
      GIT_TERMINAL_PROMPT: '0',
    };
  }
  if (!auth.bearer) return {};
  const noHelpers = { GIT_CONFIG_KEY_0: `credential.https://${host}.helper`, GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0' };
  try {
    const token = await auth.bearer();
    return { ...noHelpers, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: `http.https://${host}/.extraheader`, GIT_CONFIG_VALUE_1: `AUTHORIZATION: bearer ${token}` };
  } catch (err) {
    writeLog({ level: 'warn', text: `No Microsoft token for git on ${host}: ${(err as Error).message}` });
    return { ...noHelpers, GIT_CONFIG_COUNT: '1' };
  }
}

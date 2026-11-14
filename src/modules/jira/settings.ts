import { buildPaths } from '../../core/paths.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { loadSecrets, mergeSecrets, saveSecrets } from '../../core/secrets.js';
import { overlayTrackerEnv } from '../../tracker/env-overlay.js';
import { jiraAccess } from '../../tracker/jira-site.js';
import type { SetupField } from '../tracker/types.js';
import { projectOf, siteOf } from './refs.js';

/**
 * A project's Jira settings. The team's part is in `.squad/config.yaml`: the site, the project and the board its
 * sprints come from. The person's part stays on this computer with their other sign-ins: their email and API token.
 * squad-kit 0.x kept the site, email and token the same way, so a setup from then is read as it is.
 */

export interface JiraSettings {
  site: string;
  email: string;
  token: string;
  /** The project key, like PAY. A setup from before this version may have none yet. */
  project?: string;
  /** The board whose sprints the Backlog shows; none: the project has no sprints, or the person chose none. */
  board?: { id: number; name: string };
  /**
   * Set up before this version (0.x) and not saved since: squad-kit only reads Jira and keeps its updates until the
   * person presses Save and check once.
   */
  readOnly: boolean;
}

/** What is saved, whole or not: the form shows it, and Save uses it for what the form left empty. */
export interface SavedJira {
  site?: string;
  email?: string;
  token?: string;
  project?: string;
  board?: { id: number; name: string } | 'none';
  readOnly: boolean;
  /** The team's site, when the token on this computer was saved for another host (or for none): it is not sent there. */
  moved?: string;
}

export const FIELDS: SetupField[] = [
  { key: 'site', label: 'Site', placeholder: 'yourcompany.atlassian.net, or paste any Jira link' },
  { key: 'email', label: 'Email', placeholder: 'The email you sign in to Atlassian with' },
  { key: 'token', label: 'API token', secret: true, placeholder: 'API token from id.atlassian.com' },
  { key: 'project', label: 'Project', choice: true, typed: true, placeholder: 'Pick one, or type its key, like PAY' },
  { key: 'board', label: 'Sprints from', choice: true },
];

/** Saved by every save in this version: squad-kit may write to Jira. A setup from before has no such mark. */
const WRITES = 'on';

/**
 * The person's own sign-in on this computer, with the JIRA_* variables over it as in 0.x. `site` is the host the token
 * was saved for (JIRA_HOST for a token in JIRA_API_TOKEN): the token goes to that host and no other.
 */
export function savedSignIn(root: string): { site?: string; email?: string; token?: string } {
  const jira = overlayTrackerEnv(loadSecrets(buildPaths(root).secretsFile)).tracker?.jira ?? {};
  return { ...(siteOf(jira.host) ? { site: siteOf(jira.host)! } : {}), ...(jira.email ? { email: jira.email } : {}), ...(jira.token ? { token: jira.token } : {}) };
}

/** What Settings and Connections say when the team's site is not the one the token here was saved for. */
export function movedWords(site: string): { en: string; ar: string } {
  return { en: `The team's Jira site is now ${site}. Paste your token for it.`, ar: `موقع Jira للفريق صار ${site}. الصق رمزك له.` };
}

/** The saved token, for this site only: the host it was saved for. */
export function tokenFor(site: string | undefined, own: { site?: string; token?: string }): string | undefined {
  return site && own.token && own.site === site ? own.token : undefined;
}

/** What is saved for the project, or null when its tracker is not Jira. */
export function readSaved(root: string): SavedJira | null {
  let tracker;
  try {
    tracker = loadConfig(buildPaths(root).configFile).tracker;
  } catch {
    return null;
  }
  if (tracker.type !== 'jira') return null;
  const o = tracker.options ?? {};
  const own = savedSignIn(root);
  const id = Number(o.board);
  // The team's site rules. A commit that changes it never sends anyone's token to the new host: the token waits.
  const access = jiraAccess(tracker.workspace, { host: own.site, email: own.email, token: own.token });
  const project = projectOf(tracker.project);
  return {
    ...(access.email ? { email: access.email } : {}),
    ...(access.site ? { site: access.site } : {}),
    ...(access.token ? { token: access.token } : {}),
    ...(access.moved ? { moved: access.moved } : {}),
    ...(project ? { project } : {}),
    ...(o.board === 'none' ? { board: 'none' as const } : id > 0 ? { board: { id, name: o.boardName ?? `Board ${id}` } } : {}),
    readOnly: o.updates !== WRITES,
  };
}

/** The settings a tracker opens with: only when the site, the email and the token are all there. */
export function readSettings(root: string): JiraSettings | null {
  const s = readSaved(root);
  if (!s?.site || !s.email || !s.token) return null;
  return {
    site: s.site,
    email: s.email,
    token: s.token,
    ...(s.project ? { project: s.project } : {}),
    ...(s.board && s.board !== 'none' ? { board: s.board } : {}),
    readOnly: s.readOnly,
  };
}

/** The values the Settings form shows. The token never leaves this computer's file. */
export function formValues(s: SavedJira): Record<string, string> {
  return { site: s.site ?? '', email: s.email ?? '', project: s.project ?? '', board: s.board === 'none' ? 'none' : s.board ? String(s.board.id) : '' };
}

/** Saves the checked settings: the team's part in the project's config, the person's sign-in on this computer. */
export function writeSettings(root: string, s: { site: string; email: string; token?: string; project?: string; board?: { id: number; name: string } | 'none' }): void {
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);
  const options: Record<string, string> = { updates: WRITES };
  if (s.board === 'none') options.board = 'none';
  else if (s.board) Object.assign(options, { board: String(s.board.id), boardName: s.board.name });
  saveConfig(paths.configFile, { ...config, tracker: { type: 'jira', workspace: s.site, ...(s.project ? { project: s.project } : {}), options } });
  saveSecrets(paths.secretsFile, mergeSecrets(loadSecrets(paths.secretsFile), { tracker: { jira: { host: s.site, email: s.email, token: s.token } } }));
}

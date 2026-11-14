import { ModuleError } from '../errors.js';
import type { SetupChoice, TrackerModule } from '../tracker/types.js';
import { atlassianReady } from './atlassian-app.js';
import { atlassianCloud, atlassianSiteHost, orSignIn } from './atlassian-token.js';
import { JiraClient, type JiraAccess } from './client.js';
import { projectOf, siteOf } from './refs.js';
import { FIELDS, formValues, movedWords, readSaved, readSettings, savedSignIn, tokenFor, writeSettings, type SavedJira } from './settings.js';
import { JiraTracker } from './tracker.js';

/** Jira in the tracker list: its settings, the projects and boards Settings picks from, and the save that checks them. */

interface Board {
  id: number;
  name: string;
  type?: string;
}

/**
 * The sign-in for these values: what the form has, else what is saved, else squad-kit's own Atlassian sign-in when it
 * covers the site (ADR-012). The saved token goes only to the host it was saved for: a half-typed site, another site, or
 * a host typed in the form get no call with it. With no site typed or saved, the site the Atlassian sign-in chose.
 */
function accessOf(values: Record<string, string | undefined>, root?: string): Partial<JiraAccess> {
  const own = root ? savedSignIn(root) : {};
  const site = siteOf(values.site) ?? (root ? readSaved(root)?.site : undefined) ?? own.site ?? atlassianSiteHost();
  const token = values.token?.trim() || tokenFor(site, own);
  const email = values.email?.trim() || own.email;
  const signedIn = site && !token ? atlassianCloud(site) : null;
  return signedIn ? { site, email: signedIn.who, cloud: signedIn.cloud } : { site, email, token };
}

async function projectsOf(client: JiraClient): Promise<{ key: string; name: string }[]> {
  const all: { key: string; name: string }[] = [];
  for (let page = 0; page < 6; page += 1) {
    const got = await client.call<{ values?: { key: string; name: string }[]; isLast?: boolean }>('GET', `/rest/api/3/project/search?orderBy=key&startAt=${all.length}&maxResults=50`);
    all.push(...(got?.values ?? []));
    if (got?.isLast !== false || !got.values?.length) break;
  }
  return all;
}

/** The project's boards that can have sprints: a Kanban board has none. */
async function boardsOf(client: JiraClient, project: string): Promise<Board[]> {
  const got = await client.call<{ values?: Board[] }>('GET', `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}&maxResults=50`);
  return (got?.values ?? []).filter((b) => b.type !== 'kanban').sort((a, b) => Number(b.type === 'scrum') - Number(a.type === 'scrum'));
}

/** Jira says a board without sprints turned on does not support them. */
async function hasSprints(client: JiraClient, id: number): Promise<boolean> {
  try {
    await client.call('GET', `/rest/agile/1.0/board/${id}/sprint?maxResults=1`);
    return true;
  } catch (err) {
    if (err instanceof ModuleError && err.status === 400) return false;
    throw err;
  }
}

/** The board the person chose, checked; or, left to squad-kit, the project's first board with sprints. */
async function boardFor(client: JiraClient, project: string, asked: string): Promise<{ id: number; name: string } | 'none'> {
  if (asked === 'none') return 'none';
  if (asked) {
    const id = Number(asked);
    const board = Number.isInteger(id) && id > 0 ? await client.call<Board>('GET', `/rest/agile/1.0/board/${id}`).catch(() => null) : null;
    if (!board) throw new ModuleError(`Jira has no board ${asked} that this account can see. Pick one from the list.`, 'not-found');
    if (!(await hasSprints(client, board.id))) throw new ModuleError(`Board ${board.name} has no sprints. Pick a board with sprints, or None.`);
    return { id: board.id, name: board.name };
  }
  for (const b of (await boardsOf(client, project)).slice(0, 3)) if (await hasSprints(client, b.id)) return { id: b.id, name: b.name };
  return 'none';
}

/** The site and sign-in must work; a project, one this account can see. A site with one project needs no pick. */
async function checked(http: typeof fetch | undefined, root: string, values: Record<string, string | undefined>) {
  const access = accessOf(values, root);
  if (!access.site) throw new ModuleError('Enter your Jira site, like yourcompany.atlassian.net. A link to any Jira page works too.');
  if (!access.cloud) {
    const or = atlassianReady() ? ` ${orSignIn(access.site)}` : '';
    if (!access.email || !access.email.includes('@')) throw new ModuleError(`Enter the email you sign in to Atlassian with.${or}`);
    if (!access.token) throw new ModuleError(`Paste your Jira API token for ${access.site}. Make one at id.atlassian.com, under Security, API tokens.${or}`);
  }
  const sign = access as JiraAccess;
  const client = new JiraClient(sign, http);
  await new JiraTracker(client, { ...sign, readOnly: true }).whoAmI();
  const typed = values.project?.trim();
  // A pasted link to an issue or a project names the project too.
  let project = typed ? projectOf(typed) : /^https?:\/\//i.test(values.site ?? '') ? projectOf(values.site) : null;
  if (typed && !project) throw new ModuleError(`"${typed}" is not a Jira project key. Pick the project from the list, or type its key, like PAY.`);
  if (!project) {
    const all = await projectsOf(client);
    if (all.length === 1) project = all[0]!.key;
  }
  if (project) {
    const found = await client.call<{ key: string }>('GET', `/rest/api/3/project/${encodeURIComponent(project)}`).catch((err: unknown) => {
      if (err instanceof ModuleError && err.kind === 'not-found') throw new ModuleError(`Jira at ${access.site} has no project ${project} that ${access.email} can see.`, 'not-found');
      throw err;
    });
    project = found.key;
  }
  const board = project ? await boardFor(client, project, values.board?.trim() ?? '') : undefined;
  // Only a newly pasted token is written; an empty one keeps the saved one. With the Atlassian sign-in, nothing is.
  return { site: access.site, ...(access.cloud ? {} : { email: access.email, token: values.token?.trim() || undefined }), ...(project ? { project } : {}), ...(board ? { board } : {}) };
}

async function choicesFor(http: typeof fetch | undefined, values: Record<string, string>, root?: string): Promise<Record<string, SetupChoice[]>> {
  const access = accessOf(values, root);
  // Nothing to ask with yet: the lists come once the sign-in is saved.
  if (!access.site || (!access.cloud && (!access.email || !access.token))) return {};
  const client = new JiraClient(access as JiraAccess, http);
  const lists: Record<string, SetupChoice[]> = { project: (await projectsOf(client)).map((p) => ({ value: p.key, label: `${p.key}: ${p.name}` })) };
  const project = projectOf(values.project);
  if (!project) return lists;
  const boards = await boardsOf(client, project);
  lists.board = boards.length
    ? [{ value: '', label: `${boards[0]!.name} (best fit)` }, { value: 'none', label: 'None: no sprints' }, ...boards.map((b) => ({ value: String(b.id), label: b.name }))]
    : [{ value: '', label: 'None: the project has no board with sprints' }];
  return lists;
}

function noteOf(saved: SavedJira): string | undefined {
  const signedIn = saved.site ? atlassianCloud(saved.site) : null;
  if (saved.moved && !signedIn) return movedWords(saved.moved).en;
  if (saved.readOnly) return `Set up before this version: squad-kit only reads Jira for now. ${saved.project ? 'Press' : 'Pick the project the stories come from, then press'} Save and check to let it update Jira.`;
  if (!saved.project) return 'Pick the project the stories come from, then press Save and check.';
  if (!signedIn) return undefined;
  // Both here: the token is the person's own choice for this project, and is used (ADR-012).
  return saved.token ? 'The API token saved here is used, not your Atlassian sign-in.' : `Signed in with Atlassian as ${signedIn.who}: no token needed.`;
}

export function jiraTrackerModule(http?: typeof fetch): TrackerModule {
  return {
    name: 'jira',
    label: 'Jira',
    get about() {
      const how = atlassianReady()
        ? 'Sign in with Atlassian on the Connections page, or paste an API token here: a saved token is used first, and stays on this computer.'
        : 'Your API token stays on this computer.';
      return `Stories and bugs come from a Jira project, and sprints from its board. squad-kit moves them along as the squad works and writes on each one. ${how}`;
    },
    hint: 'Make the API token at id.atlassian.com, under Security, API tokens.',
    fields: FIELDS,
    open(root) {
      const settings = readSettings(root);
      return settings ? new JiraTracker(new JiraClient(settings, http), settings) : null;
    },
    read(root) {
      const saved = readSaved(root);
      if (!saved) return { values: {}, hasSecret: false };
      const note = noteOf(saved);
      return { values: formValues(saved), hasSecret: Boolean(saved.token), ...(note ? { note } : {}) };
    },
    async save(root, values) {
      writeSettings(root, await checked(http, root, values));
    },
    guess: () => null,
    choices: (values, root) => choicesFor(http, values, root),
  };
}

export const jiraTracker = jiraTrackerModule();

import fs from 'node:fs';
import path from 'node:path';
import { buildPaths } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { loadSecrets } from '../../core/secrets.js';
import { overlayTrackerEnv } from '../../tracker/env-overlay.js';
import { ModuleError, kindOfStatus, type ModuleErrorKind } from '../errors.js';
import { withoutTags } from '../../utils/text.js';
import { writeLog } from '../../core/app-log.js';

/**
 * Azure Boards and Azure Repos for the live squad: the backlog, work item states and comments, bugs, and pull
 * requests. squad-kit makes these calls itself; the AI roles never touch Azure.
 */

export interface AzureTarget {
  organization: string;
  project: string;
  pat: string;
}

export interface WorkItemRow {
  id: number;
  type: string;
  title: string;
  state: string;
  points?: number;
  priority?: number;
  sprint?: string;
  assignedTo?: string;
  tags: string[];
  url: string;
}

export interface WorkItem extends WorkItemRow {
  description: string;
  acceptanceCriteria: string;
  reproSteps: string;
  parents: { id: number; type: string; title: string }[];
  dependsOn: { id: number; title: string; state: string }[];
  attachments: { name: string; url: string; size: number }[];
}

export interface Sprint {
  name: string;
  path: string;
  start?: string;
  finish?: string;
  current: boolean;
}

export type StateCategory = 'Proposed' | 'InProgress' | 'Resolved' | 'Completed';

export interface PullRequest {
  id: number;
  url: string;
  status: string;
}

export class AzureError extends ModuleError {
  constructor(message: string, status?: number, kind?: ModuleErrorKind) {
    super(message, kind ?? (status ? kindOfStatus(status) : 'other'), status);
    this.name = 'AzureError';
  }
}

type FetchLike = typeof fetch;

/** The longest one call to Azure DevOps may take, so a stalled network never holds up the board. */
const CALL_MS = 60_000;

const late = (err: unknown) => (err as Error)?.name === 'TimeoutError';
const seconds = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? '' : 's'}`;
};

export class Azure {
  private readonly auth: string;
  private readonly orgUrl: string;
  private readonly projUrl: string;
  private stateCache = new Map<string, { name: string; category: string }[]>();
  private typeCache: Promise<WorkItemType[]> | null = null;
  private fieldCache = new Map<string, Promise<string[]>>();

  constructor(
    readonly target: AzureTarget,
    private readonly http: FetchLike = fetch,
    private readonly timeoutMs = CALL_MS,
  ) {
    this.auth = 'Basic ' + Buffer.from(`:${target.pat}`).toString('base64');
    this.orgUrl = `https://dev.azure.com/${encodeURIComponent(target.organization)}`;
    this.projUrl = `${this.orgUrl}/${encodeURIComponent(target.project)}`;
  }

  webUrl(id: number): string {
    return `${this.projUrl}/_workitems/edit/${id}`;
  }

  /** How a link from one work item to another names its target. */
  itemApiUrl(id: number): string {
    return `${this.orgUrl}/_apis/wit/workItems/${id}`;
  }

  async call<T>(method: string, url: string, body?: unknown, contentType = 'application/json'): Promise<T> {
    const full = url.startsWith('http') ? url : `${this.projUrl}/${url}`;
    const sep = full.includes('?') ? '&' : '?';
    let res: Response;
    const tooLong = () => new AzureError(`Azure DevOps did not answer within ${seconds(this.timeoutMs)}. Check the network, then try again.`, undefined, 'offline');
    try {
      res = await this.http(`${full}${full.includes('api-version=') ? '' : `${sep}api-version=7.1`}`, {
        method,
        headers: {
          authorization: this.auth,
          accept: 'application/json',
          'X-TFS-FedAuthRedirect': 'Suppress',
          ...(body !== undefined ? { 'content-type': contentType } : {}),
        },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (late(err)) throw tooLong();
      writeLog({ level: 'warn', text: `Could not reach Azure DevOps: ${(err as Error).message}` });
      throw new AzureError('Could not reach Azure DevOps. Check the connection, then try again.', undefined, 'offline');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const detail = text.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? '';
      // The exact answer is for engineers: which scope is missing, which rule said no.
      writeLog({ level: 'warn', text: `Azure DevOps said HTTP ${res.status}. ${detail}`.trim() });
      if (res.status === 401 || res.status === 403 || res.status === 302 || res.status === 203) {
        throw new AzureError('Azure DevOps did not accept the sign-in. Check it in Settings. An engineer can see why in the log.', res.status);
      }
      throw new AzureError('Azure DevOps said no to this. An engineer can see why in the log.', res.status);
    }
    const text = await res.text().catch((err: unknown) => {
      throw late(err) ? tooLong() : err;
    });
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Who the token belongs to, as a connection check. */
  async whoAmI(): Promise<string> {
    const data = await this.call<{ authenticatedUser?: { providerDisplayName?: string } }>('GET', `${this.orgUrl}/_apis/connectionData?api-version=7.1-preview`);
    const name = data?.authenticatedUser?.providerDisplayName;
    if (!name || name === 'Anonymous') throw new AzureError('Azure DevOps did not accept the token.');
    return name;
  }

  async sprints(): Promise<Sprint[]> {
    const team = await this.defaultTeam();
    const data = await this.call<{ value: { name: string; path: string; attributes?: { startDate?: string; finishDate?: string; timeFrame?: string } }[] }>(
      'GET',
      `${encodeURIComponent(team)}/_apis/work/teamsettings/iterations`,
    );
    return data.value.map((i) => ({
      name: i.name,
      path: i.path,
      start: i.attributes?.startDate?.slice(0, 10),
      finish: i.attributes?.finishDate?.slice(0, 10),
      current: i.attributes?.timeFrame === 'current',
    }));
  }

  private async defaultTeam(): Promise<string> {
    const p = await this.call<{ defaultTeam?: { name: string } }>('GET', `${this.orgUrl}/_apis/projects/${encodeURIComponent(this.target.project)}`);
    return p.defaultTeam?.name ?? `${this.target.project} Team`;
  }

  /** Stories and bugs, by sprint when given. Closed and removed items are left out unless asked. */
  async listWorkItems(opts: { sprintPath?: string; types?: string[]; includeDone?: boolean } = {}): Promise<WorkItemRow[]> {
    const types = opts.types ?? ['User Story', 'Product Backlog Item', 'Requirement', 'Bug', 'Issue'];
    const where = [
      '[System.TeamProject] = @project',
      `[System.WorkItemType] IN (${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')})`,
      opts.includeDone ? '' : "[System.State] NOT IN ('Closed', 'Done', 'Removed')",
      opts.sprintPath ? `[System.IterationPath] = '${opts.sprintPath.replace(/'/g, "''")}'` : '',
    ].filter(Boolean);
    const wiql = await this.call<{ workItems: { id: number }[] }>('POST', '_apis/wit/wiql', {
      query: `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [Microsoft.VSTS.Common.StackRank] ASC, [System.Id] ASC`,
    });
    const ids = wiql.workItems.map((w) => w.id).slice(0, 200);
    const rows: WorkItemRow[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = await this.call<{ value: RawItem[] }>('POST', '_apis/wit/workitemsbatch', { ids: ids.slice(i, i + 100), fields: ROW_FIELDS });
      rows.push(...batch.value.map((w) => this.row(w)));
    }
    const order = new Map(ids.map((id, n) => [id, n]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  /**
   * The newest items of a type that carry a tag and have this text in their description: an item squad-kit made and
   * could not save the link of. One query, then the descriptions of at most 50 items.
   */
  async findByTagAndText(type: string, tag: string, text: string): Promise<WorkItemRow | null> {
    const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
    const wiql = await this.call<{ workItems: { id: number }[] }>('POST', '_apis/wit/wiql?$top=50', {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = ${q(type)} AND [System.Tags] CONTAINS ${q(tag)} ORDER BY [System.Id] DESC`,
    });
    const ids = wiql.workItems.map((w) => w.id).slice(0, 50);
    if (!ids.length) return null;
    const batch = await this.call<{ value: RawItem[] }>('POST', '_apis/wit/workitemsbatch', { ids, fields: [...ROW_FIELDS, 'System.Description'] });
    const hit = batch.value.find((w) => str(w.fields?.['System.Description']).includes(text));
    return hit ? this.row(hit) : null;
  }

  async getWorkItem(id: number): Promise<WorkItem> {
    const raw = await this.call<RawItem>('GET', `_apis/wit/workitems/${id}?$expand=relations`);
    const f = raw.fields ?? {};
    const rels = raw.relations ?? [];
    const idOf = (url: string) => Number(url.split('/').pop());
    const parents: WorkItem['parents'] = [];
    let parentRel = rels.find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
    // Walk up to two levels: the feature and the epic give the agents the bigger picture.
    for (let depth = 0; parentRel && depth < 2; depth++) {
      const p = await this.call<RawItem>('GET', `_apis/wit/workitems/${idOf(parentRel.url)}?$expand=relations`).catch(() => null);
      if (!p) break;
      parents.push({ id: p.id, type: str(p.fields?.['System.WorkItemType']), title: str(p.fields?.['System.Title']) });
      parentRel = (p.relations ?? []).find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
    }
    const depIds = rels.filter((r) => r.rel === 'System.LinkTypes.Dependency-Reverse').map((r) => idOf(r.url));
    const dependsOn = depIds.length
      ? (await this.call<{ value: RawItem[] }>('POST', '_apis/wit/workitemsbatch', { ids: depIds, fields: ['System.Title', 'System.State'] })).value.map((d) => ({
          id: d.id,
          title: str(d.fields?.['System.Title']),
          state: str(d.fields?.['System.State']),
        }))
      : [];
    return {
      ...this.row(raw),
      description: htmlToText(str(f['System.Description'])),
      acceptanceCriteria: htmlToText(str(f['Microsoft.VSTS.Common.AcceptanceCriteria'])),
      reproSteps: htmlToText(str(f['Microsoft.VSTS.TCM.ReproSteps'])),
      parents,
      dependsOn,
      attachments: rels
        .filter((r) => r.rel === 'AttachedFile')
        .map((r) => ({ name: str(r.attributes?.name) || 'attachment', url: r.url, size: Number(r.attributes?.resourceSize ?? 0) })),
    };
  }

  /** Every page of the project wiki, with its text, so the squad can follow the team's written rules. */
  async wikiPages(): Promise<{ path: string; content: string }[]> {
    const wikis = await this.call<{ value: { id: string; type: string }[] }>('GET', '_apis/wiki/wikis');
    const wiki = wikis.value.find((w) => w.type === 'projectWiki') ?? wikis.value[0];
    if (!wiki) return [];
    type Page = { path: string; subPages?: Page[] };
    const tree = await this.call<Page>('GET', `_apis/wiki/wikis/${wiki.id}/pages?path=/&recursionLevel=full`);
    const paths: string[] = [];
    const walk = (p: Page) => {
      if (p.path !== '/') paths.push(p.path);
      p.subPages?.forEach(walk);
    };
    walk(tree);
    const pages: { path: string; content: string }[] = [];
    for (const p of paths.slice(0, 40)) {
      const page = await this.call<{ content?: string }>('GET', `_apis/wiki/wikis/${wiki.id}/pages?path=${encodeURIComponent(p)}&includeContent=true`).catch(() => null);
      if (page?.content?.trim()) pages.push({ path: p, content: page.content });
    }
    return pages;
  }

  /** Saves an attachment to a file and returns its path. */
  async download(url: string, file: string): Promise<string> {
    // A file may be big: it gets more time than a call, but never forever.
    const res = await this.http(url, { headers: { authorization: this.auth, 'X-TFS-FedAuthRedirect': 'Suppress' }, signal: AbortSignal.timeout(this.timeoutMs * 5) });
    if (!res.ok) throw new AzureError(`Could not download ${path.basename(file)} (HTTP ${res.status}).`, res.status);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  }

  /** Move a work item to the first state in a category ("InProgress" is Active in Agile, Committed in Scrum). */
  async moveTo(id: number, category: StateCategory): Promise<string | null> {
    const item = await this.call<RawItem>('GET', `_apis/wit/workitems/${id}?fields=System.WorkItemType,System.State`);
    const type = str(item.fields?.['System.WorkItemType']);
    const current = str(item.fields?.['System.State']);
    const states = await this.statesOf(type);
    const at = states.findIndex((s) => s.name === current);
    const target = pickState(states, category, at);
    // Never move backwards: a story already past this point stays where it is.
    if (!target || target === current || (at >= 0 && states.findIndex((s) => s.name === target) < at)) return null;
    await this.patch(id, [{ op: 'add', path: '/fields/System.State', value: target }]);
    return target;
  }

  private async statesOf(type: string): Promise<{ name: string; category: string }[]> {
    if (!this.stateCache.has(type)) {
      const data = await this.call<{ value: { name: string; category: string }[] }>('GET', `_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`);
      this.stateCache.set(type, data.value);
    }
    return this.stateCache.get(type)!;
  }

  async comment(id: number, html: string): Promise<void> {
    await this.call('POST', `_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`, { text: html });
  }

  async addTag(id: number, tag: string): Promise<void> {
    const item = await this.call<RawItem>('GET', `_apis/wit/workitems/${id}?fields=System.Tags`);
    const tags = parseTags(item.fields?.['System.Tags']);
    if (tags.includes(tag)) return;
    await this.patch(id, [{ op: 'add', path: '/fields/System.Tags', value: [...tags, tag].join('; ') }]);
  }

  async createBug(input: { title: string; reproSteps: string; severity?: string; tags?: string[]; relatedIds?: number[]; iterationPath?: string }): Promise<WorkItemRow> {
    const ops: PatchOp[] = [
      { op: 'add', path: '/fields/System.Title', value: input.title },
      { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: input.reproSteps },
    ];
    if (input.severity) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: input.severity });
    if (input.tags?.length) ops.push({ op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') });
    if (input.iterationPath) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: input.iterationPath });
    for (const rid of input.relatedIds ?? []) {
      ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Related', url: `${this.orgUrl}/_apis/wit/workItems/${rid}` } });
    }
    const raw = await this.call<RawItem>('POST', '_apis/wit/workitems/$Bug', ops, 'application/json-patch+json');
    return this.row(raw);
  }

  private async patch(id: number, ops: PatchOp[]): Promise<void> {
    await this.call('PATCH', `_apis/wit/workitems/${id}`, ops, 'application/json-patch+json');
  }

  // ---- Making items (a breakdown's send) ----

  /** The project's work item types that are turned on, with the fields each one has when Azure lists them. */
  workItemTypes(): Promise<WorkItemType[]> {
    this.typeCache ??= this.call<{ value: RawType[] }>('GET', '_apis/wit/workitemtypes')
      .then((data) =>
        (data?.value ?? [])
          .filter((t) => !t.isDisabled)
          .map((t) => ({ name: t.name, ...(t.fields ? { fields: t.fields.map((f) => f.referenceName) } : {}) })),
      )
      .catch((err: unknown) => {
        this.typeCache = null;
        throw err;
      });
    return this.typeCache;
  }

  /** True when the work item type has the field ("Microsoft.VSTS.Common.AcceptanceCriteria"). */
  async typeHasField(type: string, field: string): Promise<boolean> {
    const listed = (await this.workItemTypes()).find((t) => t.name.toLowerCase() === type.toLowerCase());
    if (listed?.fields) return listed.fields.includes(field);
    if (!this.fieldCache.has(type)) {
      this.fieldCache.set(
        type,
        this.call<{ value: { referenceName: string }[] }>('GET', `_apis/wit/workitemtypes/${encodeURIComponent(type)}/fields`).then((d) => (d?.value ?? []).map((f) => f.referenceName)),
      );
    }
    return (await this.fieldCache.get(type)!).includes(field);
  }

  /** Makes a work item of a type. The ops set its fields and links; squad-kit never sets an iteration here. */
  async createWorkItem(type: string, ops: PatchOp[]): Promise<WorkItemRow> {
    const raw = await this.call<RawItem>('POST', `_apis/wit/workitems/$${encodeURIComponent(type)}`, ops, 'application/json-patch+json');
    return this.row(raw);
  }

  async updateWorkItem(id: number, ops: PatchOp[]): Promise<void> {
    if (ops.length) await this.patch(id, ops);
  }

  /** A work item's type and its links, in Azure's order: a link is removed by its place in this list. */
  async linksOf(id: number): Promise<{ type: string; relations: { rel: string; id: number }[] }> {
    const raw = await this.call<RawItem>('GET', `_apis/wit/workitems/${id}?$expand=relations`);
    return {
      type: str(raw.fields?.['System.WorkItemType']),
      relations: (raw.relations ?? []).map((r) => ({ rel: r.rel, id: Number(r.url.split('/').pop()) })),
    };
  }

  // ---- Azure Repos ----

  async createPullRequest(input: { repo: string; source: string; target: string; title: string; description: string; workItemIds: number[] }): Promise<PullRequest> {
    const pr = await this.call<RawPr>('POST', `_apis/git/repositories/${encodeURIComponent(input.repo)}/pullrequests`, {
      sourceRefName: `refs/heads/${input.source}`,
      targetRefName: `refs/heads/${input.target}`,
      title: input.title,
      // Azure keeps PR descriptions under 4000 characters.
      description: input.description.length > 3990 ? `${input.description.slice(0, 3980)}\n…` : input.description,
      workItemRefs: input.workItemIds.map((id) => ({ id: String(id) })),
    });
    return this.pr(input.repo, pr);
  }

  /** The open PR from a branch, if one exists (so a retry does not open a second one). */
  async findPullRequest(repo: string, source: string): Promise<PullRequest | null> {
    const data = await this.call<{ value: RawPr[] }>(
      'GET',
      `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${source}`)}&searchCriteria.status=active`,
    );
    return data.value[0] ? this.pr(repo, data.value[0]) : null;
  }

  /** The newest PR from a branch in any state (active, completed or abandoned), so one merged in Azure is found again. */
  async lastPullRequest(repo: string, source: string): Promise<PullRequest | null> {
    const data = await this.call<{ value: RawPr[] }>(
      'GET',
      `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${source}`)}&searchCriteria.status=all`,
    );
    const newest = [...data.value].sort((a, b) => b.pullRequestId - a.pullRequestId)[0];
    return newest ? this.pr(repo, newest) : null;
  }

  /** Uploads a screenshot to the PR and returns a link to use in markdown. */
  async attachToPullRequest(repo: string, prId: number, file: string): Promise<string> {
    const name = path.basename(file);
    const data = await this.call<{ url: string }>(
      'POST',
      `_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/attachments/${encodeURIComponent(name)}`,
      fs.readFileSync(file),
      'application/octet-stream',
    );
    return data.url;
  }

  async updatePullRequestDescription(repo: string, prId: number, description: string): Promise<void> {
    await this.call('PATCH', `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}`, {
      description: description.length > 3990 ? `${description.slice(0, 3980)}\n…` : description,
    });
  }

  async getPullRequest(repo: string, prId: number): Promise<AzurePr> {
    return this.call<RawPr>('GET', `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}`);
  }

  /** Merges the PR with a merge commit and deletes its branch. Resolves once Azure has finished merging. */
  async completePullRequest(repo: string, prId: number, message: string): Promise<{ mergeCommit: string }> {
    let pr = await this.getPullRequest(repo, prId);
    if (pr.status !== 'completed') {
      pr = await this.call<RawPr>('PATCH', `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}`, {
        status: 'completed',
        lastMergeSourceCommit: pr.lastMergeSourceCommit,
        completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: true, mergeCommitMessage: message, transitionWorkItems: false },
      });
    }
    for (let i = 0; i < 30 && pr.status !== 'completed'; i++) {
      if (pr.mergeStatus === 'conflicts' || pr.mergeStatus === 'failure' || pr.mergeStatus === 'rejectedByPolicy') {
        throw new AzureError(`Azure could not merge PR ${prId} (${pr.mergeStatus}). Open it in Azure to see why.`, undefined, pr.mergeStatus === 'conflicts' ? 'clash' : 'other');
      }
      await new Promise((r) => setTimeout(r, 2000));
      pr = await this.getPullRequest(repo, prId);
    }
    if (pr.status !== 'completed') {
      throw new AzureError(`PR ${prId} is not merged yet. It may be waiting for a required review or build in Azure.`);
    }
    return { mergeCommit: pr.lastMergeCommit?.commitId ?? '' };
  }

  async abandonPullRequest(repo: string, prId: number): Promise<void> {
    await this.call('PATCH', `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}`, { status: 'abandoned' });
  }

  private pr(repo: string, raw: RawPr): PullRequest {
    return { id: raw.pullRequestId, status: raw.status, url: `${this.projUrl}/_git/${encodeURIComponent(repo)}/pullrequest/${raw.pullRequestId}` };
  }

  private row(w: RawItem): WorkItemRow {
    const f = w.fields ?? {};
    const points = f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? f['Microsoft.VSTS.Scheduling.Effort'];
    return {
      id: w.id,
      type: str(f['System.WorkItemType']),
      title: str(f['System.Title']),
      state: str(f['System.State']),
      points: typeof points === 'number' ? points : undefined,
      priority: typeof f['Microsoft.VSTS.Common.Priority'] === 'number' ? (f['Microsoft.VSTS.Common.Priority'] as number) : undefined,
      sprint: str(f['System.IterationPath']).split('\\').slice(1).join('\\') || undefined,
      assignedTo: (f['System.AssignedTo'] as { displayName?: string } | undefined)?.displayName,
      tags: parseTags(f['System.Tags']),
      url: this.webUrl(w.id),
    };
  }
}

const ROW_FIELDS = [
  'System.Id',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.IterationPath',
  'System.AssignedTo',
  'System.Tags',
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'Microsoft.VSTS.Scheduling.Effort',
  'Microsoft.VSTS.Common.Priority',
];

export type PatchOp = { op: 'add' | 'replace'; path: string; value: unknown } | { op: 'remove'; path: string };

export interface WorkItemType {
  name: string;
  /** The fields' reference names, when Azure listed them with the type. */
  fields?: string[];
}

interface RawType {
  name: string;
  isDisabled?: boolean;
  fields?: { referenceName: string }[];
}

/** The four processes Azure DevOps comes with; a project's own process inherits one of them and keeps its type names. */
export type AzureProcess = 'Agile' | 'Scrum' | 'CMMI' | 'Basic';

/**
 * The work item type for each level of a breakdown, per process. Basic has only Epic, Issue and Task: a feature
 * becomes an Issue under its epic, and a story a Task under its Issue (or under the epic, when the breakdown skips
 * features).
 */
export const PROCESS_TYPES: Record<AzureProcess, { epic: string; feature: string; story: string }> = {
  Agile: { epic: 'Epic', feature: 'Feature', story: 'User Story' },
  Scrum: { epic: 'Epic', feature: 'Feature', story: 'Product Backlog Item' },
  CMMI: { epic: 'Epic', feature: 'Feature', story: 'Requirement' },
  Basic: { epic: 'Epic', feature: 'Issue', story: 'Task' },
};

/**
 * The process a project follows, from its work item types. Its story type tells: Agile has User Story, Scrum Product
 * Backlog Item, CMMI Requirement. Agile and CMMI have an Issue type too, so Basic is the one left with Issue and Task.
 */
export function processOf(types: string[]): AzureProcess | null {
  const has = (name: string) => types.some((t) => t.toLowerCase() === name.toLowerCase());
  if (has('User Story')) return 'Agile';
  if (has('Product Backlog Item')) return 'Scrum';
  if (has('Requirement')) return 'CMMI';
  if (has('Issue') && has('Task')) return 'Basic';
  return null;
}

interface RawItem {
  id: number;
  fields?: Record<string, unknown>;
  relations?: { rel: string; url: string; attributes?: { name?: string; resourceSize?: number } }[];
}

export type AzurePr = RawPr;

interface RawPr {
  pullRequestId: number;
  status: string;
  mergeStatus?: string;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeCommit?: { commitId: string };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The state for a step of the squad's journey. Processes differ: Agile puts its "Resolved" story state in the In
 * Progress category, so a state named Resolved counts even when no state has the Resolved category.
 */
export function pickState(states: { name: string; category: string }[], category: StateCategory, currentIndex = -1): string | undefined {
  const byCategory = states.filter((s) => s.category === category);
  if (byCategory.length) return byCategory[0]!.name;
  if (category === 'Resolved') {
    const named = states.find((s) => /^resolved$/i.test(s.name));
    if (named) return named.name;
    // Otherwise the last "in progress" state after the current one, if there is one.
    const later = states.filter((s, i) => s.category === 'InProgress' && i > currentIndex);
    return later.length > 1 ? later.at(-1)!.name : undefined;
  }
  return undefined;
}

function parseTags(raw: unknown): string[] {
  return typeof raw === 'string' ? raw.split(';').map((s) => s.trim()).filter(Boolean) : [];
}

export function htmlToText(html: string): string {
  const breaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  return withoutTags(breaks)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Where a git remote lives on Azure Repos, or null for any other host. */
export function parseAzureRemote(url: string): { organization: string; project: string; repo: string } | null {
  const clean = url.trim().replace(/\.git$/, '');
  const patterns = [
    /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i,
    /^https:\/\/(?:[^@/]+@)?([^.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i,
    /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com:(?:22\/)?v3\/([^/]+)\/([^/]+)\/([^/]+)$/i,
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (m?.[1] && m[2] && m[3]) return { organization: decodeURIComponent(m[1]), project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
  }
  return null;
}

/** The Azure client for a project folder, when its tracker is Azure and a token is saved. */
export function azureForProject(root: string): Azure | null {
  const paths = buildPaths(root);
  if (!fs.existsSync(paths.configFile)) return null;
  const config = loadConfig(paths.configFile);
  if (config.tracker.type !== 'azure') return null;
  const secrets = overlayTrackerEnv(loadSecrets(paths.secretsFile));
  const az = secrets.tracker?.azure;
  const organization = az?.organization ?? config.tracker.workspace;
  const project = az?.project ?? config.tracker.project;
  if (!organization || !project || !az?.pat) return null;
  return new Azure({ organization, project, pat: az.pat });
}

/**
 * Env vars that let `git push` sign in to Azure Repos with the saved token, without writing it to any git config
 * file or putting it in the command line.
 */
export function gitAuthEnv(pat: string | undefined, remoteUrl: string): Record<string, string> {
  if (!pat || !/^https:\/\//i.test(remoteUrl) || !parseAzureRemote(remoteUrl)) return {};
  const host = new URL(remoteUrl).host;
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

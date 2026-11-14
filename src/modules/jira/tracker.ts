import { ModuleError } from '../errors.js';
import type {
  BugSeverity,
  ItemLevel,
  ItemList,
  ItemStage,
  NewTrackerItem,
  Sprint,
  Tracker,
  TrackerAbilities,
  TrackerItem,
  TrackerItemChange,
  TrackerItemRow,
  TrackerLevels,
} from '../tracker/types.js';
import { adfToMarkdown } from './adf-read.js';
import { markdownToAdf } from './adf-write.js';
import type { JiraClient } from './client.js';
import { JiraContext, type Status } from './context.js';
import { createIssue, fileBugIssue, findMadeIssue, linkBlockedBy, updateIssue } from './create.js';
import { levelsOf } from './levels.js';
import { parseRef, projectOfKey, refOf } from './refs.js';
import { blockedBy, labelOf, rowFields, rowOf, type RawIssue } from './rows.js';
import type { JiraSettings } from './settings.js';
import { goalOf, nextStep, rankOf } from './states.js';

/**
 * Jira Cloud as a squad-kit tracker: a project's stories, tasks and bugs in its backlog's rank order, a board's sprints,
 * the workflow's statuses by their categories, comments and labels, bugs, and a breakdown's items. Every search goes
 * through Jira's paged JQL search; sprints and boards come from its Agile API.
 */

const CAP = 500;
const CRITERIA = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)?(?:done when|acceptance criteria)(?:\*\*)?:?(?:\*\*)?[ \t]*$/im;

/** A description with its "done when" part apart, for a project whose stories keep it in the text. */
function splitCriteria(text: string): { description: string; acceptance: string } {
  const at = CRITERIA.exec(text);
  return at ? { description: text.slice(0, at.index).trim(), acceptance: text.slice(at.index + at[0].length).trim() } : { description: text, acceptance: '' };
}

interface RawSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
}

export class JiraTracker implements Tracker {
  readonly name = 'jira';
  readonly label = 'Jira';
  readonly abilities: TrackerAbilities;
  private readonly ctx: JiraContext;

  constructor(
    readonly client: JiraClient,
    readonly settings: JiraSettings,
  ) {
    this.ctx = new JiraContext(client, settings);
    // Read only (set up before this version) or no project yet: a breakdown cannot be sent.
    this.abilities = { sprints: Boolean(settings.board), wiki: false, bugs: true, tags: true, create: !settings.readOnly && Boolean(settings.project) };
  }

  get identity(): string {
    const s = this.settings;
    return `${s.site}/${s.email}/${s.project ?? ''}/${s.board?.id ?? ''}`;
  }

  parseRef(text: string): string | null {
    return parseRef(text, this.settings.project);
  }

  refOf(id: string): string {
    return refOf(id, this.settings.project);
  }

  async whoAmI(): Promise<string> {
    const me = await this.client.call<{ accountId?: string; displayName?: string; emailAddress?: string }>('GET', '/rest/api/3/myself');
    if (!me?.accountId) throw new ModuleError('Jira did not say who this API token belongs to. Check the email and token in Settings.', 'sign-in');
    return me.displayName || me.emailAddress || this.settings.email;
  }

  /** The board's sprints: the running and next ones, and the ten newest finished ones. */
  async sprints(): Promise<Sprint[]> {
    const board = this.settings.board;
    if (!board) return [];
    const all: RawSprint[] = [];
    for (let page = 0; page < 10; page += 1) {
      const got = await this.client.call<{ values?: RawSprint[]; isLast?: boolean }>('GET', `/rest/agile/1.0/board/${board.id}/sprint?state=active,future,closed&startAt=${all.length}&maxResults=50`);
      all.push(...(got?.values ?? []));
      if (got?.isLast !== false || !got.values?.length) break;
    }
    const closed = all.filter((s) => s.state === 'closed').slice(-10);
    return [...closed, ...all.filter((s) => s.state !== 'closed')].map((s) => ({
      name: s.name,
      path: String(s.id),
      ...(s.startDate ? { start: s.startDate.slice(0, 10) } : {}),
      ...(s.endDate ? { finish: s.endDate.slice(0, 10) } : {}),
      current: s.state === 'active',
    }));
  }

  /** The project's stories, tasks and bugs in its backlog's rank order, or a sprint's. At most 500. */
  async list(opts: { sprint?: string; includeDone?: boolean } = {}): Promise<ItemList> {
    const project = this.ctx.project();
    const sprint = opts.sprint === undefined ? undefined : Number(opts.sprint);
    if (sprint !== undefined && !(Number.isInteger(sprint) && sprint > 0)) throw new ModuleError(`"${opts.sprint}" is not a Jira sprint.`, 'not-found');
    const standard = (await this.ctx.types(project)).filter((t) => t.level === 0 && !t.subtask).map((t) => t.id);
    const where = [
      `project = "${project}"`,
      standard.length ? `issuetype in (${standard.join(', ')})` : 'issuetype in standardIssueTypes()',
      sprint ? `sprint = ${sprint}` : '',
      opts.includeDone ? '' : 'statusCategory != Done',
    ];
    const fields = await this.ctx.fields();
    const found = await this.client.search<RawIssue>(`${where.filter(Boolean).join(' AND ')} ORDER BY Rank ASC`, rowFields(fields), CAP);
    const rows: ItemList = found.issues.map((i) => rowOf(i, fields, (k) => this.client.browseUrl(k)));
    if (found.more) rows.more = true;
    return rows;
  }

  async get(id: string): Promise<TrackerItem> {
    const key = this.key(id);
    const fields = await this.ctx.fields();
    const want = [...rowFields(fields), 'description', 'attachment', 'parent', 'issuelinks', ...(fields.criteria ? [fields.criteria.id] : [])];
    const issue = await this.client.call<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${want.join(',')}`);
    const description = adfToMarkdown(issue.fields.description);
    const criteria = fields.criteria ? adfToMarkdown(issue.fields[fields.criteria.id]) : '';
    const text = criteria ? { description, acceptance: criteria } : splitCriteria(description);
    // The feature and epic above it, nearest first: Jira gives the parent; its own parent is asked for.
    const parents: TrackerItem['parents'] = [];
    for (let p = issue.fields.parent; p && parents.length < 3; ) {
      parents.push({ id: p.key, type: p.fields?.issuetype?.name ?? '', title: p.fields?.summary ?? '' });
      p = (await this.client.call<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(p.key)}?fields=parent`).catch(() => null))?.fields.parent;
    }
    return {
      ...rowOf(issue, fields, (k) => this.client.browseUrl(k)),
      description: text.description,
      acceptanceCriteria: text.acceptance,
      reproSteps: '',
      parents,
      dependsOn: blockedBy(issue.fields.issuelinks),
      attachments: (issue.fields.attachment ?? []).map((a) => ({ name: a.filename, url: a.content, size: a.size ?? 0 })),
    };
  }

  download(url: string, file: string): Promise<string> {
    return this.client.download(url, file);
  }

  async wikiPages(): Promise<{ path: string; content: string }[]> {
    return [];
  }

  /** Forward only, through the workflow's own transitions, a step at a time when it has no direct way. */
  async moveTo(id: string, stage: ItemStage, opts: { merged?: boolean } = {}): Promise<string | null> {
    this.ctx.writing();
    const key = this.key(id);
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}`;
    const issue = await this.client.call<RawIssue>('GET', `${path}?fields=status,issuetype`);
    let now: Status = { name: issue.fields.status?.name ?? '', category: issue.fields.status?.statusCategory?.key ?? '' };
    const goal = goalOf(stage, await this.ctx.statuses(projectOfKey(key), issue.fields.issuetype?.name ?? ''), opts.merged);
    let moved: string | null = null;
    for (let hop = 0; hop < 4 && rankOf(now) < goal; hop += 1) {
      const raw = await this.client.call<{ transitions?: { id: string; to: { name: string; statusCategory?: { key?: string } } }[] }>('GET', `${path}/transitions`);
      const step = nextStep((raw?.transitions ?? []).map((t) => ({ id: t.id, to: { name: t.to.name, category: t.to.statusCategory?.key ?? '' } })), now, goal);
      if (!step) break;
      await this.client.call('POST', `${path}/transitions`, { transition: { id: step.id } });
      now = step.to;
      moved = step.to.name;
    }
    return moved;
  }

  /** None: Jira does not close an issue from a pull request's text. squad-kit moves it itself. */
  closesWith(): string | null {
    return null;
  }

  async comment(id: string, markdown: string): Promise<void> {
    this.ctx.writing();
    await this.client.call('POST', `/rest/api/3/issue/${encodeURIComponent(this.key(id))}/comment`, { body: markdownToAdf(markdown) });
  }

  async addTag(id: string, tag: string): Promise<void> {
    this.ctx.writing();
    await this.client.call('PUT', `/rest/api/3/issue/${encodeURIComponent(this.key(id))}`, { update: { labels: [{ add: labelOf(tag) }] } });
  }

  fileBug(input: { title: string; steps: string; severity: BugSeverity; tags: string[]; related: string[] }): Promise<TrackerItemRow> {
    return fileBugIssue(this.ctx, { ...input, related: input.related.map((r) => this.key(r)) });
  }

  levels(): Promise<TrackerLevels> {
    return levelsOf(this.ctx);
  }

  createItem(input: NewTrackerItem): Promise<TrackerItemRow> {
    return createIssue(this.ctx, { ...input, ...(input.parent ? { parent: this.key(input.parent) } : {}) });
  }

  findMade(input: { level: ItemLevel; tag: string; mark: string }): Promise<TrackerItemRow | null> {
    return findMadeIssue(this.ctx, input);
  }

  updateItem(id: string, change: TrackerItemChange): Promise<void> {
    return updateIssue(this.ctx, this.key(id), { ...change, ...(change.parent !== undefined ? { parent: this.key(change.parent) } : {}) });
  }

  linkDepends(id: string, on: string[]): Promise<void> {
    return linkBlockedBy(this.ctx, this.key(id), on.map((o) => this.key(o)));
  }

  /** The issue key an id names; anything else is refused before Jira is asked. */
  private key(id: string): string {
    const key = this.parseRef(id);
    if (!key) throw new ModuleError(`"${id}" is not a Jira issue key, like PAY-40.`, 'not-found');
    return key;
  }
}

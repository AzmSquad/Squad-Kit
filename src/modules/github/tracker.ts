import fs from 'node:fs';
import path from 'node:path';
import type {
  BugSeverity,
  ItemLevel,
  ItemStage,
  NewTrackerItem,
  ItemList,
  Sprint,
  Tracker,
  TrackerAbilities,
  TrackerItem,
  TrackerItemChange,
  TrackerItemRow,
  TrackerLevels,
} from '../tracker/types.js';
import { ModuleError } from '../errors.js';
import { attachmentsOf, hostedFile, textOf } from './body.js';
import type { GithubCalls } from './calls.js';
import { GithubContext } from './context.js';
import { createIssue, fileBugIssue, findMadeIssue, levelsOf, linkBlockedBy, updateIssue } from './create.js';
import { addToBoard, BOARD_CAP, boardItems, priorityOf, setOption, sprintsOf, valueOf, type Board } from './project.js';
import { byTeam, fromRest, rowOf, typeOf, type IssueNode, type RestIssue, type ValueNode } from './queries.js';
import { idOf, parseRef, refOf, splitRepo, ticketName } from './refs.js';
import type { GithubSettings } from './settings.js';
import { forwardTo, isFinished } from './states.js';

/**
 * GitHub as a squad-kit tracker: stories from a repo's Issues, or from a Project board. A board's Status options are
 * the states and its iterations the sprints; the repo's Issues alone are open or closed. Sub-issues are the parents,
 * "blocked by" the items a story needs.
 */

const IMAGE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };

export class GithubTracker implements Tracker {
  readonly name = 'github';
  readonly label = 'GitHub';
  readonly abilities: TrackerAbilities;
  private readonly ctx: GithubContext;

  constructor(
    calls: GithubCalls,
    readonly settings: GithubSettings,
  ) {
    this.ctx = new GithubContext(calls, settings);
    // Read only (set up before this version): a breakdown cannot be sent. Moves, comments and bugs wait in the queue.
    this.abilities = { sprints: settings.from === 'project' && Boolean(settings.sprints), wiki: false, bugs: true, tags: true, create: !settings.readOnly };
  }

  get identity(): string {
    return `${this.settings.repo}/${this.settings.from}/${this.settings.board?.id ?? ''}`;
  }

  parseRef(text: string): string | null {
    return parseRef(text, this.settings.repo);
  }

  refOf(id: string): string {
    return refOf(id, this.settings.repo);
  }

  ticketName(id: string): string {
    return ticketName(id, this.settings.repo);
  }

  /** The signed-in login. With a board, the board is read too, so a missing Projects right shows at connect. */
  async whoAmI(): Promise<string> {
    const me = await this.ctx.calls.rest<{ login: string }>('/user');
    await this.ctx.board();
    return me.login;
  }

  async sprints(): Promise<Sprint[]> {
    const board = await this.ctx.board();
    return board ? sprintsOf(board) : [];
  }

  async list(opts: { sprint?: string; includeDone?: boolean } = {}): Promise<ItemList> {
    return this.ctx.board() ? this.boardList(opts) : this.issueList(opts.includeDone);
  }

  /** Only the team's issues, unless the person chose stories from anyone: others' words could steer the agents. */
  private wanted(issue: IssueNode): boolean {
    return this.settings.anyone || byTeam(issue);
  }

  /** The repo's issues with the chosen labels and assignee, newest first. At most 500 are read. */
  private async issueList(includeDone = false): Promise<ItemList> {
    const { owner, name } = splitRepo(this.settings.repo);
    const q = new URLSearchParams({ state: includeDone ? 'all' : 'open', per_page: '100' });
    if (this.settings.labels.length) q.set('labels', this.settings.labels.join(','));
    const who = this.settings.assignee;
    if (who) q.set('assignee', who === '@me' ? (await this.ctx.calls.rest<{ login: string }>('/user')).login : who.replace(/^@/, ''));
    const rows: ItemList = [];
    for (let page = 1; page <= BOARD_CAP / 100; page += 1) {
      q.set('page', String(page));
      const issues = await this.ctx.calls.rest<RestIssue[]>(`/repos/${owner}/${name}/issues?${q.toString()}`);
      const mine = issues.filter((i) => !i.pull_request).map((i) => fromRest(i, this.settings.repo));
      rows.push(...mine.filter((i) => this.wanted(i)).map((i) => rowOf(i, this.settings.repo)));
      if (issues.length < 100) return rows;
    }
    rows.more = true;
    return rows;
  }

  /**
   * The board's issues in its own order, as its view, Status or sprint shows them, without the merged and released
   * ones. GitHub filters them, so the 500 read are the ones asked for.
   */
  private async boardList(opts: { sprint?: string; includeDone?: boolean }): Promise<ItemList> {
    const stages = await this.ctx.stages();
    const board = stages?.board ?? (await this.ctx.board())!;
    const view = this.settings.view ? board.views.find((v) => v.name === this.settings.view) : undefined;
    const status = this.settings.status;
    const sprint = opts.sprint ? board.iteration?.iterations.find((i) => i.id === opts.sprint)?.title : undefined;
    const said = (field: string, value: string | undefined) => (value ? `${field.toLowerCase().replace(/\s+/g, '-')}:"${value.replace(/"/g, '')}"` : '');
    const query = [view?.filter ?? '', said('status', status), said(board.iteration?.name ?? 'iteration', sprint), opts.includeDone ? '' : 'is:open'];
    const read = await boardItems(this.ctx.calls, board, query.filter(Boolean).join(' '));
    const rows: ItemList = [];
    for (const item of read.items) {
      const state = valueOf(item.values, board.status?.id)?.name;
      if (!opts.includeDone && stages && state !== status && isFinished(state, stages.map, stages.options)) continue;
      if (opts.sprint && valueOf(item.values, board.iteration?.id)?.iterationId !== opts.sprint) continue;
      if (!this.wanted(item.issue)) continue;
      rows.push(rowOf(item.issue, this.settings.repo, this.boardValues(board, item.values)));
    }
    if (read.more) rows.more = true;
    return rows;
  }

  private boardValues(board: Board, values: ValueNode[]): Partial<Pick<TrackerItemRow, 'state' | 'points' | 'priority' | 'sprint'>> {
    const state = valueOf(values, board.status?.id)?.name;
    const points = valueOf(values, board.points?.id)?.number;
    const priority = priorityOf(valueOf(values, board.priority?.id)?.name, board.priority?.options ?? []);
    const sprint = valueOf(values, board.iteration?.id)?.title;
    return { ...(state ? { state } : {}), ...(points !== undefined ? { points } : {}), ...(priority ? { priority } : {}), ...(sprint ? { sprint } : {}) };
  }

  async get(id: string): Promise<TrackerItem> {
    const issue = await this.ctx.detail(id);
    const board = await this.ctx.board();
    const onBoard = board ? issue.projectItems?.nodes.find((n) => n?.project.id === board.id) : undefined;
    const text = textOf(issue.body);
    const parents: TrackerItem['parents'] = [];
    for (let p = issue.parent ?? undefined; p; p = p.parent ?? undefined) parents.push({ id: idOf(p.repository.nameWithOwner, p.number), type: typeOf(p), title: p.title });
    return {
      ...rowOf(issue, this.settings.repo, board && onBoard ? this.boardValues(board, onBoard.fieldValues.nodes) : {}),
      description: text.description,
      acceptanceCriteria: text.acceptance,
      reproSteps: '',
      parents,
      dependsOn: issue.blockedBy.nodes
        .filter(Boolean)
        .map((b) => ({ ref: this.refOf(idOf(b.repository.nameWithOwner, b.number)), title: b.title, state: b.state === 'OPEN' ? 'Open' : 'Closed' })),
      attachments: attachmentsOf(issue.body ?? ''),
    };
  }

  /** An image saved without its kind in the name gets the one GitHub says. */
  async download(url: string, file: string): Promise<string> {
    if (!hostedFile(url)) throw new ModuleError('squad-kit only downloads files kept on GitHub itself.', 'not-found');
    const { bytes, type } = await this.ctx.calls.download(url);
    const ext = IMAGE_EXT[type.split(';')[0]!.trim().toLowerCase()];
    const target = ext && path.extname(file).toLowerCase() !== ext && /^image-\d+\.png$/.test(path.basename(file)) ? file.replace(/\.png$/, ext) : file;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return target;
  }

  async wikiPages(): Promise<{ path: string; content: string }[]> {
    return [];
  }

  /**
   * On a board: the Status of the stage, only forward, putting the issue on the board when it is not there yet. Merged
   * and released also close the issue, as a merged pull request that says "Closes #40" would. Issues alone are open
   * until then.
   */
  async moveTo(id: string, stage: ItemStage): Promise<string | null> {
    this.ctx.writing();
    const issue = await this.ctx.detail(id);
    let moved: string | null = null;
    const stages = await this.ctx.stages();
    if (stages) {
      const { board } = stages;
      const item = issue.projectItems?.nodes.find((n) => n?.project.id === board.id);
      const to = forwardTo(stage, item ? valueOf(item.fieldValues.nodes, board.status!.id)?.name : null, stages.options, stages.map);
      if (to) {
        await setOption(this.ctx.calls, board, item?.id ?? (await addToBoard(this.ctx.calls, board, issue.id)), board.status!, to);
        moved = to;
      }
    }
    if ((stage === 'resolved' || stage === 'closed') && issue.state === 'OPEN') {
      await this.ctx.calls.rest(this.ctx.path(id), { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
      moved ??= 'Closed';
    }
    return moved;
  }

  /** GitHub writes Markdown itself. */
  async comment(id: string, markdown: string): Promise<void> {
    this.ctx.writing();
    await this.ctx.calls.rest(`${this.ctx.path(id)}/comments`, { method: 'POST', body: { body: markdown } });
  }

  async addTag(id: string, tag: string): Promise<void> {
    this.ctx.writing();
    await this.ctx.calls.rest(`${this.ctx.path(id)}/labels`, { method: 'POST', body: { labels: [tag] } });
  }

  fileBug(input: { title: string; steps: string; severity: BugSeverity; tags: string[]; related: string[] }): Promise<TrackerItemRow> {
    return fileBugIssue(this.ctx, input);
  }

  levels(): Promise<TrackerLevels> {
    return levelsOf(this.ctx);
  }

  createItem(input: NewTrackerItem): Promise<TrackerItemRow> {
    return createIssue(this.ctx, input);
  }

  findMade(input: { level: ItemLevel; tag: string; mark: string }): Promise<TrackerItemRow | null> {
    return findMadeIssue(this.ctx, input);
  }

  updateItem(id: string, change: TrackerItemChange): Promise<void> {
    return updateIssue(this.ctx, id, change);
  }

  linkDepends(id: string, on: string[]): Promise<void> {
    return linkBlockedBy(this.ctx, id, on);
  }
}

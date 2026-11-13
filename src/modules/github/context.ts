import { ModuleError } from '../errors.js';
import type { ItemStage } from '../tracker/types.js';
import type { GithubCalls } from './calls.js';
import { boardById, type Board } from './project.js';
import { issueDetail, type IssueDetail } from './queries.js';
import { keyOf, splitRepo, type IssueKey } from './refs.js';
import type { GithubSettings } from './settings.js';
import { stageOptions } from './states.js';

/** Why a write waits: GitHub was set up before this version, and squad-kit asks once before it writes there. */
const READ_ONLY = 'squad-kit only reads GitHub for this project until you connect it again: press Save and check in Settings, or run squad config set tracker --type github';

/** What every part of the GitHub tracker shares: the calls, the settings, and what it read once already. */
export class GithubContext {
  private boardRead?: Promise<Board>;
  private typesRead?: Promise<{ id: string; name: string }[]>;
  private nodes = new Map<string, string>();

  constructor(
    readonly calls: GithubCalls,
    readonly settings: GithubSettings,
  ) {}

  get own(): string {
    return this.settings.repo;
  }

  key(id: string): IssueKey {
    return keyOf(id, this.own);
  }

  /** The REST path of an issue. */
  path(id: string): string {
    const k = this.key(id);
    return `/repos/${k.owner}/${k.name}/issues/${k.number}`;
  }

  /** Stops a write while squad-kit may only read GitHub (a setup from before this version). */
  writing(): void {
    if (this.settings.readOnly) throw new ModuleError(READ_ONLY, 'sign-in');
  }

  async detail(id: string): Promise<IssueDetail> {
    const k = this.key(id);
    const query = issueDetail(Boolean(this.board()));
    const data = await this.calls.graphql<{ repository: { issue: IssueDetail | null } | null }>(query, { owner: k.owner, name: k.name, number: k.number });
    const issue = data.repository?.issue;
    if (!issue) throw new ModuleError(`GitHub has no issue ${k.owner}/${k.name}#${k.number}.`, 'not-found');
    this.nodes.set(id, issue.id);
    return issue;
  }

  /** The GraphQL id of an issue, which the links between issues need. */
  async nodeId(id: string): Promise<string> {
    const known = this.nodes.get(id);
    if (known) return known;
    const issue = await this.calls.rest<{ node_id: string }>(this.path(id));
    this.nodes.set(id, issue.node_id);
    return issue.node_id;
  }

  remember(id: string, nodeId: string): void {
    this.nodes.set(id, nodeId);
  }

  /** The Project board the stories come from, or null for Issues. */
  board(): Promise<Board> | null {
    const b = this.settings.from === 'project' ? this.settings.board : undefined;
    if (!b) return null;
    this.boardRead ??= boardById(this.calls, b.id);
    return this.boardRead;
  }

  /** The Status option for each stage on the board. */
  async stages(): Promise<{ board: Board; options: string[]; map: Partial<Record<ItemStage, string>> } | null> {
    const board = await this.board();
    if (!board?.status) return null;
    const options = board.status.options.map((o) => o.name);
    return { board, options, map: stageOptions(options, this.settings.stages) };
  }

  /** The organization's issue types for the repo (Task, Bug, Feature…). A repo without them has none. */
  issueTypes(): Promise<{ id: string; name: string }[]> {
    const { owner, name } = splitRepo(this.own);
    this.typesRead ??= this.calls
      .graphql<{ repository: { issueTypes: { nodes: { id: string; name: string; isEnabled: boolean }[] } | null } | null }>(
        `query SquadIssueTypes($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issueTypes(first: 30) { nodes { id name isEnabled } } } }`,
        { owner, name },
      )
      .then((d) => (d.repository?.issueTypes?.nodes ?? []).filter((t) => t?.isEnabled).map((t) => ({ id: t.id, name: t.name })))
      .catch(() => []);
    return this.typesRead;
  }
}

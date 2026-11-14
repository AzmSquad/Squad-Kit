import { buildPaths } from '../../core/paths.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { loadSecrets, mergeSecrets, saveSecrets } from '../../core/secrets.js';
import type {
  BugSeverity,
  ItemLevel,
  ItemStage,
  NewTrackerItem,
  Tracker,
  TrackerItem,
  TrackerItemChange,
  TrackerItemRow,
  TrackerLevels,
  TrackerModule,
} from '../tracker/types.js';
import { Azure, AzureError, parseAzureRemote, PROCESS_TYPES, processOf, type PatchOp, type StateCategory, type WorkItemRow } from './client.js';
import { azureForProject } from './sign-in.js';
import { signedInWithMicrosoft } from './token.js';
import { markdownToHtml } from './markdown.js';

/** Azure Boards as a squad-kit tracker. */

const CRITERIA = 'Microsoft.VSTS.Common.AcceptanceCriteria';
const PARENT = 'System.LinkTypes.Hierarchy-Reverse';
/** A predecessor: the item it points to comes first. The client reads these links as an item's dependsOn. */
const PREDECESSOR = 'System.LinkTypes.Dependency-Reverse';
const LEVEL_WORD: Record<ItemLevel, string> = { epic: 'epics', feature: 'features', story: 'stories' };

const STAGE: Record<ItemStage, StateCategory> = { 'not-started': 'Proposed', 'in-progress': 'InProgress', resolved: 'Resolved', closed: 'Completed' };
const SEVERITY: Record<BugSeverity, string> = { 'stops-work': '1 - Critical', annoying: '3 - Medium', small: '4 - Low' };

function num(id: string): number {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`"${id}" is not a work item number.`);
  return n;
}

function row(w: WorkItemRow): TrackerItemRow {
  return { ...w, id: String(w.id), ref: `AB#${w.id}`, isBug: w.type === 'Bug' };
}

export class AzureTracker implements Tracker {
  readonly name = 'azure';
  readonly label = 'Azure DevOps';
  readonly abilities = { sprints: true, wiki: true, bugs: true, tags: true, create: true };

  constructor(readonly az: Azure) {}

  get identity(): string {
    const t = this.az.target;
    return `${t.organization}/${t.project}/${t.pat ? t.pat.slice(-6) : 'microsoft'}`;
  }

  parseRef(text: string): string | null {
    const id = text.trim().replace(/^AB#/i, '').replace(/^#/, '');
    return /^\d+$/.test(id) && Number(id) > 0 ? id : null;
  }

  refOf(id: string): string {
    return `AB#${id}`;
  }

  whoAmI(): Promise<string> {
    return this.az.whoAmI();
  }

  sprints() {
    return this.az.sprints();
  }

  async list(opts: { sprint?: string; includeDone?: boolean } = {}): Promise<TrackerItemRow[]> {
    return (await this.az.listWorkItems({ ...(opts.sprint ? { sprintPath: opts.sprint } : {}), ...(opts.includeDone ? { includeDone: true } : {}) })).map(row);
  }

  async get(id: string): Promise<TrackerItem> {
    const w = await this.az.getWorkItem(num(id));
    return {
      ...row(w),
      description: w.description,
      acceptanceCriteria: w.acceptanceCriteria,
      reproSteps: w.reproSteps,
      parents: w.parents.map((p) => ({ ...p, id: String(p.id) })),
      dependsOn: w.dependsOn.map((d) => ({ ref: `AB#${d.id}`, title: d.title, state: d.state })),
      attachments: w.attachments,
    };
  }

  download(url: string, file: string): Promise<string> {
    return this.az.download(url, file);
  }

  wikiPages() {
    return this.az.wikiPages();
  }

  moveTo(id: string, stage: ItemStage): Promise<string | null> {
    return this.az.moveTo(num(id), STAGE[stage]);
  }

  comment(id: string, markdown: string): Promise<void> {
    return this.az.comment(num(id), markdownToHtml(markdown));
  }

  addTag(id: string, tag: string): Promise<void> {
    return this.az.addTag(num(id), tag);
  }

  async fileBug(input: { title: string; steps: string; severity: BugSeverity; tags: string[]; related: string[] }): Promise<TrackerItemRow> {
    return row(
      await this.az.createBug({
        title: input.title,
        reproSteps: markdownToHtml(input.steps),
        severity: SEVERITY[input.severity],
        tags: input.tags,
        relatedIds: input.related.map(num),
      }),
    );
  }

  /** The item types from the project's own work item types: its process says which ones are epics, features and stories. */
  async levels(): Promise<TrackerLevels> {
    const types = (await this.az.workItemTypes()).map((t) => t.name);
    const process = processOf(types);
    if (!process) {
      throw new AzureError(
        `Project ${this.az.target.project} on Azure DevOps has no User Story, Product Backlog Item, Requirement or Issue work item type, so squad-kit cannot tell which items to make for the stories.`,
        undefined,
        'not-found',
      );
    }
    return { ...PROCESS_TYPES[process], process, project: this.az.target.project };
  }

  async createItem(input: NewTrackerItem): Promise<TrackerItemRow> {
    const levels = await this.levels();
    const type = levels[input.level];
    if (!(await this.az.workItemTypes()).some((t) => t.name.toLowerCase() === type.toLowerCase())) {
      throw new AzureError(
        `Project ${this.az.target.project} on Azure DevOps has no ${type} work item type, which the ${levels.process} process uses for ${LEVEL_WORD[input.level]}. Turn it on in the project's process settings, or ask the person who runs Azure DevOps.`,
        undefined,
        'not-found',
      );
    }
    const ops: PatchOp[] = [{ op: 'add', path: '/fields/System.Title', value: input.title }, ...(await this.textOps(type, input.markdown, input.acceptance))];
    if (input.tags?.length) ops.push({ op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') });
    if (input.parent) ops.push(this.link(PARENT, num(input.parent)));
    // No iteration: the item lands in the project's backlog, never in a sprint.
    return row(await this.writing(`make ${/^[aeiou]/i.test(type) ? 'an' : 'a'} ${type}`, () => this.az.createWorkItem(type, ops)));
  }

  /** An item made before by a send that was cut off before it saved the link: its tag and its "Made by squad-kit" line. */
  async findMade(input: { level: ItemLevel; tag: string; mark: string }): Promise<TrackerItemRow | null> {
    const type = (await this.levels())[input.level];
    const found = await this.az.findByTagAndText(type, input.tag, input.mark);
    return found ? row(found) : null;
  }

  async updateItem(id: string, change: TrackerItemChange): Promise<void> {
    const n = num(id);
    const item = await this.az.linksOf(n);
    const ops: PatchOp[] = [];
    if (change.title !== undefined) ops.push({ op: 'add', path: '/fields/System.Title', value: change.title });
    if (change.markdown !== undefined || change.acceptance !== undefined) ops.push(...(await this.textOps(item.type, change.markdown, change.acceptance)));
    if (change.parent !== undefined) {
      const parent = num(change.parent);
      const at = item.relations.findIndex((r) => r.rel === PARENT);
      if (item.relations[at]?.id !== parent) {
        // An item has one parent: the old link goes before the new one is added.
        if (at >= 0) ops.push({ op: 'remove', path: `/relations/${at}` });
        ops.push(this.link(PARENT, parent));
      }
    }
    await this.writing(`change ${this.refOf(id)}`, () => this.az.updateWorkItem(n, ops));
  }

  async linkDepends(id: string, on: string[]): Promise<void> {
    const n = num(id);
    const item = await this.az.linksOf(n);
    const have = new Set(item.relations.filter((r) => r.rel === PREDECESSOR).map((r) => r.id));
    const missing = [...new Set(on.map(num))].filter((d) => d !== n && !have.has(d));
    await this.writing(`link ${this.refOf(id)} to the items it needs`, () => this.az.updateWorkItem(n, missing.map((d) => this.link(PREDECESSOR, d))));
  }

  /**
   * The description, and the acceptance criteria in their own field when the type has one. A type without it (Basic's
   * Issue and Task) gets them at the end of its description, under Done when.
   */
  private async textOps(type: string, markdown: string | undefined, acceptance: string | undefined): Promise<PatchOp[]> {
    const ops: PatchOp[] = [];
    const criteriaField = acceptance !== undefined && (await this.az.typeHasField(type, CRITERIA));
    if (criteriaField) {
      if (markdown !== undefined) ops.push({ op: 'add', path: '/fields/System.Description', value: markdownToHtml(markdown) });
      ops.push({ op: 'add', path: `/fields/${CRITERIA}`, value: markdownToHtml(acceptance) });
      return ops;
    }
    const text = [markdown ?? '', acceptance?.trim() ? `**Done when**\n\n${acceptance.trim()}` : ''].filter(Boolean).join('\n\n');
    ops.push({ op: 'add', path: '/fields/System.Description', value: markdownToHtml(text) });
    return ops;
  }

  private link(rel: string, id: number): PatchOp {
    return { op: 'add', path: '/relations/-', value: { rel, url: this.az.itemApiUrl(id) } };
  }

  /** A write Azure turned down because of the token or the person's rights gets a plain way out. */
  private async writing<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const e = err as AzureError;
      if (e?.kind === 'sign-in' || /TF237111|permission/i.test(e?.message ?? '')) {
        throw new AzureError(
          `Azure DevOps did not let squad-kit ${what} in project ${this.az.target.project}. The token needs the Work Items (Read & write) scope, and its owner needs the right to add work items there. Check the token in Settings, then try again.`,
          e.status,
          'sign-in',
        );
      }
      throw err;
    }
  }
}

export const azureTracker: TrackerModule = {
  name: 'azure',
  label: 'Azure DevOps',
  about:
    'Stories and bugs come from Azure Boards. squad-kit moves them along as the squad works, opens a pull request for each finished ticket, and merges it when you release. Sign in with Microsoft on the Connections page, or paste a token here: a saved token is used first, and stays on this computer.',
  hint: 'Token scopes: Work Items and Code (read, write and manage).',
  fields: [
    { key: 'organization', label: 'Organization', placeholder: 'e.g. momenysr' },
    { key: 'project', label: 'Project', placeholder: 'e.g. Mawid' },
    { key: 'token', label: 'Token', secret: true, placeholder: 'Personal access token from Azure DevOps' },
  ],
  open(root) {
    const az = azureForProject(root);
    return az ? new AzureTracker(az) : null;
  },
  read(root) {
    const paths = buildPaths(root);
    const config = loadConfig(paths.configFile);
    const values: Record<string, string> = config.tracker.type === 'azure' ? { organization: config.tracker.workspace ?? '', project: config.tracker.project ?? '' } : {};
    const hasSecret = Boolean(loadSecrets(paths.secretsFile).tracker?.azure?.pat || process.env.AZURE_DEVOPS_PAT);
    // Both here: the token is used (ADR-011), and Settings says so.
    return { values, hasSecret, ...(hasSecret && signedInWithMicrosoft() ? { note: 'The token saved here is used, not your Microsoft sign-in.' } : {}) };
  },
  save(root, values) {
    const organization = values.organization?.trim().replace(/^https:\/\/dev\.azure\.com\//, '').replace(/\/.*$/, '');
    const project = values.project?.trim();
    if (!organization || !project) throw new Error('Enter the Azure organization and project.');
    const paths = buildPaths(root);
    const config = loadConfig(paths.configFile);
    // Another tracker's own settings go with it.
    const kept = config.tracker.type === 'azure' && config.tracker.options ? { options: config.tracker.options } : {};
    saveConfig(paths.configFile, { ...config, tracker: { type: 'azure', workspace: organization, project, ...kept } });
    const secrets = loadSecrets(paths.secretsFile);
    saveSecrets(paths.secretsFile, mergeSecrets(secrets, { tracker: { azure: { organization, project, pat: values.token?.trim() || undefined } } }));
  },
  guess(remoteUrl) {
    const where = parseAzureRemote(remoteUrl);
    return where ? { organization: where.organization, project: where.project } : null;
  },
};

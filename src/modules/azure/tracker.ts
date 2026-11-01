import { buildPaths } from '../../core/paths.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { loadSecrets, mergeSecrets, saveSecrets } from '../../core/secrets.js';
import type { BugSeverity, ItemStage, Tracker, TrackerItem, TrackerItemRow, TrackerModule } from '../tracker/types.js';
import { Azure, azureForProject, parseAzureRemote, type StateCategory, type WorkItemRow } from './client.js';
import { markdownToHtml } from './markdown.js';

/** Azure Boards as a squad-kit tracker. */

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
  readonly abilities = { sprints: true, wiki: true, bugs: true, tags: true };

  constructor(readonly az: Azure) {}

  get identity(): string {
    const t = this.az.target;
    return `${t.organization}/${t.project}/${t.pat.slice(-6)}`;
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
}

export const azureTracker: TrackerModule = {
  name: 'azure',
  label: 'Azure DevOps',
  fields: [
    { key: 'organization', label: 'Organization' },
    { key: 'project', label: 'Project' },
    { key: 'token', label: 'Personal access token', secret: true },
  ],
  open(root) {
    const az = azureForProject(root);
    return az ? new AzureTracker(az) : null;
  },
  read(root) {
    const paths = buildPaths(root);
    const config = loadConfig(paths.configFile);
    const values: Record<string, string> = config.tracker.type === 'azure' ? { organization: config.tracker.workspace ?? '', project: config.tracker.project ?? '' } : {};
    return {
      values,
      hasSecret: Boolean(loadSecrets(paths.secretsFile).tracker?.azure?.pat || process.env.AZURE_DEVOPS_PAT),
    };
  },
  save(root, values) {
    const organization = values.organization?.trim().replace(/^https:\/\/dev\.azure\.com\//, '').replace(/\/.*$/, '');
    const project = values.project?.trim();
    if (!organization || !project) throw new Error('Enter the Azure organization and project.');
    const paths = buildPaths(root);
    const config = loadConfig(paths.configFile);
    saveConfig(paths.configFile, { ...config, tracker: { ...config.tracker, type: 'azure', workspace: organization, project } });
    const secrets = loadSecrets(paths.secretsFile);
    saveSecrets(paths.secretsFile, mergeSecrets(secrets, { tracker: { azure: { organization, project, pat: values.token?.trim() || undefined } } }));
  },
  guess(remoteUrl) {
    const where = parseAzureRemote(remoteUrl);
    return where ? { organization: where.organization, project: where.project } : null;
  },
};

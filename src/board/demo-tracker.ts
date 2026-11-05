import type {
  BugSeverity,
  ItemLevel,
  ItemStage,
  NewTrackerItem,
  Sprint,
  Tracker,
  TrackerAbilities,
  TrackerItem,
  TrackerItemChange,
  TrackerItemRow,
  TrackerLevels,
} from '../modules/tracker/types.js';

/**
 * A tracker kept in memory, for the scripted squad and the tests: nothing goes over the network. By default it looks
 * like the demo board's tracker (items AB#120, AB#121 …). It makes epics, features and stories with their parent and
 * dependency links, moves items forward, takes comments and bugs, and can be told to fail part way, so a send that is
 * cut off half-way can be shown and tested.
 */

export interface DemoItem {
  id: string;
  type: string;
  title: string;
  state: string;
  /** In Markdown, as squad-kit wrote it. */
  description: string;
  acceptance: string;
  tags: string[];
  parent?: string;
  /** The ids of the items it needs first. */
  dependsOn: string[];
  comments: string[];
}

export interface DemoTrackerOptions {
  name?: string;
  label?: string;
  /** How people write an item id: AB#120. */
  prefix?: string;
  /** The item types and process it says it has. */
  levels?: Partial<TrackerLevels>;
  /** The first item number. */
  start?: number;
  /** An item's link is this followed by its id. No links when left out. */
  baseUrl?: string;
  /** How long each write takes, so the demo's progress can be seen moving. */
  delayMs?: number;
}

const STATES = ['New', 'Active', 'Resolved', 'Closed'];
const STAGE_AT: Record<ItemStage, number> = { 'not-started': 0, 'in-progress': 1, resolved: 2, closed: 3 };

export class DemoTracker implements Tracker {
  readonly name: string;
  readonly label: string;
  readonly abilities: TrackerAbilities = { sprints: false, wiki: false, bugs: true, tags: true, create: true };
  readonly identity: string;
  readonly items = new Map<string, DemoItem>();
  /** Every write that went through, in order: "create Epic 120", "update 121", "link 125 124". */
  readonly log: string[] = [];
  private nextId: number;
  private readonly lv: TrackerLevels;
  private readonly prefix: string;
  private readonly baseUrl: string;
  private readonly delayMs: number;
  private failing: { left: number; message: string } | null = null;

  constructor(opts: DemoTrackerOptions = {}) {
    this.name = opts.name ?? 'azure';
    this.label = opts.label ?? 'Azure DevOps';
    this.prefix = opts.prefix ?? 'AB#';
    this.lv = { epic: 'Epic', feature: 'Feature', story: 'User Story', process: 'Agile', ...opts.levels };
    this.nextId = opts.start ?? 120;
    this.baseUrl = opts.baseUrl ?? '';
    this.delayMs = opts.delayMs ?? 0;
    this.identity = `demo/${this.name}`;
  }

  /** After this many more writes, every write fails with the message, until mend(). */
  breakAfter(writes: number, message = `${this.label} did not answer`): void {
    this.failing = { left: writes, message };
  }

  mend(): void {
    this.failing = null;
  }

  /**
   * Items made before this tracker was (the app restarted): known again by their ids, so a send updates them instead
   * of failing, and new items get the numbers after them.
   */
  remember(items: { id: string; type: string; title: string; parent?: string }[]): void {
    for (const i of items) {
      if (!this.items.has(i.id)) this.items.set(i.id, { id: i.id, type: i.type, title: i.title, state: 'New', description: '', acceptance: '', tags: [], ...(i.parent ? { parent: i.parent } : {}), dependsOn: [], comments: [] });
      if (/^\d+$/.test(i.id)) this.nextId = Math.max(this.nextId, Number(i.id) + 1);
    }
  }

  parseRef(text: string): string | null {
    const id = text.trim().replace(new RegExp(`^${this.prefix.replace(/[^\w]/g, '\\$&')}`, 'i'), '').replace(/^#/, '');
    return /^\d+$/.test(id) && Number(id) > 0 ? id : null;
  }

  refOf(id: string): string {
    return `${this.prefix}${id}`;
  }

  async whoAmI(): Promise<string> {
    return 'Demo';
  }

  async sprints(): Promise<Sprint[]> {
    return [];
  }

  async list(opts: { sprint?: string; includeDone?: boolean } = {}): Promise<TrackerItemRow[]> {
    return [...this.items.values()]
      .filter((w) => w.type !== this.lv.epic && w.type !== this.lv.feature && (opts.includeDone || w.state !== 'Closed'))
      .map((w) => this.row(w));
  }

  async get(id: string): Promise<TrackerItem> {
    const w = this.item(id);
    const parents: TrackerItem['parents'] = [];
    for (let p = w.parent ? this.items.get(w.parent) : undefined; p && parents.length < 2; p = p.parent ? this.items.get(p.parent) : undefined) {
      parents.push({ id: p.id, type: p.type, title: p.title });
    }
    return {
      ...this.row(w),
      description: w.description,
      acceptanceCriteria: w.acceptance,
      reproSteps: '',
      parents,
      dependsOn: w.dependsOn.map((d) => this.item(d)).map((d) => ({ ref: this.refOf(d.id), title: d.title, state: d.state })),
      attachments: [],
    };
  }

  async download(): Promise<string> {
    throw new Error('The demo tracker keeps no files.');
  }

  async wikiPages(): Promise<{ path: string; content: string }[]> {
    return [];
  }

  async moveTo(id: string, stage: ItemStage): Promise<string | null> {
    const w = this.item(id);
    if (STAGE_AT[stage] <= STATES.indexOf(w.state)) return null;
    await this.write(`move ${id} ${STATES[STAGE_AT[stage]]}`);
    w.state = STATES[STAGE_AT[stage]]!;
    return w.state;
  }

  async comment(id: string, markdown: string): Promise<void> {
    const w = this.item(id);
    await this.write(`comment ${id}`);
    w.comments.push(markdown);
  }

  async addTag(id: string, tag: string): Promise<void> {
    const w = this.item(id);
    if (w.tags.includes(tag)) return;
    await this.write(`tag ${id} ${tag}`);
    w.tags.push(tag);
  }

  async fileBug(input: { title: string; steps: string; severity: BugSeverity; tags: string[]; related: string[] }): Promise<TrackerItemRow> {
    await this.write('create Bug');
    return this.row(this.add({ type: 'Bug', title: input.title, description: input.steps, tags: input.tags }));
  }

  async levels(): Promise<TrackerLevels> {
    return { ...this.lv };
  }

  async createItem(input: NewTrackerItem): Promise<TrackerItemRow> {
    if (input.parent) this.item(input.parent);
    const type = this.lv[input.level];
    await this.write(`create ${type} ${this.nextId}`);
    const w = this.add({ type, title: input.title, description: input.markdown, acceptance: input.acceptance ?? '', tags: input.tags ?? [], parent: input.parent });
    return this.row(w);
  }

  /** An item made before with this tag and this line in its text, newest first: a send cut off before saving it. */
  async findMade(input: { level: ItemLevel; tag: string; mark: string }): Promise<TrackerItemRow | null> {
    const type = this.lv[input.level];
    const hit = [...this.items.values()].reverse().find((w) => w.type === type && w.tags.includes(input.tag) && w.description.includes(input.mark));
    return hit ? this.row(hit) : null;
  }

  async updateItem(id: string, change: TrackerItemChange): Promise<void> {
    const w = this.item(id);
    if (change.parent) this.item(change.parent);
    await this.write(`update ${id}`);
    if (change.title !== undefined) w.title = change.title;
    if (change.markdown !== undefined) w.description = change.markdown;
    if (change.acceptance !== undefined) w.acceptance = change.acceptance;
    // One parent: the new one replaces the old.
    if (change.parent !== undefined) w.parent = change.parent;
  }

  async linkDepends(id: string, on: string[]): Promise<void> {
    const w = this.item(id);
    const missing = [...new Set(on)].filter((d) => d !== id && !w.dependsOn.includes(d));
    for (const d of missing) this.item(d);
    if (!missing.length) return;
    await this.write(`link ${id} ${missing.join(' ')}`);
    w.dependsOn.push(...missing);
  }

  private item(id: string): DemoItem {
    const w = this.items.get(String(id));
    if (!w) throw new Error(`${this.refOf(String(id))} is not in ${this.label}.`);
    return w;
  }

  private add(fields: Partial<DemoItem> & { type: string; title: string }): DemoItem {
    const id = String(this.nextId++);
    const w: DemoItem = { id, state: 'New', description: '', acceptance: '', tags: [], dependsOn: [], comments: [], ...fields };
    if (!w.parent) delete w.parent;
    this.items.set(id, w);
    return w;
  }

  private row(w: DemoItem): TrackerItemRow {
    return {
      id: w.id,
      ref: this.refOf(w.id),
      type: w.type,
      title: w.title,
      state: w.state,
      tags: [...w.tags],
      url: this.baseUrl ? `${this.baseUrl}${w.id}` : '',
      isBug: w.type === 'Bug',
    };
  }

  private async write(what: string): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failing) {
      if (this.failing.left <= 0) throw new Error(this.failing.message);
      this.failing.left -= 1;
    }
    this.log.push(what);
  }
}

export function demoTracker(opts: DemoTrackerOptions = {}): DemoTracker {
  return new DemoTracker(opts);
}

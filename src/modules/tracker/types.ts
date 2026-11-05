/**
 * A tracker: where the team keeps its work items, sprints and bugs. squad-kit calls it itself; agents never do.
 * Each product is one module behind this interface, and the engine never names a product (ADR-002).
 */

export interface TrackerItemRow {
  /** The tracker's own id, as text. */
  id: string;
  /** How people write it, for example AB#40 or PAY-40. */
  ref: string;
  type: string;
  title: string;
  state: string;
  points?: number;
  /** 1 is the highest. */
  priority?: number;
  sprint?: string;
  assignedTo?: string;
  tags: string[];
  url: string;
  isBug: boolean;
}

export interface TrackerItem extends TrackerItemRow {
  description: string;
  acceptanceCriteria: string;
  reproSteps: string;
  /** The feature and epic above it, nearest first. */
  parents: { id: string; type: string; title: string }[];
  /** Items it builds on. */
  dependsOn: { ref: string; title: string; state: string }[];
  attachments: { name: string; url: string; size: number }[];
}

export interface Sprint {
  name: string;
  /** What to pass back to list() to get this sprint's items. */
  path: string;
  start?: string;
  finish?: string;
  current: boolean;
}

/** squad-kit's four stages for an item. Each tracker maps them to its own states. */
export type ItemStage = 'not-started' | 'in-progress' | 'resolved' | 'closed';

export type BugSeverity = 'stops-work' | 'annoying' | 'small';

/** What this tracker can do. The board hides what it cannot, instead of failing. */
export interface TrackerAbilities {
  sprints: boolean;
  wiki: boolean;
  bugs: boolean;
  tags: boolean;
  /** Makes and updates epics, features and stories, with their parent and dependency links (a breakdown's send). */
  create: boolean;
}

/** The three levels of a breakdown, in the order a tracker nests them. */
export type ItemLevel = 'epic' | 'feature' | 'story';

/** The item type this project uses for each level, in the tracker's own words, and the process they come from. */
export interface TrackerLevels {
  epic: string;
  feature: string;
  story: string;
  /** The project's process (Agile, Scrum, CMMI, Basic), or the tracker's own name for its setup. */
  process: string;
  /** The project the items go into, for "Into project RoomFlow". */
  project?: string;
}

/** A new item. squad-kit writes Markdown; the module turns it into the tracker's own format. */
export interface NewTrackerItem {
  level: ItemLevel;
  title: string;
  /** The item's text. */
  markdown: string;
  /** The acceptance criteria. A type with no field for them gets them at the end of its text, under Done when. */
  acceptance?: string;
  /** The parent item's id. */
  parent?: string;
  tags?: string[];
}

/** What changes on an item that was made before. Left out: stays as it is. */
export interface TrackerItemChange {
  title?: string;
  markdown?: string;
  /** Give the markdown with it: a type that keeps the criteria in its text gets both written again. */
  acceptance?: string;
  /** The new parent item's id. An item has one parent, so this replaces the one it had. */
  parent?: string;
}

export interface Tracker {
  /** The module's name, saved on tickets that came from it. */
  readonly name: string;
  /** For people, for example "Azure DevOps". */
  readonly label: string;
  readonly abilities: TrackerAbilities;
  /** Which account and project this is, without secrets, so a saved connection check can tell when it changes. */
  readonly identity: string;
  /** The item id in what a person typed (AB#40, 40), or null when it is not one. */
  parseRef(text: string): string | null;
  /** How people write an item id. */
  refOf(id: string): string;
  /** The signed-in name, as a connection check. */
  whoAmI(): Promise<string>;
  sprints(): Promise<Sprint[]>;
  /** Stories and bugs, in backlog order; a sprint's items when given its path. */
  list(opts?: { sprint?: string; includeDone?: boolean }): Promise<TrackerItemRow[]>;
  get(id: string): Promise<TrackerItem>;
  /** Saves an attachment to a file and returns its path. */
  download(url: string, file: string): Promise<string>;
  wikiPages(): Promise<{ path: string; content: string }[]>;
  /** Moves the item forward to the stage; never backwards. Returns the new state, or null when it stayed. */
  moveTo(id: string, stage: ItemStage): Promise<string | null>;
  /** squad-kit writes Markdown; the module turns it into the tracker's own format. */
  comment(id: string, markdown: string): Promise<void>;
  addTag(id: string, tag: string): Promise<void>;
  fileBug(input: { title: string; steps: string; severity: BugSeverity; tags: string[]; related: string[] }): Promise<TrackerItemRow>;
  /** The item types for epics, features and stories in this project. Only when abilities.create. */
  levels(): Promise<TrackerLevels>;
  /** Makes an item into the project's backlog, never into a sprint, under its parent when given. */
  createItem(input: NewTrackerItem): Promise<TrackerItemRow>;
  /**
   * An item a send made but could not save (it was cut off right after making it), found by its tag and a line of its
   * text, so the next send uses it instead of making a double. Optional: without it, the item is made again.
   */
  findMade?(input: { level: ItemLevel; tag: string; mark: string }): Promise<TrackerItemRow | null>;
  /** Changes an item made before. squad-kit never deletes an item. */
  updateItem(id: string, change: TrackerItemChange): Promise<void>;
  /** Says the item needs these items first. Only the links it does not have yet are added. */
  linkDepends(id: string, on: string[]): Promise<void>;
}

/** A setting a person fills in for this tracker. Secrets are saved apart from the project's files. */
export interface SetupField {
  key: string;
  label: string;
  secret?: boolean;
}

export interface TrackerModule {
  name: string;
  label: string;
  fields: SetupField[];
  /** The tracker for a project folder, or null when it is not set up or has no sign-in saved. */
  open(root: string): Tracker | null;
  /** What is saved now (secrets only say whether they are there). */
  read(root: string): { values: Record<string, string>; hasSecret: boolean };
  /** Saves the settings; secrets left empty keep the saved ones. */
  save(root: string, values: Record<string, string | undefined>): void;
  /** Settings read from a git remote that lives on this product, for a project not set up yet. */
  guess(remoteUrl: string): Record<string, string> | null;
}

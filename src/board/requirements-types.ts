import type { Activity, Criterion, Payment, Question, UsageLine } from './types.js';

/**
 * A breakdown: one requirements document (a BRD) the Analyst turned into epics, features and stories.
 *
 * The project's part lives in `.squad/requirements/<id>/breakdown.yaml`, with the document, its text and its pictures
 * beside it (`source/`, `text/`, `media/`). What only this computer needs (the Analyst's job, the build switch, the
 * sync's progress) lives in `~/.squad-kit/projects/<id>/requirements/<id>.yaml` (ADR-001).
 *
 * Epics and features are groups. Only a story becomes a board ticket, and only when it starts.
 */

/**
 * reading: the Analyst reads the document. questions: it waits for the person's answers. drafting: it writes the
 * epics, features and stories. ready: the person reviews and edits it. approved: it may be built and sent to the
 * tracker. failed: the read or the draft did not get through (`error` says why, and Try again starts it again).
 */
export type BreakdownStatus = 'reading' | 'questions' | 'drafting' | 'ready' | 'approved' | 'failed';

export type StorySize = 'S' | 'M' | 'L';

/** The three levels, Azure's order. A small document may skip features: its stories sit straight under the epic. */
export type BreakdownLevel = 'epic' | 'feature' | 'story';

export interface BreakdownSource {
  /** The document inside the breakdown's folder ("source/RoomFlow BRD v2.docx"), or "source/pasted.md" for pasted text. */
  file: string;
  /** The name the person sees: the file name without its folder. */
  name: string;
  kind: 'pdf' | 'docx' | 'markdown' | 'text' | 'pasted';
  bytes: number;
  /** PDF pages, or the parts squad-kit split a long text into. */
  pages?: number;
  /** Pictures found in the document and kept beside its text. */
  pictures?: number;
  /** Mockups and other files the person added with it, inside the folder ("source/booking.png"). */
  extra?: string[];
  addedBy: string;
  addedAt: string;
}

/** Where in the document a part comes from: section 3.4 "Holding a slot", page 7. */
export interface BrdRef {
  section?: string;
  title?: string;
  page?: number;
}

/** Who made a small choice on their own instead of asking. 'answer': it follows from the person's answer to a question. */
export type DecidedBy = 'analyst' | 'architect' | 'builder' | 'tester' | 'reviewer' | 'answer';

/**
 * A small choice an agent made instead of asking, so nothing is hidden: the person sees it on the breakdown page and
 * on the ticket, and can change it. Changing it on a started story becomes a small change on that ticket (or a new
 * linked ticket once it is merged).
 */
export interface Decided {
  /** d1, d2 … unique inside its breakdown or ticket. */
  id: string;
  text: string;
  by: DecidedBy;
  at: string;
  /** The epic, feature or story it is about (S-4), when it is about one. */
  item?: string;
  /** The ticket it was decided on, once the story started. */
  ticket?: string;
  /** The person changed it: what they want instead, and the change or ticket it became. */
  changed?: { text: string; by: string; at: string; ticket?: string };
}

/** One tracker item a part of the breakdown was sent to. */
export interface TrackerLink {
  /** The tracker module's name ("azure"). */
  module: string;
  id: string;
  /** How people write it: AB#139. */
  ref: string;
  url: string;
  /** The item type it was made as, in the tracker's words ("User Story", "Product Backlog Item"). */
  type: string;
  /** A short hash of what was sent, so Send changes only updates the items that changed. */
  sentHash: string;
  sentAt: string;
}

export interface BreakdownStory {
  /** S-1, S-2 … never reused inside a breakdown. */
  key: string;
  title: string;
  /** As a …, I want …, so that … */
  story: string;
  /** Done when: the acceptance criteria. They become the ticket's criteria, already approved. */
  criteria: Criterion[];
  size: StorySize;
  /** Story keys it needs merged first. */
  dependsOn: string[];
  ref?: BrdRef;
  /** squad-kit's own first story on a project with no code (board/first-story.ts). */
  setsUp?: boolean;
  /** The ticket it became when it started (RO-24). */
  ticket?: string;
  tracker?: TrackerLink;
}

export interface BreakdownFeature {
  /** F-1, F-2 … */
  key: string;
  title: string;
  summary?: string;
  ref?: BrdRef;
  stories: BreakdownStory[];
  tracker?: TrackerLink;
}

export interface BreakdownEpic {
  /** E-1, E-2 … */
  key: string;
  title: string;
  /** What the epic is for, in one or two sentences. */
  goal?: string;
  ref?: BrdRef;
  features: BreakdownFeature[];
  /** Stories straight under the epic, when the document is small enough to skip features. */
  stories: BreakdownStory[];
  tracker?: TrackerLink;
}

/**
 * A question the Analyst asks before it drafts. Only two kinds stop it: a critical gap (the document misses
 * something that changes what is built) and a clash (two parts of it disagree). It is a ticket question card, so
 * answers, "Ask about this" and "Something else" work the same.
 */
export interface BreakdownQuestion extends Question {
  kind: 'gap' | 'clash';
  /** The parts of the document it is about. */
  refs?: BrdRef[];
  /** What the answer changes, in a few words: "Changes 3 stories in Online booking". */
  impact?: string;
}

/** A part of the document the breakdown leaves out on purpose (out of scope, already built, a note), and why. */
export interface LeftOut {
  text: string;
  why: string;
  ref?: BrdRef;
}

export interface Breakdown {
  /** BR-1, BR-2 … */
  id: string;
  /** Named after the document ("RoomFlow BRD v2"); the person can rename it. */
  title: string;
  status: BreakdownStatus;
  source: BreakdownSource;
  /** What the Analyst understood the document to ask for, in two or three sentences. */
  summary?: string;
  questions: BreakdownQuestion[];
  epics: BreakdownEpic[];
  decided: Decided[];
  leftOut: LeftOut[];
  /** Who approved it. Nothing is built or sent to the tracker before this. */
  approved?: { by: string; at: string };
  /** Why the read or the draft failed, in plain words. */
  error?: string;
  createdAt: string;
  createdBy: string;
  /** The person who added it. Only their squad reads, builds and sends it (ADR-001). */
  owner: string;
  /** The next number for each level, so a removed key is never given again. */
  next: { epic: number; feature: number; story: number };
  /** The last time it went to the tracker. */
  sent?: { module: string; at: string; by: string };
}

/** The Analyst's work on a breakdown, as this computer runs it. */
export interface BreakdownJob {
  /**
   * text: turning the document into text. read: reading it and writing the questions. draft: writing the parts.
   * redo: rewriting one part. reply: answering "Ask about this" on one question.
   */
  step: 'text' | 'read' | 'draft' | 'redo' | 'reply';
  status: 'pending' | 'running' | 'done' | 'failed' | 'stopping';
  startedAt?: string;
  /** What it does now, in plain words: "Reading the document". */
  now?: string;
  /** How far it got: page 18 of 31, or part 3 of 8 of a long text. */
  at?: { done: number; of: number; unit: 'page' | 'part' };
  /** What it found so far, for "Found 3 epics and 6 features so far". */
  found?: { epics: number; features: number; stories: number };
  /** How long this usually takes, in seconds, for "usually about 8 min for 31 pages". */
  usualSeconds?: number;
  /** redo: the part to rewrite (E-2, S-4) and what the person asked for. reply: the question's id (q2). */
  item?: string;
  ask?: string;
  question?: string;
  error?: string;
}

/** What only this computer keeps about a breakdown. */
export interface BreakdownState {
  job?: BreakdownJob;
  /** The Analyst's conversation, so a redo or a reply carries on in it. */
  sessions?: { read?: string };
  activity: Activity[];
  /**
   * Build continuously: on, who switched it, and why it is held now (the month budget, the usage limit, or nothing
   * can start until other stories merge). `heldFor` says which, for the button to show: at the budget, Build
   * continuously again goes on this month (`budgetOk`, the month it was let go on, like 2026-11).
   */
  build?: { on: boolean; by: string; at: string; held?: string; heldFor?: 'budget' | 'limit' | 'waits'; budgetOk?: string };
  /**
   * Send to the tracker: the items one by one, then the dependency links. `done` of `of` counts both, each link one
   * "S-5 needs S-4" (the Send dialog's unit); `items` and `links` say each apart, for "14 of 30 items, then 20 links".
   * `making`: the item a send was making when it was cut off, looked for in the tracker before it is made again.
   */
  sync?: {
    status: 'pending' | 'running' | 'done' | 'failed';
    done: number;
    of: number;
    items?: { done: number; of: number };
    links?: { done: number; of: number };
    making?: string;
    by?: string;
    at?: string;
    error?: string;
  };
  /** What the Analyst used on this breakdown. */
  usage?: UsageLine[];
}

/** "38 stories, about $210 and 9 hours", from this project's own ticket history. */
export interface BreakdownEstimate {
  stories: number;
  /** Left out for a subscription: the cost is the plan's usage limits, not dollars. */
  costUsd?: number;
  minutes: number;
  /** How many stories build at once (the parallel limit). */
  parallel: number;
  /** How many finished tickets it is based on. */
  basedOn: number;
  /** No finished tickets yet: a rough guess from the story sizes alone. */
  rough: boolean;
  payment: Payment;
}

/**
 * Where one story is, for the tree, the map and the progress bar. not-started: no ticket yet. next: it starts at the
 * next free place. waits: a story it needs is not merged yet. building: its ticket runs. needs-you: its ticket waits
 * for the person. merged: its change is in the base branch. released: it went out in a release.
 */
export type StoryState = 'not-started' | 'next' | 'waits' | 'building' | 'needs-you' | 'merged' | 'released';

export interface StoryProgress {
  key: string;
  state: StoryState;
  /** One line, like a card's status: "Tester taking screenshots, step 5 of 6", "Waits for S-5 to merge". */
  line: string;
  ticket?: string;
  /** waits: the story keys it waits on. */
  waitsOn?: string[];
  /** needs-you: what kind of stop it is, for the tag ("Two parts clash", "Missing in the BRD", "A check failed"). */
  stop?: 'gap' | 'clash' | 'check' | 'other';
}

/** A breakdown as the board shows it: the project's part, this computer's part and what is worked out from both. */
export interface BreakdownView extends Breakdown {
  state: BreakdownState;
  estimate: BreakdownEstimate;
  progress: StoryProgress[];
  counts: { epics: number; features: number; stories: number; merged: number; building: number; needsYou: number };
  /** The tracker it can be sent to, when the project has one that can create items. */
  tracker?: { module: string; label: string; project?: string };
  /** Only the owner's squad builds it; other people see it read-only. */
  mine: boolean;
  /** Why Approve breakdown cannot be pressed yet, in plain words. Empty or missing when it can. */
  problems?: string[];
}

/** Each level's items in a send: all of them, and how many are new, changed or the same as last time. */
export interface SendLevelCount {
  all: number;
  new: number;
  changed: number;
  unchanged: number;
}

/** What Send to <tracker> will do, for the dialog: GET /api/v1/requirements/:id/send. Nothing is sent by it. */
export interface SendPreview {
  tracker: { module: string; label: string; project?: string };
  /** The item types this project uses for each level ("User Story" or "Product Backlog Item"), and its process. */
  levels: { epic: string; feature: string; story: string; process: string };
  counts: {
    epics: SendLevelCount;
    features: SendLevelCount;
    stories: SendLevelCount;
    /** Stories that sit straight under their epic (a small BRD with no features). */
    storiesUnderEpic: number;
    links: number;
    new: number;
    changed: number;
    unchanged: number;
  };
  /** Items to create or update, for the button: "Send 34 items". Zero with no links: nothing to send. */
  items: number;
  /** Dependency links still to add, one for each "S-5 needs S-4" (as counts.links). */
  links: number;
  /** Never sent before: the first send creates everything. */
  first: boolean;
}

/** One row of the Requirements list. */
export interface BreakdownRow {
  id: string;
  title: string;
  status: BreakdownStatus;
  source: { name: string; kind: BreakdownSource['kind'] };
  counts: BreakdownView['counts'];
  building: boolean;
  createdAt: string;
  owner: string;
}

/** The 7 stages a ticket moves through. `done` means released and off the board. */
export type Stage = 'tickets' | 'specs' | 'implement' | 'test' | 'review' | 'release' | 'bugs' | 'done';

export const BOARD_STAGES: Exclude<Stage, 'done'>[] = [
  'tickets',
  'specs',
  'implement',
  'test',
  'review',
  'release',
  'bugs',
];

export type Role = 'analyst' | 'architect' | 'spec' | 'builder' | 'tester' | 'reviewer' | 'release' | 'triage';

/** Who wrote an activity line or a thread message. */
export type Actor = Role | 'you' | 'squad';

/** 'spec' waits for you to approve the what (story, done when); 'plan' the how (decision, steps). */
export type WaitingKind = 'questions' | 'spec' | 'plan' | 'proof' | 'stuck' | 'release' | 'ask' | 'yours';

export interface Waiting {
  kind: WaitingKind;
  /** One line shown on the "Waiting for you" card. */
  summary: string;
}

export interface ThreadMessage {
  who: Actor;
  text: string;
  at: string;
}

export interface Question {
  id: string;
  from: 'analyst' | 'architect';
  text: string;
  options: string[];
  /** The option that takes a typed value, e.g. "Yes: Angular Material". */
  inputOption?: string;
  answer?: { choice: string; value?: string };
  thread?: ThreadMessage[];
  /** Set while the squad is writing a reply to "Ask about this". */
  thinking?: boolean;
}

export interface Criterion {
  given: string;
  when: string;
  then: string;
}

/** A part of a spec or design the person can point at. `index` counts from 0 for criteria and steps. */
export interface PlanPart {
  part: 'story' | 'criterion' | 'decision' | 'step';
  index?: number;
}

export interface PlanComment extends PlanPart {
  text: string;
}

/** The person's own wording for a part. It wins over a rewrite. */
export interface PlanEdit extends PlanPart {
  text?: string;
  criterion?: Criterion;
}

/** The spec and design as they were, so the next version can show what changed. */
export interface PlanSnapshot {
  story?: string;
  criteria?: Criterion[];
  decision?: string;
  steps?: string[];
}

export interface DecisionOption {
  name: string;
  note: string;
  chosen?: boolean;
}

export interface DecisionDraft {
  title: string;
  options: DecisionOption[];
  why: string;
  clientCheck?: string;
  /** Set once the plan is approved and the decision is saved. */
  adr?: string;
}

export interface Step {
  title: string;
  status: 'todo' | 'doing' | 'done';
  minutes?: number;
  /** What the squad is doing right now, shown under the active step. */
  live?: string;
}

/** 'skipped': the person pressed Continue anyway, with a reason (see Ticket.overrides). The engine never skips a gate itself. */
export type GateState = 'pending' | 'pass' | 'fail' | 'skipped';

export interface Gates {
  checks: GateState;
  checksText?: string;
  review: GateState;
  reviewBy?: string;
  proof: GateState;
}

export interface ProofShot {
  criterion: string;
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  note?: string;
}

/** The ways out of a stop. Every stop has at least Try again and one more. */
export type WayOut = 'retry' | 'yourself' | 'continue' | 'plan' | 'skip-pr';

export interface StuckOption extends DecisionOption {
  /** What the choice does. Older boards have no `do`: their first choice tries again, the second goes to the plan. */
  do?: WayOut;
}

export interface StuckChoice {
  question: string;
  options: StuckOption[];
  /** What stopped: a failed gate the person can continue past, a clash with the base branch, or any other error. */
  gate?: 'checks' | 'review' | 'merge';
}

/** The person went past a failed gate on purpose. Shown on the ticket, the pull request and the release notes. */
export interface GateOverride {
  gate: 'checks' | 'review';
  reason: string;
  by: string;
  at: string;
}

export interface Activity {
  at: string;
  who: Actor;
  text: string;
}

/** Where the scripted squad is in a ticket's journey. Only the squad reads and writes this. */
export interface SquadState {
  phase: string;
  /** ISO time when the squad should take its next step. */
  nextAt: string;
  index?: number;
}

/** Saved Claude Code conversations for a ticket, one per role, so follow-ups continue them. */
export interface TicketSessions {
  intake?: string;
  build?: string;
  review?: string;
  tester?: string;
}

/** Something the person added to a ticket at any time. Every agent on the ticket reads all of them. */
export interface TicketNote {
  at: string;
  by: string;
  /** A criterion joins the "done when" list, so the Tester must prove it. */
  kind: 'note' | 'criterion' | 'rule';
  text: string;
  /** A message to one agent from its conversation. Every agent still reads it; this one is told it is for them. */
  to?: AgentName;
}

export type AgentName = 'analyst' | 'architect' | 'builder' | 'reviewer' | 'tester';

export type Track = 'full' | 'express';

export interface AgentQuestion {
  from: 'architect' | 'builder' | 'reviewer';
  text: string;
  /** What the agent thinks the choices are. The person can also write their own answer. */
  options: string[];
  /** Why it matters: what goes wrong with a wrong guess. */
  why?: string;
  /** Pictures, wireframes, an HTML mockup or other files the agent attached, as full paths it may show. */
  files?: string[];
  at: string;
  answer?: string;
}

export interface TicketBrief {
  criteria: string[];
  rules: string[];
  edgeCases: string[];
}

export interface Ticket {
  id: string;
  title: string;
  ask: string;
  kind: 'feature' | 'bug';
  /** Where the ticket came from. For tracker items: its id, web link and type (User Story, Bug…). */
  source: { type: 'manual' | 'azure' | 'github' | 'jira'; ref?: string; id?: string; url?: string; itemType?: string };
  priority: 'high' | 'normal' | 'low';
  stage: Stage;
  /** One line under the card title: what is happening now. */
  status: string;
  /** True while a squad member is actively working on it. */
  live?: boolean;
  /** 0 to 100, for the current stage. */
  progress?: number;
  waiting: Waiting | null;
  createdAt: string;
  createdBy: string;
  builder?: string;
  reviewer?: string;
  story?: string;
  criteria?: Criterion[];
  questions?: Question[];
  decision?: DecisionDraft;
  work?: { steps: number; tests: number; screens: number };
  steps?: Step[];
  gates?: Gates;
  proof?: ProofShot[];
  stuck?: StuckChoice;
  release?: string;
  /** One line for the release notes, written by the squad. */
  releaseNote?: string;
  foundIn?: string;
  severity?: 'stops-work' | 'annoying' | 'small';
  changeRequest?: string;
  activity: Activity[];
  squad?: SquadState | null;
  /** Live engine only: where the ticket's code lives and how far the squad got. */
  sessions?: TicketSessions;
  worktree?: string;
  branch?: string;
  baseCommit?: string;
  tries?: number;
  reviewRound?: number;
  /** Step to run again when the person picks "Try again" on a stuck card. */
  retryPhase?: string;
  attachments?: string[];
  /** What the person added when writing the ticket by hand: their own acceptance criteria, business rules and edge cases. */
  brief?: TicketBrief;
  /** In a multi-repo workspace: the code repo this ticket changes. */
  repo?: string;
  /** Set when the person presses Stop; the live squad stops the running step. */
  stopRequested?: boolean;
  /** The squad's review notes still to fix, passed to the Builder. */
  reviewNotes?: string[];
  /** The pull request opened after the proof was accepted. */
  pr?: { id: number; url: string; repo: string; host: 'azure' };
  /** When the change went into the base branch. Accepted work merges right away, so later tickets build on it. */
  mergedAt?: string;
  /** Set by the watchdog when a running step shows no progress: what it waits on, and whether that looks stuck. */
  quiet?: { since: string; kind: 'stuck' | 'long'; detail: string; command?: string; pid?: number };
  /** "Keep waiting": the watchdog stays quiet about this ticket until then. */
  quietSnoozedUntil?: string;
  /** Updates still to send to the tracker; the live squad sends them, so terminal commands never wait on Azure. */
  trackerQueue?: TrackerEvent[];
  notes?: TicketNote[];
  overrides?: GateOverride[];
  /** Full track: who approved the spec. The Architect writes the design only after this. */
  specApproved?: { by: string; at: string };
  /** The Architect's HTML mockup of the main screen, approved with the design. */
  mockup?: string;
  /** Review like a document: comments sent back, the person's own edits, and the version before the rewrite. */
  planReview?: { before?: PlanSnapshot; sent?: PlanComment[]; edits?: PlanEdit[] };
  /** You took the ticket over in Claude Code. The squad does nothing on it until you give it back. */
  takenOver?: { by: string; at: string; session: string; cwd: string };
  /**
   * Full runs every step. Express (a typo, an urgent small bug) skips the questions and the plan approval, never the
   * build, checks, review or your Looks right. Missing means Full.
   */
  track?: Track;
  /** A question from an agent in the middle of its work. The ticket waits; the answer goes back into the same session. */
  agentQuestion?: AgentQuestion;
  /** How many notes each agent session has been given, so a running agent gets new ones at its next step. */
  notesSeen?: Record<string, number>;
}

export type TrackerEvent =
  | { kind: 'started' }
  | { kind: 'answered' }
  | { kind: 'planned' }
  | { kind: 'note'; text: string; noteKind: TicketNote['kind'] }
  | { kind: 'released'; version: string }
  | { kind: 'file-bug' };

export interface Release {
  version: string;
  status: 'draft' | 'released';
  from: string;
  date?: string;
  tickets: string[];
  notes: string;
  addons: { changelog: boolean; tag: boolean; pipeline: boolean; whatsapp: boolean };
  bugs?: string[];
  whatsappDraft?: string;
  /** Titles of tickets that are no longer on the board, for past releases. */
  titles?: Record<string, string>;
  /** What the release really did, in plain words, shown after releasing. */
  log?: { ok: boolean; text: string }[];
}

export interface Decision {
  id: string;
  title: string;
  why: string;
  options: string[];
  chosen: string;
  from: string;
  approvedBy: string;
  date: string;
  checkedBy: { kind: 'test' | 'lint rule'; name: string; passing: boolean } | null;
  tickets: string[];
}

export interface Lesson {
  id: string;
  text: string;
  from: string;
  date: string;
}

export interface BoardMeta {
  project: string;
  key: string;
  nextNumber: number;
  /** `demo` runs the scripted squad; `live` will drive the real AI tools. */
  engine: 'demo' | 'live';
  user: { name: string; role: string };
  roles: Record<'analyst' | 'architect' | 'builder' | 'tester' | 'reviewer', string>;
  tools: { name: string; ready: boolean }[];
  /** Multiplier for the scripted squad's pace. 1 is normal, 2 is twice as fast. */
  speed: number;
  map: { area: string; detail: string }[];
  lessons: Lesson[];
  /** Live engine: how to set up, check and run the project. Empty means "not set up". */
  commands?: ProjectCommands;
  git?: { base: string; remote: string };
  scan?: { status: 'pending' | 'running' | 'done' | 'failed'; at?: string; error?: string; summary?: string; empty?: boolean };
  /** How many squad jobs may run at the same time. */
  parallel?: number;
  /** How squad-kit talks to Claude: through the Agent Client Protocol (default), or by running Claude Code directly. */
  runner?: 'acp' | 'direct';
  /**
   * A workspace that holds several code repos (each with its own git). Without it, the project
   * folder itself is the one repo, using `commands` and `git`.
   */
  repos?: RepoInfo[];
}

export interface RepoInfo {
  /** Folder relative to the project, like "moj-t4-ui-vue". */
  path: string;
  base: string;
  remote: string;
  commands: ProjectCommands;
  summary?: string;
}

export interface ProjectCommands {
  setup?: string;
  test?: string;
  lint?: string;
  build?: string;
  start?: string;
  url?: string;
  /** Runs after a release, for example a pipeline trigger. */
  deploy?: string;
}

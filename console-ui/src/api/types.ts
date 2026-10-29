// Mirrors src/board/types.ts on the server. Keep the two in step.

/** The 7 stages a ticket moves through. `done` means released and off the board. */
export type Stage = 'tickets' | 'specs' | 'implement' | 'test' | 'review' | 'release' | 'bugs' | 'done';


export type Role = 'analyst' | 'architect' | 'spec' | 'builder' | 'tester' | 'reviewer' | 'release' | 'triage';

/** Who wrote an activity line or a thread message. */
export type Actor = Role | 'you' | 'squad';

export type WaitingKind = 'questions' | 'plan' | 'proof' | 'stuck' | 'release';

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

export type GateState = 'pending' | 'pass' | 'fail';

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

export interface StuckChoice {
  question: string;
  options: DecisionOption[];
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

export interface Ticket {
  id: string;
  title: string;
  ask: string;
  kind: 'feature' | 'bug';
  source: { type: 'manual' | 'azure' | 'github' | 'jira'; ref?: string };
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
}

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
}

export interface BoardResponse {
  ready: boolean;
  meta: BoardMeta;
  tickets: Ticket[];
  stats: { released30: number; bugs30: number; open: number };
}

export interface ReleaseItem {
  id: string;
  title: string;
  gates: Gates | null;
  kind: 'feature' | 'bug';
}

export type ReleaseWithItems = Release & { items: ReleaseItem[] };

export interface DecisionsResponse {
  decisions: Decision[];
  map: BoardMeta['map'];
  lessons: Lesson[];
}

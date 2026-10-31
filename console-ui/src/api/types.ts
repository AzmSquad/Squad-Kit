// Mirrors src/board/types.ts on the server. Keep the two in step.

/** The 7 stages a ticket moves through. `done` means released and off the board. */
export type Stage = 'tickets' | 'specs' | 'implement' | 'test' | 'review' | 'release' | 'bugs' | 'done';


export type Role = 'analyst' | 'architect' | 'spec' | 'builder' | 'tester' | 'reviewer' | 'release' | 'triage';

/** Who wrote an activity line or a thread message. */
export type Actor = Role | 'you' | 'squad';

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

export type WayOut = 'retry' | 'yourself' | 'continue' | 'plan' | 'skip-pr';

export interface StuckChoice {
  question: string;
  options: (DecisionOption & { do?: WayOut })[];
  gate?: 'checks' | 'review' | 'merge';
}

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

export type Track = 'full' | 'express';

export interface TicketNote {
  at: string;
  by: string;
  kind: 'note' | 'criterion' | 'rule';
  text: string;
  to?: 'analyst' | 'architect' | 'builder' | 'reviewer' | 'tester';
}

export interface Ticket {
  id: string;
  title: string;
  ask: string;
  kind: 'feature' | 'bug';
  source: { type: 'manual' | 'azure' | 'github' | 'jira'; ref?: string; id?: string; url?: string; itemType?: string };
  pr?: { id: number; url: string; repo: string; host: 'azure' };
  quiet?: { since: string; kind: 'stuck' | 'long'; detail: string; command?: string; pid?: number };
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
  brief?: { criteria: string[]; rules: string[]; edgeCases: string[] };
  notes?: TicketNote[];
  overrides?: GateOverride[];
  specApproved?: { by: string; at: string };
  takenOver?: { by: string; at: string; session: string; cwd: string };
  track?: Track;
  agentQuestion?: { from: 'builder' | 'reviewer'; text: string; options: string[]; why?: string; at: string; answer?: string };
  /** In a multi-repo workspace: the code repo this ticket changes. */
  repo?: string;
  /** Set when the person presses Stop; the live squad stops the running step. */
  stopRequested?: boolean;
  /** The squad's review notes still to fix, passed to the Builder. */
  reviewNotes?: string[];
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
export interface BoardResponse {
  ready: boolean;
  meta: BoardMeta;
  /** The running board: when it started and whether a newer squad-kit is installed. */
  console?: { startedAt: string; outdated: boolean } | null;
  tickets: Ticket[];
  stats: { released30: number; bugs30: number; open: number };
}

export interface ReleaseItem {
  id: string;
  title: string;
  gates: Gates | null;
  kind: 'feature' | 'bug';
}

export type ReleaseWithItems = Release & { items: ReleaseItem[]; targets: { repo: string; branch: string; remote: string }[] };

export interface DecisionsResponse {
  decisions: Decision[];
  map: BoardMeta['map'];
  lessons: Lesson[];
}

export interface WorkItemRow {
  id: number;
  type: string;
  title: string;
  state: string;
  points?: number;
  priority?: number;
  sprint?: string;
  assignedTo?: string;
  tags: string[];
  url: string;
  ticket: { id: string; stage: Stage; status: string } | null;
}

export interface Sprint {
  name: string;
  path: string;
  start?: string;
  finish?: string;
  current: boolean;
}

export interface BacklogResponse {
  connected: boolean;
  error?: string | null;
  user?: string;
  sprints: Sprint[];
  sprint?: string;
  items: WorkItemRow[];
}

export interface TrackerStatus {
  type: 'none' | 'azure' | 'jira' | 'github';
  organization: string;
  project: string;
  hasToken: boolean;
  user?: string;
  error?: string;
}

export interface AgentInfo {
  role: 'analyst' | 'architect' | 'builder' | 'reviewer' | 'tester';
  name: string;
  job: string;
  tool: 'claude' | 'codex';
  model: string;
  instructions: string;
  file: string;
  working: { id: string; title: string; status: string }[];
}

export interface ConversationSummary {
  key: 'intake' | 'build' | 'review' | 'tester';
  label: string;
  sessionId: string;
  started: boolean;
}

/** A subset of the Agent Client Protocol (ACP v1) types the board draws. */
export type AcpContentBlock =
  | { type: 'text'; text: string; _meta?: { squadKit?: { from?: 'squad-kit' | 'claude-code' } } | null }
  | { type: 'image'; data: string; mimeType: string; uri?: string | null }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string | null; size?: number | null }
  | { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string | null } };

export type AcpToolContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpUpdate =
  | { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; kind?: AcpToolKind; status?: AcpToolStatus; content?: AcpToolContent[]; locations?: { path: string; line?: number | null }[]; rawInput?: { command?: string; path?: string } }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; title?: string | null; kind?: AcpToolKind | null; status?: AcpToolStatus | null; content?: AcpToolContent[] | null; rawInput?: { command?: string; path?: string } | null }
  | { sessionUpdate: 'plan'; entries: { content: string; priority: string; status: 'pending' | 'in_progress' | 'completed' }[] };

export interface ConversationResponse {
  sessionId: string;
  protocol?: string;
  cwd?: string;
  command?: string;
  total: number;
  updates: { at?: string; update: AcpUpdate }[];
}

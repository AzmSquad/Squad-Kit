// Mirrors src/board/types.ts on the server. Keep the two in step.

/** The 7 stages a ticket moves through. `done` means released and off the board. */
export type Stage = 'tickets' | 'specs' | 'implement' | 'test' | 'review' | 'release' | 'bugs' | 'done';


export type Role = 'analyst' | 'architect' | 'spec' | 'builder' | 'tester' | 'reviewer' | 'release' | 'triage';

/** Who wrote an activity line or a thread message. */
export type Actor = Role | 'you' | 'squad';

export type WaitingKind = 'questions' | 'spec' | 'plan' | 'proof' | 'stuck' | 'release' | 'ask' | 'yours' | 'chat';

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

export type AgentName = 'analyst' | 'architect' | 'builder' | 'reviewer' | 'tester';

export interface ChatMessage {
  who: 'you' | AgentName | 'squad';
  text: string;
  at: string;
  files?: string[];
}

export interface AgentChat {
  with: AgentName;
  open: boolean;
  messages: ChatMessage[];
  thinking?: boolean;
  ready?: boolean;
}

export interface PlanPart {
  part: 'story' | 'criterion' | 'decision' | 'step';
  index?: number;
}

export interface PlanComment extends PlanPart {
  text: string;
}

export interface PlanSnapshot {
  story?: string;
  criteria?: Criterion[];
  decision?: string;
  steps?: string[];
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
  /** The saved decision (ADR id) this one changes. On approval the old one is marked replaced. */
  replaces?: string;
  /** Where in the project it sits, for the architecture page. */
  area?: DecisionArea;
  /** Set once the plan is approved and the decision is saved. */
  adr?: string;
}

export const DECISION_AREAS = ['Structure', 'Data', 'Security', 'Interface', 'Rules'] as const;
export type DecisionArea = (typeof DECISION_AREAS)[number];

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
  gate?: 'checks' | 'review' | 'proof' | 'merge';
}

export interface GateOverride {
  gate: 'checks' | 'review' | 'proof';
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
  source: { type: string; ref?: string; id?: string; url?: string; itemType?: string };
  pr?: { id: number; url: string; repo: string; host: string };
  /** Installing packages and running migrations in the person's own checkout, after the merge moved it. */
  /** Decisions approved after this ticket was planned that change it, waiting for the person. */
  outdated?: { adr: string; why: string; change: string; at: string }[];
  replanFor?: string;
  /** When the change went into the base branch. */
  mergedAt?: string;
  localSetup?: { status: 'pending' | 'running' | 'done' | 'failed'; dir: string; command: string; at?: string; seconds?: number; output?: string };
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
  /** Saved decisions (ADR ids) this ticket's design follows. Each one lists the ticket once the design is approved. */
  follows?: string[];
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
  agentQuestion?: { from: 'architect' | 'builder' | 'reviewer'; text: string; options: string[]; why?: string; files?: string[]; at: string; answer?: string };
  mockup?: string;
  chat?: AgentChat;
  planReview?: { before?: PlanSnapshot; sent?: PlanComment[]; edits?: (PlanPart & { text?: string; criterion?: Criterion })[] };
  /** In a multi-repo workspace: the code repo this ticket changes. */
  repo?: string;
  /** Set when the person presses Stop; the live squad stops the running step. */
  stopRequested?: boolean;
  /** The squad's review notes still to fix, passed to the Builder. */
  reviewNotes?: string[];
  /** What each role used on this ticket, per step and model level. */
  usage?: UsageLine[];
}

/** What some runs used, added up. A count the AI tool never reported stays out, with the runs it is missing for. */
export interface UsageTotal {
  runs: number;
  /** Tokens the model read, cached ones included. */
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  /** What the runs would cost at the AI company's API prices, in US dollars. */
  costUsd?: number;
  tokensUnknown?: number;
  costUnknown?: number;
}

export interface UsageLine extends UsageTotal {
  role: AgentName;
  step: string;
  level: ModelLevel;
  /** The model in words ("Opus"), or the model someone pinned. */
  model: string;
}

export interface RoleUsage {
  role: AgentName;
  total: UsageTotal;
  levels: { level: ModelLevel; model: string; steps: string[]; total: UsageTotal }[];
}

/** Everything the squad used on this board, on this computer. */
export interface BoardUsage {
  total: UsageTotal;
  /** The project's own work, with no ticket. */
  project: UsageTotal;
  roles: RoleUsage[];
  tickets: number;
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
  /** The ticket that made it first, then every ticket whose design followed it. */
  tickets: string[];
  area?: DecisionArea;
  /** Saved decisions this one was built on: the ones its ticket followed. */
  buildsOn?: string[];
  /** The older decision this one changed. */
  replaces?: string;
  /** Set when a newer decision changed this one. A replaced decision is no longer a rule. */
  replacedBy?: string;
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
  scan?: { status: 'pending' | 'running' | 'done' | 'failed'; at?: string; error?: string; summary?: string; empty?: boolean; now?: string };
  /** How many squad jobs may run at the same time. */
  parallel?: number;
  runner?: 'acp' | 'direct';
  /** What the squad used on the project's own work, with no ticket. */
  usage?: UsageLine[];
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
  id: string;
  /** How people write it, for example AB#40. */
  ref: string;
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
  /** The tracker's name in words: "Azure DevOps". */
  label?: string;
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
  /** The team's instructions for one step, by step id. */
  steps: Record<string, string>;
  stepList: { id: string; name: string }[];
  file: string;
  working: { id: string; title: string; status: string }[];
  /** Each step's model level now, squad-kit's default, the team's choice and this person's own. */
  levels: LevelRow[];
  teamRole: LevelChoice | null;
  youRole: LevelChoice | null;
  /** The AI tool's model for each level, for example strongest: Opus. */
  modelOf: Record<ModelLevel, string>;
  supportsEffort: boolean;
}

export type ModelLevel = 'strongest' | 'balanced' | 'fast';
export type Effort = 'high' | 'medium' | 'low';

export interface LevelChoice {
  level?: ModelLevel;
  effort?: Effort;
  model?: string;
}

export interface LevelRow {
  step: string;
  name: string;
  standard: LevelChoice;
  team: LevelChoice | null;
  you: LevelChoice | null;
  now: { level: ModelLevel; effort?: Effort; model?: string; modelName: string; from: 'squad-kit' | 'project' | 'you'; why?: string };
}

export interface CorePrompts {
  ticket: { id: string; title: string };
  prompts: { step: string; name: string; prompt: string; team: string }[];
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

export type TimelineState = 'shipped' | 'merged' | 'building' | 'designed' | 'coming';

export interface TimelineTicket {
  id: string;
  title: string;
  kind: Ticket['kind'];
  state: TimelineState;
  made?: string;
  follows: string[];
  release?: string;
}

export type TechRole = 'Language' | 'Framework' | 'Interface' | 'Data' | 'Testing' | 'Tooling' | 'Services';

/** A technology the code really uses, with the Architect's why and the decisions that chose it. */
export interface StackItem {
  name: string;
  role: TechRole;
  icon?: string;
  version?: string;
  repo: string;
  why?: string;
  decisions: string[];
  via?: { name: string; decisions: string[] };
  draft?: {
    tech: string;
    status: 'writing' | 'ready' | 'failed';
    error?: string;
    decision?: { title: string; area: DecisionArea; options: string[]; chosen: string; why: string; buildsOn: string[] };
  };
}

/** The Architect checking the open tickets against a newly approved decision. */
export interface ImpactCheck {
  adr: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  at?: string;
  error?: string;
  checked?: string[];
  affected?: string[];
}

export interface PatternNote {
  name: string;
  what: string;
  where: string[];
  decision?: string;
}

export interface ArchitectureResponse {
  decisions: Decision[];
  tickets: TimelineTicket[];
  map: BoardMeta['map'];
  lessons: Lesson[];
  stack: StackItem[];
  patterns: PatternNote[];
  impact: ImpactCheck[];
  reading?: { status: 'pending' | 'running' | 'done' | 'failed'; at?: string; error?: string };
}

/** One app the project runs: a code repo with a start command and a web address. */
export interface ProjectApp {
  name: string;
  repo: string;
  url: string;
  start?: string;
  up: boolean;
}

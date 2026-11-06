import type { FirstLook, FolderKind } from './onboard-types';
import type { Decided } from './requirements-types';

// Mirrors src/board/types.ts on the server. Keep the two in step.

/** The 7 stages a ticket moves through. `done` means released and off the board. */
export type Stage = 'tickets' | 'specs' | 'implement' | 'test' | 'review' | 'release' | 'bugs' | 'done';


export type Role = 'analyst' | 'architect' | 'spec' | 'builder' | 'tester' | 'reviewer' | 'release' | 'triage';

/** Who wrote an activity line or a thread message. */
export type Actor = Role | 'you' | 'squad';

export type WaitingKind = 'questions' | 'spec' | 'plan' | 'proof' | 'stuck' | 'release' | 'ask' | 'yours' | 'chat' | 'change' | 'depends';

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
  /** Short answers the agent offers to its question. */
  options?: string[];
  /** A note from squad-kit: you stopped the answer, or the agent could not answer. */
  note?: 'stopped' | 'failed' | 'waits';
}

export interface AgentChat {
  with: AgentName;
  open: boolean;
  messages: ChatMessage[];
  thinking?: boolean;
  ready?: boolean;
  /** Asking beside the work: the squad goes on, and the chat changes nothing on the ticket. */
  beside?: boolean;
  /** The side conversation's session id. */
  side?: string;
  stopping?: boolean;
}

/** One ticket's talk with an agent, as the chat tabs and the Conversations page list it. */
export interface ChatSummary {
  id: string;
  title: string;
  stage: Stage;
  release?: string;
  with: AgentName;
  open: boolean;
  thinking: boolean;
  /** Beside the work: the squad goes on, or the ticket is accepted. */
  beside: boolean;
  yourTurn: boolean;
  /** Agent messages since you last wrote. */
  fresh: number;
  count: number;
  at: string;
  last?: { who: ChatMessage['who']; text: string; at: string };
  match?: string;
}

/** One part of the spec a change touches. A "done when" counts from 0; a new one has no index. */
export interface ChangePart {
  part: 'story' | 'criterion';
  index?: number;
  before: string;
  after: string;
  criterion?: Criterion;
}

export type ChangeStatus = 'writing' | 'proposed' | 'approved' | 'designing' | 'design-ready' | 'building' | 'done' | 'declined' | 'failed';

/** A change the person proposed to the spec. One open at a time per ticket. */
export interface SpecChange {
  id: string;
  ask: string;
  by: string;
  at: string;
  from?: AgentName;
  status: ChangeStatus;
  size?: 'small' | 'big';
  summary?: string;
  why?: string;
  parts?: ChangePart[];
  design?: { summary: string; before: string[]; steps: { title: string; change: 'same' | 'changed' | 'new' }[] };
  decided?: { by: string; at: string; approved: boolean; reason?: string; withdrawn?: boolean };
  error?: string;
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

/** 'unchecked': the checks ran, but no tests did ("Not checked", never a green pass). */
export type GateState = 'pending' | 'pass' | 'fail' | 'skipped' | 'unchecked';

export interface Gates {
  checks: GateState;
  checksText?: string;
  /** What the checks ran, for engineers. */
  ran?: { name: string; command: string; ok: boolean; tests?: number; failedOnce?: boolean }[];
  review: GateState;
  reviewBy?: string;
  proof: GateState;
}

/** Another after picture of a "done when": a part or case its main picture does not show. */
export interface ProofPicture {
  after: string;
  /** Where it was taken, like a row's page. */
  page?: string;
  /** What it shows, one plain sentence from the Tester. */
  note?: string;
}

export interface ProofShot {
  criterion: string;
  before: string;
  /** The main after picture: the one the before pairs with. */
  after: string;
  beforeLabel: string;
  afterLabel: string;
  /** What the main after picture shows. */
  note?: string;
  /** Where the main after picture was taken, as the address in the app without the host, like "/test/sign-up". */
  page?: string;
  /** The other after pictures of this "done when", one per part or case. Rows with one picture have none. */
  more?: ProofPicture[];
  /**
   * What all its after pictures show together, from the Tester's verdict and squad-kit's own check of them: the "done
   * when" is met, "broken" (a picture shows it does not work) or "not-shown" (the pictures do not show all of it clearly).
   * "off-screen": the Tester and the check agree the rest of it cannot be shown at all, so the pictures that show a part
   * stay and it does not stop the story. Only broken goes back to the Builder. Rows from before verdicts have none.
   */
  shows?: 'met' | 'broken' | 'not-shown' | 'off-screen';
  /** Why it is not met yet, in plain words: the Tester's note or squad-kit's check. */
  why?: string;
}

/** A "done when" that shows on no screen (it happens on a restart, in an email), with why in plain words. */
export interface OffScreen {
  criterion: string;
  why: string;
}

export type WayOut = 'retry' | 'yourself' | 'continue' | 'plan' | 'skip-pr' | 'more' | 'stop' | 'add-test' | 'no-tests' | 'save-again' | 'skip-hooks';

/** GET /api/v1/sandbox: whether the Builder's and Tester's commands run in a sandbox here, and what they may reach. */
export interface SandboxInfo {
  tools: { tool: string; available: boolean; why: string; fix?: string }[];
  registries: string[];
  allowedHosts: string[];
  /** Set where the agents' own commands or the project's own have no guard (Windows today): "Windows: less protected", in plain words. */
  note?: { title: string; text: string };
  /** squad-kit's own guard for the project's tests, setup and app on this computer, and what an engineer allowed. */
  guard?: { on: boolean; why: string; fix?: string; allowRead: string[]; allowWrite: string[] };
}

export interface StuckChoice {
  /** What happened, in plain words. */
  question: string;
  options: (DecisionOption & { do?: WayOut })[];
  /** 'cap': the step reached its turn or spend cap; Give it more or Stop. */
  gate?: 'checks' | 'review' | 'proof' | 'merge' | 'cap';
  /** Why the gate stopped, when it is not a plain failure. 'guard': a project command needed a file squad-kit's guard blocked. */
  kind?: 'weakened' | 'no-tests' | 'bad-proof' | 'guard' | 'broken' | 'not-shown' | 'hook';
  /** The plain reasons, one per line: "test/booking.test.ts was deleted (4 tests)". */
  points?: string[];
  /** The ticket stopped between two steps at its budget, or the month's. */
  budget?: 'ticket' | 'month';
  /** "The Builder stopped". */
  title?: string;
  /** What is safe: "Nothing was merged or pushed." */
  safe?: string[];
  /** The exact error, for engineers. */
  detail?: string;
}

export interface GateOverride {
  gate: 'checks' | 'review' | 'proof' | 'hooks';
  /** Continued past tests made weaker: what was weakened. */
  weakened?: string[];
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

/** auto: "Builds by itself", a story started from an approved breakdown. */
export type Track = 'full' | 'express' | 'auto';

export interface TicketNote {
  at: string;
  by: string;
  kind: 'note' | 'criterion' | 'rule';
  text: string;
  to?: 'analyst' | 'architect' | 'builder' | 'reviewer' | 'tester';
}

/** The ticket fields the Analyst filled in from a pasted idea or message. */
export interface TicketDraft {
  title: string;
  ask: string;
  kind: Ticket['kind'];
  track?: Track;
  priority: Ticket['priority'];
  criteria: string[];
  rules: string[];
  edgeCases: string[];
  gaps: string[];
}

/** A draft the Analyst is writing (src/engine/draft.ts). It waits under New ticket until it is used. */
export interface DraftJob {
  id: string;
  status: 'working' | 'done' | 'failed' | 'cancelled';
  /** Reading the message, looking at the project, or writing the ticket. */
  step: 'read' | 'look' | 'write';
  looked: string[];
  text: string;
  files: { name: string; size: number }[];
  startedAt: string;
  endedAt?: string;
  draft?: TicketDraft;
  error?: string;
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
  /** The design changes the test command: squad-kit tries it at the checks. `ask`: it cannot tell, so the person chooses. */
  testChange?: { from: string; to: string; repo?: string; at: string; ask?: boolean; ran?: string };
  /** How the last change to the test command was settled, for the Developer tab. */
  testDecided?: { from: string; to: string; kept: 'new' | 'current'; by: 'squad' | 'you'; why?: string; ran?: string; at: string };
  replanFor?: string;
  /** When the change went into the base branch. */
  mergedAt?: string;
  localSetup?: { status: 'pending' | 'running' | 'done' | 'failed'; dir: string; command: string; at?: string; seconds?: number; output?: string };
  quiet?: { since: string; kind: 'stuck' | 'long'; detail: string; command?: string; pid?: number; port?: { port: number; pid?: number; program?: string; ours: boolean; app?: string } };
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
  /** The "done when" items the Tester said show on no screen, with why. They do not fail the proof. */
  offScreen?: OffScreen[];
  /** Rounds of screenshots that showed a "done when" does not work, since the last met proof (2 at most, then a stop). */
  proofRound?: number;
  stuck?: StuckChoice;
  release?: string;
  /** One line for the release notes, written by the squad. */
  releaseNote?: string;
  /** What the change touches that the plan did not include, in the Reviewer's plain words. */
  alsoChanged?: string[];
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
  agentQuestion?: {
    from: 'architect' | 'builder' | 'reviewer';
    text: string;
    options: string[];
    why?: string;
    files?: string[];
    /** Builds by itself: why it stopped. gap: something is missing. clash: two things disagree. */
    kind?: 'gap' | 'clash';
    /** Where the stop comes from: a place in the BRD, an earlier answer, or a ticket it clashes with. */
    sources?: { text: string; ticket?: string; page?: number; section?: string }[];
    at: string;
    answer?: string;
    /** A busy port another program holds: asked in plain words, the details are for engineers. */
    port?: { port?: number; pid: number; program?: string; app?: string; asked: string };
  };
  mockup?: string;
  chat?: AgentChat;
  planReview?: { before?: PlanSnapshot; sent?: PlanComment[]; edits?: (PlanPart & { text?: string; criterion?: Criterion })[] };
  /** In a multi-repo workspace: the code repo this ticket changes. */
  repo?: string;
  /** Set when the person presses Stop; the live squad stops the running step. */
  stopRequested?: boolean;
  /** The squad's review notes still to fix, passed to the Builder. */
  reviewNotes?: string[];
  /** Changes proposed to the spec, oldest first. */
  changes?: SpecChange[];
  /** The accepted ticket this one changes. */
  changeOf?: string;
  /** Whose ticket it is. Only the owner's squad works on it, on the owner's computer. */
  owner?: string;
  /** The last hand over: who gave it to whom, and when. */
  handedOver?: { from: string; to: string; at: string };
  /** What each role used on this ticket, per step and model level. */
  usage?: UsageLine[];
  /** The steps that ended well, oldest first. */
  history?: { who: AgentName | 'squad'; step: TimedStep; from: string; to: string }[];
  /** The Quality setting the squad last ran it on. */
  quality?: Quality;
  /** The person let it go on past a budget. */
  budgetOk?: { ticket?: boolean; month?: string };
  /** "Stop and try again": once the running step has stopped, it starts again at once. */
  retryOnStop?: boolean;
  /** The step running now, as the engine keeps it. */
  clock?: { who: AgentName | 'squad'; step: TimedStep; since: string; part?: number; doing?: string; doingAt?: string; limit?: number; began?: string; resumed?: string; paused?: string };
  /** What is happening now, in words, worked out by squad-kit from the live record. */
  now?: LiveNow;
  /** A merged or released ticket off the board. Its history stays. */
  archived?: { by: string; at: string };
  /** Delete was pressed. Still here when a delete stopped half-way: then `error` says why. */
  deleting?: { at: string; by: string; remote?: boolean; error?: string };
  /** Open tickets whose code this one needs, as its design names them ("depends on RO-1"). */
  dependsOn?: string[];
  /** How the person chose to build while one of them was not merged. */
  dependency?: DependencyChoice;
  /** The breakdown story this ticket builds (BR-1, S-14). */
  breakdown?: { id: string; item: string };
  /** Small choices the squad made on its own instead of asking (Builds by itself). */
  decided?: Decided[];
  /** "Bring in latest main" was pressed while a step ran: it comes in before the next checks. */
  baseWanted?: { by: string; at: string };
  /** Someone else's ticket that its owner deleted on their computer, as the remote shows it. */
  ownerDeleted?: { by: string; at: string; how: 'note' | 'gone'; branch: string };
}

/** branch: built on the dependency's branch; anyway: from main without it; wait: starts once it is merged. */
export interface DependencyChoice {
  on: string[];
  way: 'branch' | 'anyway' | 'wait';
  by: string;
  at: string;
  from?: string;
  caughtUp?: string;
  started?: string;
}

/** What Delete would remove and what stays, in the engine's own words. */
export interface DeletePlan {
  id: string;
  title: string;
  summary: string;
  refused?: string;
  archive?: boolean;
  removes: string[];
  stays: string[];
  warnings: string[];
  pushed?: { remote: string; branch: string; why: string };
  unfinished?: string;
  remote: boolean;
  /** Someone else's ticket their owner deleted: it only leaves this board. */
  local?: { by: string };
  base: string;
  command: string;
}

export type TimedStep = 'questions' | 'spec' | 'design' | 'build' | 'fix' | 'checks' | 'review' | 'proof';

/** The "Taking longer than usual" or "Looks stuck" card. */
export interface SlowCard {
  kind: 'long' | 'stuck';
  title: string;
  where: string;
  text: string;
  facts: { label: string; value: string }[];
  limit?: string;
  canEnd: boolean;
  /** A program squad-kit started holds up the app: it may stop it, after a confirm. */
  freePort?: { port: number; what: string };
  /** The command, the port and the process, for engineers. */
  detail?: string;
}

/** What is happening on a ticket now: the card's lines, the Now tab's sentence, and what comes next. */
export interface LiveNow {
  state: 'working' | 'queued' | 'you' | 'stopping' | 'idle' | 'ready' | 'done';
  who?: string;
  role?: AgentName | 'squad';
  step?: TimedStep;
  part?: { n: number; of: number };
  doing?: string;
  line: string;
  time?: string;
  bar?: ('done' | 'now' | 'todo')[];
  sentence: string;
  detail?: string;
  next?: string;
  then?: string;
  since?: string;
  seconds?: number;
  usual?: { low: number; high: number; learned: boolean; runs: number };
  lastAt?: string;
  readyIn?: { seconds: number; what: string };
  stages: { stage: Stage; note: string }[];
  noteWhen: string;
  slow?: SlowCard;
}

export type AskOffer =
  | { do: 'propose'; label: string; note: string }
  | { do: 'note'; label: string; note: string; to?: AgentName }
  | { do: 'chat'; label: string; to: AgentName }
  | { do: 'stop'; label: string };

/** A status question answered from the live record. */
export interface AskAnswer {
  lang: 'en' | 'ar';
  topic: 'problem' | 'when' | 'doing' | 'next' | 'cost' | 'change' | 'other';
  instant: boolean;
  lines: string[];
  offers: AskOffer[];
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
  /** Deleted tickets: what they used stays in the total. */
  deleted?: { tickets: number; total: UsageTotal };
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
  /** Repos whose push failed: the release is only on this computer until Push again sends it. */
  unpushed?: { repo: string; remote: string; base: string; commit: string; tag?: string; error: string; plain?: string }[];
  /** Tickets taken out before the release was made: they go out with the next one. */
  out?: string[];
}

/** Old branches of released tickets, here and on the remote, and the ones that stay. */
export interface BranchPlan {
  here: { repo: string; branch: string; ticket: string }[];
  remote: { repo: string; branch: string; ticket: string; remote?: string }[];
  kept: { branch: string; why: string }[];
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
  /** Found by the first read and not approved yet: a proposal, not a rule. */
  proposed?: boolean;
}

export interface Lesson {
  id: string;
  text: string;
  from: string;
  date: string;
}

export interface BoardMeta {
  /** The project's id: it names this computer's folder for the project. */
  id?: string;
  /** Off: squad-kit never commits the project's documents (ADR-001). */
  documentsInGit?: boolean;
  /** The Quality setting; left out means best. */
  quality?: Quality;
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
  /** Hosts the Builder's and Tester's commands may reach besides the package registries. */
  allowedHosts?: string[];
  /** What an engineer lets the project's own commands (tests, setup, the app) reach outside their copy. */
  guard?: { allowRead?: string[]; allowWrite?: string[] };
  /** What the squad used on the project's own work, with no ticket. */
  usage?: UsageLine[];
  /** Spending limits in US dollars, used when the person pays per use. */
  budget?: { ticketUsd?: number; monthUsd?: number };
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
  /** Archived tickets, off the board until "Show archived". */
  archived?: Ticket[];
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
  /** The efforts the AI tool takes, hardest first. */
  efforts: Effort[];
}

export type ModelLevel = 'strongest' | 'balanced' | 'fast';
export type Effort = 'xhigh' | 'high' | 'medium' | 'low';
export type Quality = 'best' | 'balanced' | 'thrifty';

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
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; title?: string | null; kind?: AcpToolKind | null; status?: AcpToolStatus | null; content?: AcpToolContent[] | null; rawInput?: { command?: string; path?: string } | null; _meta?: { squadKit?: { blocked?: string[] } } | null }
  | { sessionUpdate: 'plan'; entries: { content: string; priority: string; status: 'pending' | 'in_progress' | 'completed' }[] };

export interface ConversationResponse {
  sessionId: string;
  protocol?: string;
  cwd?: string;
  /** The terminal command that opens the session in its AI tool, and the tool's name. */
  command?: string;
  tool?: string;
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

/** One app the project runs, from squad-kit's own copy of main, and how it is now. */
export interface ProjectApp {
  name: string;
  repo: string;
  base: string;
  url?: string;
  start?: string;
  setup?: string;
  state: 'not-running' | 'starting' | 'running' | 'stopped' | 'failed';
  step?: 'update' | 'setup' | 'start';
  address?: string;
  startedAt?: string;
  since?: string;
  /** Why it failed, in one plain sentence. */
  error?: string;
  /** What failed, for engineers ("See what failed"). */
  detail?: string;
  busy?: { port: number; program?: string; pid?: number; ours: boolean };
  commit?: string;
  dir: string;
  elsewhere?: boolean;
  /** Something answers at the app's address now. */
  up: boolean;
  /** The newest tickets in the code it runs. */
  includes: { id: string; title: string }[];
  /** A ticket merged since it started: "RO-5 is in main · Run the new version". */
  fresh?: { id: string; title: string; base: string; release?: string };
}

export interface AppsResponse {
  apps: ProjectApp[];
  live?: boolean;
  /** The Architect is reading the project now ("Ask the Architect to find it"). */
  reading?: boolean;
  readError?: string;
}

export interface AppOutput {
  name: string;
  start: string | null;
  url: string | null;
  address: string | null;
  dir: string;
  commit: string | null;
  lines: string[];
}

/* ── The one app (ADR-001): every project, one Waiting for you list, the folder browser ── */

export interface AppProject {
  id: string;
  name: string;
  root: string;
  /** The squad runs here. A project that could not open says why instead. */
  open: boolean;
  why?: string;
  engine?: 'demo' | 'live';
  setup?: { status: 'pending' | 'running' | 'done' | 'failed'; now?: string; error?: string; line?: string; ready?: boolean; approved?: boolean; brd?: { id: string; title: string } };
  tickets: number;
  waiting: number;
  working: number;
  url: string;
}

/** How many tickets run at once, shared by every project, and how many run now. */
export interface AppSettings {
  parallel: number;
  max: number;
  running: number;
}

export interface AppProjects extends AppSettings {
  projects: AppProject[];
}

export interface AppWaiting {
  items: { project: { id: string; name: string }; ticket: Ticket }[];
}

export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  kind: FolderKind;
  repos: number;
  /** A home folder or the disk's top folder can't be a project; a folder inside it can. */
  canAdd: boolean;
  folders: { name: string; path: string; kind: 'project' | 'repo' | 'folder' }[];
  places: { name: string; path: string }[];
  /** What squad-kit found in the folder and what adding it does. */
  look?: FirstLook;
  /** Where a new project goes unless the person picks another place. */
  place: string;
  /** Why a new project cannot go in this folder. */
  notHere?: string;
}

/** The Update button: where squad-kit stands against npm, and where an update is. */
export type UpdateState = 'idle' | 'waiting' | 'installing' | 'restarting' | 'done' | 'failed';

export interface UpdateWork {
  project: string;
  ticket?: string;
  title: string;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  newer: boolean;
  /** A new major version: read what changed and run the command; it never installs by itself. */
  major: boolean;
  checkedAt: string | null;
  checkError?: string;
  notes?: string[];
  /** What is new in every release the person gets, newest first (only releases with notes). */
  releases?: { version: string; lines: string[]; url: string }[];
  notesUrl: string;
  /** A source checkout only gets the command. */
  devInstall: boolean;
  command: string;
  daily: boolean;
  later: string | null;
  /** When the app started; a new value means it restarted. */
  startedAt: string;
  progress: {
    state: UpdateState;
    at?: string;
    from?: string;
    to?: string;
    busy?: UpdateWork[];
    waitedFor?: UpdateWork[];
    now?: boolean;
    carried?: UpdateWork[];
    reason?: string;
    permission?: boolean;
    output?: string;
  };
}

/** The AI account's usage limit: every project's queue waits until it resets. */
export interface UsageLimitStatus {
  pause: { name: string; since: string; resetsAt?: string; until: string; project?: string; ticket?: string } | null;
  /** "Claude's usage limit is reached. The squad carries on at 3:40 PM by itself". */
  text?: string;
}

/** What Report a problem saves, before and after it is saved. */
export interface ReportPlan {
  name: string;
  folder: string;
  holds: string[];
  never: string;
  command: string;
  file?: string;
}

/** Try it yourself: the ticket's own copy of the app, while it waits for your check (src/engine/try-app.ts). */
export interface TryStatus {
  ticket: string;
  state: 'off' | 'starting' | 'running' | 'failed';
  url?: string;
  /** Each page of "Where to look" at the copy's address, while it runs. */
  pages?: { page: string; url: string }[];
  since?: string;
  /** Why it did not start, in plain words. */
  error?: string;
  /** What it printed, for engineers ("See what failed"). */
  detail?: string;
  /** Another ticket's copy runs now: starting this one stops it. */
  other?: string;
  can: boolean;
  why?: string;
}

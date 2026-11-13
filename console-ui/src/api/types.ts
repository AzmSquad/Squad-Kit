import type { FirstLook, FolderKind } from './onboard-types';
export type { FirstLook };
import type { Decided } from './requirements-types';
import type { CriterionProof, OffScreen, ProofShot } from './proof-kind';

// Mirrors src/board/types.ts on the server. Keep the two in step.

/** The 7 stages a ticket moves through. `done` means released and off the board. */
export type Stage = 'tickets' | 'specs' | 'implement' | 'test' | 'review' | 'release' | 'bugs' | 'done';


export type Role = 'analyst' | 'architect' | 'spec' | 'builder' | 'tester' | 'reviewer' | 'release' | 'triage';

/** Who wrote an activity line or a thread message. */
export type Actor = Role | 'you' | 'squad';

export type WaitingKind = 'questions' | 'spec' | 'plan' | 'proof' | 'stuck' | 'release' | 'ask' | 'yours' | 'chat' | 'change' | 'depends' | 'split';

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
  /** You pasted a text that looks like several stories or a whole requirements document: a hint shows under it. */
  big?: 'few' | 'brd';
  /** That whole document was sent to Requirements from the hint: the breakdown it became. */
  breakdown?: string;
}

export interface AgentChat {
  with: AgentName;
  open: boolean;
  messages: ChatMessage[];
  thinking?: boolean;
  /** Its reply so far, while it writes it. */
  draft?: string;
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
  /** How this line is proved. Old specs have none. */
  proof?: CriterionProof;
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
  /** Old tests that also fail on main, without this story's change: the story went on past them. */
  oldFailures?: { title: string; file: string; story?: string }[];
  review: GateState;
  reviewBy?: string;
  proof: GateState;
}

// The proof's rows are with the proof kinds (api/proof-kind.ts), as on the server.
export type { OffScreen, ProofPicture, ProofShot } from './proof-kind';

export type WayOut = 'retry' | 'yourself' | 'continue' | 'plan' | 'skip-pr' | 'more' | 'stop' | 'add-test' | 'no-tests' | 'save-again' | 'skip-hooks' | 'engineer';

/** GET /api/v1/sandbox: whether the Builder's and Tester's commands run in a sandbox here, and what they may reach. */
export interface SandboxInfo {
  tools: { tool: string; available: boolean; why: string; fix?: string }[];
  registries: string[];
  allowedHosts: string[];
  /** Set where the agents' own commands or the project's own have no guard (Windows today): "Windows: less protected", in plain words. */
  note?: { title: string; text: string };
  /** squad-kit's own guard for the project's tests, setup and app on this computer, and what an engineer allowed. */
  guard?: { on: boolean; why: string; fix?: string; allowRead: string[]; allowWrite: string[] };
  /** The project's network level, what it does to the project's own commands here, and the sites refused lately, newest first. */
  network?: { level: NetworkLevel; commands: 'internet' | 'this-computer'; blocked: { host: string; story: string; level: NetworkLevel; at: string }[] };
}

/** How much of the internet the squad's commands and the project's own reach. */
export type NetworkLevel = 'standard' | 'strict' | 'off';

/** GET /api/v1/database: the project's database and each story's own copy of it, for engineers. No password is in it. */
export interface DatabaseInfo {
  database: {
    kind: 'sqlite' | 'postgres' | 'mysql' | 'mongo';
    kindName: string;
    repo: string;
    name?: string;
    where?: string;
    setting: { env?: string; file?: string; key?: string };
    /** With any password shown as ***. */
    address?: string;
    /** The address is kept on this computer only. */
    secret: boolean;
    from?: string[];
    confirmed?: { by: string; at: string };
    hidePersonal?: boolean;
    sampleRows?: number;
  } | null;
  template: { sourceName: string; madeAt: string; bytes: number; hidePersonal: boolean; tables: { name: string; kept: 'whole' | 'sampled'; rows: number }[]; hidden: string[]; notes: string[] } | null;
  making?: { since: string; by: string };
  failed?: { at: string; text: string };
  /** Why the app would not use a story's own copy: stories then use the database as before. */
  blocked?: string;
  /** The app's Redis, and each story's own database number on it: read only. */
  redis?: { server: string; here: boolean; own: number; stories: { story: string; number: number }[]; words: string };
  stories: { story: string; name: string; at: string; title?: string }[];
  notes: { at: string; story?: string; text: string }[];
  /** Tools this computer lacks for the database's kind. */
  missing: string[];
  /** One plain sentence for everyone. */
  words: string;
}

export interface StuckChoice {
  /** What happened, in plain words. */
  question: string;
  options: (DecisionOption & { do?: WayOut })[];
  /** 'cap': the step reached its turn or spend cap; Give it more or Stop. */
  gate?: 'checks' | 'review' | 'proof' | 'merge' | 'cap';
  /** Why the gate stopped, when it is not a plain failure. 'guard': a project command needed a file squad-kit's guard blocked. */
  kind?: 'weakened' | 'no-tests' | 'bad-proof' | 'guard' | 'broken' | 'not-shown' | 'hook' | 'gate-cant-run';
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
  added?: string;
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
  /** More than one story: the Analyst's split, or a whole requirements document. The fields above are for one story anyway. */
  split?: SplitSuggestion;
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
  /** The pull request that clashed with the base, kept while the clash card waits: a person may merge it on the code host. */
  clashedPr?: { id: number; url: string; repo: string; host: string };
  /** The pull request the code host closed without merging. */
  prClosed?: number;
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
  /** Merged here, with its work going on by pull request: how to send it. Only on the ticket's own record. */
  sendAs?: { branch: string; remote: string; push: string; dir: string; page?: string; host?: string; into?: string };
  quiet?: { since: string; kind: 'stuck' | 'long'; detail: string; command?: string; pid?: number; port?: { port: number; pid?: number; program?: string; ours: boolean; app?: string } };
  priority: 'high' | 'normal' | 'low';
  stage: Stage;
  /** One line under the card title: what is happening now. */
  status: string;
  /** True while a squad member is actively working on it. */
  live?: boolean;
  /** Made by squad-kit, it waits on the board until you start it: nothing runs or costs before. */
  waitsToStart?: boolean;
  /** 0 to 100, for the current stage. */
  progress?: number;
  waiting: Waiting | null;
  /** What it waits on the person for now, as a short mark (board/wait-key.ts): a decision card in a chat sends it back with a press. */
  waitKey?: string;
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
  work?: { steps: number; tests: number; screens: number; asks?: number };
  steps?: Step[];
  gates?: Gates;
  proof?: ProofShot[];
  /** The "done when" items the Tester said show on no screen, with why. They do not fail the proof. */
  offScreen?: OffScreen[];
  /** The pictures are of the app's web version, as its phone tools are missing: why, and the Tools page line. */
  picturesNote?: { text: string; link: string };
  /** Rounds of screenshots that showed a "done when" does not work, since the last met proof (2 at most, then a stop). */
  proofRound?: number;
  stuck?: StuckChoice;
  release?: string;
  /** One line for the release notes, written by the squad. */
  releaseNote?: string;
  /** What the change touches that the plan did not include, in the Reviewer's plain words. */
  alsoChanged?: string[];
  added?: AddedResult[];
  foundIn?: string;
  severity?: 'stops-work' | 'annoying' | 'small';
  changeRequest?: string;
  activity: Activity[];
  squad?: SquadState | null;
  /** Live engine only: where the ticket's code lives and how far the squad got. */
  sessions?: TicketSessions;
  /** The product's parts this story changes, by their ids. */
  parts?: string[];
  /** The folder holding the story's copies, on a workspace of several repos. */
  storyDir?: string;
  copies?: { repo: string; dir: string; baseCommit?: string }[];
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
  takenOver?: { by: string; at: string; session: string; cwd: string; free?: { from?: string; designApproved?: boolean } };
  /** Worked on in a conversation outside squad-kit: on its record for good. */
  outside?: { from?: string; by: string; at: string; checked?: { at: string; by: string; noTests?: boolean } };
  track?: Track;
  /** "Write new tests" was off on the new story form: the story says "Built without new tests". */
  noNewTests?: boolean;
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
  /** It waits for a tool on this computer: which, why, and the line on the Tools page (src/engine/tools). */
  toolWait?: ToolBlock;
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
  /** Its size: the Analyst's suggestion to split it, what you chose, or the story it was split from (src/board/split.ts). */
  split?: StorySplit;
}

/** One story of a suggested split, in the order to build them. `needs`: the parts it needs first, by number (1 is the first). */
export interface SplitPart {
  title: string;
  line: string;
  size: 'S' | 'M' | 'L';
  needs: number[];
  criteria?: number[];
  doneWhen?: string[];
}

/** The Analyst's suggestion for a story too big for one: split it (`few`), or a whole requirements document (`brd`). */
export interface SplitSuggestion {
  size: 'few' | 'brd';
  why: string;
  parts: SplitPart[];
  areas?: { name: string; stories: number }[];
  /** What squad-kit's own count found, in plain words. */
  found: string[];
  at: string;
}

export interface StorySplit {
  suggestion?: SplitSuggestion;
  questions?: Question[];
  /** Your note for another split, while the Analyst writes it again. */
  change?: string;
  decided?: { choice: 'split' | 'keep' | 'requirements'; by: string; at: string; made?: string[]; breakdown?: string };
  checked?: string;
  from?: string;
  was?: { title: string; ask: string };
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
  /** Taking longer: why, in plain words, picked from what really happened on the step. */
  why?: { kind: 'own-fail' | 'own-fixed' | 'checks' | 'review' | 'setup' | 'busy' | 'bigger'; short: string; sentence: string };
  /** Taking longer, with progress in the last few minutes: a calm card, not amber. */
  calm?: boolean;
  /** Taking longer: the board card's second line, "Longer than usual · 19 min · still working". */
  line?: string;
  /** Taking longer: the reason under it, when the card's first line does not say it already. */
  note?: string;
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
  /** `wait`: a small second line under a finished stage that waited long, "waited 25 min for you". */
  stages: { stage: Stage; note: string; wait?: string }[];
  noteWhen: string;
  slow?: SlowCard;
  /** On its way in now: its save after Looks right, then its merge or its pull request. */
  merging?: true;
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
  gateStop?: { id: string; name: string; result: 'failed' | 'cant-run'; why?: string; output?: string }[];
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
  /** An engineer chose that every story writes new tests: no "Write new tests" switch on a new story. */
  alwaysNewTests?: boolean;
  /** The phone an app for both phones uses: the iPhone or Android. Left out: automatic. */
  phone?: 'iphone' | 'android';
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
  /** The project's network level. Left out, Standard. */
  network?: NetworkLevel;
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
  parts?: ProductPart[];
  atOnce?: number;
  delivery?: 'pr' | 'push';
  localFiles?: ProjectFile[];
  lockedFiles?: ProjectFile[];
}

/** A file an engineer named, in one of the project's repos. */
export interface ProjectFile {
  repo: string;
  path: string;
}

/** One thing that runs when the whole product is up: a part of it, or a service the parts share. */
export interface ProductPart {
  id: string;
  name: string;
  shared?: boolean;
  repo?: string;
  folder?: string;
  needs: string[];
  url?: string;
  off?: boolean;
  noRun?: boolean;
  byHand?: boolean;
}

export interface RepoInfo {
  /** Folder relative to the project, like "web-ui". */
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
  /** The env file the app reads its settings from, like .env.dev: squad-kit gives its values to the commands it runs here. */
  envFile?: string;
}
/** A ticket the board cannot show: what the person reads, and for engineers its file and why. */
export interface BrokenTicket {
  id: string;
  problem: string;
  file: string;
  detail: string;
}

/** A record whose file cannot be read: the person's words, and for engineers the file and why. */
export interface BrokenRecord extends BrokenTicket {
  kind: 'decision' | 'release' | 'breakdown';
}

export interface BoardResponse {
  ready: boolean;
  /** Not ready because the project's settings file cannot be read, in plain words. */
  settings?: string;
  meta: BoardMeta;
  /** The running board: when it started and whether a newer squad-kit is installed. */
  console?: { startedAt: string; outdated: boolean } | null;
  tickets: Ticket[];
  /** Archived tickets, off the board until "Show archived". */
  archived?: Ticket[];
  /** Ticket folders whose ticket file cannot be read, so they are not among the tickets. */
  broken?: BrokenTicket[];
  /** Decisions, releases and breakdowns whose file cannot be read. Their own pages show them too. */
  brokenRecords?: BrokenRecord[];
  stats: { released30: number; bugs30: number; open: number };
  /** The project is squad-kit's own code: the plain notes its pages show. */
  self?: { note: string; releases: string; docs: string };
}

export interface ReleaseItem {
  id: string;
  title: string;
  gates: Gates | null;
  kind: 'feature' | 'bug';
  outside?: Ticket['outside'];
  noNewTests?: boolean;
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

export interface StoryLink {
  id: string;
  title: string;
  at: string;
}

export interface HarnessNeed {
  id: string;
  summary: string;
  row: string;
  proof: boolean;
}

/** One gate, or one rule that is always on, as /api/v1/harness gives it. */
export interface HarnessRow {
  id: string;
  name: string;
  what: string;
  fail?: string;
  then?: string;
  you?: boolean;
  skip?: Track[];
  note?: Partial<Record<Track, string>>;
  d?: [string, string][];
  seen?: { passed?: number; stopped?: number; week?: number; last?: StoryLink; did?: string };
  needs?: HarnessNeed[];
  cells?: Record<Track, { word: string; note?: string }>;
  team?: { state: AdditionState; kind: HarnessAddition['kind'] };
}

export type AdditionState = 'try' | 'on' | 'off';

/** What a team added to its harness, from .squad/harness.yaml. */
export interface HarnessAddition {
  id: string;
  kind: 'rule' | 'checklist' | 'gate';
  name: string;
  state: AdditionState;
  from: string;
  added_by: string;
  added_at: string;
  stage: string;
  agents?: string[];
  text?: string;
  note?: string;
  agent?: 'reviewer' | 'tester';
  questions?: string[];
  when?: 'checks' | 'merge' | 'release';
  command?: string;
  part?: string;
  partGone?: boolean;
  on_fail?: 'stop' | 'warn';
  tried?: { at: string; by: string; result: 'passed' | 'failed'; seconds: number };
  seen?: HarnessRow['seen'];
}

export interface HarnessLogLine {
  at: string;
  by: string;
  did: 'added' | AdditionState | 'removed' | 'tried';
  name: string;
  kind: HarnessAddition['kind'];
  from?: string;
}

export interface GateTryAnswer {
  result: 'passed' | 'failed' | 'cant-run';
  seconds: number;
  why?: string;
  output: string;
}

export interface FolderFind {
  key: string;
  kind: HarnessAddition['kind'];
  name: string;
  source: string;
  text?: string;
  questions?: string[];
  command?: string;
  when?: 'checks' | 'merge' | 'release';
  out?: string;
  already?: boolean;
}

export interface FolderLook {
  name: string;
  path: string;
  finds: FolderFind[];
  left: number;
  more: boolean;
}

/** What one of the team's additions did on a story. */
export interface AddedResult {
  id: string;
  name: string;
  kind: 'gate' | 'checklist';
  state: 'try' | 'on';
  at: string;
  result?: 'passed' | 'failed' | 'warned' | 'would-stop' | 'cant-run';
  why?: string;
  output?: string;
  agent?: 'reviewer' | 'tester';
  answers?: { question: string; answer?: 'yes' | 'no'; why?: string }[];
}

export interface HarnessStage {
  id: string;
  name: string;
  about: string;
  on: Record<Track, { kind: 'you' | 'squad' | 'skip'; sub: string; off?: boolean }>;
  gates: HarnessRow[];
  stopped?: number;
}

/** Everything the Harness page shows, with the engine's real values and what really happened on this project's stories. */
export interface HarnessView {
  quality: Quality;
  qualityNote: Record<Quality, string>;
  range: { days: number; weekDays: number; stories: number };
  tiles: { working: number; stopped: number; needs: HarnessNeed[] };
  tracks: { id: Track; name: string; words: string }[];
  stages: HarnessStage[];
  alwaysOn: HarnessRow[];
  limits: { id: string; group: string; n: string; name: string; what: string; hit?: StoryLink }[];
  caps: { key: string; name: string; turns: number; spendUsd: number }[];
  agents: Record<string, { can: [string, boolean][] }>;
  /** The Squad lead: what it may read, its three levels, Always allow, and its limits. */
  lead: HarnessLead;
  additions: {
    items: HarnessAddition[];
    log: HarnessLogLine[];
    broken?: string;
    parts: { id: string; name: string }[];
    guarded: boolean;
    demo: boolean;
    /** The file travels through git, so the team gets it. */
    shared: boolean;
    limits: { rules: number; ruleChars: number; questions: number };
  };
  safety: {
    hidden: string[];
    locked: string[];
    sites: string[];
    refused: string[];
    tools: string[];
    local: string[];
    lockedByYou: string[];
    /** The project's network level, the three to pick from, and what stays closed on all of them. */
    network: { level: NetworkLevel; levels: { id: NetworkLevel; name: string; words: string }[]; closed: string[]; commands: 'internet' | 'this-computer' };
  };
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
  /** Decisions whose file cannot be read, so they are not among the decisions. */
  broken?: BrokenRecord[];
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
  step?: 'update' | 'copy' | 'setup' | 'start' | 'phone';
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
  /** A phone app: Start opens it on squad-kit's iPhone or Android phone. */
  phone?: PhoneAppView;
  /** "How to sign in", once the Squad lead learned it: shown next to Open. */
  signIn?: string;
}

/** An app opened on squad-kit's phone for you: each step with the time left, then the device it runs on. */
export interface PhoneOpenView {
  state: 'starting' | 'running' | 'stopped' | 'failed';
  step?: 'build' | 'phone' | 'install' | 'open';
  /** "Building the app for the iPhone, about 4 minutes left". */
  line?: string;
  secondsLeft?: number;
  /** "iPhone 16 Pro", once it runs. */
  device?: string;
  language?: string;
  since?: string;
  error?: string;
  detail?: string;
  /** Why it stopped by itself: "You closed the iPhone window, so squad-kit stopped the app." */
  ended?: string;
}

/** A phone app in Your apps or Try it yourself. */
export interface PhoneAppView {
  /** The phone it opens on: "iPhone", "Android phone". */
  word: string;
  /** The tools for it are here: Start opens it on the phone. */
  ready: boolean;
  why?: string;
  /** The Tools page line: "/tools#xcode". */
  link?: string;
  /** The languages to pick from next to Start, English first. Empty: nothing to pick. */
  languages: string[];
  /** It also has a web version: "Use the web version now". */
  web: boolean;
  /** Start runs it on the phone now. */
  on?: boolean;
  run?: PhoneOpenView;
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
  /** The person went past the first start's Welcome, on this computer. */
  welcomed?: boolean;
}

/** The first start's "Is your computer ready?" (src/engine/computer-ready.ts). */
export type ReadyStep = 'install-git' | 'update-git' | 'install-tool' | 'sign-in';

export interface ComputerReady {
  git: { ok: boolean; step?: ReadyStep };
  tool: { ok: boolean; label?: string; step?: ReadyStep };
}

/** The Tools page, "What this project needs" (src/engine/tools/index.ts). */
export type ToolAction = 'build' | 'checks' | 'pictures' | 'start-app' | 'try-it';
export type ToolState = 'ready' | 'missing' | 'too-old' | 'getting' | 'updating' | 'not-here';

export interface ToolGetting {
  tool: string;
  name: string;
  version?: string;
  startedAt: string;
  /** squad-kit's own download and unpack, its install after (Android), or an update of your own copy. */
  step: 'download' | 'unpack' | 'install' | 'update';
  /** A download: bytes so far and in all. An update: seconds so far and the time it usually takes. */
  done: number;
  total?: number;
  secondsLeft: number;
  /** An update: the step it is at, in plain words. */
  words?: string;
}

export interface ToolLine {
  id: string;
  name: string;
  gives: string;
  priority: 'required' | 'recommended' | 'optional';
  state: ToolState;
  version?: string;
  needs?: string;
  why?: string;
  note?: string;
  notHere?: string;
  installer: 'squad-kit' | 'you';
  reason?: string;
  steps: string[];
  link: string;
  usedFor: string;
  actions: ToolAction[];
  blocks: ToolAction[];
  getting?: ToolGetting;
  trouble?: string;
  command: string;
  /** Too old, and squad-kit can update your copy safely: the warning to OK first, the usual time, and the command. */
  update?: { warning: string; seconds: number; command: string };
  /** Too old, and squad-kit can't update your copy: why, in one line. */
  cantUpdate?: string;
  /** Ready, and older than its makers recommend: the version they recommend. It stops nothing; the steps say how to update. */
  recommended?: string;
  /** Its maker's license comes first: whether you accepted it, and the command that shows it and asks. */
  license?: { accepted: boolean; command: string };
  /** squad-kit gets it: how much room it takes ("about 20 GB") and about how long the first time takes, in seconds. */
  size?: string;
  seconds?: number;
}

/** A tool's license in full, from its maker, for you to read before Accept. */
export interface LicenseView {
  tool: string;
  name: string;
  licenses: { id: string; text: string }[];
  accepted: boolean;
}

export interface ToolsView {
  system: 'mac' | 'windows' | 'linux';
  checkedAt: string | null;
  checking: boolean;
  summary: string;
  places: { place: string; part?: string; kinds: string[]; platforms: string[] }[];
  lines: ToolLine[];
  getting: ToolGetting | null;
}

/** A step a Required tool stops: what can't happen, why, and the link to its line. */
export interface ToolBlock {
  action: ToolAction;
  tools: { id: string; name: string; state: ToolState; version?: string; needs?: string }[];
  text: string;
  status: string;
  link: string;
  checking?: true;
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
  /** An iPhone app on a Mac: Try it yourself opens the story's copy on squad-kit's iPhone. */
  phone?: PhoneAppView;
  /** Why it stopped by itself last time. */
  ended?: string;
}

/* ── The Squad lead (GET /api/v1/lead and the calls under it) ─────────── */

/** Where a question was asked from. squad-kit fills in the facts of a story or a problem itself. */
export type LeadContext =
  | { from: 'board'; page?: string }
  | { from: 'app'; path: string; app?: string }
  | { from: 'story'; story: string }
  | { from: 'problem'; problem: 'slow' | 'stuck' | 'waiting' | 'error'; story?: string; error?: string };

/** How a "done when" will be proved. */
export type ProofKind = 'screen' | 'api' | 'data' | 'test';

/** One line of the work trace: "Read MA-12 "Owner cancels a booking"", "Looked at /my-bookings in its own copy". */
export interface LeadStep {
  at: string;
  text: string;
  kind: 'notes' | 'board' | 'story' | 'code' | 'app' | 'guide' | 'log' | 'refused' | 'card';
}

/** A picture in an answer: one the lead took in its own copy, or one of a story's own proof pictures. `url` serves it. */
export interface LeadEvidence {
  file: string;
  caption: string;
  url: string;
  /** The story whose proof it is from; left out for a picture the lead took. */
  story?: string;
}

export interface LeadSource {
  kind: 'story' | 'decision' | 'file' | 'release' | 'note' | 'guide' | 'log';
  /** "MA-12", "MA-12.1", "src/lib/booking-rules.ts:42", "0.2.0". */
  ref: string;
  label?: string;
}

/** The board actions a card can run, each the same call as the board's own button. */
export type LeadAction =
  | 'more_time'
  | 'pictures_again'
  | 'start_app'
  | 'try_again'
  | 'restart'
  | 'stop'
  | 'start_story'
  | 'stop_story'
  | 'get_tool'
  | 'update_tool'
  | 'engineer'
  | 'morning_brief';

/** The part of a story an Open card shows. */
export type LeadStoryTab = 'proof' | 'spec' | 'plan' | 'questions';

/** The only actions "Always allow" can cover. */
export type LeadAllowable = 'more_time' | 'pictures_again' | 'start_app' | 'morning_brief';

interface LeadCardBase {
  /** POST /api/v1/lead/cards/<id>/run presses it. */
  id: string;
  /** 1: "On its own" (it only writes text or opens a page). 2: "Needs your OK". */
  level: 1 | 2;
  /** The main button's words: "Create story", "Allow once", "Send", "Save". */
  label: string;
  why?: string;
  /** The same press in the terminal. */
  command: string;
  status: 'open' | 'done' | 'failed' | 'dismissed';
  /** What it did once pressed, or why it did not. */
  result?: string;
  /** It ran by itself under "Always allow", and the line that says so. */
  byItself?: string;
  /** "Always allow" can be pressed on it. */
  allowAlways?: boolean;
  /** It came from what the lead read, not from your message, so it asks first even with "Always allow" on. */
  asksFirst?: boolean;
}

export type LeadCard =
  /** `split`: the text is more than one story; you choose its parts, Requirements, or one story anyway. `stories`: what it made. */
  | (LeadCardBase & { kind: 'draft_story'; title: string; ask: string; storyKind: 'feature' | 'bug'; doneWhen: { text: string; proof: ProofKind }[]; warnings: string[]; story?: string; split?: SplitSuggestion; stories?: string[]; breakdown?: string })
  /** A whole requirements document pasted to the lead, by squad-kit's own count: Send to Requirements, in its language. */
  | (LeadCardBase & { kind: 'requirements'; found: string[]; lang: 'en' | 'ar'; breakdown?: string })
  | (LeadCardBase & { kind: 'board_action'; action: LeadAction; story?: string; minutes?: number; app?: string; tool?: string })
  | (LeadCardBase & { kind: 'send_answer'; story: string; text: string })
  | (LeadCardBase & { kind: 'settings_change'; setting: string; value: string; technical: boolean })
  | (LeadCardBase & { kind: 'engineer_report'; report?: string })
  /** Opens a story on the board at its tab; `open` is the board's own place, "/tickets/MA-7/proof". Nothing is pressed. */
  | (LeadCardBase & { kind: 'open_story'; story: string; tab?: LeadStoryTab; open: string })
  /**
   * A story that waits for you, brought into the chat: the board shows it from its live data, with its own buttons. The
   * lead brings it; only you press it. `key` is what waited when the card was made: a press sends it back, so the board
   * acts only on what you saw.
   */
  | (LeadCardBase & { kind: 'decide'; story: string; wait: WaitingKind; key: string; open: string });

export interface LeadAnswer {
  /** The answer in one sentence. */
  headline: string;
  /** A few short lines, Markdown. */
  body: string;
  evidence: LeadEvidence[];
  sources: LeadSource[];
  cards: LeadCard[];
  /** What it saved in squad-kit's notes. */
  learned?: string;
  /** Answered by squad-kit itself, with no AI: a saved note, the story's live record, a refusal, the day's limit. */
  by?: 'note' | 'record' | 'refusal' | 'limit' | 'check';
}

export interface LeadTurn {
  n: number;
  ask: { text: string; at: string; context: LeadContext; facts?: string[] };
  answer?: LeadAnswer;
  trace: LeadStep[];
  /** What squad-kit refused, in its exact words. */
  refused: string[];
  seconds?: number;
  /** At API prices, in US dollars. 0 when squad-kit answered itself. */
  costUsd?: number;
  /** Why no answer came, in plain words. */
  error?: string;
  /** "Sonnet (balanced, medium effort)". */
  model?: string;
  /** While it answers: its words so far. */
  draft?: { headline?: string; body?: string };
}

/** GET /api/v1/lead/conversations/<id>: poll it while `thinking`. */
export interface LeadConversation {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  context: LeadContext;
  turns: LeadTurn[];
  thinking?: boolean;
  session?: string;
  /** The story a card made from it. */
  story?: string;
}

export interface LeadSummary {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  turns: number;
  thinking: boolean;
  costUsd?: number;
  story?: string;
  context: LeadContext;
}

/** One "Needs you" item, with the lead's check-in words, made with no AI. */
export interface NeedsYouItem {
  id: string;
  story: string;
  title: string;
  kind: 'proof' | 'spec' | 'plan' | 'questions' | 'ask' | 'stuck' | 'slow' | 'looks-stuck' | 'release' | 'other';
  /** "MA-7 is ready for your check: 5 pictures, checks pass, Reviewer approved." */
  words: string;
  more?: string;
  lowRisk?: boolean;
  cards: LeadCard[];
  /** The board's path to open: "/tickets/MA-7/proof", "/board?ticket=MA-9". */
  open: string;
}

/** "The squad now": one agent at work. */
export interface SquadNowItem {
  story: string;
  title: string;
  who: string;
  doing: string;
  /** 0 to 1, for the bar. */
  progress?: number;
  slow?: boolean;
}

/** The morning brief, when it is on: since yesterday evening, no AI. */
export interface MorningBrief {
  since: string;
  headline: string;
  merged: string[];
  released: string[];
  working: string[];
  stopped: string[];
  waiting: number;
  costUsd?: number;
}

export interface LeadRules {
  always: LeadAllowable[];
  brief: boolean;
}

/** GET /api/v1/lead. */
export interface LeadView {
  conversations: LeadSummary[];
  needsYou: NeedsYouItem[];
  squadNow: SquadNowItem[];
  brief?: MorningBrief;
  rules: LeadRules;
  today: { costUsd: number; limitUsd: number };
  /** "How to sign in", once the lead learned it. */
  signIn?: string;
}

export interface LeadLimits {
  questionUsd: number;
  questionTurns: number;
  dayUsd: number;
  minutes: number;
}

/** GET /api/v1/lead/rules. PUT takes { always?: LeadAllowable[], brief?: boolean }; the never list cannot change. */
export interface LeadRulesView extends LeadRules {
  allowable: { id: LeadAllowable; name: string }[];
  never: { id: string; name: string; refusal: string }[];
  limits: LeadLimits;
  today: { costUsd: number; limitUsd: number };
}

/** GET /api/v1/lead/can: the "What it can do" panel. */
export interface LeadCan {
  levels: { level: 1 | 2 | 3; name: string; words: string; items: string[] }[];
  always: { words: string; actions: { id: LeadAllowable; name: string }[] };
  reads: string[];
  looks: string[];
  limits: LeadLimits;
}

/** POST /api/v1/lead/cards/<id>/run: { always?: true, dismiss?: true, edits?: { title, ask, doneWhen, text } }. */
export interface LeadCardRun {
  card: LeadCard;
  conversation?: string;
}

/** The Harness page's Squad lead section. */
export interface HarnessLead {
  reads: string[];
  levels: { level: 1 | 2 | 3; name: string; words: string; items: string[] }[];
  always: { words: string; can: { id: LeadAllowable; name: string }[]; on: LeadAllowable[] };
  limits: { name: string; n: string; what: string }[];
  model: string;
}

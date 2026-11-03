import type { SetupState } from './setup-state.js';

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

/**
 * 'spec' waits for you to approve the what (story, done when); 'plan' the how (decision, steps). 'change': the
 * Builder paused for a big change, and the Architect's design update waits for you. 'depends': the design needs a
 * ticket that is not merged yet, and you choose how to build.
 */
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

/**
 * 'skipped': the person pressed Continue anyway, with a reason (see Ticket.overrides). The engine never skips a gate itself.
 * 'unchecked': the checks ran, but no tests did, so they prove little ("Not checked", never a green pass).
 */
export type GateState = 'pending' | 'pass' | 'fail' | 'skipped' | 'unchecked';

export interface Gates {
  checks: GateState;
  checksText?: string;
  /** Each check squad-kit ran last, for the Reviewer: "test (npm test): passed, 18 tests". */
  ran?: { name: string; command: string; ok: boolean; tests?: number }[];
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

/** The ways out of a stop. Every stop has at least Try again and one more; a step paused on a cap has Give it more and Stop. */
export type WayOut = 'retry' | 'yourself' | 'continue' | 'plan' | 'skip-pr' | 'more' | 'stop' | 'add-test' | 'no-tests';

export interface StuckOption extends DecisionOption {
  /** What the choice does. Older boards have no `do`: their first choice tries again, the second goes to the plan. */
  do?: WayOut;
}

export interface StuckChoice {
  /** What happened, in plain words. */
  question: string;
  options: StuckOption[];
  /** The exact error behind it, for engineers: the Developer tab, the app log and Report a problem. */
  detail?: string;
  /** Filled in when the ticket is read (see board/problem.ts), never saved: "The Builder stopped". */
  title?: string;
  /** Filled in when the ticket is read: what is safe, "Nothing was merged or pushed." */
  safe?: string[];
  /** What stopped: a failed gate the person can continue past, a clash with the base branch, a step's cap, or any other error. */
  gate?: 'checks' | 'review' | 'proof' | 'merge' | 'cap';
  /** Why the gate stopped, when it is not a plain failure: tests made weaker, no tests at all, or screenshots that failed squad-kit's check. */
  kind?: 'weakened' | 'no-tests' | 'bad-proof';
  /** For failed checks: which ones failed (for weakened tests: what was weakened), so continuing past them is remembered for them. */
  checks?: string[];
  /** The plain reasons, one per line on the card: "test/booking.test.ts was deleted (4 tests)". */
  points?: string[];
  /** The ticket stopped between two steps at its own budget, or at the month's (API key only). */
  budget?: 'ticket' | 'month';
}

/** The person went past a failed gate on purpose. Shown on the ticket, the pull request and the release notes. */
export interface GateOverride {
  gate: 'checks' | 'review' | 'proof';
  /** Continued past tests made weaker, not past failing checks: what was weakened. */
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

export interface ChatMessage {
  who: 'you' | AgentName | 'squad';
  text: string;
  at: string;
  /** Screenshots, files or voice notes added to the message, as full paths. */
  files?: string[];
  /** Short answers the agent offers to its question; the person taps one or writes their own. */
  options?: string[];
  /** A note from squad-kit: the person stopped the answer, the agent could not answer, or the answer waits for the usage limit. */
  note?: 'stopped' | 'failed' | 'waits';
}

/**
 * Talking it through with one agent, in its own Claude Code session. A ticket that was waiting for you stays with you
 * while you talk; only you move it on: write or update the spec or design from the talk, or Done. A ticket the squad
 * is working on goes on working: the chat is beside the work.
 */
export interface AgentChat {
  with: AgentName;
  open: boolean;
  messages: ChatMessage[];
  /** Set while the agent writes its reply. */
  thinking?: boolean;
  /** The agent thinks it understands enough for the next step. It only says so; you decide. */
  ready?: boolean;
  /** Where the ticket was when the chat started, to go back to it on Done. */
  before: { waiting: Waiting | null; phase?: string };
  /**
   * Asking beside the work: the squad was working (or the ticket is accepted), so the chat changes nothing on the
   * ticket. The agent answers in a side conversation of its own, never in the one that is working.
   */
  beside?: boolean;
  /** The side conversation's session id. */
  side?: string;
  /** Set when the person presses Stop on the answer. */
  stopping?: boolean;
}

/** One part of the spec a change touches. A "done when" counts from 0; a new one has no index yet. */
export interface ChangePart {
  part: 'story' | 'criterion';
  index?: number;
  /** The words now. Empty for a new "done when". */
  before: string;
  /** The words after the change. Empty when the "done when" goes. */
  after: string;
  /** The new "done when" itself, to put in the spec on approval. */
  criterion?: Criterion;
}

/** One design step after a big change, and whether the Builder must do it again. */
export interface ChangeStep {
  title: string;
  change: 'same' | 'changed' | 'new';
}

/**
 * writing: the Analyst writes it into the spec. proposed: it waits for you. approved: a small one waits to reach the
 * Builder, a big one for the Builder's current step to end. designing: the Architect updates the design.
 * design-ready: the new design waits for you. building: the Builder works on it. done, declined, failed: closed.
 */
export type ChangeStatus = 'writing' | 'proposed' | 'approved' | 'designing' | 'design-ready' | 'building' | 'done' | 'declined' | 'failed';

/**
 * A change the person proposed to the spec. The Analyst writes the old and new wording of the parts it touches and
 * says whether it is small or big; the person approves or declines. A big one also gets the Architect's new design,
 * approved before the Builder redoes the steps it touches. One open change at a time per ticket.
 */
export interface SpecChange {
  id: string;
  /** What the person asked, in their words. */
  ask: string;
  by: string;
  at: string;
  /** The chat it came from, when it came from a message to an agent. */
  from?: AgentName;
  status: ChangeStatus;
  size?: 'small' | 'big';
  /** One line: what changes. */
  summary?: string;
  /** Why it is small or big, in plain words. */
  why?: string;
  parts?: ChangePart[];
  /** A big change: the Architect's design update, with the steps as they were. */
  design?: { summary: string; before: string[]; steps: ChangeStep[] };
  /** Who approved or declined it, and why. `withdrawn`: it was approved, then taken back before it was built. */
  decided?: { by: string; at: string; approved: boolean; reason?: string; withdrawn?: boolean };
  /** A small change approved while the Builder works goes into the spec at once: the spec before it, for a withdraw. */
  specBefore?: { story?: string; criteria?: Criterion[] };
  /** A big change: what waited while the design was updated, to go back to if the update is declined. */
  paused?: { phase?: string; waiting?: Waiting };
  error?: string;
}

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

/** A decision approved after this ticket was planned, that the Architect says changes it. */
export interface Outdated {
  adr: string;
  why: string;
  /** What to change, in the Architect's words: the change request for the plan, or the follow-up ticket. */
  change: string;
  at: string;
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

/** What some runs used, added up. A count the AI tool never reported stays out, with the runs it is missing for. */
export interface UsageTotal {
  runs: number;
  /** Tokens the model read, cached ones included. */
  inputTokens?: number;
  /** The part of inputTokens read back from the tool's cache. */
  cachedTokens?: number;
  outputTokens?: number;
  /** What the runs would cost at the AI company's API prices, in US dollars. */
  costUsd?: number;
  /** Runs whose tokens the AI tool did not report. */
  tokensUnknown?: number;
  /** Runs whose cost the AI tool did not report. */
  costUnknown?: number;
}

/**
 * What one role used on one step at one model level (ADR-001: cost is visible). Kept on this computer: each person
 * runs the squad on their own AI account, and it changes with every run.
 */
export interface UsageLine extends UsageTotal {
  role: AgentName;
  step: string;
  level: 'strongest' | 'balanced' | 'fast';
  /** The model in words, as the AI tool names it for the level ("Opus"), or the model someone pinned. */
  model: string;
}

/**
 * How a ticket builds while a ticket it depends on is not merged. branch: its copy starts from that ticket's branch,
 * and brings in the base once that ticket merges. anyway: from the base, without it. wait: it starts by itself once
 * that ticket merges. Kept on the ticket's record.
 */
export interface DependencyChoice {
  /** The tickets it needed, not merged when the person chose. */
  on: string[];
  way: 'branch' | 'anyway' | 'wait';
  by: string;
  at: string;
  /** branch: the commit of the dependency's work the copy started from. */
  from?: string;
  /** branch: the dependency merged, and the base came into the copy. */
  caughtUp?: string;
  /** wait: the dependency merged, and the build started. */
  started?: string;
}

/** After a merge moved the person's own checkout: the project's setup runs there, so the app keeps working. */
export interface LocalSetup {
  status: 'pending' | 'running' | 'done' | 'failed';
  dir: string;
  command: string;
  at?: string;
  seconds?: number;
  output?: string;
}

export interface Ticket {
  id: string;
  title: string;
  ask: string;
  kind: 'feature' | 'bug';
  /**
   * Where the ticket came from: 'manual', or the name of the tracker module it was pulled from, with the item's id,
   * how people write it (ref), its web link and its type (User Story, Bug…).
   */
  source: { type: string; ref?: string; id?: string; url?: string; itemType?: string };
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
  /** The Builder's runs that did not get through: the run itself failed, or the checks or the Reviewer turned it back. */
  fails?: number;
  reviewRound?: number;
  /** Step to run again when the person picks "Try again" on a stuck card. */
  retryPhase?: string;
  /** A step that reached its caps, and how many times the person pressed Give it more on it: each time doubles them. */
  capRaise?: { role: string; step: string; times: number };
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
  /** The pull request on the code host module named in host. */
  pr?: { id: number; url: string; repo: string; host: string };
  /** When the change went into the base branch. Accepted work merges right away, so later tickets build on it. */
  mergedAt?: string;
  /** Installing packages and running migrations in the person's own checkout, after the merge moved it. */
  localSetup?: LocalSetup;
  /** Decisions approved after this ticket was planned that change it, waiting for the person. */
  outdated?: Outdated[];
  /** The plan is being redone to follow this decision: the build brings in the latest base first. */
  replanFor?: string;
  /** Set by the watchdog when a running step shows no progress: what it waits on, and whether that looks stuck. */
  quiet?: { since: string; kind: 'stuck' | 'long'; detail: string; command?: string; pid?: number; port?: QuietPort };
  /** "Keep waiting": the watchdog stays quiet about this ticket until then. */
  quietSnoozedUntil?: string;
  /** Updates still to send to the tracker; the live squad sends them, so terminal commands never wait on Azure. */
  trackerQueue?: TrackerEvent[];
  /** The first queued update failed this many times; the next try waits until nextAt. */
  trackerRetry?: { tries: number; nextAt: string };
  /** The checks the person chose to continue past. While only these fail, the work goes on as they decided. */
  checksContinued?: string[];
  /** The weakened tests the person chose to continue past (see engine/weakened.ts). Only new ones stop the ticket again. */
  weakenedContinued?: string[];
  /** The test command the Architect suggested for a project with none. The person approves it before squad-kit uses it. */
  testSuggestion?: string;
  /** The design changes a test command the project has: it waits for the person, the checks keep the current one. */
  testChange?: TestChange;
  /** The Reviewer's notes from its last round, shown to it again with the whole change in the next round. */
  reviewAsked?: string[];
  /** The plan the Builder's conversation was given, as a short hash: a resumed Builder gets the plan again when it changed. */
  builtPlan?: string;
  notes?: TicketNote[];
  overrides?: GateOverride[];
  /** Full track: who approved the spec. The Architect writes the design only after this. */
  specApproved?: { by: string; at: string };
  /** The Architect's HTML mockup of the main screen, approved with the design. */
  mockup?: string;
  /** Review like a document: comments sent back, the person's own edits, and the version before the rewrite. */
  chat?: AgentChat;
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
  /** Changes the person proposed to the spec, oldest first. Kept in spec.md, the spec's own record. */
  changes?: SpecChange[];
  /** The accepted or released ticket this one changes: a change asked for after release becomes a new linked ticket. */
  changeOf?: string;
  /** What each role used on this ticket, per step and model level. */
  usage?: UsageLine[];
  /** The steps that ended well, oldest first: who, which step, from when to when. "What happened" draws them. */
  history?: StepRun[];
  /** The Quality setting the squad last ran this ticket on, for the cost and time per Quality setting. */
  quality?: Quality;
  /** The person let the ticket go on past a budget: its own, or the month's ("2026-11"). */
  budgetOk?: { ticket?: boolean; month?: string };
  /**
   * Whose ticket it is: the person who made or pulled it, until they hand it over. Only the owner's squad works on
   * it, on the owner's computer, so two squads never build the same ticket (ADR-001).
   */
  owner?: string;
  /** The last hand over. The new owner's squad carries on from the pushed branch, not from the chats. */
  handedOver?: HandOver;
  /** The step running now: who, since when, and what it does. Shown on the card and the Now tab. */
  clock?: StepClock;
  /** How long the ticket spent in each stage, for the tracker under its title. */
  stageTimes?: StageTimes;
  /** "Stop and try again": once the running step has stopped, it starts again at once. */
  retryOnStop?: boolean;
  /** Archived: a merged or released ticket off the board. Its history stays in git and in `.squad/`. */
  archived?: { by: string; at: string };
  /** Delete was pressed. Kept until the last part of the ticket is gone, so a delete cut off half-way can finish. */
  deleting?: Deleting;
  /** Open tickets whose code this one needs, as its design names them ("depends on RO-1"). */
  dependsOn?: string[];
  /** How the person chose to build while one of them was not merged. */
  dependency?: DependencyChoice;
  /** "Bring in latest main" was pressed while a step ran: the base comes into the copy before the next checks. */
  baseWanted?: { by: string; at: string };
  /** Someone else's ticket, last seen on the remote here ("origin/squad/ro-5"): proof it came from there. */
  seenOn?: string;
  /** Its owner deleted it on their computer, and the remote shows it: Remove from my board cleans this computer only. */
  ownerDeleted?: OwnerDeleted;
}

/**
 * The app's port, while a step that needs the app looks stuck: something listens on it and the app does not answer.
 * `ours` when squad-kit started that program (one of this project's apps, or a copy it ran for a check), so squad-kit
 * may stop it; a program of the person's own is never stopped.
 */
export interface QuietPort {
  port: number;
  pid?: number;
  program?: string;
  ours: boolean;
  /** The project's app it is, when it is one squad-kit runs from Your apps. */
  app?: string;
}

/** How this board knows the owner deleted a ticket: their delete's note on its branch, or its branch gone unmerged. */
export interface OwnerDeleted {
  by: string;
  at: string;
  how: 'note' | 'gone';
  /** The branch it was on, as this computer saw it. */
  branch: string;
}

/** A delete in progress: nothing starts on the ticket again, and what runs stops. */
export interface Deleting {
  at: string;
  by: string;
  /** Also delete the pushed branch on the remote. */
  remote?: boolean;
  remoteDone?: boolean;
  /** A squad in another window stopped its runs on the ticket, so the delete may go on. */
  stopped?: string;
  /** Why the last try stopped half-way. */
  error?: string;
}

/** A deleted ticket, on this computer: its cost stays in Usage, and its pushed branch does not bring it back. */
export interface DeletedTicket {
  id: string;
  title: string;
  at: string;
  by: string;
  usage?: UsageLine[];
  /** Removed from this board after its owner deleted it: if it is pushed again, it comes back. */
  fromBoard?: boolean;
}

/** The kinds of step squad-kit times. Each has a usual time, learned from the project's own history. */
export type TimedStep = 'questions' | 'spec' | 'design' | 'build' | 'fix' | 'checks' | 'review' | 'proof';

/**
 * The step running now. The Builder's clock runs per plan step (`part`, from 1), the others per run. When a step ends
 * well its time joins the project's usual times, kept on this computer.
 */
export interface StepClock {
  /** The agent working, or squad-kit itself for the checks. */
  who: AgentName | 'squad';
  step: TimedStep;
  since: string;
  part?: number;
  /** The latest action, in plain words, and when it happened: the step's last progress. */
  doing?: string;
  doingAt?: string;
  /** The hard limit of the run, in minutes: squad-kit stops the step there and keeps the work. */
  limit?: number;
  /** When the whole step began. `since` starts again with each of the Builder's plan steps. */
  began?: string;
}

/** A step that ended well, kept on the ticket for "What happened" and the time each ticket took. */
export interface StepRun {
  who: AgentName | 'squad';
  step: TimedStep;
  from: string;
  to: string;
}

/** The stage the ticket is in since when, and the seconds it spent in each stage before. */
export interface StageTimes {
  stage: Stage;
  since: string;
  spent: Partial<Record<Stage, number>>;
}

export interface HandOver {
  from: string;
  to: string;
  at: string;
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
  /**
   * Repos whose push failed: the release commit and tag are made, but only on this computer. The release stays open
   * (its tickets are not closed) until Push again sends them.
   */
  unpushed?: UnpushedRelease[];
  /**
   * Tickets taken out before the release was made. Their code stays in the base; the release leaves it out (its tag
   * does not have it), and they go out with the next release.
   */
  out?: string[];
}

export interface UnpushedRelease {
  /** The repo's folder in the project, '.' for the project itself. */
  repo: string;
  remote: string;
  base: string;
  /** The release commit, pushed to the remote's base branch. */
  commit: string;
  /** The tag to push with it, when the release tags. */
  tag?: string;
  error: string;
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
  /** Found in the code by the first read and not approved by the person yet: a proposal, not a rule. */
  proposed?: boolean;
}

export interface Lesson {
  id: string;
  text: string;
  from: string;
  date: string;
}

/** A technology the code uses, as the Architect explains it. */
export interface StackNote {
  name: string;
  why: string;
  decision?: string;
  /** Set when the Architect found it in the code itself, not in a package file, so the page knows where it goes. */
  role?: TechRole;
}

/** What a technology does in the project, for grouping on the architecture page. */
export const TECH_ROLES = ['Language', 'Framework', 'Interface', 'Data', 'Testing', 'Tooling', 'Services'] as const;
export type TechRole = (typeof TECH_ROLES)[number];

/** A design pattern the code follows, where it is used, and the decision it comes from. */
export interface PatternNote {
  name: string;
  what: string;
  where: string[];
  decision?: string;
}

/** The Architect's draft decision for a technology already in the code. The person approves or discards it. */
export interface TechDraft {
  tech: string;
  status: 'writing' | 'ready' | 'failed';
  error?: string;
  decision?: { title: string; area: DecisionArea; options: string[]; chosen: string; why: string; buildsOn: string[] };
}

export interface Blueprint {
  status: 'pending' | 'running' | 'done' | 'failed';
  at?: string;
  /** Each repo's base commit when the code was read, by repo path. A merge compares against it. */
  commits?: Record<string, string>;
  error?: string;
  stack: StackNote[];
  patterns: PatternNote[];
}

/** A change to the test command, from the Architect's design. Only the person can make it (squad test-command). */
export interface TestChange {
  from: string;
  to: string;
  /** The code repo whose command it is, in a workspace with several. */
  repo?: string;
  at: string;
}

/** How strong the squad's models are, for the whole project. */
export type Quality = 'best' | 'balanced' | 'thrifty';

/** How the person pays for the AI: a subscription with usage limits, or per use with an API key or a cloud account. */
export type Payment = 'subscription' | 'api-key';

/** Spending limits in US dollars, for a person who pays per use. Kept for this project on this computer. */
export interface Budget {
  ticketUsd?: number;
  monthUsd?: number;
}

export interface BoardMeta {
  /** Links the project's files to this computer's files for it (ADR-001). */
  id?: string;
  /** The shape of the project's files: 2 is the split of ADR-001. */
  layout?: number;
  /** One-repo projects: commit the project's documents on each ticket's branch (on by default). */
  documentsInGit?: boolean;
  /** The Quality setting: the levels each role starts from. Left out means best. */
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
  /** The person chose to go on without tests in this project: the checks show "Not checked", and squad-kit asks once. */
  noTests?: { by: string; at: string; ticket: string };
  git?: { base: string; remote: string };
  scan?: { status: 'pending' | 'running' | 'done' | 'failed'; at?: string; error?: string; summary?: string; empty?: boolean; now?: string };
  /** The project's first run, step by step, on this computer (src/board/setup-state.ts). */
  setup?: SetupState;
  /** What the Architect last read from the code: why each technology is there, and the design patterns it follows. */
  blueprint?: Blueprint;
  /** Decisions the Architect is writing, or has written, for technologies that were picked without one. */
  techDrafts?: TechDraft[];
  /** Each approved decision is checked against the tickets planned before it. */
  impactChecks?: ImpactCheck[];
  /** How many tickets this board ran at once before the one app; the app's shared limit in ~/.squad-kit/settings.yaml wins. */
  parallel?: number;
  /** How squad-kit talks to Claude: through the Agent Client Protocol (default), or by running Claude Code directly. */
  runner?: 'acp' | 'direct';
  /** Hosts the Builder's and Tester's commands may reach besides the package registries, such as a private package server. */
  allowedHosts?: string[];
  /** What the squad used on the project's own work, with no ticket: reading the project, filling in new tickets. */
  usage?: UsageLine[];
  /** Tickets deleted on this computer, with what they used. */
  deleted?: DeletedTicket[];
  /** Spending limits, used when the person pays per use. */
  budget?: Budget;
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

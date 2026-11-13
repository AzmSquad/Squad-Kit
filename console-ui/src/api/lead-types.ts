import type { SplitSuggestion, WaitingKind } from './types';

// The Squad lead (GET /api/v1/lead and the calls under it). Mirrors src/engine/lead/types.ts on the server.

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
  /** The main button's words, naming what it does: "Create story", "Take the pictures again", "Send", "Save". */
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
  /** Answered by squad-kit itself, with no AI: a saved note, the story's live record, a refusal, the day's limit, small talk. */
  by?: 'note' | 'record' | 'refusal' | 'limit' | 'check' | 'board';
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

/** "What's new": a released story with news, never counted in what needs you. */
export interface NewsItem {
  id: string;
  story: string;
  title: string;
  /** "MA-3 is released in v0.2.0. ADR-011 came after its plan." */
  words: string;
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
  /** What needs a press from you: the open stories, as the board counts them. */
  needsYou: NeedsYouItem[];
  whatsNew?: NewsItem[];
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

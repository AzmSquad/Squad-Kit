import type { ProofKind, SplitSuggestion, WaitingKind } from '../../board/types.js';

/**
 * The Squad lead: one contact for the whole project. It reads, looks and tells on its own; it drafts the rest as
 * cards the person presses; and some things it never does, whatever anyone asks. These are the shapes the engine,
 * the REST API, the terminal and the board share.
 */

export type { ProofKind };

/** Where the person asked from. The engine fills in the facts of a story or a problem itself. */
export type LeadContext =
  | { from: 'board'; page?: string }
  | { from: 'app'; path: string; app?: string }
  | { from: 'story'; story: string }
  | { from: 'problem'; problem: LeadProblem; story?: string; error?: string };

/** The card the person pressed "Ask the lead" on: taking longer, looks stuck, waiting for you, or an error page. */
export type LeadProblem = 'slow' | 'stuck' | 'waiting' | 'error';


/** One line of the work trace, in plain words: "Read MA-12 "Owner cancels a booking"", "Looked at /my-bookings in its own copy". */
export interface LeadStep {
  at: string;
  text: string;
  kind: 'notes' | 'board' | 'story' | 'code' | 'app' | 'guide' | 'log' | 'refused' | 'card';
}

/**
 * A picture in an answer, with what it shows, served at `url` like the proof pictures: one the lead took in its own copy,
 * or one of a story's own proof pictures, the same the board shows on that story.
 */
export interface LeadEvidence {
  file: string;
  caption: string;
  url: string;
  /** The story whose proof it is from. Left out for a picture the lead took. */
  story?: string;
}

/** Where an answer comes from: a story, a decision, a file and line, a release, a saved note, the guide, a log. */
export interface LeadSource {
  kind: 'story' | 'decision' | 'file' | 'release' | 'note' | 'guide' | 'log';
  ref: string;
  label?: string;
}

/** The board actions a card can run, each through the same function as the board's own button. */
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

/** The part of a story an Open card shows: its proof, its spec, its plan or its questions. */
export type StoryTab = 'proof' | 'spec' | 'plan' | 'questions';

/** The low-risk actions "Always allow" may cover. Nothing else ever runs without a press. */
export type Allowable = Extract<LeadAction, 'more_time' | 'pictures_again' | 'start_app' | 'morning_brief'>;

export interface DoneWhen {
  text: string;
  proof: ProofKind;
}

interface CardBase {
  /** `<conversation>.<n>`, or `now.<story>.<action>` for a card on the "Needs you" rail. */
  id: string;
  /** 1: on its own (it only writes text or opens a page). 2: needs the person's OK. */
  level: 1 | 2;
  /** The words on its main button, naming what it does: "Create story", "Take the pictures again", "Send". */
  label: string;
  /** Why the lead offers it, one plain line. */
  why?: string;
  /** The same press from the terminal. */
  command: string;
  status: 'open' | 'done' | 'failed' | 'dismissed';
  /** What it did, once pressed, or why it did not. */
  result?: string;
  /** It ran by itself because "Always allow" is on for it, and the line that says so. */
  byItself?: string;
  /** "Always allow" can be pressed on it. */
  allowAlways?: boolean;
  /** It came from what the lead read, not from the person's own message, so it always asks first. */
  asksFirst?: boolean;
}

export type LeadCard =
  /**
   * A story from the conversation. `split`: the person's text is more than one story, by squad-kit's own count or the
   * lead's: Create N stories, or Send to Requirements for a whole document, or one story anyway. `stories`: what it made.
   */
  | (CardBase & { kind: 'draft_story'; title: string; ask: string; storyKind: 'feature' | 'bug'; doneWhen: DoneWhen[]; warnings: string[]; story?: string; split?: SplitSuggestion; stories?: string[]; breakdown?: string })
  /**
   * A whole requirements document pasted to the lead: squad-kit's own count says so, with no AI. Send to Requirements.
   * `lang`: the language it was written in, for the card's words.
   */
  | (CardBase & { kind: 'requirements'; found: string[]; lang: 'en' | 'ar'; breakdown?: string })
  | (CardBase & { kind: 'board_action'; action: LeadAction; story?: string; minutes?: number; app?: string; tool?: string })
  | (CardBase & { kind: 'send_answer'; story: string; text: string })
  | (CardBase & { kind: 'settings_change'; setting: string; value: string; technical: boolean })
  | (CardBase & { kind: 'engineer_report'; report?: string })
  /** Opens a story on the board, at its tab: `open` is the board's own place, "/tickets/MA-7/proof". It changes nothing. */
  | (CardBase & { kind: 'open_story'; story: string; tab?: StoryTab; open: string })
  /**
   * A story that waits on the person, brought into the chat: the board shows it there from its live data, with the
   * board's own buttons. The lead brings it; only the person presses it, and the press is checked again against `key`,
   * the mark of what waited when the card was made (board/wait-key.ts). The card itself changes nothing.
   */
  | (CardBase & { kind: 'decide'; story: string; wait: WaitingKind; key: string; open: string });

/** The lead's answer, as the engine checked and cleaned it. */
export interface LeadAnswer {
  headline: string;
  body: string;
  evidence: LeadEvidence[];
  sources: LeadSource[];
  cards: LeadCard[];
  /** A short note worth keeping, saved in squad-kit's notes for the next person. */
  learned?: string;
  /**
   * Answered by squad-kit itself, with no AI: from a saved note, the story's live record, a refusal, the day's limit,
   * its own count of a pasted document, or the board's own numbers (a greeting or other small talk).
   */
  by?: 'note' | 'record' | 'refusal' | 'limit' | 'check' | 'board';
}

/** One question and its answer. */
export interface LeadTurn {
  n: number;
  ask: { text: string; at: string; context: LeadContext; facts?: string[] };
  answer?: LeadAnswer;
  trace: LeadStep[];
  /** What the engine refused, in its exact words. */
  refused: string[];
  seconds?: number;
  costUsd?: number;
  /** Why no answer came, in plain words. */
  error?: string;
  /** The model it ran on, for the cost line: "Sonnet (balanced, medium effort)". */
  model?: string;
  /** While it answers: its words so far, as they come from the AI tool. Gone once the answer is in. */
  draft?: { headline?: string; body?: string };
}

/** One conversation, one file under squad-kit's own folder for the project. */
export interface LeadConversation {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  /** Where it was first asked from. */
  context: LeadContext;
  turns: LeadTurn[];
  /** An answer is being written now. */
  thinking?: boolean;
  /** The AI tool's own conversation, so a follow-up carries on in it. */
  session?: string;
  /** The story a card made from this conversation. */
  story?: string;
}

/** A conversation in the list: no turns. */
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

/** One thing that needs the person, with the lead's check-in words, made from the board's data with no AI. */
export interface NeedsYouItem {
  id: string;
  story: string;
  title: string;
  kind: 'proof' | 'spec' | 'plan' | 'questions' | 'ask' | 'stuck' | 'slow' | 'looks-stuck' | 'release' | 'split' | 'other';
  /** The check-in: "MA-7 is ready for your check: 5 pictures, checks pass, Reviewer approved". */
  words: string;
  /** A second short line, when there is one. */
  more?: string;
  /** Low risk, so "Always allow" can cover it. */
  lowRisk?: boolean;
  cards: LeadCard[];
  /** Where on the board it opens. */
  open: string;
}

/** "What's new": a released story with news, never counted in what needs the person. */
export interface NewsItem {
  id: string;
  story: string;
  title: string;
  /** "MA-3 is released in v0.2.0. ADR-011 came after its plan." */
  words: string;
  /** Where on the board it opens. */
  open: string;
}

/** One agent at work now, for "The squad now". */
export interface SquadNowItem {
  story: string;
  title: string;
  who: string;
  /** "fixing a failed test". */
  doing: string;
  /** 0 to 1, from the step's part or its usual time; left out when unknown. */
  progress?: number;
  slow?: boolean;
}

/** The morning brief: since yesterday, from the board's data, no AI. */
export interface MorningBrief {
  since: string;
  headline: string;
  merged: string[];
  released: string[];
  working: string[];
  stopped: string[];
  waiting: number;
  /** What the AI used since then, at API prices; left out when unknown. */
  costUsd?: number;
}

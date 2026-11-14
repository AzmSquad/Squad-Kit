/**
 * The board's view of squad-kit's own code as a contribution, and of the outside tools' sign-ins: the shapes of
 * GET /contribute, /contribute/journey, /tickets/:id/pull-request and /connections (src/engine/contribution,
 * src/engine/connections.ts).
 */

export interface Words {
  en: string;
  ar: string;
}

/* ── The contribution checklist ─────────────────────────── */

export interface ChecklistAction {
  id: 'fork' | 'sync' | 'idea';
  name: string;
  route: string;
  command: string;
}

export interface ChecklistItem {
  id: 'sign-in' | 'copy' | 'up-to-date' | 'rules' | 'idea';
  title: string;
  state: 'done' | 'todo' | 'blocked' | 'info';
  line: string;
  steps?: string[];
  points?: string[];
  link?: string;
  file?: string;
  account?: string;
  count?: number;
  action?: ChecklistAction;
}

export interface Checklist {
  self: boolean;
  line: string;
  host?: string;
  main?: string;
  copy?: string;
  items: ChecklistItem[];
  /** Nothing left before the first story: the person can write their idea. */
  ready: boolean;
  /** How many items still come before it. */
  left: number;
}

export interface Journey {
  self: boolean;
  /** 0 to 5, or 6 once the owner merged it. */
  at: number;
  steps: string[];
  ticket?: string;
  /** The owner closed its pull request without merging. */
  closed?: true;
  line: string;
}

/* ── A story's pull request in someone else's repo ──────── */

export interface OwnerNote {
  id: string;
  kind: 'line' | 'review' | 'comment';
  who: string;
  text: string;
  file?: string;
  line?: number;
  url: string;
  at: string;
  changes?: boolean;
  state: 'new' | 'fixing' | 'fixed' | 'left';
  fixedIn?: string;
  answered?: boolean;
  /** The pull request it was written on: an old one's notes stay out of the new one's card. */
  pr?: number;
  /** Left: why squad-kit did not answer it. */
  why?: string;
}

export interface TrackStep {
  id: 'looks-right' | 'pushed' | 'opened' | 'review' | 'merged';
  state: 'done' | 'now' | 'later' | 'closed';
  at?: string;
}

export interface PullRequestView {
  ticket: string;
  pr?: { id: number; url: string; host: string; repo: string };
  to: 'own' | 'owner' | 'none';
  into?: string;
  base?: string;
  state: 'none' | 'open' | 'merged' | 'waiting' | 'notes' | 'fixing' | 'closed';
  line: string;
  notes: OwnerNote[];
  lookedAt?: string;
  since?: string;
  actions: { id: 'fix' | 'leave' | 'check' | 'send-again' | 'leave-closed'; name: string; command: string }[];
  track: { steps: TrackStep[]; copy?: string; branch?: string; host?: string; catchUp?: string } | null;
}

/** The part of a ticket the board reads to know it went to someone else's repo. */
export interface SentTicket {
  contribution?: { state: 'waiting' | 'notes' | 'fixing' | 'merged' | 'closed'; into: string; lookedAt?: string; notes?: { state: string }[] };
}

/* ── Connections ───────────────────────────────────────── */

export interface GuideStep {
  text: Words;
  command?: string;
  done?: Words;
  page?: string;
  link?: string;
}

export interface SignInFlow {
  state: 'waiting' | 'done' | 'failed' | 'cancelled' | 'none';
  code?: string;
  url?: string;
  startedAt?: string;
  line?: string;
  account?: string;
}

/** The page the code is typed on, when it is not the tool's own. */
export interface CodePage {
  name: string;
  then: Words;
  foot: Words;
}

export interface ConnectionRow {
  name: string;
  label: string;
  what: Words;
  how: 'sign-in' | 'token' | 'soon';
  can: Words[];
  next?: Words;
  /** A sign-in that also takes a token instead: that token goes in Settings. */
  tracker?: string;
  codePage?: CodePage;
  /** squad-kit's own sign-in: Disconnect signs only squad-kit out. */
  ownSignIn?: boolean;
  state: 'connected' | 'not-connected' | 'missing' | 'unknown' | 'soon';
  account?: string;
  steps: GuideStep[];
  /** 'token': the token in Settings is the way here. */
  by?: 'token';
  line?: Words;
  for?: { repo: string; into?: string; self: boolean };
  flow?: SignInFlow;
  actions: { id: 'sign-in' | 'disconnect' | 'check'; name: string; command: string }[];
}

import { PROJECT } from '../api/client';
import type { AgentName, Ticket } from '../api/types';
import { isApiProof } from './verdict';

/**
 * Decision cards in a chat: a story that waits on the person, shown where they talk, with the board's own buttons. The
 * card is worked out from the story as the board has it now, never from words saved in the chat; a press runs the
 * board's own action, checked again against the mark of what waited (`waitKey`). No React here, so each rule is tested
 * on its own.
 */

/** What the card asks: Looks right on a proof, Approve on a spec, a plan or a design, answers, or only Open. */
export type DecideKind = 'proof' | 'spec' | 'plan' | 'design' | 'questions' | 'ask' | 'split' | 'open';

/** The kind of card for what the story waits on now, or null when it waits for nothing a card can show. */
export function decideKind(t: Ticket): DecideKind | null {
  const w = t.waiting?.kind;
  if (!w || t.now?.merging) return null;
  switch (w) {
    case 'proof':
      return 'proof';
    case 'spec':
      return 'spec';
    case 'plan':
      return t.specApproved ? 'design' : 'plan';
    case 'questions':
      return (t.questions ?? []).some((q) => !q.answer) ? 'questions' : 'open';
    case 'ask': {
      // A busy port or a stop of a story that builds by itself has its own card on the board.
      const q = t.agentQuestion;
      return q && !q.port && !q.kind ? 'ask' : 'open';
    }
    // Too big for one story: the Analyst's suggestion, with its own card (components/split).
    case 'split':
      return t.split?.suggestion ? 'split' : 'open';
    // The talk itself waits for the person: the talk is the place.
    case 'chat':
      return null;
    default:
      return 'open';
  }
}

/** Where a card stands: live with its buttons, already decided, changed since it was made, or gone from the board. */
export type CardState = 'live' | 'decided' | 'changed' | 'gone';

/** `made` is the mark the lead's card was made with; a story's own talk shows the story as it is, so it has none. */
export function cardState(t: Ticket | undefined, made?: string): CardState {
  if (!t) return 'gone';
  if (!t.waiting || t.now?.merging) return 'decided';
  if (!made || !t.waitKey || made === t.waitKey) return 'live';
  // It waits on something else now (the spec was approved, now its proof waits): what the card showed was decided.
  return made.split(':')[0] === t.waitKey.split(':')[0] ? 'changed' : 'decided';
}

/** One proof picture on the card: the main "after" picture of each "done when" that has one. */
export interface Shot {
  file: string;
  label: string;
}

export function proofShots(t: Ticket): Shot[] {
  return (t.proof ?? []).filter((p) => p.after && !isApiProof(p.after)).map((p) => ({ file: p.after, label: p.criterion }));
}

/** Never blind: the thing to look at is there, so Looks right or Approve may show. */
export function seeable(t: Ticket, kind: DecideKind): boolean {
  switch (kind) {
    case 'proof':
      return proofShots(t).length > 0 || (t.proof ?? []).some((p) => p.after);
    case 'spec':
      return Boolean(t.story?.trim() || t.criteria?.length);
    case 'plan':
    case 'design':
      return Boolean(t.steps?.length || t.decision);
    case 'questions':
      return (t.questions ?? []).some((q) => !q.answer);
    case 'ask':
      return Boolean(t.agentQuestion?.text.trim());
    case 'split':
      return Boolean(t.split?.suggestion);
    default:
      return true;
  }
}

/** The small words at the top right of the card. */
export function whoFor(t: Ticket, kind: DecideKind): string {
  switch (kind) {
    case 'proof':
      return 'Proof for you';
    case 'spec':
      return 'Spec for you';
    case 'plan':
      return 'Plan for you';
    case 'design':
      return 'Design for you';
    case 'questions':
      return 'Questions for you';
    case 'ask':
      return `${agentName(t.agentQuestion?.from ?? 'builder')} asks you`;
    case 'split':
      return 'Suggestion for you';
    default:
      return 'Waits for you';
  }
}

export function agentName(a: AgentName): string {
  return { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' }[a];
}

/**
 * The agent of a story's head and popup when it has no talk: the one its wait is with, the person would talk to about
 * it, or the one at work on it now.
 */
export function agentFor(t: Ticket): AgentName {
  if (t.chat) return t.chat.with;
  const working = t.clock?.who;
  if (!t.waiting && working && working !== 'squad') return working;
  switch (t.waiting?.kind) {
    case 'proof':
      return 'tester';
    case 'plan':
      return 'architect';
    case 'ask':
      return t.agentQuestion?.from ?? 'builder';
    case 'stuck':
      return 'builder';
    default:
      return 'analyst';
  }
}

/** Who a "Something's wrong" or "Ask for changes" goes to, as the board sends it. */
export function changeTo(kind: DecideKind): string {
  return kind === 'proof' ? 'Builder' : kind === 'spec' ? 'Analyst' : kind === 'design' ? 'Architect' : 'Spec writer';
}

/** The main button's words. */
export function yesLabel(kind: DecideKind): string {
  return kind === 'proof' ? 'Looks right' : kind === 'spec' ? 'Approve spec' : kind === 'design' ? 'Approve design' : kind === 'plan' ? 'Approve plan' : 'Open';
}

/** The line under the buttons: who brought the card, or what the press starts. */
export function footnote(kind: DecideKind, fromLead: boolean): string {
  if (fromLead) return 'The lead brings this card. Only you can press it.';
  return kind === 'proof' ? 'It is accepted for the next release after your OK.' : kind === 'spec' ? 'The Architect designs it after your OK.' : 'Building starts after your OK.';
}

/**
 * The real outcome of a press, from the story the board sent back: "You pressed Looks right. MA-17 is accepted." It
 * says what happened, not what was hoped for.
 */
export function outcome(kind: DecideKind, id: string, after: Partial<Ticket> | null, what: 'yes' | 'change' | 'answers' | { answer: string }): string {
  if (what === 'change') return `You sent it back with your note. The ${changeTo(kind)} works on it now.`;
  if (what === 'answers') return `You sent your answers. ${after?.status ? `${id}: ${after.status}.` : 'The squad carries on.'}`;
  if (typeof what === 'object') return `You answered “${what.answer}”. ${after?.status ? `${id}: ${after.status}.` : 'The squad carries on.'}`;
  switch (kind) {
    case 'proof':
      if (after?.mergedAt || after?.stage === 'release') return `You pressed Looks right. ${id} is accepted${after.mergedAt ? ' and merged' : ''}, ready for the next release.`;
      if (after?.live) return 'You pressed Looks right. Newer work changed the same code, so the Builder brings it in first. Then the proof comes back to you.';
      return `You pressed Looks right. ${id}: ${after?.status ?? 'saved'}.`;
    case 'spec':
      return 'You approved the spec. The Architect is designing how to build it.';
    case 'design':
      return 'You approved the design. Building starts now.';
    default:
      return 'You approved the plan. The Builder started.';
  }
}

/* ── Presses already made here ─────────────────────────── */

/** What the person pressed on a card, so it stays green with its outcome after the story moved on. */
export interface Pressed {
  words: string;
  at: string;
  /** What the card showed when pressed, so it still shows it, green, after the story moved on. */
  kind?: DecideKind;
  /** The mark of what waited when it was pressed. */
  key?: string;
}

const KEY = `sk.pressed.${PROJECT ?? 'local'}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** One card's press, by its story and the mark of what waited. */
export function pressedKey(story: string, key: string | undefined): string {
  return `${story}|${key ?? ''}`;
}

export function readPressed(): Record<string, Pressed> {
  try {
    return JSON.parse(storage()?.getItem(KEY) ?? '{}') as Record<string, Pressed>;
  } catch {
    return {};
  }
}

/**
 * The press a card shows, green, or null for the story as it is now. The lead's card (`made`) keeps its press. A
 * story's own talk shows the next thing to decide as soon as the story waits on something new: a press covers only
 * the wait it was made on. `mine` was pressed in this card, `kept` is the one saved for what it showed, `latest` the
 * newest press on the story here.
 */
export function pressShown(o: { mine: Pressed | null; kept: Pressed | null; latest: Pressed | null; made?: string; state: CardState; waitKey?: string }): Pressed | null {
  const still = (p: Pressed | null) => (p && (o.made || o.state !== 'live' || !o.waitKey || !p.key || p.key === o.waitKey) ? p : null);
  return still(o.mine) ?? still(o.kept) ?? (!o.made && o.state !== 'live' ? o.latest : null);
}

/** The newest press on a card of this story here in the last half hour: its talk keeps the green card. */
export function latestPress(story: string, now = Date.now()): Pressed | null {
  const mine = Object.entries(readPressed()).filter(([k, p]) => k.startsWith(`${story}|`) && now - Date.parse(p.at) < 30 * 60_000);
  return mine.sort((a, b) => b[1].at.localeCompare(a[1].at))[0]?.[1] ?? null;
}

export function pressedLately(story: string, now = Date.now()): boolean {
  return latestPress(story, now) !== null;
}

/** Keeps the newest 40 presses: enough for every card still in a chat. */
export function savePressed(k: string, words: string, kind?: DecideKind, key?: string): Record<string, Pressed> {
  const all = { ...readPressed(), [k]: { words, at: new Date().toISOString(), ...(kind ? { kind } : {}), ...(key ? { key } : {}) } };
  const kept = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 40));
  try {
    storage()?.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Private windows can refuse storage; the card then shows the story as the board has it.
  }
  return kept;
}

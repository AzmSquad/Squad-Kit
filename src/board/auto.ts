import { addActivity, now, readMeta, readTicket, requireTicket, updateTicket, type BoardPaths } from './store.js';
import type { AgentQuestion, Ticket } from './types.js';
import type { Decided, DecidedBy } from './requirements-types.js';
import { BoardActionError, acceptInTurn, holdingSave, CHECKOUT_WAITS, acceptProof, changeAfterRelease, openChange, proposeChange, saveBeforeAccept, shipped } from './actions.js';
import { isMerged, refuseBeforeDependency } from './depends.js';
import { scheduleSquad } from './schedule.js';
import { saysTheSame } from './same-words.js';
import { bringInAgain } from './bring-in.js';

/**
 * Builds by itself (the 'auto' track): a story from an approved breakdown. Its story and done-when were approved with
 * the breakdown, so there is no questions step; the plan is approved on its own; the agents decide small things
 * themselves and log each one in "Decided for you"; and once the checks, the review and the proof pass, the squad
 * accepts and merges it itself. It stops only for a critical gap, a clash, or what stops any ticket (a check that
 * cannot be fixed, a cap, a budget). Releasing stays the person's. Both squads, the board and the terminal use this.
 */

/** The track's name on screen. */
export const BUILDS_BY_ITSELF = 'Builds by itself';

/** The intake line: no questions step. */
export const NO_QUESTIONS = 'Builds by itself: no questions, the story was approved with the breakdown';

/** The card's line while the plan approves itself. */
export const APPROVING = 'Builds by itself: approving the plan';

/** The card's line while the squad accepts it. */
export const ACCEPTING = 'Accepting it by itself';

/** A clash at the merge brings in the newest code by itself, on every track (board/bring-in.ts). */
export { MAX_BASE_TRIES, MAX_LANDING_WAIT_MS, bringInAgain, landingFirst, waitForLanding } from './bring-in.js';

/** The tracks where the squad accepts and merges by itself, with no Looks right to wait for. */
export function mergesByItself(t: Pick<Ticket, 'track'>): boolean {
  return t.track === 'auto';
}

/** A pull request that needs a person to approve it: a normal wait, not a failure. */
export const PR_WAITS = 'Waits for someone to approve the pull request';

/**
 * Accepted, but its change is not in the base yet and nothing runs for it: the merge could not move the person's own
 * checkout of the base ('checkout', on every track), or on this track its pull request waits for a person to approve
 * it ('pr'). The live squad looks again on a timer (engine/sync.ts recheckMerge). Meanwhile it holds no building place,
 * and its story shows as needing someone.
 */
export function mergeWait(t: Ticket | undefined | null): 'pr' | 'checkout' | null {
  if (!t || t.stage !== 'release' || isMerged(t) || t.squad || t.waiting || t.live || t.deleting || t.archived) return null;
  if (t.pr) return t.track === 'auto' ? 'pr' : null;
  return t.branch ? 'checkout' : null;
}

/** The words for a merge wait, on the story and the card. */
export function mergeWaitWords(wait: 'pr' | 'checkout'): string {
  return wait === 'pr' ? PR_WAITS : CHECKOUT_WAITS;
}

/** The same entry, word for word in any language (case and marks aside), or in other words. */
function sameDecided(a: string, b: string): boolean {
  const plain = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return plain(a) === plain(b) || saysTheSame(a, b);
}

/** How an agent marks the option it suggests, at the end of the option's words: "… (suggested)". */
export { SUGGESTED } from '../engine/auto-prompts.js';

/** The three stops, as the board names them. */
export const STOP_WORDS = { gap: 'Missing in the BRD', clash: 'Two parts clash', check: 'A check failed' } as const;

export type StopKind = 'gap' | 'clash' | 'check' | 'other';

/** At most this many entries from one answer of one agent. */
export const MAX_DECIDED = 6;

/**
 * The card's line and the Waiting for you summary when an agent asks: "Needs you: two parts clash" and "Two parts
 * clash" for a stop on this track, else the usual words.
 */
export function askWords(who: string, kind?: 'gap' | 'clash'): { status: string; summary: string } {
  if (kind) return { status: `Needs you: ${STOP_WORDS[kind].charAt(0).toLowerCase()}${STOP_WORDS[kind].slice(1)}`, summary: STOP_WORDS[kind] };
  return { status: `${who} has a question for you`, summary: `The ${who} needs an answer to carry on` };
}

/** At most this many sources on one stop. */
const MAX_SOURCES = 4;

/**
 * Where a gap or a clash comes from, as an agent gave it: at most 4, each with its words and, when it said so, its
 * ticket (RO-12), section (4.2) and page. Anything else it wrote is left out.
 */
export function cleanSources(raw: unknown): NonNullable<AgentQuestion['sources']> {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<AgentQuestion['sources']> = [];
  for (const r of raw) {
    if (out.length >= MAX_SOURCES) break;
    const o = (r ?? {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    if (!text) continue;
    const ticket = typeof o.ticket === 'string' ? o.ticket.trim().toUpperCase() : '';
    const section = typeof o.section === 'string' || typeof o.section === 'number' ? String(o.section).trim().slice(0, 40) : '';
    const page = Number(o.page);
    out.push({
      text,
      ...(/^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/.test(ticket) ? { ticket } : {}),
      ...(section ? { section } : {}),
      ...(Number.isInteger(page) && page > 0 ? { page } : {}),
    });
  }
  return out;
}

/** The kind of stop a waiting ticket is at, for the tags: a gap, a clash, a check that failed, or something else. */
export function stopOf(t: Ticket): StopKind | undefined {
  if (!t.waiting) return undefined;
  if (t.waiting.kind === 'ask' && t.agentQuestion?.kind) return t.agentQuestion.kind;
  const gate = t.waiting.kind === 'stuck' ? t.stuck?.gate : undefined;
  if (gate === 'checks' || gate === 'review' || gate === 'proof') return 'check';
  return 'other';
}

/**
 * Saves the small choices an agent made instead of asking on a Builds by itself ticket: each gets its own id (d1,
 * d2 …), the role, the time and the story it is about, with a line in the activity. One that says the same as an
 * entry the ticket has already, even in other words (board/same-words.ts), is not added again: a second review
 * round often writes the first one's choices once more. Other tracks keep nothing. Changes `t` in place (inside an
 * update) and returns what it added.
 */
export function addDecided(t: Ticket, by: DecidedBy, texts: unknown): Decided[] {
  if (t.track !== 'auto' || !Array.isArray(texts)) return [];
  const list = t.decided ?? [];
  const seen = list.map((d) => d.text);
  let n = list.reduce((m, d) => Math.max(m, Number(/^d(\d+)$/.exec(d.id)?.[1] ?? 0)), 0);
  const added: Decided[] = [];
  for (const raw of texts.slice(0, MAX_DECIDED)) {
    const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!text || seen.some((d) => sameDecided(d, text))) continue;
    seen.push(text);
    n += 1;
    added.push({ id: `d${n}`, text, by, at: now(), ...(t.breakdown ? { item: t.breakdown.item } : {}), ticket: t.id });
  }
  if (!added.length) return added;
  t.decided = [...list, ...added];
  for (const d of added) addActivity(t, by === 'answer' ? 'squad' : by, `Decided for you (${d.id}): ${d.text}`);
  return added;
}

/**
 * Changes a "Decided for you" entry. Not accepted yet: it becomes a small change on the same ticket, through the usual
 * change flow (the Analyst writes it into the spec, the person approves it, the Builder makes it). Accepted or
 * released: it becomes a new ticket linked to this one. The entry keeps what the person wants instead and what it
 * became (the change, like c2, or the new ticket). Returns the ticket the entry is on.
 */
export function changeDecided(bp: BoardPaths, id: string, decidedId: string, text: string): Ticket {
  const want = text?.trim();
  if (!want) throw new BoardActionError('Say what it should be instead.');
  const t0 = requireTicket(bp, id);
  const key = decidedId?.trim().toLowerCase();
  const d = t0.decided?.find((x) => x.id === key);
  if (!d) throw new BoardActionError(`${t0.id} has nothing decided for you as ${decidedId}.${t0.decided?.length ? ` It has ${t0.decided.map((x) => x.id).join(', ')}.` : ''}`);
  const meta = readMeta(bp);
  let became: string;
  if (shipped(t0)) {
    became = changeAfterRelease(bp, t0.id, `${want}\n\nInstead of "${d.text}", which the squad decided on ${t0.id}.`, 'ticket').id;
  } else {
    became = openChange(proposeChange(bp, t0.id, `Instead of "${d.text}" (decided for you): ${want}`))!.id;
  }
  return updateTicket(bp, t0.id, (t) => {
    const e = t.decided?.find((x) => x.id === d.id);
    if (e) e.changed = { text: want, by: meta.user.name, at: now(), ticket: became };
    addActivity(t, 'you', `Changed what was decided for you (${d.id}): ${want}. It became ${/^c\d+$/.test(became) ? 'change' : 'ticket'} ${became}`);
  });
}

function and(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** What the squad's own accept says on the record: what passed, and what the person chose to go on without. */
export function acceptedLine(t: Ticket): string {
  const g = t.gates;
  const passed = [g?.checks === 'pass' ? 'checks' : '', g?.review === 'pass' ? 'review' : '', (t.proof ?? []).some((p) => p.after) ? 'screenshots' : ''].filter(Boolean);
  const head = passed.length ? `${and(passed).charAt(0).toUpperCase()}${and(passed).slice(1)} passed: accepted by itself` : 'Accepted by itself';
  const notes = [
    g?.checks === 'unchecked' ? 'No tests ran: you chose to go on without tests in this project' : '',
    g?.checks === 'skipped' ? 'The checks did not pass, and you chose to go on anyway' : '',
    g?.review === 'skipped' ? 'The review was still open, and you chose to go on anyway' : '',
  ].filter(Boolean);
  return [head, ...notes].join('. ');
}

/** The proof passed: instead of waiting for Looks right, the squad accepts it as its next step. Changes `t` in place. */
export function acceptNext(t: Ticket, seconds: number, speed: number): void {
  t.live = true;
  t.stage = 'review';
  t.waiting = null;
  t.status = ACCEPTING;
  scheduleSquad(t, 'accept', seconds, speed);
}

/**
 * The accept step from the live squad: the project's hooks run beside everything else first, so a slow one never holds
 * up the board. When the ticket will not be accepted now (a change still open, a "done when" not met) nothing is saved.
 * The step's Stop ends a hook that is running. A Stop or a delete that came while the hook ran never ends in a merge:
 * the ticket is left as it is, and the squad's next turn takes it from there.
 */
export async function acceptByItselfBeside(bp: BoardPaths, id: string, signal?: AbortSignal): Promise<Ticket> {
  const t = requireTicket(bp, id);
  const blocked = (x: Ticket) => x.track !== 'auto' || shipped(x) || Boolean(openChange(x)) || (x.proof ?? []).some((p) => p.shows && p.shows !== 'met' && p.shows !== 'off-screen') || beforeDependency(bp, x);
  if (blocked(t)) return signal?.aborted || t.stopRequested || t.deleting ? t : acceptByItself(bp, id);
  return holdingSave(bp, t.id, async (closing) => {
    if (!(await saveBeforeAccept(bp, id, closing, signal))) return requireTicket(bp, id);
    return acceptInTurn(bp, id, closing, () => {
      // Read once more here, with nothing between this and the merge: anything that came meanwhile goes first.
      const now = requireTicket(bp, id);
      if (signal?.aborted || now.stopRequested || now.deleting || now.takenOver || (now.chat?.open && !now.chat.beside)) return now;
      return acceptByItself(bp, id);
    });
  });
}

function beforeDependency(bp: BoardPaths, t: Ticket): boolean {
  try {
    refuseBeforeDependency(bp, t);
    return false;
  } catch {
    return true;
  }
}

/**
 * The squad's own Looks right, when the checks, the review and the proof passed: the same commit, merge or pull
 * request and draft release, with the squad as the actor. A change still open waits first (the person settles it, then
 * the accept comes); a merge clash brings in the latest base (bringInAgain).
 */
export function acceptByItself(bp: BoardPaths, id: string): Ticket {
  const t = requireTicket(bp, id);
  if (t.track !== 'auto') throw new BoardActionError(`${t.id} is not on the ${BUILDS_BY_ITSELF} track. Check the proof and press Looks right.`);
  // Accepted already, by a step that ran twice: nothing more to do.
  if (shipped(t)) return updateTicket(bp, id, (x) => x.squad?.phase === 'accept' && (x.squad = null));
  const c = openChange(t);
  if (c) {
    return updateTicket(bp, id, (x) => {
      x.selfAccept = { ...x.selfAccept, waitsFor: c.id };
      x.live = false;
      x.squad = null;
      x.waiting = null;
      x.stage = 'review';
      x.status = `Waits for change ${c.id}, then it is accepted by itself`;
      addActivity(x, 'squad', `The checks, the review and the proof passed, but change ${c.id} is still open: it is accepted by itself once that change is settled`);
    });
  }
  // Never with a "done when" the screenshots do not show met: the person checks the proof and decides. Not on a screen
  // is not one of those: the Tester and squad-kit's check agreed it cannot be shown.
  const open = (t.proof ?? []).filter((p) => p.shows && p.shows !== 'met' && p.shows !== 'off-screen');
  if (open.length) {
    const broken = open.some((p) => p.shows === 'broken');
    return updateTicket(bp, id, (x) => {
      x.live = false;
      x.squad = null;
      x.stage = 'review';
      x.status = 'Proof ready to check';
      x.waiting = { kind: 'proof', summary: `Ready for you to check: a "done when" is ${broken ? 'not working' : 'not shown'} yet` };
      addActivity(x, 'squad', broken ? 'Not accepted by itself: the screenshots show a "done when" is not working yet' : 'Not accepted by itself: the screenshots do not show a "done when" yet');
    });
  }
  try {
    refuseBeforeDependency(bp, t);
  } catch (err) {
    // Built on another ticket's branch by the person's choice: that one goes in first, so the person accepts this one.
    return updateTicket(bp, id, (x) => {
      x.live = false;
      x.squad = null;
      x.stage = 'review';
      x.status = 'Proof ready to check';
      x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
      addActivity(x, 'squad', `Not accepted by itself: ${(err as Error).message}`);
    });
  }
  if (t.selfAccept?.waitsFor) updateTicket(bp, id, (x) => delete x.selfAccept?.waitsFor);
  // A merge clash brings in the latest base by itself (board/bring-in.ts).
  return acceptProof(bp, requireTicket(bp, id), acceptedLine(t));
}

/**
 * After the live squad tried to merge the pull request of a ticket: a clash brings in the base again, on every track,
 * and on this track a pull request that waits for a person to approve it is a normal wait, said plainly.
 */
export function afterPullRequest(bp: BoardPaths, id: string, clash: boolean): void {
  if (clash) {
    bringInAgain(bp, id);
    return;
  }
  const t = readTicket(bp, id);
  if (t?.track !== 'auto' || t.mergedAt || !t.pr) return;
  updateTicket(bp, id, (x) => {
    x.status = PR_WAITS;
    addActivity(x, 'release', `Pull request ${x.pr?.id ?? ''} waits for someone to approve it. That is a normal wait, not a failure`);
  });
}

/**
 * A ticket that waited for an open change before its accept: once that change is declined or withdrawn, the squad
 * accepts it now. Both squads ask on every turn; true when it starts.
 */
export function resumeAccept(bp: BoardPaths, t: Ticket): boolean {
  if (t.track !== 'auto' || !t.selfAccept?.waitsFor || t.squad || t.waiting || t.takenOver || t.deleting || shipped(t) || openChange(t)) return false;
  const meta = readMeta(bp);
  updateTicket(bp, t.id, (x) => {
    delete x.selfAccept?.waitsFor;
    addActivity(x, 'squad', 'The change it waited for is settled, so it is accepted by itself now');
    acceptNext(x, 0.2, meta.engine === 'live' ? 1 : meta.speed);
  });
  return true;
}

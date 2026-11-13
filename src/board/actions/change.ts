import { addActivity, now, readMeta, requireTicket, updateTicket, type BoardPaths } from '../store.js';
import type { Ticket, AgentName, ChangePart, SpecChange } from '../types.js';
import { scheduleSquad } from '../schedule.js';
import { criterionText } from '../docs.js';
import { changeLines } from '../../engine/prompts.js';
import { BoardActionError, tellLater } from './errors.js';
import { createTicket, reportBug } from './new-ticket.js';
import { AGENT_TITLE } from './chat.js';
import { planSnapshot } from './plan-edits.js';
import { changedLine, kindChanged, withKindWords, withLocks } from '../proof-lock.js';
import { hasKinds } from '../proof-rows.js';

/* ── A change goes through the spec ───────────────────── */

/** Accepted (merged, or waiting for its release) or released: the work is for questions only. */
export function shipped(t: Ticket): boolean {
  return t.stage === 'release' || t.stage === 'done';
}

/** Thrown for a change asked on accepted work. It becomes a new linked ticket or a bug report instead. */
export class ReleasedError extends BoardActionError {}

function releasedLine(t: Ticket): string {
  const when = t.stage === 'done' ? `released${t.release ? ` in ${t.release}` : ''}` : `accepted${t.release ? ` and goes out in ${t.release}` : ''}`;
  return `${t.id} is ${when}, so it only answers questions. Make the change a new linked ticket or report a bug.`;
}

/** The change still open on a ticket, if any. There is at most one. */
export function openChange(t: Ticket): SpecChange | undefined {
  const c = t.changes?.at(-1);
  return c && c.status !== 'done' && c.status !== 'declined' ? c : undefined;
}

/** A change the person must look at: the Analyst's proposal, or a proposal that could not be written. */
export function changeNeedsYou(t: Ticket): boolean {
  const s = openChange(t)?.status;
  return s === 'proposed' || s === 'failed' || s === 'design-ready';
}

/** The Builder has started on the ticket's copy: from now on a change reaches the work through the Builder. */
export function buildStarted(t: Ticket): boolean {
  return Boolean(t.sessions?.build);
}

/**
 * What an open change needs from the squad next: the Architect's design update (a big one), the Builder, or nothing
 * yet. Only once the build has started; before that, the change lives in the spec and the design alone.
 */
export function changeWork(t: Ticket): 'design' | 'build' | null {
  const c = openChange(t);
  if (!c || !buildStarted(t)) return null;
  if (c.size === 'big') return c.status === 'approved' || c.status === 'designing' ? 'design' : c.status === 'building' ? 'build' : null;
  return c.status === 'approved' || c.status === 'building' ? 'build' : null;
}

/** The Analyst or the Architect is writing the spec or the design right now. */
function writerNow(t: Ticket): string | null {
  if (!t.live || (t.stage !== 'tickets' && t.stage !== 'specs')) return null;
  return t.specApproved ? 'Architect is writing the design' : 'Analyst is writing the spec';
}

export const SPEC_CHANGED = 'The spec changed';

/** Puts the change's new wording into the spec. New "done when" items go at the end, so the others keep their numbers. */
function applyChange(t: Ticket, c: SpecChange): void {
  const criteria = [...(t.criteria ?? [])];
  const gone = new Set<number>();
  for (const p of c.parts ?? []) {
    if (p.part === 'story') t.story = p.after;
    else if (p.index === undefined) {
      if (p.criterion) criteria.push({ ...p.criterion });
    } else if (p.criterion) criteria[p.index] = { ...p.criterion };
    else gone.add(p.index);
  }
  t.criteria = withLocks(criteria.filter((_, i) => !gone.has(i)));
}

/** The Analyst's answer when it writes a change into the spec. */
export interface ChangeAnswer {
  summary: string;
  size: 'small' | 'big';
  why: string;
  /** The whole new story, or empty when the change does not touch it. */
  story: string;
  criteria: { number: number; action: 'change' | 'add' | 'remove'; given?: string; when?: string; then?: string; proof?: unknown }[];
}

/** Turns the Analyst's answer into old and new wording. The old words come from the ticket itself, never from the agent. */
export function changeParts(t: Ticket, out: ChangeAnswer): ChangePart[] {
  const parts: ChangePart[] = [];
  const story = out.story?.trim();
  if (story && story !== t.story?.trim()) parts.push({ part: 'story', before: t.story ?? '', after: story });
  const criteria = t.criteria ?? [];
  const used = new Set<number>();
  for (const x of out.criteria ?? []) {
    const i = Math.round(x.number) - 1;
    const old = criteria[i];
    const c = changedLine(x.action === 'change' ? old : undefined, x.proof, { given: x.given?.trim() ?? '', when: x.when?.trim() ?? '', then: x.then?.trim() ?? '' }, hasKinds(t));
    if (x.action === 'remove') {
      if (old && !used.has(i)) parts.push({ part: 'criterion', index: i, before: criterionText(old), after: '' });
      used.add(i);
      continue;
    }
    if (!c.then) continue;
    if (x.action === 'change' && old && !used.has(i)) {
      if (criterionText(old) !== criterionText(c) || kindChanged(old, c)) parts.push({ part: 'criterion', index: i, before: withKindWords(criterionText(old), old, c), after: withKindWords(criterionText(c), c, old), criterion: c });
      used.add(i);
    } else parts.push({ part: 'criterion', before: '', after: criterionText(c), criterion: c });
  }
  return parts;
}

/**
 * The person proposes a change, from the ticket or from a message in a chat. The Analyst writes it into the spec
 * beside the work: the old and new wording, and whether it is small or big. Nothing changes until the person approves.
 */
export function proposeChange(bp: BoardPaths, id: string, text: string, from?: AgentName): Ticket {
  const ask = text?.trim();
  if (!ask) throw new BoardActionError('Say in a line or two what should change.');
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (shipped(t)) throw new ReleasedError(releasedLine(t));
    if (t.takenOver?.free) throw new BoardActionError(`${t.id} is in a conversation outside squad-kit. Say it there, or bring it back first.`);
    const open = openChange(t);
    if (open) throw new BoardActionError(`${t.id} already has change ${open.id} open. Approve or decline it first: one change at a time.`);
    if (t.takenOver) throw new BoardActionError(`${t.id} is taken over. Give it back first.`);
    // Before its approval the spec is changed right on its card, with comments, edits or a talk.
    if (!t.specApproved && !['implement', 'test', 'review'].includes(t.stage)) {
      throw new BoardActionError(
        t.story
          ? `The spec of ${t.id} still waits for your approval. Change it right there: comment on it, edit it or talk it through.`
          : `The spec of ${t.id} is not written yet. Add a note or tell the Analyst, and it goes into the spec.`,
      );
    }
    const c: SpecChange = { id: `c${(t.changes?.length ?? 0) + 1}`, ask, by: meta.user.name, at: now(), status: 'writing', ...(from && AGENT_TITLE[from] ? { from } : {}) };
    t.changes = [...(t.changes ?? []), c];
    addActivity(t, 'you', `Proposed change ${c.id}: ${ask}`);
  });
}

/** The Analyst could not write the change: it tries again. */
export function retryChange(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    const c = openChange(t);
    if (c?.status !== 'failed') throw new BoardActionError(`${t.id} has no change to try again.`);
    c.status = 'writing';
    delete c.error;
    addActivity(t, 'you', `Asked the Analyst to write change ${c.id} again`);
  });
}

/**
 * Approves the change that waits: the Analyst's proposal, or the Architect's design update for a big one. Before the
 * build the change simply goes into the spec (and a big one back to the Architect's design, approved as usual). Once
 * the Builder works: a small change goes into the spec now and reaches the Builder at the end of its current step; a
 * big one pauses the Builder after that step, while the Architect updates the design.
 */
export function approveChange(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  const live = meta.engine === 'live';
  return updateTicket(bp, id, (t) => {
    const c = openChange(t);
    if (shipped(t)) throw new ReleasedError(releasedLine(t));
    if (c?.status === 'design-ready') return approveChangeDesign(t, c, live ? 0.2 : 2, live ? 1 : meta.speed);
    if (c?.status !== 'proposed') throw new BoardActionError(`${t.id} has no change waiting for you.`);
    const busy = writerNow(t);
    if (busy) throw new BoardActionError(`The ${busy} right now. Approve the change once it is ready for you.`);
    c.decided = { by: meta.user.name, at: now(), approved: true };
    const big = c.size === 'big';
    const what = (c.summary ?? c.ask).replace(/\.+$/, '');
    tellLater(t, meta.engine, { kind: 'note', text: `Change ${c.id} to the spec, approved by ${meta.user.name}: ${c.summary ?? c.ask}`, noteKind: 'note' });
    if (!buildStarted(t)) {
      const before = planSnapshot(t);
      applyChange(t, c);
      c.status = 'done';
      if (big && t.steps) {
        // The design was written from the old spec: the Architect updates it, and you approve it as any design.
        t.planReview = { before, sent: [] };
        t.changeRequest = `${SPEC_CHANGED} (change ${c.id}): ${c.summary ?? c.ask}\n${changeLines(c)}\nUpdate the design so it builds the new spec.`;
        t.waiting = null;
        t.live = true;
        t.stage = 'specs';
        t.status = 'Architect is updating the design for your change';
        scheduleSquad(t, 'plan-rewrite', 2, meta.speed);
        addActivity(t, 'you', `Approved change ${c.id} (big): ${what}. The spec says it now, and the Architect updates the design`);
      } else addActivity(t, 'you', `Approved change ${c.id}: ${what}. The spec says it now`);
      return;
    }
    c.status = 'approved';
    if (big) {
      addActivity(t, 'you', `Approved change ${c.id} (big): ${what}. The Builder pauses after its current step, and the Architect updates the design`);
      return;
    }
    // Kept so the change can still be withdrawn until the Builder takes it.
    c.specBefore = { ...(t.story !== undefined ? { story: t.story } : {}), ...(t.criteria ? { criteria: t.criteria.map((x) => ({ ...x })) } : {}) };
    applyChange(t, c);
    addActivity(t, 'you', `Approved change ${c.id} (small): ${what}. The spec says it now; it reaches the Builder at the end of its current step`);
  });
}

/**
 * Withdraws an approved change the squad has not built yet: a small one before the Builder takes it into a step, a
 * big one before its design update is ready. The spec goes back to how it was, and the ticket goes back to what it
 * did before the change came in. Once the Builder works on it, a new change undoes it instead.
 */
export function withdrawChange(bp: BoardPaths, id: string, reason?: string): Ticket {
  const meta = readMeta(bp);
  const live = meta.engine === 'live';
  return updateTicket(bp, id, (t) => {
    const c = openChange(t);
    if (c?.status === 'building') throw new BoardActionError(`The Builder is making change ${c.id} already. Once it is done, propose a new change to undo it.`);
    if (c?.status !== 'approved' && c?.status !== 'designing') throw new BoardActionError(`${t.id} has no approved change to withdraw.`);
    const why = reason?.trim();
    const back = Boolean(c.specBefore);
    if (c.specBefore) {
      if (c.specBefore.story !== undefined) t.story = c.specBefore.story;
      else delete t.story;
      if (c.specBefore.criteria) t.criteria = c.specBefore.criteria;
      else delete t.criteria;
      delete c.specBefore;
    }
    c.status = 'declined';
    c.decided = { by: meta.user.name, at: now(), approved: false, withdrawn: true, ...(why ? { reason: why } : {}) };
    addActivity(t, 'you', `Withdrew change ${c.id}${back ? '; the spec is back to how it was' : ''}${why ? `: ${why}` : ''}`);
    tellLater(t, meta.engine, { kind: 'note', text: `Change ${c.id} to the spec was withdrawn by ${meta.user.name}${why ? `: ${why}` : ''}`, noteKind: 'note' });
    // What the ticket did before the change came in: what waited for you, or the step it paused after.
    const paused = c.paused;
    delete c.paused;
    if (paused?.waiting) {
      t.waiting = paused.waiting;
      t.live = false;
      t.squad = null;
      t.status = paused.waiting.summary;
    } else if (paused?.phase) {
      t.live = true;
      t.status = 'Carrying on';
      scheduleSquad(t, paused.phase, live ? 0.2 : 2, live ? 1 : meta.speed);
    } else if (t.squad?.phase.startsWith('change-')) {
      t.squad = null;
      t.live = false;
    }
  });
}

/** The design update for a big change: the spec and the design change together, and the Builder redoes only what changed. */
function approveChangeDesign(t: Ticket, c: SpecChange, seconds: number, speed: number): void {
  const design = c.design!;
  applyChange(t, c);
  const old = t.steps ?? [];
  t.steps = design.steps.map((s) => {
    const kept = s.change === 'same' ? old.find((o) => o.title === s.title) : undefined;
    return { title: s.title, status: kept ? (kept.status === 'done' ? 'done' : 'todo') : s.change === 'same' ? 'done' : 'todo' };
  });
  if (t.work) t.work = { ...t.work, steps: t.steps.length };
  const redo = t.steps.flatMap((s, i) => (s.status === 'done' ? [] : [i + 1]));
  c.status = 'building';
  delete c.paused;
  t.waiting = null;
  t.live = true;
  t.stage = 'implement';
  t.status = `Builder is redoing ${redo.length === 1 ? 'step' : 'steps'} ${redo.join(', ')} for change ${c.id}`;
  addActivity(t, 'you', `Approved the design update for change ${c.id}. The Builder redoes only ${redo.length === 1 ? 'step' : 'steps'} ${redo.join(', ') || 'none'}`);
  scheduleSquad(t, 'change-build', seconds, speed);
}

/**
 * Declines the change that waits. Declining a proposal changes nothing. Declining a big change's design update keeps
 * the spec as it was, and the work carries on from where it paused.
 */
export function declineChange(bp: BoardPaths, id: string, reason?: string): Ticket {
  const meta = readMeta(bp);
  const live = meta.engine === 'live';
  return updateTicket(bp, id, (t) => {
    const c = openChange(t);
    if (!c || (c.status !== 'proposed' && c.status !== 'design-ready' && c.status !== 'failed')) throw new BoardActionError(`${t.id} has no change waiting for you.`);
    const why = reason?.trim();
    const design = c.status === 'design-ready';
    c.status = 'declined';
    c.decided = { by: meta.user.name, at: now(), approved: false, ...(why ? { reason: why } : {}) };
    addActivity(t, 'you', `Declined ${design ? `the design update for change ${c.id}; the spec stays as it was` : `change ${c.id}`}${why ? `: ${why}` : ''}`);
    if (!design) return;
    const paused = c.paused;
    delete c.paused;
    t.waiting = paused?.waiting ?? null;
    if (t.waiting) {
      t.live = false;
      t.status = t.waiting.summary;
      return;
    }
    t.live = true;
    t.status = 'Carrying on';
    scheduleSquad(t, paused?.phase ?? 'test', live ? 0.2 : 2, live ? 1 : meta.speed);
  });
}

/**
 * A change asked for after the ticket is accepted or released: it becomes a new ticket linked to it, or a bug report
 * found in its release. The released ticket itself stays as it is.
 */
export function changeAfterRelease(bp: BoardPaths, id: string, text: string, as: 'ticket' | 'bug'): Ticket {
  const ask = text?.trim();
  if (!ask) throw new BoardActionError('Say in a line or two what should change.');
  const t0 = requireTicket(bp, id);
  if (!shipped(t0)) throw new BoardActionError(`${t0.id} is not accepted yet. Propose the change on it instead.`);
  const line = ask.split('\n')[0]!.trim();
  const title = line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line;
  const link = `A change to ${t0.id} "${t0.title}"${t0.release ? `, ${t0.stage === 'done' ? 'released in' : 'going out in'} ${t0.release}` : ''}.`;
  const made = as === 'bug' ? reportBug(bp, { what: title, ...(t0.release && t0.stage === 'done' ? { foundIn: t0.release } : {}) }) : createTicket(bp, { title, ask: `${ask}\n\n${link}`, priority: t0.priority });
  updateTicket(bp, t0.id, (x) => addActivity(x, 'you', `Asked for a change after release. It became ${as === 'bug' ? 'bug' : 'ticket'} ${made.id}: ${title}`));
  return updateTicket(bp, made.id, (x) => {
    x.changeOf = t0.id;
    if (as === 'bug') x.ask = `${ask}\n\n${link}`;
  });
}

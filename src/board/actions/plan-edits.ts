import { addActivity, readMeta, updateTicket, type BoardPaths } from '../store.js';
import type { Ticket, PlanComment, PlanEdit, PlanPart, PlanSnapshot } from '../types.js';
import { scheduleSquad } from '../schedule.js';
import { criterionText } from '../docs.js';
import { BoardActionError } from './errors.js';
import { SPEC_CHANGED } from './change.js';

/* ── Review a plan like a document ─────────────────────── */

const PART_NAME = { story: 'the story', criterion: 'done when', decision: 'the decision', step: 'step' } as const;

function partLabel(p: PlanPart): string {
  return p.part === 'criterion' || p.part === 'step' ? `${PART_NAME[p.part]} ${(p.index ?? 0) + 1}` : PART_NAME[p.part];
}

/** The words a part has now, to quote it back to the agent. */
function partText(t: Ticket, p: PlanPart): string {
  if (p.part === 'story') return t.story ?? '';
  if (p.part === 'decision') return t.decision ? `${t.decision.title}. ${t.decision.why}` : '';
  if (p.part === 'criterion') return t.criteria?.[p.index ?? 0] ? criterionText(t.criteria[p.index ?? 0]!) : '';
  return t.steps?.[p.index ?? 0]?.title ?? '';
}

export function planSnapshot(t: Ticket): PlanSnapshot {
  return {
    ...(t.story ? { story: t.story } : {}),
    ...(t.criteria ? { criteria: t.criteria.map((c) => ({ ...c })) } : {}),
    ...(t.decision ? { decision: `${t.decision.title}: ${t.decision.options.find((o) => o.chosen)?.name ?? ''}` } : {}),
    ...(t.steps ? { steps: t.steps.map((s) => s.title) } : {}),
  };
}

/** Which parts the person may change on the card that waits: the spec's what, or the design's how. */
function editable(t: Ticket, p: PlanPart): boolean {
  if (t.waiting?.kind === 'spec') return p.part === 'story' || p.part === 'criterion';
  if (t.waiting?.kind === 'plan') return p.part === 'step' || (!t.specApproved && (p.part === 'story' || p.part === 'criterion'));
  return false;
}

/** Puts the person's own wording back after a rewrite: their edits win. */
export function applyPlanEdits(t: Ticket): void {
  for (const e of t.planReview?.edits ?? []) {
    const i = e.index ?? 0;
    if (e.part === 'story' && e.text) t.story = e.text;
    if (e.part === 'criterion' && e.criterion && t.criteria?.[i]) t.criteria[i] = { ...e.criterion };
    if (e.part === 'step' && e.text && t.steps?.[i]) t.steps[i] = { ...t.steps[i]!, title: e.text };
  }
}

/** Edit a part of the spec or design yourself. It takes effect at once; Approve keeps it, a rewrite keeps it too. */
export function editPlan(bp: BoardPaths, id: string, edit: PlanEdit): Ticket {
  return updateTicket(bp, id, (t) => {
    if (!editable(t, edit)) throw new BoardActionError(`That part of ${t.id} cannot be edited now.`);
    const i = edit.index ?? 0;
    const text = edit.text?.trim();
    if (edit.part === 'criterion') {
      const c = edit.criterion;
      if (!c?.given.trim() || !c.when.trim() || !c.then.trim()) throw new BoardActionError('Fill in Given, When and Then.');
      if (!t.criteria?.[i]) throw new BoardActionError('That "done when" item is gone. Reload the ticket.');
      t.criteria[i] = { given: c.given.trim(), when: c.when.trim(), then: c.then.trim() };
    } else {
      if (!text) throw new BoardActionError('Write the new text first.');
      if (edit.part === 'story') t.story = text;
      else if (t.steps?.[i]) t.steps[i] = { ...t.steps[i]!, title: text };
      else throw new BoardActionError('That step is gone. Reload the ticket.');
    }
    const saved: PlanEdit = edit.part === 'criterion' ? { part: 'criterion', index: i, criterion: t.criteria![i]! } : { part: edit.part, ...(edit.part === 'step' ? { index: i } : {}), text };
    const others = (t.planReview?.edits ?? []).filter((e) => !(e.part === saved.part && (e.index ?? 0) === i));
    t.planReview = { ...t.planReview, edits: [...others, saved] };
    addActivity(t, 'you', `Edited ${partLabel(edit)}`);
  });
}

/** The comments and edits, written for the agent that rewrites. */
export function reviewText(t: Ticket, comments: PlanComment[]): string {
  const lines = comments.map((c) => {
    const quote = partText(t, c);
    return `- On ${partLabel(c)}${quote ? ` ("${quote.slice(0, 200)}")` : ''}: ${c.text.trim()}`;
  });
  const edits = (t.planReview?.edits ?? []).map((e) => `- ${partLabel(e)}: "${e.part === 'criterion' && e.criterion ? criterionText(e.criterion) : (e.text ?? '')}"`);
  return [
    'The person reviewed it and left these comments:',
    ...lines,
    ...(edits.length ? ['They also rewrote these parts themselves. Keep their wording exactly:', ...edits] : []),
  ].join('\n');
}

function toWriter(t: Ticket, note: string, speed: number, status?: string): void {
  const spec = t.waiting?.kind === 'spec';
  t.changeRequest = note;
  t.waiting = null;
  t.live = true;
  t.status = status ?? (spec ? 'Analyst is updating the spec' : t.specApproved ? 'Architect is updating the design' : 'Spec writer is updating the plan');
  scheduleSquad(t, spec ? 'spec-rewrite' : 'plan-rewrite', 2, speed);
}

/** One short line for the activity: the change itself, or what kind of review it was. */
export function changeSummary(change: string | undefined): string {
  if (!change) return 'your change';
  if (change.startsWith('Start over')) return 'started over with your new direction';
  if (change.startsWith(SPEC_CHANGED)) return 'for the change to the spec';
  if (change.includes('\n')) {
    const n = change.split('\n').filter((l) => l.startsWith('- On ')).length;
    return `with your ${n} ${n === 1 ? 'comment' : 'comments'}`;
  }
  return change;
}

/** Send back: every comment at once. The next version shows what changed. */
export function sendBack(bp: BoardPaths, id: string, comments: PlanComment[]): Ticket {
  const meta = readMeta(bp);
  const clean = (comments ?? []).filter((c) => c?.text?.trim() && ['story', 'criterion', 'decision', 'step'].includes(c.part));
  if (!clean.length) throw new BoardActionError('Add at least one comment first.');
  return updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'spec' && t.waiting?.kind !== 'plan') throw new BoardActionError(`${t.id} has no spec or design waiting for you.`);
    const sent = clean.map((c) => ({ part: c.part, ...(c.index !== undefined ? { index: c.index } : {}), text: c.text.trim() }));
    const note = reviewText(t, sent);
    t.planReview = { ...t.planReview, before: planSnapshot(t), sent };
    addActivity(t, 'you', `Sent back with ${sent.length} ${sent.length === 1 ? 'comment' : 'comments'}`);
    toWriter(t, note, meta.speed);
  });
}

/** Start over: the whole idea was wrong. The agent writes it again from zero, with your new direction. */
export function startOver(bp: BoardPaths, id: string, direction: string): Ticket {
  const meta = readMeta(bp);
  const text = direction?.trim();
  if (!text) throw new BoardActionError('Say in a line or two what the new direction is.');
  return updateTicket(bp, id, (t) => {
    const kind = t.waiting?.kind;
    if (kind !== 'spec' && kind !== 'plan') throw new BoardActionError(`${t.id} has no spec or design waiting for you.`);
    const design = kind === 'plan' && t.specApproved;
    if (!design) {
      delete t.story;
      delete t.criteria;
      delete t.releaseNote;
    }
    delete t.decision;
    delete t.steps;
    delete t.work;
    delete t.mockup;
    t.planReview = undefined;
    addActivity(t, 'you', `Started over: ${text}`);
    toWriter(
      t,
      `Start over from zero. Drop your earlier version completely; the person's new direction is:\n${text}`,
      meta.speed,
      kind === 'spec' ? 'Analyst is writing a new spec' : design ? 'Architect is writing a new design' : 'Spec writer is writing a new plan',
    );
  });
}

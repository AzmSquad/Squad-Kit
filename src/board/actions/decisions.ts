import {
  addActivity,
  listDecisions,
  nextDecisionId,
  now,
  readMeta,
  requireTicket,
  updateTicket,
  writeDecision,
  writeRelease,
  listReleases,
  writeMeta,
  codeChanged,
  queueImpactCheck,
  type BoardPaths,
} from '../store.js';
import type { BoardMeta, Decision, ImpactCheck, TechDraft, Ticket } from '../types.js';
import { detectStack } from '../stack.js';
import { scheduleSquad } from '../schedule.js';
import { BoardActionError } from './errors.js';
import { createTicket } from './new-ticket.js';
import { openChange } from './change.js';

/** Ask the Architect to read the code again for the architecture page: the stack, the patterns and the project map. */
export function readCodeAgain(bp: BoardPaths): BoardMeta['blueprint'] {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') throw new BoardActionError('Reading the code needs the live squad.');
  return codeChanged(bp) ?? meta.blueprint;
}

/** Ask the Architect to write a decision for a technology that was picked without one. */
export function draftTechDecision(bp: BoardPaths, tech: string): TechDraft {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') throw new BoardActionError('Writing a decision needs the live squad.');
  // In a package file, or seen in the code by the Architect (a project without package files).
  const inCode = detectStack(bp.root, meta).some((t) => t.name === tech) || Boolean(meta.blueprint?.stack.some((n) => n.role && n.name === tech));
  if (!inCode) throw new BoardActionError(`${tech} is not in the code.`);
  const drafts = (meta.techDrafts ?? []).filter((d) => d.tech !== tech || d.status !== 'failed');
  const open = drafts.find((d) => d.tech === tech);
  if (open) return open;
  const draft: TechDraft = { tech, status: 'writing' };
  writeMeta(bp, { ...meta, techDrafts: [...drafts, draft] });
  return draft;
}

/** The person approves the Architect's draft: it becomes a saved decision, and a rule from now on. */
export function approveTechDecision(bp: BoardPaths, tech: string): Decision {
  const meta = readMeta(bp);
  const draft = meta.techDrafts?.find((d) => d.tech === tech);
  if (draft?.status !== 'ready' || !draft.decision) throw new BoardActionError(`There is no decision for ${tech} to approve yet.`);
  const known = new Set(listDecisions(bp).map((d) => d.id));
  const d = draft.decision;
  const decision: Decision = {
    id: nextDecisionId(bp),
    title: d.title,
    why: d.why,
    options: d.options,
    // The choice must name the technology, so the stack links to it.
    chosen: d.chosen.toLowerCase().includes(tech.toLowerCase()) ? d.chosen : `${tech}: ${d.chosen}`,
    from: 'Code review',
    approvedBy: meta.user.name,
    date: now(),
    checkedBy: null,
    tickets: [],
    area: d.area,
    ...(d.buildsOn.filter((x) => known.has(x)).length ? { buildsOn: d.buildsOn.filter((x) => known.has(x)) } : {}),
  };
  writeDecision(bp, decision);
  writeMeta(bp, { ...readMeta(bp), techDrafts: meta.techDrafts!.filter((x) => x.tech !== tech) });
  queueImpactCheck(bp, decision.id);
  return decision;
}

export function discardTechDecision(bp: BoardPaths, tech: string): void {
  const meta = readMeta(bp);
  writeMeta(bp, { ...meta, techDrafts: (meta.techDrafts ?? []).filter((x) => x.tech !== tech) });
}

/**
 * A newer decision changes this ticket. Not merged yet: the Architect redoes the design to follow it, and a ticket
 * that was already being built brings in the latest base before the Builder redoes the work. Merged already: its code
 * is in the base, so a follow-up ticket brings it in line.
 */
export function updateForDecision(bp: BoardPaths, id: string, adr: string): Ticket {
  const meta = readMeta(bp);
  const t0 = requireTicket(bp, id);
  const hit = t0.outdated?.find((o) => o.adr === adr);
  if (!hit) throw new BoardActionError(`${id} has nothing to update for ${adr}.`);
  const rest = (t0.outdated ?? []).filter((o) => o.adr !== adr);
  if (t0.mergedAt || t0.stage === 'done') {
    const d = listDecisions(bp).find((x) => x.id === adr);
    const follow = createTicket(bp, {
      title: `Bring "${t0.title}" in line with ${adr}`,
      ask: `${t0.id} (${t0.title}) was built before ${adr}${d ? ` (${d.title})` : ''} was approved. ${hit.change}`,
      priority: t0.priority,
    });
    updateTicket(bp, id, (t) => {
      t.outdated = rest.length ? rest : undefined;
      addActivity(t, 'you', `Made ${follow.id} to bring it in line with ${adr}`);
    });
    return follow;
  }
  if (t0.takenOver) throw new BoardActionError(`${id} is taken over. Give it back first.`);
  if (t0.chat?.open && !t0.chat.beside) throw new BoardActionError(`${id} has a chat open. Finish it first.`);
  const open = openChange(t0);
  if (open) throw new BoardActionError(`${id} has change ${open.id} open. Finish it first: one change at a time.`);
  if (t0.live && meta.engine === 'live') throw new BoardActionError(`${id} is working right now. Press Stop first, then update the plan.`);
  // Accepted but not merged (its pull request could not merge): it leaves the draft release until it is accepted again.
  const draft = listReleases(bp).find((r) => r.status !== 'released' && r.tickets.includes(id));
  if (draft) writeRelease(bp, { ...draft, tickets: draft.tickets.filter((x) => x !== id) });
  return updateTicket(bp, id, (t) => {
    // Its open pull request is found again by branch when it is accepted the next time.
    t.pr = undefined;
    t.release = undefined;
    t.outdated = rest.length ? rest : undefined;
    t.changeRequest = `Follow ${adr}: ${hit.change}`;
    t.waiting = null;
    t.stuck = undefined;
    t.retryPhase = undefined;
    t.live = true;
    t.stage = 'specs';
    t.status = 'Architect is updating the design';
    if (t.worktree) t.replanFor = adr;
    addActivity(t, 'you', `Asked to update the plan to follow ${adr}`);
    scheduleSquad(t, 'plan-rewrite', 2, meta.speed);
  });
}

/** The person keeps the plan as it is, and says why. The reason stays on the ticket. */
export function keepPlan(bp: BoardPaths, id: string, adr: string, reason: string): Ticket {
  const why = reason.trim();
  if (!why) throw new BoardActionError('Say in one line why the plan stays as it is.');
  return updateTicket(bp, id, (t) => {
    if (!t.outdated?.some((o) => o.adr === adr)) throw new BoardActionError(`${id} has nothing to update for ${adr}.`);
    t.outdated = t.outdated.filter((o) => o.adr !== adr);
    if (!t.outdated.length) t.outdated = undefined;
    addActivity(t, 'you', `Kept the plan with ${adr}: ${why}`);
  });
}

/** Check the open tickets against a saved decision again, or for the first time on one approved before checks. */
export function checkTicketsAgainst(bp: BoardPaths, adr: string): ImpactCheck {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') throw new BoardActionError('Checking tickets needs the live squad.');
  if (!listDecisions(bp).some((d) => d.id === adr)) throw new BoardActionError(`${adr} is not a saved decision.`);
  const now = meta.impactChecks?.find((c) => c.adr === adr);
  if (now?.status === 'pending' || now?.status === 'running') return now;
  const check: ImpactCheck = { adr, status: 'pending' };
  writeMeta(bp, { ...meta, impactChecks: [...(meta.impactChecks ?? []).filter((c) => c.adr !== adr), check] });
  return check;
}

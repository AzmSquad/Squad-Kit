import type { Ticket } from './types.js';

/**
 * Every stop says what happened in plain words, what is safe, and the ways out (phase 10). The plain words are the
 * stuck card's question and the exact error its detail, both saved when the step stops. The title and what is safe
 * come from the ticket as it is now, so older cards get them too and they never go stale.
 */

export interface Problem {
  title: string;
  what: string;
  safe: string[];
  detail?: string;
}

/** A step's failure, with the exact error kept beside the plain words. */
export class StepError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

/** Errors squad-kit itself did not expect: a bug, a missing file. They get plain words; the real ones go to the detail. */
function unexpected(e: Error): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError || Boolean(code && /^E[A-Z]+$/.test(code));
}

/** The plain words and the exact error of anything thrown while a step ran. */
export function explainError(err: unknown): { what: string; detail?: string } {
  if (err instanceof StepError) return { what: err.message, ...(err.detail && err.detail !== err.message ? { detail: err.detail } : {}) };
  const e = err instanceof Error ? err : new Error(String(err));
  if (!unexpected(e)) return { what: e.message };
  const stack = e.stack?.split('\n').slice(1, 6).join('\n');
  return { what: 'squad-kit ran into a problem it did not expect.', detail: `${e.name}: ${e.message}${stack ? `\n${stack}` : ''}` };
}

const STOPPED = /^You stopped the squad\b/;

const ROLE_OF: [string, string[]][] = [
  ['Analyst', ['analyst-read', 'triage', 'spec-rewrite', 'chat-spec']],
  ['Architect', ['plan-rewrite', 'answered-architect', 'chat-design', 'change-design']],
  ['Builder', ['build', 'unstick', 'pick-up', 'fix', 'answered-builder', 'chat-carry-builder', 'change-build', 'review-fix', 'restore-tests', 'update-base', 'proof-fix']],
  ['Reviewer', ['review', 'answered-reviewer', 'chat-carry-reviewer']],
  ['Tester', ['proof', 'chat-carry-tester']],
];

/** Who was working in a step, for "The Builder stopped". */
function who(t: Ticket, phase: string | undefined): string | null {
  // The plan step writes the spec first on the Full track (the Analyst), then the design (the Architect).
  if (phase === 'plan-write') return t.track !== 'express' && !t.specApproved ? 'Analyst' : 'Architect';
  return ROLE_OF.find(([, phases]) => phase && phases.includes(phase))?.[0] ?? null;
}

function title(t: Ticket): string {
  const s = t.stuck!;
  if (STOPPED.test(s.question)) return 'You stopped the squad';
  if (s.budget) return s.budget === 'ticket' ? 'This ticket reached its budget' : "This month's budget is reached";
  if (s.kind === 'gate-cant-run') return 'A check of your team could not run';
  if (s.kind === 'hook') return s.added ? "Your team's check said no" : "The project's own check said no";
  if (s.gate === 'checks') return s.kind === 'weakened' ? 'The tests were made weaker' : s.kind === 'no-tests' ? 'No tests to check the work' : s.kind === 'guard' ? 'A file was blocked' : 'The checks still fail';
  if (s.gate === 'review') return 'The review is still open';
  if (s.gate === 'proof') return s.kind === 'bad-proof' ? 'The screenshots did not pass the check' : s.kind === 'broken' ? 'A "done when" is not working yet' : s.kind === 'not-shown' ? 'A "done when" is not shown yet' : 'No screenshots yet';
  if (s.gate === 'merge') return 'The change clashes with newer code';
  if (s.gate === 'cap') {
    const role = t.capRaise?.role;
    return `The ${role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : (who(t, t.retryPhase) ?? 'squad')} reached its limit for this step`;
  }
  if (t.retryPhase === 'publish') return 'The pull request did not open';
  if (t.retryPhase === 'test') return 'The checks could not run';
  const role = who(t, t.retryPhase);
  return role ? `The ${role} stopped` : 'The squad stopped';
}

/** "Your work is saved: steps 1 to 3 are done and kept." */
function workKept(t: Ticket): string {
  const steps = t.steps ?? [];
  const done = steps.filter((s) => s.status === 'done').length;
  if (!done) return 'Nothing was lost: the work so far is kept.';
  const first = steps.slice(0, done).every((s) => s.status === 'done');
  const which = !first ? `${done} of ${steps.length} steps are` : done === 1 ? 'step 1 is' : `steps 1 to ${done} are`;
  return `Your work is saved: ${which} done and kept.`;
}

function safe(t: Ticket): string[] {
  const s = t.stuck!;
  const out = [s.gate && s.gate !== 'merge' ? "The changes are kept in the ticket's own copy of the code." : workKept(t)];
  if (t.mergedAt) return out;
  out.push(t.pr || t.retryPhase === 'publish' ? 'Nothing was merged yet.' : 'Nothing was merged or pushed.');
  return out;
}

/** What a stuck ticket's card says, or null when it is not stuck. */
export function problemOf(t: Ticket): Problem | null {
  if (!t.stuck) return null;
  return {
    title: title(t),
    what: t.stuck.question,
    // "You stopped the squad. Nothing was lost; …" says what is safe itself.
    safe: STOPPED.test(t.stuck.question) ? [] : safe(t),
    ...(t.stuck.detail ? { detail: t.stuck.detail } : {}),
  };
}

/** The ticket as the board shows it: a stuck card with its title and what is safe. */
export function withProblem(t: Ticket): Ticket {
  const p = problemOf(t);
  if (!p || !t.stuck) return t;
  return { ...t, stuck: { ...t.stuck, title: p.title, safe: p.safe } };
}

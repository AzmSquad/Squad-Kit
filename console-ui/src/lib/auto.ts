import type { Ticket } from '../api/types';
import type { BrdRef, BreakdownView } from '../api/requirements-types';

/**
 * Builds by itself, on the ticket's side, without React: which stop a ticket is at, where its story sits in the
 * breakdown, which stories wait for its answer, and the agent's suggested choice. Tested on its own.
 */

export type StopKind = 'gap' | 'clash' | 'check';

/** The three stops, in the words the board uses everywhere. */
export const STOP_WORDS: Record<StopKind, string> = { gap: 'Missing in the BRD', clash: 'Two parts clash', check: 'A check failed' };

/** Which of the three stops a ticket that builds by itself waits at, if any. */
export function stopKind(t: Ticket): StopKind | null {
  if (t.track !== 'auto' || !t.waiting) return null;
  if (t.waiting.kind === 'ask' && t.agentQuestion?.kind && !t.agentQuestion.answer) return t.agentQuestion.kind;
  const gate = t.waiting.kind === 'stuck' ? t.stuck?.gate : undefined;
  return gate === 'checks' || gate === 'review' || gate === 'proof' ? 'check' : null;
}

/** The Requirements page for a breakdown, with one of its parts picked. */
export function requirementsPath(id: string, item?: string): string {
  return `/requirements/${encodeURIComponent(id)}${item ? `?item=${encodeURIComponent(item)}` : ''}`;
}

/** Where a story sits in its breakdown, by name: "Payments › Invoices and refunds › S-14". */
export function placeOf(v: Pick<BreakdownView, 'epics'> | undefined, key: string): string {
  for (const e of v?.epics ?? []) {
    for (const f of e.features) if (f.stories.some((s) => s.key === key)) return [e.title, f.title, key].join(' › ');
    if (e.stories.some((s) => s.key === key)) return [e.title, key].join(' › ');
  }
  return key;
}

/** How an agent marks the option it suggests: "… (suggested)". */
const SUGGESTED = /\s*\(suggested\)\s*$/i;

/** The agent's choices, with the marker taken off the one it suggests. */
export function optionsOf(options: string[]): { text: string; suggested: boolean }[] {
  return options.map((o) => ({ text: o.replace(SUGGESTED, ''), suggested: SUGGESTED.test(o) }));
}

/** What the agent was doing when it stopped, for "The Architect found it while planning". */
export function doingWords(t: Pick<Ticket, 'stage'>): string {
  if (t.stage === 'specs') return 'planning';
  if (t.stage === 'implement') return 'building';
  if (t.stage === 'test') return 'testing';
  if (t.stage === 'review') return 'reviewing';
  return 'working';
}

function and(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** The stories that need this one, directly or through another, and are not merged yet: "S-16 Partial refunds". */
export function waitingOn(v: Pick<BreakdownView, 'epics' | 'progress'>, key: string): string[] {
  const stories = v.epics.flatMap((e) => [...e.features.flatMap((f) => f.stories), ...e.stories]);
  const done = new Set(v.progress.filter((p) => p.state === 'merged' || p.state === 'released').map((p) => p.key));
  const out = new Set<string>();
  const add = (k: string) => {
    for (const s of stories) {
      if (s.dependsOn.includes(k) && !out.has(s.key)) {
        out.add(s.key);
        add(s.key);
      }
    }
  };
  add(key);
  return stories.filter((s) => out.has(s.key) && !done.has(s.key)).map((s) => `${s.key} ${s.title}`);
}

/** "S-16 Partial refunds waits for your answer. The other stories keep building." */
export function waitsLine(v: Pick<BreakdownView, 'epics' | 'progress' | 'state'> | undefined, t: Pick<Ticket, 'breakdown'>): string {
  if (!v || !t.breakdown) return '';
  const wait = waitingOn(v, t.breakdown.item);
  const building = Boolean(v.state.build?.on);
  if (wait.length) return `${and(wait)} ${wait.length === 1 ? 'waits' : 'wait'} for your answer.${building ? ' The other stories keep building.' : ''}`;
  return building ? 'No other story waits for it: the others keep building.' : '';
}

/** One source of a stop: a place in the BRD, an earlier answer, or a ticket it clashes with. */
export type Source = NonNullable<NonNullable<Ticket['agentQuestion']>['sources']>[number];

/** The place in the BRD a source points to (section 4.2, page 18), or null for an answer or a ticket. */
export function sourceRef(s: Source): BrdRef | null {
  if (s.ticket || (!s.page && !s.section)) return null;
  return { ...(s.section ? { section: s.section } : {}), ...(s.page ? { page: s.page } : {}) };
}

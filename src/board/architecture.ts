import path from 'node:path';
import { listDecisions, listReleases, listTickets, readMeta, type BoardPaths } from './store.js';
import { reposOf } from '../engine/repos.js';
import { decidedIn, detectStack, type Tech } from './stack.js';
import type { BoardMeta, Blueprint, Decision, ImpactCheck, PatternNote, TechDraft, Ticket } from './types.js';

/** Where a ticket is, seen from the architecture: built and out, built, being built, designed, or still to come. */
export type TimelineState = 'shipped' | 'merged' | 'building' | 'designed' | 'coming';

export interface TimelineTicket {
  id: string;
  title: string;
  kind: Ticket['kind'];
  state: TimelineState;
  /** The decision this ticket made, once approved. */
  made?: string;
  follows: string[];
  release?: string;
}

/** A technology with the Architect's why and the decisions that chose it. */
export interface StackItem extends Tech {
  why?: string;
  decisions: string[];
  /** No decision names it, but it came with a technology that one chose: React with Next.js. */
  via?: { name: string; decisions: string[] };
  draft?: TechDraft;
}

export interface Architecture {
  decisions: Decision[];
  tickets: TimelineTicket[];
  map: BoardMeta['map'];
  lessons: BoardMeta['lessons'];
  stack: StackItem[];
  patterns: PatternNote[];
  /** Each decision checked against the tickets planned before it. */
  impact: ImpactCheck[];
  /** When the Architect last read the code, and whether a read is on its way. */
  reading?: Omit<Blueprint, 'stack' | 'patterns'>;
}

/** Decisions with their links, and every ticket in order, for the architecture page. */
export function architecture(bp: BoardPaths): Architecture {
  const decisions = listDecisions(bp).sort((a, b) => num(a.id) - num(b.id)).map(withMentions);
  const shipped = new Set(listReleases(bp).filter((r) => r.status === 'released').flatMap((r) => r.tickets));
  const tickets = listTickets(bp)
    .sort((a, b) => num(a.id) - num(b.id))
    .map((t): TimelineTicket => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      state: stateOf(t, shipped),
      made: t.decision?.adr ?? decisions.find((d) => d.from === t.id)?.id,
      follows: t.follows ?? decisions.filter((d) => d.from !== t.id && d.tickets.includes(t.id)).map((d) => d.id),
      ...(t.release ? { release: t.release } : {}),
    }));
  const meta = readMeta(bp);
  const notes = meta.blueprint?.stack ?? [];
  const item = (t: Tech): StackItem => {
    const note = notes.find((n) => n.name.toLowerCase() === t.name.toLowerCase());
    const chosen = [...new Set([...(note?.decision ? [note.decision] : []), ...decidedIn(t, decisions)])];
    const draft = meta.techDrafts?.find((d) => d.tech === t.name);
    return { ...t, ...(note?.why ? { why: note.why } : {}), decisions: chosen, ...(draft ? { draft } : {}) };
  };
  const inPackages = detectStack(bp.root, meta);
  const named = new Set(inPackages.map((t) => t.name.toLowerCase()));
  // What the Architect saw in the code that no package file names, like Python in a project with none.
  const repo = reposOf(meta)[0]?.path ?? '.';
  const seen = notes
    .filter((n) => n.role && !named.has(n.name.toLowerCase()))
    .map((n): Tech => ({ name: n.name, role: n.role!, icon: n.name.toLowerCase().replace(/[^a-z0-9]/g, ''), repo }));
  const found = [...inPackages, ...seen].map(item);
  const stack = found.map((t) => {
    if (t.decisions.length) return t;
    const parent = found.find((p) => t.comesWith?.includes(p.name) && p.decisions.length);
    return parent ? { ...t, via: { name: parent.name, decisions: parent.decisions } } : t;
  });
  const { stack: _s, patterns = [], ...reading } = meta.blueprint ?? { stack: [], patterns: [] };
  return { decisions, tickets, map: meta.map, lessons: meta.lessons, stack, patterns, impact: meta.impactChecks ?? [], ...(meta.blueprint ? { reading: reading as Architecture['reading'] } : {}) };
}

function stateOf(t: Ticket, shipped: Set<string>): TimelineState {
  if (shipped.has(t.id) || t.stage === 'done') return 'shipped';
  if (t.mergedAt) return 'merged';
  if (t.decision?.adr || ['implement', 'test', 'review', 'release'].includes(t.stage)) return 'building';
  if (t.work) return 'designed';
  return 'coming';
}

/** An older board has no buildsOn yet: a decision that names another one in its why was built on it. */
function withMentions(d: Decision): Decision {
  if (d.buildsOn) return d;
  const named = [...new Set(d.why.match(/ADR-\d+/g) ?? [])].filter((x) => x !== d.id);
  return named.length ? { ...d, buildsOn: named } : d;
}

function num(id: string): number {
  return Number(id.replace(/\D/g, '')) || 0;
}

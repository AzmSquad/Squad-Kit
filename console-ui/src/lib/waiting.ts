import type { SpecChange, Ticket, WaitingKind } from '../api/types';

/**
 * Waiting for you, loud: the one rule for what needs the person (the same as `squad inbox` and the REST lists), the
 * count in the browser tab, the banner's order, and which new items get a desktop notice. No React here, so each rule
 * is tested on its own.
 */

/** The change still open on a ticket, if any. There is at most one. */
export function openChange(t: Ticket): SpecChange | undefined {
  const c = t.changes?.at(-1);
  return c && c.status !== 'done' && c.status !== 'declined' ? c : undefined;
}

/** A change waits for the person: the Analyst's proposal, one it could not write, or a big change's design update. */
export function changeWaits(t: Ticket): boolean {
  const s = openChange(t)?.status;
  return s === 'proposed' || s === 'failed' || s === 'design-ready';
}

/**
 * Everything that needs the person: questions, plans, proof, decisions, changes, and steps that look stuck. Same rule as
 * `inbox()` on the server: a proof being saved after Looks right needs nobody any more.
 */
export function needsYou(t: Ticket): boolean {
  if (t.now?.merging) return false;
  return Boolean(t.waiting || t.quiet?.kind === 'stuck' || t.outdated?.length || changeWaits(t) || testChangeWaits(t));
}

/** squad-kit settles a change to the test command itself; it waits for the person only when squad-kit cannot tell. */
export function testChangeWaits(t: Ticket): boolean {
  return Boolean(t.testChange?.ask);
}

/** The line in Waiting for you. It never names a command: engineers get those in the details. */
export function testChangeLine(t: Ticket): string {
  return testChangeWaits(t) ? 'squad-kit cannot tell which way of testing to keep' : '';
}

/** The browser tab says how many things wait: "(2) roomflow". Nothing waiting, no number. */
export function tabTitle(name: string, count: number): string {
  return count > 0 ? `(${count}) ${name}` : name;
}

/** "waiting 3 min" on a banner item. */
export function waitedFor(since: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(since)) / 1000);
  if (!Number.isFinite(s) || s < 60) return 'just now';
  if (s < 3600) return `waiting ${Math.round(s / 60)} min`;
  if (s < 86400) return `waiting ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `waiting ${d} ${d === 1 ? 'day' : 'days'}`;
}

/** When a ticket started waiting, as near as the board knows: a quiet step says when it went quiet. */
export function waitingSince(t: Ticket): string {
  if (!t.waiting && t.quiet?.kind === 'stuck') return t.quiet.since;
  return t.activity[0]?.at ?? t.createdAt;
}

/**
 * The banner keeps its order while items come and go, so nothing moves under the person's mouse. On the first look the
 * one waiting longest comes first; after that a new item joins at the end and the others stay where they are.
 */
export class BannerOrder {
  private rank = new Map<string, number>();
  private next = 0;

  sort<T extends { key: string; since: string }>(items: T[]): T[] {
    const fresh = items.filter((x) => !this.rank.has(x.key)).sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
    for (const x of fresh) this.rank.set(x.key, this.next++);
    const here = new Set(items.map((x) => x.key));
    for (const k of this.rank.keys()) if (!here.has(k)) this.rank.delete(k);
    return [...items].sort((a, b) => this.rank.get(a.key)! - this.rank.get(b.key)!);
  }
}

/* ── Desktop notices ───────────────────────────────────── */

/** Why a ticket needs the person. One ticket can wait for more than one thing; each is its own notice. */
export type WaitReason = WaitingKind | 'quiet' | 'outdated' | 'test-command';

export function reasonsOf(t: Ticket): WaitReason[] {
  const out = new Set<WaitReason>();
  if (t.waiting) out.add(t.waiting.kind);
  if (changeWaits(t)) out.add('change');
  if (t.quiet?.kind === 'stuck') out.add('quiet');
  if (t.outdated?.length) out.add('outdated');
  // With the design waiting, the change to the test command is part of it.
  if (testChangeWaits(t) && t.waiting?.kind !== 'plan') out.add('test-command');
  return [...out];
}

/** The person's own moves get no notice: a ticket they took over, or a talk they started. */
const OWN_MOVES: WaitReason[] = ['yours', 'chat', 'release'];

/** Questions, approvals (spec, design, change, a newer decision), proof, and failures or stuck steps get a notice. */
export function notifies(r: WaitReason): boolean {
  return !OWN_MOVES.includes(r);
}

export interface Notice {
  key: string;
  project: { id: string; name: string };
  ticket: Ticket;
  reason: WaitReason;
}

/** One key per thing to do. A new question from an agent, a new change or a new quiet spell is a new key. */
export function noticeKey(projectId: string, t: Ticket, r: WaitReason): string {
  const change = openChange(t);
  const extra =
    r === 'ask'
      ? t.agentQuestion?.at
      : r === 'change' && change
        ? `${change.id}-${change.status === 'design-ready' ? 'design' : 'spec'}`
        : r === 'quiet'
          ? t.quiet?.since
          : r === 'outdated'
            ? t.outdated?.map((o) => o.adr).join('+')
            : r === 'test-command'
              ? t.testChange?.to
              : undefined;
  return `${projectId}/${t.id}/${r}${extra ? `/${extra}` : ''}`;
}

/** Every notice the items could give, from the app's Waiting for you list (every project). */
export function noticesOf(items: { project: { id: string; name: string }; ticket: Ticket }[]): Notice[] {
  return items.flatMap(({ project, ticket }) =>
    reasonsOf(ticket)
      .filter(notifies)
      .map((reason) => ({ key: noticeKey(project.id, ticket, reason), project, ticket, reason })),
  );
}

/** A key that comes back this soon after it went is the same item (a file read half-written), not a new one. */
export const SAME_ITEM_MS = 2 * 60_000;

/**
 * What is new since the last look, in one tab. The first look only learns what already waits: those were there when
 * the page loaded. An item that stays, or comes back soon after it went, is never new again.
 */
export class NoticeWatch {
  private known: Set<string> | null = null;
  private gone = new Map<string, number>();

  next(notices: Notice[], now: number): Notice[] {
    const keys = new Set(notices.map((n) => n.key));
    if (!this.known) {
      this.known = keys;
      return [];
    }
    const known = this.known;
    const fresh = notices.filter((n) => !known.has(n.key) && !(now - (this.gone.get(n.key) ?? -Infinity) < SAME_ITEM_MS));
    for (const k of known) if (!keys.has(k)) this.gone.set(k, now);
    for (const [k, at] of this.gone) if (keys.has(k) || now - at >= SAME_ITEM_MS) this.gone.delete(k);
    this.known = keys;
    return fresh;
  }
}

/** Where tabs leave word of the notices they showed. */
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CLAIMS = 'sk.notices.shown';

/** Another squad-kit tab may see the same new item a moment later: the first tab to claim it shows the notice. */
export function claimNotice(key: string, now: number, store: KeyStore | null): boolean {
  if (!store) return true;
  let shown: Record<string, number> = {};
  try {
    shown = JSON.parse(store.getItem(CLAIMS) ?? '{}') as Record<string, number>;
  } catch {
    shown = {};
  }
  if (now - (shown[key] ?? -Infinity) < SAME_ITEM_MS) return false;
  const kept = Object.fromEntries(Object.entries(shown).filter(([, at]) => now - at < SAME_ITEM_MS));
  kept[key] = now;
  try {
    store.setItem(CLAIMS, JSON.stringify(kept));
  } catch {
    // Storage refused: this tab still shows its notice.
  }
  return true;
}

const AGENT: Record<string, string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' };

/** The notice in plain words: "RO-2: the Builder has a question", then the ticket and its project. */
export function noticeText(n: Notice): { title: string; body: string } {
  const t = n.ticket;
  const what: Record<WaitReason, string> = {
    questions: 'the squad has questions for you',
    ask: `the ${AGENT[t.agentQuestion?.from ?? ''] ?? 'squad'} has a question`,
    spec: 'the spec is ready for you',
    plan: t.specApproved ? 'the design is ready for you' : 'the plan is ready for you',
    change: 'a change waits for you',
    depends: 'it needs a ticket that is not merged yet',
    proof: 'the proof is ready to check',
    stuck: 'the squad stopped and needs you',
    quiet: 'a step looks stuck',
    outdated: 'a newer decision changes the plan',
    'test-command': 'a choice about the tests waits for you',
    yours: 'you took it over',
    chat: 'your talk with the squad',
    release: 'ready to release',
  };
  return { title: `${t.id}: ${what[n.reason]}`, body: `${t.title} · ${n.project.name}` };
}

/** The page that answers an item: the proof page for proof, the ticket on its board for the rest. */
export function itemHref(projectId: string, t: Ticket): string {
  const base = `/p/${encodeURIComponent(projectId)}`;
  return t.waiting?.kind === 'proof' ? `${base}/tickets/${encodeURIComponent(t.id)}/proof` : `${base}/board?ticket=${encodeURIComponent(t.id)}`;
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, listTickets, updateTicket, type BoardPaths } from '../../src/board/store.js';
import { seedDemoBoard } from '../../src/board/demo.js';
import { inbox } from '../../src/board/actions.js';
import type { Ticket } from '../../console-ui/src/api/types.js';
import {
  BannerOrder,
  NoticeWatch,
  SAME_ITEM_MS,
  claimNotice,
  itemHref,
  needsYou,
  noticeText,
  noticesOf,
  notifies,
  reasonsOf,
  tabTitle,
  waitedFor,
  type KeyStore,
  type WaitReason,
} from '../../console-ui/src/lib/waiting.js';

const roomflow = { id: 'roomflow', name: 'roomflow' };

function ticket(id: string, over: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: `Ticket ${id}`,
    ask: '',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'specs',
    status: '',
    waiting: null,
    createdAt: '2026-11-03T09:00:00.000Z',
    createdBy: 'Sara',
    activity: [],
    ...over,
  };
}

const asking = (id: string, at = '2026-11-03T10:00:00.000Z') =>
  ticket(id, {
    stage: 'implement',
    waiting: { kind: 'ask', summary: 'The Builder needs an answer to carry on' },
    agentQuestion: { from: 'builder', text: 'The login screen is not in this code yet. What should I do?', options: [], at },
  });

const items = (...tickets: Ticket[]) => tickets.map((t) => ({ project: roomflow, ticket: t }));

class MemoryStore implements KeyStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('the tab title', () => {
  it('counts what waits, and has no number when nothing does', () => {
    expect(tabTitle('roomflow', 2)).toBe('(2) roomflow');
    expect(tabTitle('squad-kit', 3)).toBe('(3) squad-kit');
    expect(tabTitle('roomflow', 0)).toBe('roomflow');
  });
});

describe('what needs the person', () => {
  let tmp: string;
  let bp: BoardPaths;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-loud-'));
    bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('the banner, the tab count and the sidebar list the same tickets as squad inbox and the REST lists', () => {
    // One of each way a ticket can need the person without a waiting card.
    updateTicket(bp, 'SK-146', (t) => {
      t.quiet = { since: new Date().toISOString(), kind: 'stuck', detail: 'no output for 4 min', command: 'npm test' };
    });
    updateTicket(bp, 'SK-153', (t) => {
      t.quiet = { since: new Date().toISOString(), kind: 'long', detail: 'slow but fine' };
    });
    updateTicket(bp, 'SK-147', (t) => {
      t.outdated = [{ adr: 'ADR-006', why: 'A new rule', change: 'Use the new PDF library', at: new Date().toISOString() }];
    });
    updateTicket(bp, 'SK-151', (t) => {
      t.changes = [{ id: 'c1', ask: 'Add a print button', by: 'Sara', at: new Date().toISOString(), status: 'proposed' }];
    });
    const server = inbox(bp).map((t) => t.id).sort();
    const ui = (listTickets(bp) as unknown as Ticket[]).filter(needsYou).map((t) => t.id).sort();
    expect(ui).toEqual(server);
    expect(ui).toEqual(expect.arrayContaining(['SK-146', 'SK-147', 'SK-151']));
    expect(ui).not.toContain('SK-153');
  });
});

describe('which items get a desktop notice', () => {
  it('questions, approvals, proof and failures or stuck steps do; the person’s own moves do not', () => {
    const yes: WaitReason[] = ['questions', 'ask', 'spec', 'plan', 'change', 'outdated', 'proof', 'stuck', 'quiet'];
    const no: WaitReason[] = ['yours', 'chat'];
    for (const r of yes) expect(notifies(r), r).toBe(true);
    for (const r of no) expect(notifies(r), r).toBe(false);
  });

  it('one ticket can need the person for two things, and each is its own notice', () => {
    const t = ticket('RO-3', {
      waiting: { kind: 'proof', summary: 'The proof is ready for you to check' },
      quiet: { since: '2026-11-03T10:00:00.000Z', kind: 'stuck', detail: 'no progress' },
    });
    expect(reasonsOf(t)).toEqual(['proof', 'quiet']);
    expect(noticesOf(items(t)).map((n) => n.key)).toEqual(['roomflow/RO-3/proof', 'roomflow/RO-3/quiet/2026-11-03T10:00:00.000Z']);
    // A talk the person started is in the list, but gives no notice.
    expect(noticesOf(items(ticket('RO-4', { waiting: { kind: 'chat', summary: 'Talking it through' } })))).toEqual([]);
  });

  it('says what happened in plain words, and opens the right page', () => {
    const [n] = noticesOf(items(asking('RO-2')));
    expect(noticeText(n!)).toEqual({ title: 'RO-2: the Builder has a question', body: 'Ticket RO-2 · roomflow' });
    expect(itemHref('roomflow', n!.ticket)).toBe('/p/roomflow/board?ticket=RO-2');
    expect(itemHref('roomflow', ticket('RO-1', { waiting: { kind: 'proof', summary: '' } }))).toBe('/p/roomflow/tickets/RO-1/proof');
  });
});

describe('a notice never repeats', () => {
  const t0 = Date.parse('2026-11-03T10:00:00.000Z');

  it('nothing for what already waited when the page loaded; one notice per new item', () => {
    const watch = new NoticeWatch();
    const proof = ticket('RO-1', { stage: 'review', waiting: { kind: 'proof', summary: 'The proof is ready for you to check' } });
    expect(watch.next(noticesOf(items(proof)), t0)).toEqual([]);
    const fresh = watch.next(noticesOf(items(proof, asking('RO-2'))), t0 + 2000);
    expect(fresh.map((n) => n.key)).toEqual(['roomflow/RO-2/ask/2026-11-03T10:00:00.000Z']);
    // Still waiting on the next looks: no second notice.
    expect(watch.next(noticesOf(items(proof, asking('RO-2'))), t0 + 4000)).toEqual([]);
    expect(watch.next(noticesOf(items(proof, asking('RO-2'))), t0 + 600_000)).toEqual([]);
  });

  it('an item missing from one look and back is the same item, but a new question later is new', () => {
    const watch = new NoticeWatch();
    watch.next([], t0);
    expect(watch.next(noticesOf(items(asking('RO-2'))), t0 + 1000)).toHaveLength(1);
    expect(watch.next([], t0 + 2000)).toEqual([]);
    expect(watch.next(noticesOf(items(asking('RO-2'))), t0 + 3000)).toEqual([]);
    // Answered; minutes later the Builder asks again: a new question, a new notice.
    watch.next([], t0 + 4000);
    const again = asking('RO-2', '2026-11-03T10:05:00.000Z');
    expect(watch.next(noticesOf(items(again)), t0 + 5000)).toHaveLength(1);
    // The same kind of stop back after a long while is a new stop.
    const spec = ticket('RO-6', { waiting: { kind: 'spec', summary: 'The spec is ready: is this what you want?' } });
    expect(watch.next(noticesOf(items(again, spec)), t0 + 6000)).toHaveLength(1);
    watch.next(noticesOf(items(again)), t0 + 7000);
    expect(watch.next(noticesOf(items(again, spec)), t0 + 7000 + SAME_ITEM_MS)).toHaveLength(1);
  });

  it('two tabs see the same new item: only the first shows it', () => {
    const store = new MemoryStore();
    expect(claimNotice('roomflow/RO-2/ask', t0, store)).toBe(true);
    expect(claimNotice('roomflow/RO-2/ask', t0 + 1500, store)).toBe(false);
    expect(claimNotice('roomflow/RO-7/proof', t0 + 1500, store)).toBe(true);
    // Old claims are dropped, so the list stays small.
    expect(claimNotice('roomflow/RO-9/spec', t0 + SAME_ITEM_MS + 1, store)).toBe(true);
    expect(Object.keys(JSON.parse(store.getItem('sk.notices.shown')!))).toEqual(['roomflow/RO-7/proof', 'roomflow/RO-9/spec']);
    // No storage (a private window): the tab shows it.
    expect(claimNotice('roomflow/RO-2/ask', t0, null)).toBe(true);
  });
});

describe('the banner', () => {
  it('keeps its order while items come and go: longest waiting first, a new one at the end', () => {
    const order = new BannerOrder();
    const a = { key: 'RO-1', since: '2026-11-03T09:50:00.000Z' };
    const b = { key: 'RO-2', since: '2026-11-03T09:40:00.000Z' };
    const c = { key: 'RO-3', since: '2026-11-03T09:00:00.000Z' };
    expect(order.sort([a, b]).map((x) => x.key)).toEqual(['RO-2', 'RO-1']);
    // A new item, even one whose last activity is older, joins at the end.
    expect(order.sort([a, b, c]).map((x) => x.key)).toEqual(['RO-2', 'RO-1', 'RO-3']);
    expect(order.sort([c, a]).map((x) => x.key)).toEqual(['RO-1', 'RO-3']);
  });

  it('says how long each item has waited', () => {
    const now = Date.parse('2026-11-03T10:00:00.000Z');
    expect(waitedFor('2026-11-03T09:59:30.000Z', now)).toBe('just now');
    expect(waitedFor('2026-11-03T09:57:00.000Z', now)).toBe('waiting 3 min');
    expect(waitedFor('2026-11-03T08:00:00.000Z', now)).toBe('waiting 2 h');
    expect(waitedFor('2026-11-01T10:00:00.000Z', now)).toBe('waiting 2 days');
  });
});

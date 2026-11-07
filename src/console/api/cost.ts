import type { Context, Hono } from 'hono';
import { boardExists, readTicket, type BoardPaths } from '../../board/store.js';
import { whatHappened, type FileList } from '../../board/happened.js';
import { costOverview, ticketCost } from '../../board/cost.js';
import { howPaid } from '../../board/payment.js';
import { parseUsd, setBudget } from '../../board/budget.js';
import { setPaymentChoice } from '../../core/settings.js';
import { ticketChanges } from '../../engine/changes.js';
import type { BoardMeta } from '../../board/types.js';
import { plainWords } from '../../core/for-people.js';

/**
 * The Conversation tab's "What happened" and the Cost tab, as REST: each view is one call, and each setting one call
 * with a terminal command beside it (`squad config set payment`, `squad config set budget`).
 */

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

/** The ticket's changed files, as "What happened" lists them. */
export async function changedFiles(bp: BoardPaths, id: string): Promise<FileList | null> {
  const { files } = await ticketChanges(bp, id);
  if (!files.length) return null;
  return {
    added: files.filter((f) => f.status === 'added').map((f) => f.path),
    changed: files.filter((f) => f.status === 'changed' || f.status === 'renamed').map((f) => f.path),
    removed: files.filter((f) => f.status === 'deleted').map((f) => f.path),
  };
}

export function mountCostApi(app: Hono, bp: BoardPaths): void {
  // One card per step: its time, what it did and what it handed in.
  app.get('/api/v1/tickets/:id/happened', async (c) => {
    const t = readTicket(bp, c.req.param('id'));
    if (!t) return c.json({ error: 'not found' }, 404);
    const files = await changedFiles(bp, t.id).catch(() => null);
    return c.json(whatHappened(bp, t, { files: () => files }));
  });

  // The ticket's cost, the way the person pays.
  app.get('/api/v1/tickets/:id/cost', async (c) => {
    const t = readTicket(bp, c.req.param('id'));
    if (!t) return c.json({ error: 'not found' }, 404);
    return c.json(ticketCost(bp, t, await howPaid(bp)));
  });

  // How the person pays, the month's total, the budgets and their warnings, and the averages per Quality setting.
  app.get('/api/v1/cost', async (c) => {
    if (!boardExists(bp)) return c.json({ error: 'No board here yet.' }, 404);
    return c.json(costOverview(bp, await howPaid(bp)));
  });

  // subscription, api-key, or auto to let squad-kit find out again. For every project: they share one AI login.
  app.put('/api/v1/cost/payment', async (c) => {
    const b = await body<{ payment?: string }>(c);
    if (b.payment !== 'subscription' && b.payment !== 'api-key' && b.payment !== 'auto') {
      return c.json({ error: 'Pick subscription, api-key or auto.' }, 400);
    }
    setPaymentChoice(b.payment);
    return c.json(costOverview(bp, await howPaid(bp)));
  });

  // The budgets in US dollars: a number sets one, null or "off" takes it away, a missing one stays as it is.
  app.put('/api/v1/cost/budget', async (c) => {
    const b = await body<{ ticketUsd?: string | number | null; monthUsd?: string | number | null }>(c);
    try {
      const change: Parameters<typeof setBudget>[1] = {};
      if ('ticketUsd' in b) change.ticketUsd = parseUsd(b.ticketUsd);
      if ('monthUsd' in b) change.monthUsd = parseUsd(b.monthUsd);
      const budget: NonNullable<BoardMeta['budget']> = setBudget(bp, change);
      return c.json({ ...costOverview(bp, await howPaid(bp)), budget });
    } catch (err) {
      return c.json({ error: plainWords(err, 'Saving the budget') }, 400);
    }
  });
}

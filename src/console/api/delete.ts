import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths } from '../../board/store.js';
import { archiveTicket, deletePlan, deleteTicket, unarchiveTicket } from '../../engine/delete.js';

/**
 * Delete and Archive, one call each, the same as `squad delete` and `squad archive`. The plan says what Delete would
 * remove and what stays, so the dialog shows the engine's own words.
 */

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

/** A person-facing mistake comes back as a 400 with the message. */
async function act(c: Context, fn: () => unknown) {
  try {
    return c.json(((await fn()) as object) ?? { ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
}

export function mountDeleteApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);

  app.get('/api/v1/tickets/:id/delete', (c) => act(c, () => deletePlan(bp, c.req.param('id'), { remote: c.req.query('remote') === '1' ? true : c.req.query('remote') === '0' ? false : undefined })));

  // Stops the squad on it first and waits, so the call answers once the ticket is gone (or says what is left).
  app.post('/api/v1/tickets/:id/delete', async (c) => {
    const b = await body<{ remote?: boolean }>(c);
    return act(c, () => deleteTicket(bp, c.req.param('id'), { remote: Boolean(b.remote) }));
  });

  app.post('/api/v1/tickets/:id/archive', async (c) => {
    const b = await body<{ undo?: boolean }>(c);
    return act(c, () => (b.undo ? unarchiveTicket(bp, c.req.param('id')) : archiveTicket(bp, c.req.param('id'))));
  });
}

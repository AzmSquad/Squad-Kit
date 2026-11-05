import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths } from '../../board/store.js';
import { tryRunner } from '../../engine/try-app.js';

/**
 * Try it yourself, on a ticket that waits for your check: start, stop and how it stands, one call each. Terminal:
 * `squad try <ticket>`, `squad try <ticket> --stop`, `squad try <ticket> --status`.
 */

/** A person-facing reason ("has no copy of the code") is a 400 with the message. */
async function act(c: Context, fn: () => unknown) {
  try {
    return c.json(((await fn()) as object) ?? { ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
}

export function mountTryApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);
  const runner = () => tryRunner(bp);

  app.get('/api/v1/tickets/:id/try', (c) => act(c, () => runner().status(c.req.param('id'))));
  app.post('/api/v1/tickets/:id/try', (c) => act(c, () => runner().start(c.req.param('id'))));
  app.post('/api/v1/tickets/:id/try/stop', (c) => act(c, () => runner().stop(c.req.param('id'))));
}

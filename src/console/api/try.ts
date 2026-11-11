import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths } from '../../board/store.js';
import { tryRunner, type TryHow } from '../../engine/try-app.js';
import { act } from './act.js';

/**
 * Try it yourself, on a ticket that waits for your check: start, stop and how it stands, one call each. Terminal:
 * `squad try <ticket>`, `squad try <ticket> --stop`, `squad try <ticket> --status`.
 */

export function mountTryApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);
  const runner = () => tryRunner(bp);

  app.get('/api/v1/tickets/:id/try', (c) => act(c, () => runner().status(c.req.param('id'))));
  // { "phone": true }, { "web": true } ("Use the web version now"), and { "language": "ar" } for an iPhone app.
  app.post('/api/v1/tickets/:id/try', async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as TryHow;
    const how: TryHow = { ...(b.phone === true ? { phone: true } : {}), ...(b.web === true ? { web: true } : {}), ...(typeof b.language === 'string' ? { language: b.language } : {}) };
    return act(c, () => runner().startAs(c.req.param('id'), how));
  });
  app.post('/api/v1/tickets/:id/try/stop', (c) => act(c, () => runner().stop(c.req.param('id'))));
}

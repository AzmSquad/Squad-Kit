import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { proveLine } from '../../board/prove.js';
import { boardPaths } from '../../board/store.js';
import { act, body } from './app.js';

/**
 * How a "done when" is proved, from the chip's menu on the spec: the same as `squad prove <ticket> <line> <kind>`.
 * `keeps` true or false turns "stays as it is" on or off for a Test line (`--keeps`, `--no-keeps`).
 */
export function mountProveApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);
  app.post('/api/v1/tickets/:id/prove', async (c) => {
    const b = await body<{ line?: number; kind?: string; why?: string; keeps?: boolean }>(c);
    return act(c, () => proveLine(bp, c.req.param('id'), Number(b.line), String(b.kind ?? ''), typeof b.why === 'string' ? b.why : undefined, typeof b.keeps === 'boolean' ? b.keeps : undefined));
  });
}

import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths, readMeta } from '../../board/store.js';
import type { DependencyChoice } from '../../board/types.js';
import { bringInLatest, chooseBuild, setDependsOn } from '../../board/depends.js';
import { nextDraft, outItems, putBackInRelease, takeOutOfRelease } from '../../board/release-tidy.js';
import { cleanBranches, oldBranches } from '../../engine/branches.js';

/**
 * Tickets that depend on unmerged work, and the release fixes: one call each, the same as their terminal commands
 * (`squad depends`, `squad build`, `squad bring-in`, `squad release --without`, `squad branches --clean`).
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

export function mountDependsApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);

  // `squad depends RO-2 --on RO-1`, or `--none` with an empty list.
  app.post('/api/v1/tickets/:id/depends', async (c) => {
    const b = await body<{ on?: string[] }>(c);
    return act(c, () => setDependsOn(bp, c.req.param('id'), Array.isArray(b.on) ? b.on.map(String) : []));
  });

  // The ways out of "RO-2 needs RO-1, which is not merged yet": `squad build RO-2 --on-branch`, `--anyway` or `--wait`.
  app.post('/api/v1/tickets/:id/build', async (c) => {
    const b = await body<{ way?: DependencyChoice['way'] }>(c);
    return act(c, () => chooseBuild(bp, c.req.param('id'), b.way as DependencyChoice['way']));
  });

  // "Bring in latest main": `squad bring-in RO-2`.
  app.post('/api/v1/tickets/:id/bring-in', (c) => act(c, () => bringInLatest(bp, c.req.param('id'))));

  // Take a ticket out of the next release before it is made, or put it back: `squad release --without RO-3`.
  app.post('/api/v1/releases/:v/take-out', async (c) => {
    const b = await body<{ ticket?: string }>(c);
    return act(c, () => takeOutOfRelease(bp, c.req.param('v'), b.ticket ?? ''));
  });
  app.post('/api/v1/releases/:v/put-back', async (c) => {
    const b = await body<{ ticket?: string }>(c);
    return act(c, () => putBackInRelease(bp, c.req.param('v'), b.ticket ?? ''));
  });
  app.get('/api/v1/releases/:v/out', (c) => act(c, () => outItems(bp, nextDraft(bp, c.req.param('v')))));

  // Old ticket branches: what `squad branches` lists, and `--clean` (with `remote`, also on the remote).
  app.get('/api/v1/branches', (c) => act(c, () => (readMeta(bp).engine === 'live' ? oldBranches(bp) : { here: [], remote: [], kept: [] })));
  app.post('/api/v1/branches/clean', async (c) => {
    const b = await body<{ remote?: boolean }>(c);
    return act(c, () => {
      if (readMeta(bp).engine !== 'live') throw new Error('The sample board has no git branches to delete.');
      return cleanBranches(bp, { remote: Boolean(b.remote) });
    });
  });
}

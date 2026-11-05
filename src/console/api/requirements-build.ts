import type { Context, Hono } from 'hono';
import type { BoardPaths } from '../../board/store.js';
import { BoardActionError } from '../../board/actions.js';
import { breakdownWaits, viewBreakdown } from '../../board/requirements.js';
import { setBuild } from '../../board/requirements-build.js';
import { requestSend, sendPreview } from '../../board/requirements-send.js';

/**
 * Build continuously and Send to the tracker, one call per button like the rest of the Requirements page, and the
 * breakdowns that wait for the person, for Waiting for you on every page.
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

export function mountBuildSendApi(app: Hono, bp: BoardPaths): void {
  const view = (id: string) => viewBreakdown(bp, id);

  // My breakdowns whose Analyst has questions for me: { breakdowns: [{ id, title, questions, since }] }.
  app.get('/api/v1/requirements/waiting', (c) => act(c, () => ({ breakdowns: breakdownWaits(bp) })));

  // Build continuously { on: true }, Pause { on: false }: `squad requirements build BR-1 [--pause]`.
  app.post('/api/v1/requirements/:id/build', async (c) => {
    const b = await body<{ on?: unknown }>(c);
    return act(c, () => {
      if (typeof b.on !== 'boolean') throw new BoardActionError('Say { "on": true } to build continuously, or { "on": false } to pause.');
      return view(setBuild(bp, c.req.param('id'), b.on).id);
    });
  });

  // What Send to <tracker> will do, for the dialog: `squad requirements send BR-1 --preview`. Nothing is sent.
  app.get('/api/v1/requirements/:id/send', (c) => act(c, () => sendPreview(bp, c.req.param('id'))));

  // Send to the tracker, or Send changes: `squad requirements send BR-1`. The squad runs it; state.sync says how far.
  app.post('/api/v1/requirements/:id/send', (c) => act(c, () => view(requestSend(bp, c.req.param('id')).id)));
}

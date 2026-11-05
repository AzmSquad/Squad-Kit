import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardExists, boardPaths } from '../../board/store.js';
import {
  approveOverview,
  closeTalk,
  overviewView,
  readAgainWithTalk,
  readTalk,
  sendTalk,
  setupAgain,
  setupQuality,
  setupView,
  startTalk,
  stopSetup,
  stopTalk,
  tellIdea,
  ticketFromIdea,
} from '../../board/first-run.js';
import type { SetupStepId } from '../../board/setup-state.js';

/**
 * The first run and the Overview: the setup's live steps, the overview the Architect wrote, and the person's moves on
 * them, each one call. Terminal: `squad setup` and `squad overview`.
 */

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

async function act(c: Context, fn: () => unknown) {
  try {
    return c.json(((await fn()) as object) ?? { ok: true });
  } catch (err) {
    if (err instanceof Error) return c.json({ error: err.message }, 400);
    throw err;
  }
}

export function mountOverviewApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);

  app.get('/api/v1/setup', (c) => c.json({ setup: boardExists(bp) ? setupView(bp) : null }));
  app.post('/api/v1/setup/stop', (c) => act(c, () => stopSetup(bp)));
  // Try again or Start again from one step (the read when none is given).
  app.post('/api/v1/setup/again', async (c) => {
    const b = await body<{ step?: SetupStepId }>(c);
    return act(c, () => setupAgain(bp, b.step ?? 'read'));
  });
  // The Quality question, asked once during the setup.
  app.post('/api/v1/setup/quality', async (c) => {
    const b = await body<{ quality?: string }>(c);
    return act(c, () => ({ setup: setupQuality(bp, b.quality ?? '') }));
  });

  app.get('/api/v1/overview', (c) => (boardExists(bp) ? c.json(overviewView(bp)) : c.json({ error: 'not found' }, 404)));
  // "Looks right, start working": the rules the read found become rules.
  app.post('/api/v1/overview/approve', (c) => act(c, () => approveOverview(bp)));
  // A ticket idea becomes a ticket.
  app.post('/api/v1/overview/ideas/:n', (c) => act(c, () => ticketFromIdea(bp, Number(c.req.param('n')))));
  // "What do you want to build?" on a project with no code: the answer goes to the Architect's read.
  app.post('/api/v1/overview/idea', async (c) => {
    const b = await body<{ text?: string }>(c);
    return act(c, () => tellIdea(bp, b.text ?? ''));
  });
  // "Read it again": the whole setup from the read, so the overview is checked again.
  app.post('/api/v1/overview/read-again', (c) => act(c, () => setupAgain(bp, 'read')));

  // "Something is wrong": a talk with the Architect about what it understood.
  app.get('/api/v1/overview/talk', (c) => c.json({ talk: boardExists(bp) ? readTalk(bp) : null }));
  app.post('/api/v1/overview/talk', async (c) => {
    const b = await body<{ text?: string }>(c);
    return act(c, () => {
      const t = readTalk(bp);
      return { talk: t?.open && b.text?.trim() ? sendTalk(bp, b.text) : startTalk(bp, b.text) };
    });
  });
  app.post('/api/v1/overview/talk/stop', (c) => act(c, () => ({ talk: stopTalk(bp) })));
  app.post('/api/v1/overview/talk/close', (c) => act(c, () => ({ talk: closeTalk(bp) })));
  // "Read it again with this": the read takes what the person said into account.
  app.post('/api/v1/overview/talk/read-again', (c) => act(c, () => readAgainWithTalk(bp)));
}

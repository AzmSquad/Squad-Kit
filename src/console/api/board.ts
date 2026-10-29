import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import {
  BoardActionError,
  answerQuestions,
  approve,
  askAbout,
  composeNotes,
  createTicket,
  decideStuck,
  pullTicket,
  releaseVersion,
  reportBug,
  requestChange,
  saveReleaseNotes,
  skipQuestions,
} from '../../board/actions.js';
import { boardExists, boardPaths, listDecisions, listReleases, listTickets, readMeta, readRelease, readTicket } from '../../board/store.js';
import { seedDemoBoard } from '../../board/demo.js';
import type { Release } from '../../board/types.js';

const DAY = 86_400_000;

function withNotes(bp: ReturnType<typeof boardPaths>, r: Release): Release {
  return r.status === 'draft' && !r.notes.trim() ? { ...r, notes: composeNotes(bp, r) } : r;
}

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

/** Runs a board action and turns a person-facing mistake into a 400 with the message. */
function act(c: Context, fn: () => unknown) {
  try {
    return c.json(fn() ?? { ok: true });
  } catch (err) {
    if (err instanceof BoardActionError || err instanceof Error) return c.json({ error: err.message }, 400);
    throw err;
  }
}

export function mountBoardApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);

  app.get('/api/v1/board', (c) => {
    if (!boardExists(bp)) return c.json({ ready: false });
    const meta = readMeta(bp);
    const all = listTickets(bp);
    const recent = listReleases(bp).filter((r) => r.status === 'released' && r.date && Date.now() - Date.parse(r.date) < 30 * DAY);
    return c.json({
      ready: true,
      meta,
      tickets: all.filter((t) => t.stage !== 'done'),
      stats: {
        released30: recent.reduce((n, r) => n + r.tickets.length, 0),
        bugs30: recent.reduce((n, r) => n + (r.bugs?.length ?? 0), 0),
        open: all.filter((t) => t.stage !== 'done').length,
      },
    });
  });

  app.get('/api/v1/tickets/:id', (c) => {
    const t = readTicket(bp, c.req.param('id'));
    return t ? c.json(t) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/v1/tickets', async (c) => {
    const b = await body<{ title?: string; ask?: string; priority?: 'high' | 'normal' | 'low' }>(c);
    return act(c, () => createTicket(bp, { title: b.title ?? '', ask: b.ask, priority: b.priority }));
  });

  app.post('/api/v1/pull', async (c) => {
    const b = await body<{ ref?: string }>(c);
    return act(c, () => pullTicket(bp, b.ref ?? ''));
  });

  app.post('/api/v1/tickets/:id/answers', async (c) => {
    const b = await body<{ answers?: Record<string, { choice: string; value?: string }> }>(c);
    return act(c, () => answerQuestions(bp, c.req.param('id'), b.answers ?? {}));
  });

  app.post('/api/v1/tickets/:id/skip', (c) => act(c, () => skipQuestions(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/ask', async (c) => {
    const b = await body<{ questionId?: string; text?: string }>(c);
    return act(c, () => askAbout(bp, c.req.param('id'), b.questionId ?? '', b.text ?? ''));
  });

  app.post('/api/v1/tickets/:id/approve', (c) => act(c, () => approve(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/change', async (c) => {
    const b = await body<{ text?: string }>(c);
    return act(c, () => requestChange(bp, c.req.param('id'), b.text ?? ''));
  });

  app.post('/api/v1/tickets/:id/decide', async (c) => {
    const b = await body<{ choice?: number }>(c);
    return act(c, () => decideStuck(bp, c.req.param('id'), Number(b.choice)));
  });

  app.get('/api/v1/releases', (c) => {
    const tickets = listTickets(bp);
    const titleOf = (id: string, r: Release) => tickets.find((t) => t.id === id)?.title ?? r.titles?.[id] ?? id;
    return c.json(
      listReleases(bp).map((r) => ({
        ...withNotes(bp, r),
        items: r.tickets.map((id) => {
          const t = tickets.find((x) => x.id === id);
          return { id, title: titleOf(id, r), gates: t?.gates ?? null, kind: t?.kind ?? 'feature' };
        }),
      })),
    );
  });

  app.put('/api/v1/releases/:v/notes', async (c) => {
    const b = await body<{ notes?: string }>(c);
    return act(c, () => saveReleaseNotes(bp, c.req.param('v'), b.notes ?? ''));
  });

  app.post('/api/v1/releases/:v/release', (c) => act(c, () => releaseVersion(bp, c.req.param('v'))));

  app.get('/api/v1/releases/:v', (c) => {
    const r = readRelease(bp, c.req.param('v'));
    return r ? c.json(withNotes(bp, r)) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/v1/bugs', async (c) => {
    const b = await body<{ what?: string; how?: string; expected?: string; severity?: 'stops-work' | 'annoying' | 'small'; foundIn?: string }>(c);
    return act(c, () => reportBug(bp, { what: b.what ?? '', how: b.how, expected: b.expected, severity: b.severity, foundIn: b.foundIn }));
  });

  app.get('/api/v1/decisions', (c) => {
    if (!boardExists(bp)) return c.json({ decisions: [], map: [], lessons: [] });
    const meta = readMeta(bp);
    return c.json({ decisions: listDecisions(bp), map: meta.map, lessons: meta.lessons });
  });

  app.get('/api/v1/proof/:file', (c) => {
    const name = path.basename(c.req.param('file'));
    const abs = path.join(bp.proofDir, name);
    if (!name.endsWith('.png') || !fs.existsSync(abs)) return c.text('not found', 404);
    return new Response(fs.readFileSync(abs), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } });
  });

  app.post('/api/v1/demo/reset', (c) => {
    if (boardExists(bp) && readMeta(bp).engine !== 'demo') return c.json({ error: 'Only a demo board can be reset.' }, 400);
    const speed = boardExists(bp) ? readMeta(bp).speed : 1;
    const project = boardExists(bp) ? readMeta(bp).project : undefined;
    seedDemoBoard(bp, { speed, project });
    return c.json({ ok: true });
  });
}

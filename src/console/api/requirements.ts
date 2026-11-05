import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths } from '../../board/store.js';
import type { AnswerInput, UploadedFile } from '../../board/actions.js';
import type { Criterion } from '../../board/types.js';
import type { BreakdownLevel } from '../../board/requirements-types.js';
import { breakdownRows, readBreakdown, viewBreakdown } from '../../board/requirements.js';
import {
  addBreakdown,
  addItem,
  answerBreakdown,
  approveBreakdown,
  askAboutQuestion,
  changeDecided,
  deleteBreakdown,
  editItem,
  moveItem,
  redoItem,
  removeItem,
  renameBreakdown,
  retryBreakdown,
  skipBreakdownQuestions,
  startStory,
  stopBreakdown,
} from '../../board/requirements-actions.js';
import { breakdownDir } from '../../board/requirements-paths.js';
import { mimeOf } from '../../engine/conversations.js';
import { mountBuildSendApi } from './requirements-build.js';

/**
 * The Requirements page: one call per button, the same as `squad requirements …`. Every change answers with the
 * breakdown as the page shows it (BreakdownView). Sending to the tracker and Build continuously come with their own
 * routes (requirements-build.ts).
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

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The fields of an edit, each only when sent. */
interface PatchBody {
  title?: string;
  goal?: string;
  summary?: string;
  story?: string;
  criteria?: Criterion[];
  size?: string;
  needs?: string[];
}

function patchOf(b: PatchBody) {
  return {
    ...(str(b.title) !== undefined ? { title: b.title } : {}),
    ...(str(b.goal) !== undefined ? { goal: b.goal } : {}),
    ...(str(b.summary) !== undefined ? { summary: b.summary } : {}),
    ...(str(b.story) !== undefined ? { story: b.story } : {}),
    ...(Array.isArray(b.criteria) ? { criteria: b.criteria } : {}),
    ...(str(b.size) !== undefined ? { size: b.size } : {}),
    ...(Array.isArray(b.needs) ? { needs: b.needs.map(String) } : {}),
  };
}

export function mountRequirementsApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);
  const view = (id: string) => viewBreakdown(bp, id);
  // Build continuously, Send to the tracker and Waiting for you, before the routes that take any id.
  mountBuildSendApi(app, bp);

  // `squad requirements list`.
  app.get('/api/v1/requirements', (c) => act(c, () => ({ breakdowns: breakdownRows(bp) })));

  // Add a BRD: `squad requirements add <file> [--name] [--with <file>…]`, or `--paste`. Files come as base64, like a
  // ticket's: { file, with } or { files } (the first is the BRD), or { text } for pasted text.
  app.post('/api/v1/requirements', async (c) => {
    const b = await body<{ file?: UploadedFile; files?: UploadedFile[]; text?: string; name?: string; with?: UploadedFile[] }>(c);
    const files = Array.isArray(b.files) ? b.files : [];
    const file = b.file ?? (str(b.text) ? undefined : files[0]);
    const extra = [...(Array.isArray(b.with) ? b.with : []), ...(b.file || str(b.text) ? files : files.slice(1))];
    return act(c, async () => view(addBreakdown(bp, { ...(file ? { file } : {}), ...(str(b.text) ? { text: b.text } : {}), ...(str(b.name) ? { name: b.name } : {}), with: extra }).id));
  });

  // `squad requirements show BR-1`.
  app.get('/api/v1/requirements/:id', async (c) => {
    if (!readBreakdown(bp, c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    return act(c, () => view(c.req.param('id')));
  });

  // A file inside the breakdown's folder: the document, its pictures, the mockups added with it.
  app.get('/api/v1/requirements/:id/file', (c) => {
    const b = readBreakdown(bp, c.req.param('id'));
    const asked = c.req.query('path') ?? '';
    if (!b) return c.json({ error: 'not found' }, 404);
    const dir = breakdownDir(bp, b.id);
    const file = path.resolve(dir, asked);
    const rel = path.relative(dir, file);
    if (!asked || rel.startsWith('..') || path.isAbsolute(rel) || !/^(source|text|media)[\\/]/.test(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return c.json({ error: 'not found' }, 404);
    // SVG and HTML can carry scripts, so they download instead of opening at the board's own address, where its token is.
    const type = mimeOf(file);
    const scripts = type === 'image/svg+xml' || type === 'text/html';
    return new Response(fs.readFileSync(file), { headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(scripts ? { 'content-disposition': `attachment; filename="${path.basename(file).replace(/"/g, '')}"` } : {}) } });
  });

  // Rename: `squad requirements rename BR-1 "<name>"`.
  app.patch('/api/v1/requirements/:id', async (c) => {
    const b = await body<{ title?: string }>(c);
    return act(c, () => view(renameBreakdown(bp, c.req.param('id'), b.title ?? '').id));
  });

  // `squad requirements delete BR-1`: not while its stories build.
  app.delete('/api/v1/requirements/:id', (c) => act(c, () => deleteBreakdown(bp, c.req.param('id'))));

  // Stop the Analyst, and Try again: `squad requirements stop BR-1`, `squad requirements retry BR-1`.
  app.post('/api/v1/requirements/:id/stop', (c) => act(c, () => view(stopBreakdown(bp, c.req.param('id')).id)));
  app.post('/api/v1/requirements/:id/retry', (c) => act(c, () => view(retryBreakdown(bp, c.req.param('id')).id)));

  // Answers: { answers: { q1: { choice, value? } } }. `squad requirements answer BR-1`.
  app.post('/api/v1/requirements/:id/answers', async (c) => {
    const b = await body<{ answers?: Record<string, AnswerInput> }>(c);
    return act(c, () => view(answerBreakdown(bp, c.req.param('id'), b.answers ?? {}).id));
  });

  // "Skip: let the Analyst decide" for every open question: `squad requirements answer BR-1 --skip`.
  app.post('/api/v1/requirements/:id/skip', (c) => act(c, () => view(skipBreakdownQuestions(bp, c.req.param('id')).id)));

  // "Ask about this": `squad requirements ask BR-1 q2 "<text>"`.
  app.post('/api/v1/requirements/:id/questions/:q/ask', async (c) => {
    const b = await body<{ text?: string }>(c);
    return act(c, () => view(askAboutQuestion(bp, c.req.param('id'), c.req.param('q'), b.text ?? '').id));
  });

  // Add a part: { under?, level?, title, before?, …fields }. `squad requirements add-item BR-1 --under F-2 --title …`.
  app.post('/api/v1/requirements/:id/items', async (c) => {
    const b = await body<PatchBody & { under?: string; level?: BreakdownLevel; before?: string }>(c);
    return act(c, async () => {
      const r = addItem(bp, c.req.param('id'), {
        ...patchOf(b),
        title: b.title ?? '',
        ...(str(b.under) ? { under: b.under } : {}),
        ...(b.level === 'epic' || b.level === 'feature' || b.level === 'story' ? { level: b.level } : {}),
        ...(str(b.before) ? { before: b.before } : {}),
      });
      return { key: r.key, breakdown: await view(r.breakdown.id) };
    });
  });

  // Edit a part: `squad requirements edit BR-1 S-4 --title … --size M`.
  app.patch('/api/v1/requirements/:id/items/:key', async (c) => {
    const b = await body<PatchBody>(c);
    return act(c, () => view(editItem(bp, c.req.param('id'), c.req.param('key'), patchOf(b)).id));
  });

  // Move a part: { under?, before? }. `squad requirements move BR-1 S-4 --under F-3 [--before S-9]`.
  app.post('/api/v1/requirements/:id/items/:key/move', async (c) => {
    const b = await body<{ under?: string; before?: string }>(c);
    return act(c, () => view(moveItem(bp, c.req.param('id'), c.req.param('key'), { ...(str(b.under) ? { under: b.under } : {}), ...(str(b.before) ? { before: b.before } : {}) }).id));
  });

  // Remove a part: `squad requirements remove BR-1 S-4`.
  app.delete('/api/v1/requirements/:id/items/:key', (c) => act(c, () => view(removeItem(bp, c.req.param('id'), c.req.param('key')).id)));

  // Ask the Analyst to redo a part, or the whole breakdown with the breakdown's own id: { ask }.
  app.post('/api/v1/requirements/:id/items/:key/redo', async (c) => {
    const b = await body<{ ask?: string }>(c);
    return act(c, () => view(redoItem(bp, c.req.param('id'), c.req.param('key'), b.ask ?? '').id));
  });

  // Approve breakdown: `squad requirements approve BR-1`.
  app.post('/api/v1/requirements/:id/approve', (c) => act(c, () => view(approveBreakdown(bp, c.req.param('id')).id)));

  // Start one story now: `squad requirements start BR-1 S-4`. Answers with the new ticket and the breakdown.
  app.post('/api/v1/requirements/:id/items/:key/start', (c) =>
    act(c, async () => {
      const ticket = startStory(bp, c.req.param('id'), c.req.param('key'));
      return { ticket, breakdown: await view(c.req.param('id')) };
    }),
  );

  // Change a Decided for you entry: { text }. `squad requirements decided BR-1 d3 "<text>"`.
  app.post('/api/v1/requirements/:id/decided/:d', async (c) => {
    const b = await body<{ text?: string }>(c);
    return act(c, () => view(changeDecided(bp, c.req.param('id'), c.req.param('d'), b.text ?? '').id));
  });
}

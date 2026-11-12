import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { goodAnswer, leadBoard, pressTool, textOf } from './support/lead.js';

/**
 * The lead looks at the app only in its own copy, with its own database: never the person's running app, their
 * checkout or their real data. The copy's machinery (git, the database, the start, a product) is faked; the app's
 * answers and the window are real.
 */

const seen = { update: [] as string[], db: [] as string[], start: [] as string[], product: [] as { holder: string; kind: string; worktree?: string }[], stopped: [] as string[], appStops: 0 };
let dbState: 'own' | 'as-before' | 'none' = 'own';
let ownUrl = '';

vi.mock('../src/engine/run-app.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/run-app.js')>()),
  updateCopy: async (_root: string, _repo: unknown, dir: string) => {
    seen.update.push(dir);
    return { commit: 'abc', fresh: false };
  },
}));
vi.mock('../src/engine/local-files.js', async (orig) => ({ ...(await orig<typeof import('../src/engine/local-files.js')>()), fillOwnCopy: async () => undefined }));
vi.mock('../src/engine/story-db.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/story-db.js')>()),
  setUpStoryDb: async (_bp: unknown, story: string, dir: string) => {
    seen.db.push(`${story}:${dir}`);
    return dbState === 'own' ? { state: 'own', name: 'portal_lead', made: true } : dbState === 'none' ? { state: 'none' } : { state: 'as-before', why: 'no template yet' };
  },
}));
vi.mock('../src/engine/checks.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/checks.js')>()),
  startApp: async (dir: string) => {
    seen.start.push(dir);
    return { url: ownUrl, stop: () => (seen.appStops += 1), ended: () => false };
  },
}));
vi.mock('../src/engine/product-run.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/product-run.js')>()),
  startProduct: async (_bp: unknown, t: { worktree?: string }, holder: string, kind: string) => {
    seen.product.push({ holder, kind, ...(t.worktree ? { worktree: t.worktree } : {}) });
    return { url: ownUrl, stop: () => (seen.appStops += 1), ended: () => false };
  },
  stopProduct: (_bp: unknown, holder: string) => seen.stopped.push(holder),
}));

let agent: (opts: RunOptions) => Promise<Partial<RunResult>> = async () => ({ structured: goodAnswer() });
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => ({ ok: true, sessionId: 's1', text: '', ...(await agent(opts)) }),
}));

const { readMeta, writeMeta } = await import('../src/board/store.js');
const { askLead } = await import('../src/engine/lead/ask.js');
const { LEAD_HOLDER, NOT_YOUR_DATA, leadAppPlan, startLeadApp, stopLeadApp } = await import('../src/engine/lead/own-app.js');
const { leadDir } = await import('../src/engine/lead/store.js');
const { closeOwnDoor } = await import('../src/engine/window-server.js');

/** A little web server that says who it is and keeps what it was asked. */
function server(name: string): Promise<{ url: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const s = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: name, path: req.url }));
  });
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}`, hits, close: () => new Promise<void>((r) => s.close(() => r())) });
    }),
  );
}

let tmp: string;
let bp: Awaited<ReturnType<typeof leadBoard>>['bp'];
let yours: Awaited<ReturnType<typeof server>>;
let own: Awaited<ReturnType<typeof server>>;

beforeEach(async () => {
  for (const list of [seen.update, seen.db, seen.start, seen.product, seen.stopped]) list.length = 0;
  seen.appStops = 0;
  dbState = 'own';
  ({ tmp, bp } = await leadBoard('squad-lead-app-'));
  yours = await server('yours');
  own = await server('the lead');
  ownUrl = own.url;
  // The person's own app runs at the project's usual address.
  writeMeta(bp, { ...readMeta(bp), commands: { start: 'node server.js', url: yours.url } });
});

afterEach(async () => {
  await yours.close();
  await own.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closeOwnDoor());

describe("the lead's own copy", () => {
  it('is a copy of main in squad-kit\'s own folder, with its own database, never the person\'s folder', async () => {
    const plan = leadAppPlan(bp);
    expect(plan).toMatchObject({ product: false, start: 'node server.js', url: yours.url });
    expect(plan.dir!.startsWith(leadDir(bp))).toBe(true);
    const app = await startLeadApp(bp);
    expect(app.url).toBe(own.url);
    expect(seen.update).toEqual([plan.dir]);
    expect(seen.db).toEqual([`${LEAD_HOLDER}:${plan.dir}`]);
    expect(seen.start).toEqual([plan.dir]);
    for (const dir of [...seen.update, ...seen.start]) expect(path.relative(bp.root, dir).startsWith('..')).toBe(true);
  });

  it('never starts when it would share the person\'s own database', async () => {
    dbState = 'as-before';
    await expect(startLeadApp(bp)).rejects.toThrow(NOT_YOUR_DATA);
    expect(seen.start).toEqual([]);
  });

  it('a product runs with the lead\'s own holder, every part from copies of main, and stops with it', async () => {
    writeMeta(bp, {
      ...readMeta(bp),
      repos: [
        { path: 'web', base: 'main', remote: '', commands: { start: 'npm start', url: 'http://localhost:5101' } },
        { path: 'api', base: 'main', remote: '', commands: { start: 'npm start', url: 'http://localhost:5102' } },
      ],
      parts: [
        { id: 'web', name: 'Web app', repo: 'web', needs: ['api'], url: 'http://localhost:5101' },
        { id: 'api', name: 'API', repo: 'api', needs: [], url: 'http://localhost:5102' },
      ],
    });
    expect(leadAppPlan(bp)).toMatchObject({ product: true, parts: { web: { name: 'Web app' }, api: { name: 'API' } } });
    await startLeadApp(bp);
    expect(seen.product).toEqual([{ holder: 'lead', kind: 'try' }]);
    stopLeadApp(bp);
    expect(seen.stopped).toEqual(['lead']);
  });

  it("is what the window asks, never the person's running app, and the trace says so", async () => {
    agent = async (opts) => {
      const r = await pressTool(opts, 'ask_api', { part: 'app', path: '/hello' });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain('"app":"the lead"');
      return { structured: goodAnswer() };
    };
    const c = await askLead(bp, { text: 'What does /hello answer?', context: { from: 'app', path: '/hello' } }).done;
    const t = c.turns[0]!;
    expect(t.error).toBeUndefined();
    expect(own.hits).toEqual(['/hello']);
    expect(yours.hits).toEqual([]);
    expect(t.trace.map((s) => s.text)).toEqual(expect.arrayContaining(['Started its own copy of the app, with its own database', 'Asked the API GET /hello in its own copy']));
    // The answer ended: the app it started stopped with it.
    expect(seen.appStops).toBe(1);
  });

  it('with no app to start, the lead has no app tools and says so in its rules', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: {} });
    let tools: string[] = [];
    agent = async (opts) => {
      tools = opts.allowedTools ?? [];
      return { structured: goodAnswer() };
    };
    await askLead(bp, { text: 'Show me the bookings page' }).done;
    expect(tools.filter((x) => x.startsWith('mcp__squad__'))).toEqual(['mcp__squad__read_board', 'mcp__squad__read_story', 'mcp__squad__read_decision', 'mcp__squad__read_records', 'mcp__squad__read_logs', 'mcp__squad__read_guide']);
  });
});

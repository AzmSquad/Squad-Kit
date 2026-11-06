import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { Ticket } from '../src/board/types.js';
import { callTool, textOf } from './support/window.js';

/**
 * The whole product, for a story: everything its change touches runs together, on the parts' usual addresses, one story at
 * a time. These start real little servers, and the web app will not start unless its API answers. The AI tool is a fake.
 */

const h = vi.hoisted(() => ({ during: null as ((opts: RunOptions) => void | Promise<void>) | null }));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    await h.during?.(opts);
    return { ok: true, structured: { summary: 'done', approved: true, comments: [] }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, readTicket, writeMeta, writeTicket, updateTicket } = await import('../src/board/store.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { partsToRun, runsAsProduct } = await import('../src/board/parts.js');
const { ProductError, mainCopyDir, productPlan, startProduct, stopProduct, waitWords } = await import('../src/engine/product-run.js');
const { leaveProduct, productHold, takeProduct, waitForProduct } = await import('../src/engine/product-lock.js');
const { startApp, AddressTaken } = await import('../src/engine/checks.js');
const { TryRunner } = await import('../src/engine/try-app.js');
const { AppRunner } = await import('../src/engine/run-app.js');
const { addLocalFile, storyFile } = await import('../src/board/project-files.js');

let root: string;
let bp: ReturnType<typeof boardPaths>;
let apiPort: number;
let webPort: number;
const others: { close(): void }[] = [];
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (port: number) => {
  try {
    return await (await fetch(`http://localhost:${port}/`)).text();
  } catch {
    return null;
  }
};
const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const API_SERVER = (port: number) => `import http from 'node:http';\nimport fs from 'node:fs';\nhttp.createServer((q, s) => s.end('api ' + fs.readFileSync('who.txt', 'utf8').trim())).listen(${port});\n`;
// It will not start unless its API answers: that is the order proved.
const WEB_SERVER = (port: number, api: number) => `import http from 'node:http';\nimport fs from 'node:fs';\nconst on = () => http.createServer((q, s) => s.end('web ' + fs.readFileSync('who.txt', 'utf8').trim() + ' ' + (fs.existsSync('.env.dev') ? fs.readFileSync('.env.dev', 'utf8').trim() : 'no-env'))).listen(${port});\nhttp.get('http://localhost:${api}/', on).on('error', () => process.exit(1));\n`;

function repo(name: string, files: Record<string, string>): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries({ '.gitignore': '.env.dev\nnode_modules\n', 'who.txt': 'main\n', 'package.json': '{"type":"module"}\n', ...files })) fs.writeFileSync(path.join(dir, f), text);
  sh('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm start', dir);
}

function story(more: Partial<Ticket> = {}): Ticket {
  const t = {
    id: 'AP-1',
    title: 'Sale price',
    ask: 'Show the sale price',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: '',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    repo: 'api-server',
    parts: ['api'],
    sessions: { build: 'b-1', tester: 't-1', review: 'r-1' },
    ...more,
  } as Ticket;
  writeTicket(bp, t);
  return t;
}

type Squad = { workspace(id: string): Promise<Ticket>; runBuilder(id: string, p: string, resume: boolean, step?: string): Promise<void>; mayStart(n: number): boolean; ticketsRunning(): number };
const squad = () => new LiveSquad(bp) as unknown as Squad;

beforeEach(async () => {
  h.during = null;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-product-')));
  apiPort = await freePort();
  webPort = await freePort();
  repo('api-server', { 'server.js': API_SERVER(apiPort) });
  repo('web-ui', { 'server.js': WEB_SERVER(webPort, apiPort) });
  repo('courts', { 'server.js': 'process.exit(9);\n' });
  bp = boardPaths(path.join(root, '.squad'));
  const commands = (port: number) => ({ start: 'node server.js', url: `http://localhost:${port}` });
  writeMeta(bp, {
    project: 'Shop',
    key: 'AP',
    nextNumber: 2,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    repos: [
      { path: 'api-server', base: 'main', remote: '', commands: commands(apiPort) },
      { path: 'web-ui', base: 'main', remote: '', commands: commands(webPort) },
      { path: 'courts', base: 'main', remote: '', commands: commands(1) },
    ],
    parts: [
      { id: 'api', name: 'API', repo: 'api-server', needs: ['db'] },
      { id: 'web', name: 'Web app', repo: 'web-ui', needs: ['api'] },
      { id: 'courts', name: 'Courts app', repo: 'courts', needs: [] },
      { id: 'db', name: 'Database', shared: true, needs: [] },
    ],
    scan: { status: 'done', empty: false },
  } as never);
});

afterEach(async () => {
  stopProduct(bp, 'AP-1');
  stopProduct(bp, 'AP-2');
  for (const o of others.splice(0)) o.close();
  await sleep(50);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('what runs for a story', () => {
  const ids = (changed: string[]) => partsToRun(readMeta(bp), changed).map((p) => p.id);

  it('the change, what relies on it and what those need, first things first', () => {
    expect(ids(['api'])).toEqual(['api', 'web']);
    expect(ids(['web'])).toEqual(['api', 'web']);
    expect(ids(['web', 'api'])).toEqual(['api', 'web']);
  });

  it('never another product in the same folder, a shared service, or what is not used', () => {
    expect(ids(['api'])).not.toContain('courts');
    expect(ids(['courts'])).toEqual(['courts']);
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, parts: meta.parts!.map((p) => (p.id === 'web' ? { ...p, off: true } : p)) });
    expect(ids(['api'])).toEqual(['api']);
  });

  it('a part where nothing starts is not started, and what relies on it still is', () => {
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, parts: [...meta.parts!.map((p) => (p.id === 'web' ? { ...p, needs: ['api', 'lib'] } : p)), { id: 'lib', name: 'Library', repo: 'courts', needs: [], noRun: true }] });
    expect(ids(['lib'])).toEqual(['api', 'web']);
  });

  it('stories run the whole product only with several parts that start, once the Architect named them', () => {
    expect(runsAsProduct(readMeta(bp))).toBe(true);
    const meta = readMeta(bp);
    expect(runsAsProduct({ ...meta, parts: undefined })).toBe(false);
    expect(runsAsProduct({ ...meta, parts: [meta.parts![0]!, meta.parts![3]!] })).toBe(false);
  });

  it('runs what it changed from its copy, the rest from a copy of main, and opens what nothing relies on', async () => {
    story();
    const t = await squad().workspace('AP-1');
    const plan = productPlan(bp, readMeta(bp), t);
    expect(plan.places.map((p) => [p.part.id, p.fromStory])).toEqual([['api', true], ['web', false]]);
    expect(plan.places[0]!.dir).toBe(t.worktree);
    expect(plan.places[1]!.dir).toBe(mainCopyDir(bp, 'web-ui'));
    expect(plan.front?.part.id).toBe('web');
  });

  it('says what it does not know yet, by the part', async () => {
    story();
    const meta = readMeta(bp);
    const t = await squad().workspace('AP-1');
    writeMeta(bp, { ...meta, repos: meta.repos!.map((r) => (r.path === 'api-server' ? { ...r, commands: { start: 'node server.js' } } : r)) });
    expect(productPlan(bp, readMeta(bp), t).why).toBe('squad-kit does not know the address of API yet. An engineer can set it in Settings.');
    writeMeta(bp, { ...meta, repos: meta.repos!.map((r) => (r.path === 'web-ui' ? { ...r, commands: { url: `http://localhost:${webPort}` } } : r)) });
    expect(productPlan(bp, readMeta(bp), t).why).toBe('squad-kit does not know how to start Web app yet. An engineer can set it in Settings.');
  });
});

describe('running it', () => {
  it('starts in order, the change from its copy and the rest from main, and all of it stops together', async () => {
    story();
    const t = await squad().workspace('AP-1');
    fs.writeFileSync(path.join(t.worktree!, 'who.txt'), 'story\n');
    const front = await startProduct(bp, t, 'AP-1', 'story');
    expect(front.url).toBe(`http://localhost:${webPort}`);
    expect(await get(apiPort)).toBe('api story');
    expect(await get(webPort)).toBe('web main no-env');
    expect(productHold(bp)?.holder).toBe('AP-1');
    // Coming back starts nothing twice.
    expect((await startProduct(bp, t, 'AP-1', 'story')).url).toBe(front.url);
    stopProduct(bp, 'AP-1');
    expect(await until(async () => (await get(apiPort)) === null && (await get(webPort)) === null)).toBe(true);
    expect(productHold(bp)).toBeNull();
  });

  it('a copy of main has the values kept for stories, never the person own', async () => {
    fs.writeFileSync(path.join(root, 'web-ui', '.env.dev'), 'KEY=REAL\n');
    addLocalFile(bp, 'web-ui', '.env.dev');
    const f = storyFile(bp, { repo: 'web-ui', path: '.env.dev' });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'KEY=TEST\n');
    story();
    const t = await squad().workspace('AP-1');
    await startProduct(bp, t, 'AP-1', 'story');
    expect(await get(webPort)).toBe('web main KEY=TEST');
  });

  it('a copy of main sets up once, and again when what it needs changes', async () => {
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, repos: meta.repos!.map((r) => (r.path === 'web-ui' ? { ...r, commands: { ...r.commands, setup: 'node -e "require(\'fs\').appendFileSync(\'setup-ran.txt\',\'x\')"' } } : r)) });
    story();
    const t = await squad().workspace('AP-1');
    const count = () => fs.readFileSync(path.join(mainCopyDir(bp, 'web-ui'), 'setup-ran.txt'), 'utf8').length;
    await startProduct(bp, t, 'AP-1', 'story');
    expect(count()).toBe(1);
    stopProduct(bp, 'AP-1');
    await until(async () => (await get(apiPort)) === null && (await get(webPort)) === null);
    await startProduct(bp, t, 'AP-1', 'story');
    expect(count()).toBe(1);
    stopProduct(bp, 'AP-1');
    await until(async () => (await get(apiPort)) === null && (await get(webPort)) === null);
    const web = path.join(root, 'web-ui');
    fs.writeFileSync(path.join(web, 'package-lock.json'), '{}\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm deps', web);
    await startProduct(bp, t, 'AP-1', 'story');
    expect(count()).toBe(2);
  });

  it('a part that will not start says which, stops what started, and lets go', async () => {
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, repos: meta.repos!.map((r) => (r.path === 'api-server' ? { ...r, commands: { ...r.commands, start: 'node -e "process.exit(3)"' } } : r)) });
    story();
    const t = await squad().workspace('AP-1');
    const err = await startProduct(bp, t, 'AP-1', 'story').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProductError);
    expect((err as Error).message).toBe('squad-kit could not start API.');
    expect((err as InstanceType<typeof ProductError>).detail).toContain('stopped while starting');
    expect(productHold(bp)).toBeNull();
  });

  it('never moves off an address another program has: it says so plainly, and starts nothing else', async () => {
    const other = http.createServer((_q, s) => s.end('theirs')).listen(apiPort);
    others.push(other);
    await until(async () => (await get(apiPort)) === 'theirs');
    story();
    const t = await squad().workspace('AP-1');
    const err = await startProduct(bp, t, 'AP-1', 'story').catch((e: unknown) => e);
    expect((err as Error).message).toBe('Another program on this computer is using the address of API, so squad-kit could not run the product. Close that program, then press Try again.');
    expect(await get(apiPort)).toBe('theirs');
    expect(await get(webPort)).toBeNull();
    expect(productHold(bp)).toBeNull();
  });

  it('startApp keeps moving ports for a project with one part, and refuses to when told to stay', async () => {
    const other = http.createServer((_q, s) => s.end('theirs')).listen(apiPort);
    others.push(other);
    await until(async () => (await get(apiPort)) === 'theirs');
    const dir = path.join(root, 'api-server');
    await expect(startApp(dir, 'node server.js', `http://localhost:${apiPort}`, 1000, undefined, undefined, { fixed: true })).rejects.toBeInstanceOf(AddressTaken);
  });
});

describe('one at a time', () => {
  it('the next one waits, says for whom once, and goes on when it is free', async () => {
    expect(takeProduct(bp, 'AP-1', 'story')).toBeNull();
    const said: string[] = [];
    let done = false;
    const waiting = waitForProduct(bp, 'AP-2', 'story', { lookMs: 20, onWait: (hold) => said.push(waitWords(hold)) }).then(() => (done = true));
    await sleep(120);
    expect(done).toBe(false);
    expect(said).toEqual(['Waiting for AP-1: only one story at a time runs the product.']);
    expect(productHold(bp)?.wanted).toBe('AP-2');
    leaveProduct(bp, 'AP-1');
    await waiting;
    expect(productHold(bp)?.holder).toBe('AP-2');
  });

  it('a holder may come back, and a Stop or too long a wait ends the wait', async () => {
    expect(takeProduct(bp, 'AP-1', 'story')).toBeNull();
    expect(takeProduct(bp, 'AP-1', 'story')).toBeNull();
    const ctl = new AbortController();
    const stopped = waitForProduct(bp, 'AP-2', 'story', { lookMs: 10, signal: ctl.signal });
    ctl.abort();
    await expect(stopped).rejects.toThrow('You stopped the squad.');
    await expect(waitForProduct(bp, 'AP-2', 'story', { lookMs: 5, limitMs: 20 })).rejects.toThrow('AP-1 kept the running product too long');
  });

  it('a holder whose program is gone holds nothing', () => {
    fs.mkdirSync(bp.localDir, { recursive: true });
    fs.writeFileSync(path.join(bp.localDir, 'product-lock.json'), JSON.stringify({ holder: 'AP-9', kind: 'story', pid: 999999, at: new Date().toISOString() }));
    expect(productHold(bp)).toBeNull();
    expect(takeProduct(bp, 'AP-1', 'story')).toBeNull();
  });

  it('only the holder lets go', () => {
    takeProduct(bp, 'AP-1', 'story');
    leaveProduct(bp, 'AP-2');
    expect(productHold(bp)?.holder).toBe('AP-1');
  });

  it('says who it waits for, in plain words', () => {
    const at = new Date().toISOString();
    expect(waitWords({ holder: 'Your apps', kind: 'apps', pid: 1, at })).toContain('Stop them, and this goes on');
    expect(waitWords({ holder: 'try:AP-3', kind: 'try', pid: 1, at })).toBe('Waiting for you to finish trying AP-3: it uses the same addresses.');
  });

  it('a project may take fewer stories at once than the app allows', () => {
    const s = squad();
    expect(s.mayStart(2)).toBe(true);
    writeMeta(bp, { ...readMeta(bp), atOnce: 1 });
    Object.defineProperty(s, 'ticketsRunning', { value: () => 1 });
    expect(s.mayStart(5)).toBe(false);
  });
});

describe("the agent's window", () => {
  it('start_app brings up the whole product, and it all stops with the run', async () => {
    story();
    const s = squad();
    const t = await s.workspace('AP-1');
    fs.writeFileSync(path.join(t.worktree!, 'who.txt'), 'story\n');
    const seen: Record<string, string | null> = {};
    h.during = async (opts) => {
      seen.answer = textOf(await callTool(opts.window!, 'start_app', {}));
      seen.api = await get(apiPort);
      seen.web = await get(webPort);
    };
    await s.runBuilder('AP-1', 'Build it', false, 'build');
    expect(seen.answer).toContain(`The app runs at http://localhost:${webPort}`);
    expect(seen.api).toBe('api story');
    expect(seen.web).toContain('web main');
    expect(await until(async () => (await get(apiPort)) === null && (await get(webPort)) === null)).toBe(true);
    expect(productHold(bp)).toBeNull();
  });

  it('a part with no address gives no app tools, and the Builder works on', async () => {
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, repos: meta.repos!.map((r) => (r.path === 'api-server' ? { ...r, commands: { start: 'node server.js' } } : r)) });
    story();
    const s = squad();
    await s.workspace('AP-1');
    let tools: string[] = [];
    h.during = (opts) => {
      tools = opts.window!.tools;
    };
    await s.runBuilder('AP-1', 'Build it', false, 'build');
    expect(tools).not.toContain('start_app');
    expect(tools).toContain('run_checks');
  });
});

describe('Try it yourself', () => {
  const atReview = () => updateTicket(bp, 'AP-1', (x) => {
    x.stage = 'review';
    x.waiting = { kind: 'proof', summary: 'The proof is ready' };
    x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
  });

  it('runs the whole product for the person, and all of it stops', async () => {
    story();
    const t = await squad().workspace('AP-1');
    fs.writeFileSync(path.join(t.worktree!, 'who.txt'), 'story\n');
    atReview();
    const runner = new TryRunner(bp);
    runner.start('AP-1');
    const st = await runner.settled('AP-1');
    expect(st.state).toBe('running');
    expect(st.url).toBe(`http://localhost:${webPort}`);
    expect(await get(apiPort)).toBe('api story');
    expect(productHold(bp)?.holder).toBe('try:AP-1');
    await runner.stop('AP-1');
    expect(await until(async () => (await get(apiPort)) === null && (await get(webPort)) === null)).toBe(true);
    expect(productHold(bp)).toBeNull();
  });

  it('a forgotten copy ends once a story wants the product, and not before a while', async () => {
    story();
    await squad().workspace('AP-1');
    atReview();
    const runner = new TryRunner(bp);
    runner.start('AP-1');
    await runner.settled('AP-1');
    const hold = productHold(bp)!;
    fs.writeFileSync(path.join(bp.localDir, 'product-lock.json'), JSON.stringify({ ...hold, wanted: 'AP-2' }));
    await runner.look();
    expect(productHold(bp)?.holder).toBe('try:AP-1');
    (runner as unknown as { run: { since: string } }).run.since = new Date(Date.now() - 60 * 60_000).toISOString();
    await runner.look();
    expect(productHold(bp)).toBeNull();
    expect(readTicket(bp, 'AP-1')!.activity.some((a) => a.text.includes('AP-2 needs the product now'))).toBe(true);
    await runner.stop();
  });

  it('says what it does not know yet, in place of trying', async () => {
    const meta = readMeta(bp);
    story();
    await squad().workspace('AP-1');
    atReview();
    writeMeta(bp, { ...meta, repos: meta.repos!.map((r) => (r.path === 'api-server' ? { ...r, commands: { start: 'node server.js' } } : r)) });
    expect(() => new TryRunner(bp).start('AP-1')).toThrow('squad-kit does not know the address of API yet');
  });
});

describe('Your apps', () => {
  it('waits for no one: a story running the product means try again later, in plain words', async () => {
    takeProduct(bp, 'AP-1', 'story');
    const apps = new AppRunner(bp);
    apps.start('API');
    const api = await apps.settled('API');
    expect(api.state).toBe('failed');
    expect(api.error).toContain('The squad is running the product for AP-1');
    expect(await get(apiPort)).toBeNull();
    leaveProduct(bp, 'AP-1');
  });

  it('holds the product while it runs, keeps the address, and lets go when stopped', async () => {
    const apps = new AppRunner(bp);
    apps.start('API');
    expect(await until(async () => (await get(apiPort)) !== null, 20_000)).toBe(true);
    expect(productHold(bp)?.holder).toBe('Your apps');
    await apps.stop('API');
    expect(productHold(bp)).toBeNull();
  });
});

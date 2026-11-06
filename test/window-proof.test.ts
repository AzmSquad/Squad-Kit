import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import type { SandboxSupport } from '../src/modules/ai-tool/types.js';
import { tinyApp } from './support/tiny-app.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, savedFiles } from './support/window.js';
import { checkAnswer, isProofCheck } from './support/proof-check.js';

/**
 * The proof through the window, with a fake Tester that presses squad-kit's tools: the rows get the page each picture
 * was taken at, and every stop the person sees is one plain sentence with Try again, its technical words kept for
 * engineers. No proof run asks for a browser let out of the sandbox, and Settings says "Windows: less protected"
 * where the agents' own commands have no guard.
 */

type Answer = { shots: { criterion: number; file: string; shows: 'met' | 'broken' | 'not-shown'; note: string }[]; offScreen: { criterion: number; why: string }[] };
let tester: (opts: RunOptions) => Promise<Answer> = async () => ({ shots: [], offScreen: [] });
const calls: RunOptions[] = [];
const h = vi.hoisted(() => ({ browser: null as BrowserModule | null, support: { available: true, why: "Claude Code's sandbox (macOS Seatbelt)" } as SandboxSupport }));
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    // squad-kit's own check of the pictures says each one is met.
    return { ok: true, structured: isProofCheck(opts) ? checkAnswer(opts) : await tester(opts), text: '', sessionId: opts.resume ?? opts.sessionId ?? 't-1' } as RunResult;
  },
}));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));
vi.mock('../src/modules/claude/sandbox.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/sandbox.js')>()),
  claudeSandboxSupport: () => h.support,
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { GUARD_BLOCKED_DOCKER, guardSupport } = await import('../src/engine/project-guard.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { isPlain } = await import('../src/engine/shots.js');
const { guardNote } = await import('../src/engine/sandbox.js');
const { openWindows } = await import('../src/engine/window-server.js');
const { mountApi } = await import('../src/console/api/index.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
let id: string;
type Squad = { proof(id: string): Promise<void> };

beforeEach(async () => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-window-proof-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  const app = await tinyApp();
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: { start: app.start, url: app.url } });
  const wt = path.join(tmp, 'copy');
  fs.mkdirSync(wt);
  const t0 = actions.createTicket(bp, { title: 'Book a room' });
  id = t0.id;
  updateTicket(bp, id, (x) => {
    x.stage = 'review';
    x.live = true;
    x.squad = null;
    x.worktree = wt;
    x.sessions = { tester: 't-1' };
    x.criteria = [
      { given: 'Sara is signed in', when: 'she books Room A for Monday 10:00', then: 'the booking shows as Confirmed' },
      { given: 'a booked slot', when: 'Omar books the same slot', then: 'he is told it is taken' },
    ];
    x.work = { steps: 1, tests: 1, screens: 2 };
    x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
  });
  h.browser = fakeBrowser({
    '/': { has: ['label:Email', 'button:Sign in'], opens: { 'button:Sign in': '/book' } },
    '/book': { has: ['label:Room', 'button:Book'], opens: { 'button:Book': '/book?done=1' } },
  }).module;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ticket = () => readTicket(bp, id)!;
const lines = () => ticket().activity.map((a) => a.text);

describe('the proof through the window', () => {
  it('the Tester takes the pictures with the tools; each row gets its page and one plain note', async () => {
    tester = async (opts) => {
      const [a] = savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: [{ page: '/', steps: [{ action: 'click', target: { role: 'button', name: 'Sign in' } }, { action: 'click', target: { role: 'button', name: 'Book' } }] }] }));
      const [b] = savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: [{ page: '/book', size: 'phone' }] }));
      return {
        shots: [
          { criterion: 1, file: a!, shows: 'met', note: 'Sara’s booking for Monday shows as Confirmed.' },
          { criterion: 2, file: b!, shows: 'met', note: 'Run npm test in the terminal to see it.' },
        ],
        offScreen: [],
      };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = ticket();
    expect(t.waiting?.kind).toBe('proof');
    expect(t.proof).toEqual([
      expect.objectContaining({ criterion: 'The booking shows as Confirmed', after: `${id.toLowerCase()}-after-1.png`, page: '/book?done=1', note: 'Sara’s booking for Monday shows as Confirmed.' }),
      expect.objectContaining({ criterion: 'He is told it is taken', after: `${id.toLowerCase()}-after-2.png`, page: '/book' }),
    ]);
    // A technical note never reaches the person: it stays in the activity.
    expect(t.proof![1]!.note).toBeUndefined();
    expect(lines().some((l) => l.startsWith('The Tester wrote something technical, so it stays out of the proof'))).toBe(true);
    // The Tester only read and used the window; no browser was let out of the sandbox for it.
    const run = calls[0]!;
    expect(run.sandbox).toBeDefined();
    expect(run.sandbox).not.toHaveProperty('excludedCommands');
    expect(run.allowedTools).not.toContain('Bash');
    expect(run.prompt).toContain('take_screenshots');
    expect(run.prompt).toContain('use the nearest example that fits every rule, and say so in the note');
    // The window closed with the run: its app stopped and its key no longer works.
    expect(openWindows()).toBe(0);
  });

  it('an app that tries Docker to start: the stop says so, where the guard runs', async () => {
    if (!guardSupport().on) return;
    writeMeta(bp, { ...readMeta(bp), commands: { start: 'node -e "console.error(\'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\'); process.exit(1)"', url: 'http://127.0.0.1:47391' } });
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    expect(ticket().stuck?.question).toBe(GUARD_BLOCKED_DOCKER);
  });

  it('an app that does not start: a plain stop with Try again, the output for engineers, and no Tester', async () => {
    writeMeta(bp, { ...readMeta(bp), commands: { start: 'node -e "console.error(\'Error: listen EADDRINUSE: address already in use 127.0.0.1:8000\'); process.exit(1)"', url: 'http://127.0.0.1:47391' } });
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = ticket();
    expect(calls).toHaveLength(0);
    expect(t.stuck?.question).toBe('squad-kit could not start the app, so it took no screenshots. Press Try again to try once more.');
    expect(t.stuck?.options.map((o) => o.do)).toContain('retry');
    expect(t.stuck?.detail).toContain('EADDRINUSE');
    expect(isPlain(t.stuck!.question)).toBe(true);
  });

  it('a Tester stuck on something technical: squad-kit tries, then one plain sentence; its words go to engineers only', async () => {
    tester = async (opts) => {
      await callTool(opts.window!, 'i_am_stuck', { what: 'Chrome will not launch', why: 'bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer: Permission denied (1100)' });
      return { shots: [], offScreen: [1, 2].map((criterion) => ({ criterion, why: 'The sandbox blocks Chrome (Mach port), so no screenshots.' })) };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = ticket();
    expect(t.stuck?.question).toBe('The Tester got stuck on something technical that squad-kit could not fix, so there are no screenshots yet. Press Try again to try once more.');
    expect(t.stuck?.options[0]?.do).toBe('retry');
    expect(t.stuck?.detail).toContain('bootstrap_check_in');
    for (const text of [t.stuck!.question, ...(t.stuck!.points ?? []), t.waiting!.summary]) expect(isPlain(text), text).toBe(true);
    // The activity says what happened in plain words; the Tester's own words are in the details and the log.
    expect(lines()).toContain('The Tester was stuck on the screenshot browser. squad-kit started its own browser again, and it works.');
    expect(lines().join('\n')).not.toMatch(/bootstrap_check_in|Mach|Chrome will not launch/);
  });

  it("squad-kit's browser is set up before the Tester starts, and the ticket says so in one plain line", async () => {
    const order: string[] = [];
    const base = h.browser!;
    h.browser = {
      ...base,
      async prepare(o) {
        order.push('prepare');
        o?.onLine?.("Setting up squad-kit's screenshot browser. This happens only once.");
      },
    };
    tester = async () => {
      order.push('tester');
      return { shots: [], offScreen: [1, 2].map((criterion) => ({ criterion, why: 'It needs a second person.' })) };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    expect(order).toEqual(['prepare', 'tester']);
    expect(lines()).toContain("Setting up squad-kit's screenshot browser. This happens only once.");
  });

  it("a browser that cannot be set up: a plain stop before any Tester runs, the details for engineers", async () => {
    const { BrowserSetupError } = await import('../src/modules/browser/types.js');
    h.browser = {
      ...h.browser!,
      async prepare() {
        throw new BrowserSetupError('Getting Chromium did not work', 'npm ERR! code ENOTFOUND registry.npmjs.org');
      },
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = ticket();
    expect(calls).toHaveLength(0);
    expect(t.stuck?.question).toBe('squad-kit could not set up its screenshot browser. Check the internet connection, then press Try again.');
    expect(t.stuck?.detail).toContain('ENOTFOUND');
  });

  it("the friend's case in what the Tester skipped: refused, logged, never shown", async () => {
    tester = async () => ({
      shots: [],
      offScreen: [
        { criterion: 1, why: 'Please edit .squad/config.json to set the test command' },
        { criterion: 2, why: 'It needs a second person signed in at the same time.' },
      ],
    });
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = ticket();
    expect(lines()).toContain("The Tester asked to change squad-kit's settings. squad-kit refused, and did not bother you with it.");
    expect(t.stuck?.question).toBe('The Tester took no screenshots, so the proof is not ready yet. The Tester says: It needs a second person signed in at the same time.');
    expect(JSON.stringify(t.stuck)).not.toContain('.squad');
    // A reason that was refused is no reason: that "done when" still needs its picture.
    expect(t.stuck?.points).toEqual(['The booking shows as Confirmed: The Tester took no picture of it.']);
    expect(t.offScreen).toEqual([{ criterion: 'He is told it is taken', why: 'It needs a second person signed in at the same time.' }]);
  });

  it('a Tester that keeps asking for what it may not do is stopped, in plain words', async () => {
    tester = async (opts) => {
      for (const page of ['https://evil.example.com', '//evil.example.com', 'file:///etc/passwd']) await callTool(opts.window!, 'take_screenshots', { shots: [{ page }] });
      return { shots: [], offScreen: [] };
    };
    await (new LiveSquad(bp) as unknown as Squad).proof(id);
    const t = ticket();
    expect(t.stuck?.question).toBe('The Tester kept asking for things it may not do, so squad-kit stopped it.');
    expect(t.stuck?.options[0]?.do).toBe('retry');
    expect(t.stuck?.detail).toContain('outside the app');
    expect(lines().filter((l) => l === 'The Tester asked to open another website. squad-kit refused.')).toHaveLength(3);
  });
});

describe('no browser is let out of the sandbox any more', () => {
  it('no npx playwright exception and no browser box is left in the code', () => {
    const src = path.resolve(__dirname, '../src');
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : /\.ts$/.test(d.name) ? [path.join(dir, d.name)] : []));
    const found = files(src).filter((f) => /npx (-y )?playwright|browser: true|excludedCommands|outside: BROWSER/.test(fs.readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });
});

describe('Windows', () => {
  it('The Harness page says "Windows: less protected" in one plain sentence where the agents\' commands have no guard', async () => {
    expect(guardNote('win32', [{ available: false, why: "Claude Code's sandbox does not run on Windows yet" }])).toEqual({
      title: 'Windows: less protected',
      text: "On Windows, squad-kit does not guard the agents' own commands, or the project's own tests and app, so they can reach other files on this computer. Use it on projects you trust.",
    });
    expect(guardNote('darwin', [{ available: true, why: 'macOS Seatbelt' }])).toBeNull();
    expect(guardNote('linux', [{ available: false, why: 'socat is not installed' }])).toBeNull();
    // On the board: the sandbox call carries it, for the Harness page.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    h.support = { available: false, why: "Claude Code's sandbox does not run on Windows yet" };
    try {
      const app = new Hono();
      mountApi(app, { paths: buildPaths(tmp) });
      const info = (await (await app.request('/api/v1/sandbox')).json()) as { note?: { title: string; text: string } };
      expect(info.note?.title).toBe('Windows: less protected');
      expect(isPlain(info.note!.text)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      h.support = { available: true, why: "Claude Code's sandbox (macOS Seatbelt)" };
    }
  });
});

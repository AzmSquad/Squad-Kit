import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { fakeBrowser, type FakeBrowser } from './fakes/browser.js';
import { freePort, tinyApp } from './support/tiny-app.js';
import { savedFiles, textOf } from './support/window.js';

/**
 * The window's safety, as an independent review asked (2026-11-04): nothing it starts outlives its run, a picture is
 * never written through a link, a stopped agent's calls do nothing, every call answers well within the agent's own
 * limit for a tool, and the story only gets plain lines. squad-kit's browser is a fake; the apps are real tiny ones.
 */

const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

const { AgentWindow, ALL_TOOLS, STILL_STARTING, BROWSER_STARTING } = await import('../src/engine/window.js');
const { CALL_MS, SETTING_UP, takeOne, writeNew } = await import('../src/engine/shots.js');

let tmp: string;
let proof: string;
let fake: FakeBrowser;
let lines: string[];
let logged: string[];
const opened: InstanceType<typeof AgentWindow>[] = [];

const SCREENS = { '/': { has: ['button:Save'] }, '/book': { has: [] } };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-window-safety-')));
  proof = path.join(tmp, 'proof');
  lines = [];
  logged = [];
  fake = fakeBrowser(SCREENS);
  h.browser = fake.module;
});

afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A Tester's window on an app squad-kit starts itself. */
function windowOn(app: { start: string; url: string }, more: Partial<ConstructorParameters<typeof AgentWindow>[0]> = {}) {
  const cwd = path.join(tmp, 'copy');
  fs.mkdirSync(cwd, { recursive: true });
  const w = new AgentWindow({
    ticket: 'RO-7',
    step: 'proof',
    who: 'Tester',
    tools: ALL_TOOLS,
    app: { cwd, start: app.start, url: app.url },
    proofDir: proof,
    prefix: 'ro-7-after',
    say: (t) => lines.push(t),
    log: (t) => logged.push(t),
    limits: { appWaitMs: 15_000 },
    ...more,
  });
  opened.push(w);
  return w;
}

/** An app that answers only `ms` after it starts, like a dev server that builds first. */
async function slowApp(ms: number): Promise<{ start: string; url: string; port: number }> {
  const port = await freePort();
  return { start: `node -e "setTimeout(() => require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1'), ${ms})"`, url: `http://127.0.0.1:${port}`, port };
}

const answers = (url: string) => fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('nothing the window starts outlives its run', () => {
  it('an app still starting when the run ends is stopped, and never comes up', async () => {
    const app = await slowApp(1500);
    const w = windowOn(app);
    const call = w.call('start_app', {});
    // The app's command runs; the run ends before it answers.
    await sleep(300);
    await w.close();
    expect(textOf(await call)).toBe('You were stopped. squad-kit takes no more calls in this run.');
    await sleep(2500);
    expect(await answers(app.url)).toBe(false);
    expect(lines.some((l) => l.startsWith('squad-kit started the app'))).toBe(false);
  }, 15_000);

  it('a browser i_am_stuck starts again while the run ends is closed too', async () => {
    // The old browser takes a while to close, so the run ends while i_am_stuck waits for it.
    fake = fakeBrowser(SCREENS, { launchMs: 200 });
    const slowClose = fake.module.launch;
    fake.module.launch = async (o) => {
      const b = await slowClose(o);
      return { ...b, close: async () => (await sleep(300), b.close()) };
    };
    h.browser = fake.module;
    const app = await tinyApp();
    const w = windowOn(app);
    expect(savedFiles(await w.call('take_screenshots', { shots: [{ page: '/' }] }))).toHaveLength(1);
    expect(fake.open).toBe(1);
    const stuck = w.call('i_am_stuck', { what: 'The browser does not open', why: 'Chromium crashed' });
    await sleep(50);
    await w.close();
    await stuck;
    await sleep(1200);
    expect(fake.open).toBe(0);
  }, 15_000);
});

describe('a picture is never written through a link', () => {
  it('a link to nowhere in the proof folder is skipped: the picture gets the next free name, and nothing outside is written', async () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(proof, { recursive: true });
    fs.symlinkSync(path.join(outside, 'victim.png'), path.join(proof, 'ro-7-after-1.png'));
    fs.writeFileSync(path.join(outside, 'kept.txt'), 'mine');
    fs.symlinkSync(path.join(outside, 'kept.txt'), path.join(proof, 'ro-7-after-2.png'));
    const w = windowOn(await tinyApp());
    const a = await w.call('take_screenshots', { shots: [{ page: '/' }] });
    expect(savedFiles(a)).toEqual(['ro-7-after-3.png']);
    expect(fs.existsSync(path.join(outside, 'victim.png'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'kept.txt'), 'utf8')).toBe('mine');
    expect(fs.lstatSync(path.join(proof, 'ro-7-after-3.png')).isFile()).toBe(true);
  }, 15_000);

  it('writes only new files, never through a link', () => {
    const file = path.join(tmp, 'a.png');
    expect(writeNew(file, Buffer.from('one'))).toBe(true);
    expect(writeNew(file, Buffer.from('two'))).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('one');
    fs.symlinkSync(path.join(tmp, 'nowhere.png'), path.join(tmp, 'link.png'));
    expect(writeNew(path.join(tmp, 'link.png'), Buffer.from('x'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'nowhere.png'))).toBe(false);
  });

  it("the first run's picture replaces a link at its name instead of writing through it", async () => {
    const app = await tinyApp();
    const { startApp } = await import('../src/engine/checks.js');
    const running = await startApp(tmp, app.start, app.url, 15_000);
    try {
      const file = path.join(proof, 'setup-app.png');
      fs.mkdirSync(proof, { recursive: true });
      fs.symlinkSync(path.join(tmp, 'elsewhere.png'), file);
      await takeOne(app.url, file);
      expect(fs.lstatSync(file).isFile()).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'elsewhere.png'))).toBe(false);
    } finally {
      running.stop();
    }
  }, 15_000);
});

describe("squad-kit's browser is set up before any clock starts", () => {
  it("the first run's picture sets the browser up first, with its own limit, and says so plainly", async () => {
    const app = await tinyApp();
    const { startApp } = await import('../src/engine/checks.js');
    const running = await startApp(tmp, app.start, app.url, 15_000);
    const timers: number[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout');
    let timersWhilePreparing: number[] | null = null;
    const said: string[] = [];
    h.browser = {
      ...fake.module,
      async prepare(o) {
        o?.onLine?.(SETTING_UP);
        timersWhilePreparing = spy.mock.calls.map((c) => Number(c[1])).filter((ms) => ms === 90_000);
      },
    };
    try {
      await takeOne(app.url, path.join(proof, 'setup-app.png'), { onLine: (t) => said.push(t) });
      timers.push(...spy.mock.calls.map((c) => Number(c[1])));
    } finally {
      running.stop();
    }
    expect(said).toEqual(["Setting up squad-kit's screenshot browser. This happens only once."]);
    // No 90-second picture clock ran while the browser was set up; it started after.
    expect(timersWhilePreparing).toEqual([]);
    expect(timers).toContain(90_000);
  }, 15_000);
});

describe('a stopped agent', () => {
  it('after the third refusal, every call is refused and does nothing, without the ticket being stopped', async () => {
    const app = await tinyApp();
    const w = windowOn(app);
    let stopped = 0;
    w.whenTooMany(() => (stopped += 1));
    for (const page of ['https://a.example.com', '//b.example.com', 'file:///etc/hosts']) await w.call('look_at_page', { page });
    expect(stopped).toBe(1);
    const after = await w.call('start_app', {});
    expect(after.isError).toBe(true);
    expect(textOf(after)).toBe('squad-kit stopped you after 3 refused requests. It takes no more calls in this run.');
    expect(textOf(await w.call('take_screenshots', { shots: [{ page: '/' }] }))).toContain('takes no more calls');
    await sleep(500);
    expect(await answers(app.url)).toBe(false);
    expect(fake.launches).toBe(0);
    expect(lines.some((l) => l.startsWith('squad-kit started the app'))).toBe(false);
  }, 15_000);
});

describe('every call answers well within the agent’s own limit for a tool', () => {
  it('takes about 150 seconds at most in all, under the four minutes the agent waits', () => {
    expect(CALL_MS).toBeLessThanOrEqual(150_000);
  });

  it('an app that starts slowly: start_app says it is still starting, the start goes on, and app_status follows it', async () => {
    const app = await slowApp(3000);
    const w = windowOn(app, { limits: { appWaitMs: 15_000, callMs: 1000 } });
    const t0 = Date.now();
    const a = await w.call('start_app', {});
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(textOf(a)).toBe(STILL_STARTING);
    expect(textOf(await w.call('app_status', {}))).toBe('The app is still starting. Call app_status again in a moment.');
    // take_screenshots does not wait past its time either.
    expect(textOf(await w.call('take_screenshots', { shots: [{ page: '/' }] }))).toBe(STILL_STARTING);
    await vi.waitFor(async () => expect(textOf(await w.call('app_status', {}))).toMatch(/^The app runs at http:\/\/127\.0\.0\.1:\d+ and answers\./), { timeout: 10_000, interval: 300 });
    expect(savedFiles(await w.call('take_screenshots', { shots: [{ page: '/' }] }))).toEqual(['ro-7-after-1.png']);
  }, 20_000);

  it('a browser still being set up the first time: the call says so, and the next call finds it ready', async () => {
    fake = fakeBrowser(SCREENS, { launchMs: 1500 });
    h.browser = fake.module;
    const app = await tinyApp();
    const { startApp } = await import('../src/engine/checks.js');
    const running = await startApp(tmp, app.start, app.url, 15_000);
    const w = windowOn(app, { running, limits: { callMs: 800 } });
    const t0 = Date.now();
    expect(textOf(await w.call('take_screenshots', { shots: [{ page: '/' }] }))).toBe(BROWSER_STARTING);
    expect(Date.now() - t0).toBeLessThan(1500);
    await sleep(1200);
    expect(savedFiles(await w.call('take_screenshots', { shots: [{ page: '/' }] }))).toEqual(['ro-7-after-1.png']);
    expect(fake.launches).toBe(1);
  }, 15_000);
});

describe('the story gets plain lines; the exact words go to engineers', () => {
  it('an app that does not start: one plain line on the story, its output in the log and for the agent', async () => {
    const w = windowOn({ start: 'node -e "console.error(\'Error: listen EADDRINUSE 127.0.0.1:8000\'); process.exit(1)"', url: `http://127.0.0.1:${await freePort()}` });
    const a = await w.call('start_app', {});
    expect(textOf(a)).toContain('EADDRINUSE');
    expect(lines).toContain('squad-kit could not start the app for the Tester.');
    expect(lines.join('\n')).not.toContain('EADDRINUSE');
    expect(logged.join('\n')).toContain('EADDRINUSE');
  }, 15_000);

  it("i_am_stuck: the agent's words and the browser's errors stay out of the story", async () => {
    h.browser = fakeBrowser(SCREENS, { fail: new Error('browserType.launch: Target page, context or browser has been closed (SIGTRAP)') }).module;
    const w = windowOn(await tinyApp());
    const a = await w.call('i_am_stuck', { what: 'Playwright cannot launch Chromium', why: 'bootstrap_check_in: Permission denied (1100)' });
    expect(textOf(a)).toContain('SIGTRAP');
    expect(lines).toContain('The Tester was stuck on the screenshot browser, and squad-kit could not fix it.');
    expect(lines.join('\n')).not.toMatch(/SIGTRAP|bootstrap_check_in|Playwright|Chromium/);
    expect(logged.join('\n')).toContain('bootstrap_check_in');
    expect(w.stuck[0]).toMatchObject({ what: 'Playwright cannot launch Chromium', why: 'bootstrap_check_in: Permission denied (1100)' });
  }, 15_000);
});

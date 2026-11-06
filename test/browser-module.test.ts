import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './support/tiny-app.js';

/**
 * squad-kit's own browser module and the app's port settings: Playwright is installed once under squad-kit's folder on
 * first need, its pages never download, never pick a file and never leave the app at the top; the app's own port
 * variable moves with PORT; and every reason the browser gives a person is plain.
 */

const { readyPlaywright, preparePlaywright, singleFlight, wrapBrowser, PLAYWRIGHT_VERSION, SETTING_UP } = await import('../src/modules/playwright/index.js');
const { isLocalHost, blockedFrom } = await import('../src/modules/browser/addresses.js');
const { BrowserSetupError, StepFailure } = await import('../src/modules/browser/types.js');
const { findPortVariables, appPortVariables } = await import('../src/engine/port-vars.js');
const { startApp } = await import('../src/engine/checks.js');
const S = await import('../src/engine/shots.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-browser-')));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("squad-kit's own Playwright", () => {
  it('is installed once, on first need, even when two tickets ask at the same moment', async () => {
    const dir = path.join(tmp, 'tools', 'playwright');
    const installs: string[] = [];
    const run = async (_file: string, args: string[], o: { cwd: string }) => {
      installs.push(args[1]!);
      await new Promise((r) => setTimeout(r, 50));
      const pkg = path.join(o.cwd, 'node_modules', 'playwright-core');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: PLAYWRIGHT_VERSION }));
      fs.writeFileSync(path.join(pkg, 'index.mjs'), 'export const chromium = {};');
      return { ok: true, output: '' };
    };
    const [a, b] = await Promise.all([readyPlaywright({ dir, run }), readyPlaywright({ dir, run })]);
    expect(installs).toEqual([`playwright-core@${PLAYWRIGHT_VERSION}`]);
    expect(a).toBe(path.join(dir, 'node_modules', 'playwright-core', 'index.mjs'));
    expect(b).toBe(a);
    await readyPlaywright({ dir, run });
    expect(installs).toHaveLength(1);
    // Nothing half-made is left beside it.
    expect(fs.readdirSync(path.dirname(dir))).toEqual(['playwright']);
  });

  it('an install that does not work leaves nothing that looks ready', async () => {
    const dir = path.join(tmp, 'tools', 'playwright');
    const err = await readyPlaywright({ dir, run: async () => ({ ok: false, output: 'npm ERR! code ENOTFOUND' }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserSetupError);
    expect((err as InstanceType<typeof BrowserSetupError>).detail).toContain('ENOTFOUND');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('runs one job per key at a time', async () => {
    let n = 0;
    const job = () => singleFlight('k', async () => ++n);
    expect(await Promise.all([job(), job(), job()])).toEqual([1, 1, 1]);
    expect(await job()).toBe(2);
  });

  it('opens pages with no downloads and no file picker, and lets only the app open at the top', async () => {
    const seen: { context?: Record<string, unknown>; events: string[]; aborted: string[]; continued: string[] } = { events: [], aborted: [], continued: [] };
    let route: ((r: unknown) => Promise<void>) | null = null;
    const frame = (url: string, parent: unknown = null) => ({ url: () => url, parentFrame: () => parent });
    const page = { on: (e: string) => seen.events.push(e), close: async () => undefined, url: () => 'about:blank' };
    const pw = {
      newContext: async (o: Record<string, unknown>) => {
        seen.context = o;
        return { route: async (_m: string, fn: (r: unknown) => Promise<void>) => void (route = fn), newPage: async () => page, on: () => undefined, close: async () => undefined };
      },
      close: async () => undefined,
    };
    await wrapBrowser(pw as never).page({ origin: 'http://127.0.0.1:5000', width: 1280, height: 800 });
    expect(seen.context).toMatchObject({ acceptDownloads: false, serviceWorkers: 'block' });
    expect(seen.events).toEqual(expect.arrayContaining(['dialog', 'framenavigated', 'filechooser']));
    const ask = (url: string, nav: boolean, sub = false) => ({
      request: () => ({ url: () => url, isNavigationRequest: () => nav, frame: () => frame(url, sub ? frame('x') : null) }),
      abort: async () => void seen.aborted.push(url),
      continue: async () => void seen.continued.push(url),
    });
    await route!(ask('https://evil.example.com/', true));
    await route!(ask('http://127.0.0.1:9999/', true));
    await route!(ask('http://127.0.0.1:5000/book', true));
    // Its scripts, fonts and pictures may load from anywhere; a frame inside the page is not the top.
    await route!(ask('https://fonts.example.com/a.woff2', false));
    await route!(ask('https://maps.example.com/embed', true, true));
    expect(seen.aborted).toEqual(['https://evil.example.com/', 'http://127.0.0.1:9999/']);
    expect(seen.continued).toEqual(['http://127.0.0.1:5000/book', 'https://fonts.example.com/a.woff2', 'https://maps.example.com/embed']);
    // Nothing else on this computer or a private network loads from the page, in any way it is written.
    seen.aborted.length = 0;
    seen.continued.length = 0;
    const local = [
      'http://127.0.0.1:4999/api/v1/board',
      'http://localhost:3000/api',
      'http://127.0.0.1:5001/x.js',
      'http://10.1.2.3/',
      'http://172.20.0.5/',
      'http://192.168.1.1/admin',
      'http://169.254.169.254/latest/meta-data',
      'http://[fd12::1]/',
      'http://[fe80::1]/',
      'http://[::1]:8080/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:192.168.0.1]/',
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://017700000001/',
      'http://0.0.0.0:8000/',
      'ws://127.0.0.1:24678/',
      'http://printer.local/',
    ];
    for (const url of local) await route!(ask(url, false));
    expect(seen.aborted).toEqual(local);
    // The app itself, named another way on this computer, and the internet, still load.
    for (const url of ['http://localhost:5000/api/rooms', 'http://[::1]:5000/x', 'https://cdn.example.com/a.js', 'http://8.8.8.8/', 'http://[2606:4700::1111]/']) await route!(ask(url, false));
    expect(seen.continued).toEqual(['http://localhost:5000/api/rooms', 'http://[::1]:5000/x', 'https://cdn.example.com/a.js', 'http://8.8.8.8/', 'http://[2606:4700::1111]/']);
  });

  it('knows the addresses on this computer and private networks, in every form', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.8.9.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.1.1', '[::1]', '::', 'fc00::1', 'fdff::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '0.0.0.0', '100.64.0.1']) {
      expect(isLocalHost(host), host).toBe(true);
    }
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '2606:4700::1111', '11.0.0.1']) {
      expect(isLocalHost(host), host).toBe(false);
    }
    expect(blockedFrom('http://localhost:5000/', 'http://127.0.0.1:5000')).toBe(false);
    expect(blockedFrom('http://localhost:5001/', 'http://127.0.0.1:5000')).toBe(true);
    expect(blockedFrom('data:text/plain,hi', 'http://127.0.0.1:5000')).toBe(false);
    // The other parts of the same product: a web app calls its API. Nothing else on this computer.
    expect(blockedFrom('http://localhost:5180/api/x', 'http://localhost:3000', ['http://localhost:5180'])).toBe(false);
    expect(blockedFrom('http://127.0.0.1:5180/api/x', 'http://localhost:3000', ['http://localhost:5180'])).toBe(false);
    expect(blockedFrom('http://localhost:4141/', 'http://localhost:3000', ['http://localhost:5180'])).toBe(true);
    expect(blockedFrom('http://10.0.0.1:5180/', 'http://localhost:3000', ['http://localhost:5180'])).toBe(true);
  });
});

describe("the browser's first setup", () => {
  /** A Playwright install made by the fake npm, with a Chromium build of its own. */
  function fakeInstall(dir: string) {
    const pkg = path.join(dir, 'node_modules', 'playwright-core');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: PLAYWRIGHT_VERSION }));
    fs.writeFileSync(path.join(pkg, 'index.mjs'), 'export const chromium = {};');
    fs.writeFileSync(path.join(pkg, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium-headless-shell', revision: '9999' }] }));
  }

  it('gets Playwright and Chromium before any clock, says one plain line while it downloads, and nothing when both are there', async () => {
    const dir = path.join(tmp, 'tools', 'playwright');
    const cache = path.join(tmp, 'ms-playwright');
    const was = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    const ran: string[] = [];
    const run = async (_file: string, args: string[], o: { cwd: string }) => {
      if (args[0] === 'install' && args[1]?.startsWith('playwright-core@')) {
        ran.push('npm');
        fakeInstall(o.cwd);
      } else {
        ran.push('chromium');
        const shell = path.join(cache, 'chromium_headless_shell-9999');
        fs.mkdirSync(shell, { recursive: true });
        fs.writeFileSync(path.join(shell, 'INSTALLATION_COMPLETE'), '');
      }
      return { ok: true, output: '' };
    };
    try {
      const said: string[] = [];
      await preparePlaywright({ dir, run, onLine: (t) => said.push(t) });
      expect(ran).toEqual(['npm', 'chromium']);
      expect(said).toEqual([SETTING_UP]);
      expect(SETTING_UP).toBe("Setting up squad-kit's screenshot browser. This happens only once.");
      // Another squad-kit folder on this computer with Playwright in it finds Chromium there: nothing runs, nothing is said.
      const other = path.join(tmp, 'other', 'playwright');
      fakeInstall(other);
      const again: string[] = [];
      await preparePlaywright({ dir: other, run, onLine: (t) => again.push(t) });
      expect(ran).toEqual(['npm', 'chromium']);
      expect(again).toEqual([]);
    } finally {
      if (was === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = was;
    }
  });
});

describe('the words a project manager reads', () => {
  it('are plain, and what reached people on two real tickets is not', () => {
    const words = [
      S.NO_BROWSER,
      S.failureWords({ action: 'click', target: { css: '#save' } }, new StepFailure('missing', 'x')).plain,
      S.failureWords(null, new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8001/')).plain,
      ...(['missing', 'hidden', 'disabled', 'option', 'blocked', 'timeout', 'closed', 'other'] as const).map((k) => S.failureWords({ action: 'click', target: { role: 'button', name: 'Save' } }, new StepFailure(k, 'x')).plain),
    ];
    for (const w of words) expect(S.isPlain(w), w).toBe(true);
    for (const said of [
      'The Playwright browser tool was declined by the user, and Chromium cannot launch from the sandboxed shell.',
      'The sandbox blocks Chromium from launching (Mach port permission denied, SIGTRAP), and the Playwright MCP browser tools were refused',
      'The app copy on port 8001 is still running because kill was not permitted',
      'Please edit .squad/config.json to set the test command',
      "TypeError: Cannot read properties of undefined (reading 'id')",
      'write EPIPE',
      'Request failed with status code 529',
    ]) {
      expect(S.isPlain(said), said).toBe(false);
    }
  });
});

describe('the prompts', () => {
  it('the Analyst and the Spec writer keep every example inside the rules of the story', () => {
    const t = { id: 'RO-7', title: 'Book', ask: 'Book a room', kind: 'feature', activity: [], track: 'full' } as never;
    const rule = 'Each example in a "done when" must follow every other rule of the story: a date on an open day, a time inside opening hours';
    expect(P.specPrompt(t)).toContain(rule);
    expect(P.planPrompt(t)).toContain(rule);
    const story = fs.readFileSync(path.resolve(__dirname, '../src/engine/breakdown-prompts.ts'), 'utf8').replace(/\n\s*/g, ' ');
    expect(story).toContain(rule.replace('Each example', 'example'));
  });
});

describe('the app on a free port', () => {
  function write(rel: string, text: string): void {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), text);
  }

  it("finds the app's own port variables in node, python and shell, and leaves other servers' ports alone", () => {
    write('server.js', 'const port = Number(process.env.API_PORT) || 4000;\nconst db = process.env.DB_PORT ?? 5432;\nconst p2 = process.env["WEB_PORT"];\n');
    write('app/main.py', 'import os\nport = int(os.environ.get("ROOMFLOW_PORT", "8000"))\nredis = os.getenv("REDIS_PORT", 6379)\n');
    write('bin/start.sh', 'exec node server.js --port "${SITE_PORT:-5000}" --other "$PORT"\n');
    write('package.json', JSON.stringify({ scripts: { dev: 'vite --port $VITE_PORT' } }));
    write('node_modules/lib/index.js', 'process.env.LIB_PORT');
    write('README.md', 'Set DOCS_PORT with process.env.DOCS_PORT');
    expect(findPortVariables(tmp)).toEqual([
      { name: 'API_PORT', defaults: [4000] },
      { name: 'ROOMFLOW_PORT', defaults: [8000] },
      { name: 'SITE_PORT', defaults: [5000] },
      { name: 'VITE_PORT', defaults: [] },
      { name: 'WEB_PORT', defaults: [] },
    ]);
    expect(appPortVariables(tmp, 8000)).toEqual(['ROOMFLOW_PORT']);
    expect(appPortVariables(tmp, 4000)).toEqual(['API_PORT']);
    expect(appPortVariables(tmp, 3000)).toEqual(['VITE_PORT', 'WEB_PORT']);
  });

  it('stays quick and bounded on a big folder', () => {
    for (let i = 0; i < 40; i += 1) write(`deep/${'d/'.repeat(10)}f${i}.js`, 'process.env.DEEP_PORT');
    write('big.js', `${'x'.repeat(300 * 1024)}process.env.BIG_PORT`);
    const began = Date.now();
    expect(findPortVariables(tmp)).toEqual([]);
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it("starts the copy on a free port through the app's own variable when the usual port is taken", async () => {
    const usual = await freePort();
    const theirs = http.createServer((_q, s) => s.end('theirs')).listen(usual, '127.0.0.1');
    await new Promise((r) => theirs.once('listening', r));
    try {
      write('serve.js', `require('http').createServer((q, s) => s.end('copy')).listen(Number(process.env.SHOTS_APP_PORT || ${usual}), '127.0.0.1');\n`);
      const app = await startApp(tmp, 'node serve.js', `http://127.0.0.1:${usual}`, 20_000);
      try {
        expect(app.url).not.toBe(`http://127.0.0.1:${usual}`);
        expect(await (await fetch(app.url)).text()).toBe('copy');
      } finally {
        app.stop();
      }
    } finally {
      theirs.close();
    }
  });
});

/**
 * An open ticket leaves most of the window for reading, at the screen sizes people really have (issue #25: on a
 * 13-inch laptop the tab content had a small box). It opens the built sample board in squad-kit's own screenshot
 * browser, so it runs where both are there (a developer's computer after `pnpm build`) and skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserThere } from '../src/modules/playwright/index.js';

const CLI = path.resolve('dist/cli.js');
const UI = path.resolve('dist/console-ui/index.html');
// The developer's own screenshot browser: the tests' squad-kit folder is a fresh one, without it.
const PW = path.join(os.userInfo().homedir, '.squad-kit', 'tools', 'playwright');
const ready = fs.existsSync(CLI) && fs.existsSync(UI) && browserThere(PW) === true;

// Window sizes inside the browser: a 13-inch and a 14-inch MacBook, a small Windows laptop, a large screen.
const SIZES: [string, number, number][] = [
  ['13-inch MacBook', 1470, 833],
  ['14-inch MacBook', 1512, 870],
  ['small Windows laptop', 1366, 650],
  ['large screen', 1920, 1000],
];
// On the sample board: one the squad works on (all five buttons in the action bar), one waiting for you.
const TICKETS = { working: 'SK-145', 'your turn': 'SK-135' };

interface Page {
  goto(url: string): Promise<unknown>;
  waitForSelector(s: string, o?: { timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
}
interface Ctx {
  newPage(): Promise<Page>;
  addInitScript(fn: (full: string) => void, arg: string): Promise<void>;
  close(): Promise<void>;
}
interface Browser {
  newContext(o: { viewport: { width: number; height: number } }): Promise<Ctx>;
  close(): Promise<void>;
}

// Runs in the page (as text: these tests have no browser types). The panel scrolled to the end; what stays in place.
const ROOM = `(() => {
  const d = document.querySelector('.drawer');
  d.scrollTo({ top: 100000 });
  const h = (s) => d.querySelector(':scope > ' + s)?.getBoundingClientRect().height ?? 0;
  return { room: d.clientHeight - h('.dtop') - h('.tabs') - h('.df'), bar: h('.df'), window: innerHeight };
})()`;

let board: ChildProcess | undefined;
let browser: Browser | undefined;
let base = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

describe.runIf(ready)('an open ticket leaves room to read', () => {
  beforeAll(async () => {
    const port = await freePort();
    const token = 'c'.repeat(64);
    board = spawn(process.execPath, [CLI, 'demo', '--no-open', '--port', String(port), '--token', token, '--speed', '0.01'], {
      cwd: os.tmpdir(),
      env: { ...process.env, SQUAD_KIT_BROWSER: 'off', SQUAD_KIT_UPDATES: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`the sample board did not start:\n${out}`)), 30_000);
      board!.on('exit', (code) => reject(new Error(`the sample board stopped (${code}):\n${out}`)));
      const read = (d: Buffer) => {
        out += d.toString();
        const m = /url\s+(http:\/\/127\.0\.0\.1:\d+\/p\/[^/\s]+)/.exec(out);
        if (m) {
          base = m[1]!;
          clearTimeout(t);
          resolve();
        }
      };
      board!.stdout!.on('data', read);
      board!.stderr!.on('data', read);
    });
    const pw = (await import(pathToFileURL(path.join(PW, 'node_modules', 'playwright-core', 'index.mjs')).href)) as {
      chromium: { launch(o: { headless: boolean }): Promise<Browser> };
    };
    browser = await pw.chromium.launch({ headless: true });
    // The page keeps the token after the first visit.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/board?t=${token}`);
    await page.waitForSelector('.lane', { timeout: 20_000 });
    await ctx.close();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    board?.kill();
  });

  for (const [screen, width, height] of SIZES) {
    for (const full of ['side panel', 'full width']) {
      it(`${screen}, ${full}`, async () => {
        const ctx = await browser!.newContext({ viewport: { width, height } });
        await ctx.addInitScript((f) => localStorage.setItem('sk.ticketFull', f), full === 'full width' ? 'on' : 'off');
        const page = await ctx.newPage();
        const token = 'c'.repeat(64);
        await page.goto(`${base}/board?t=${token}`);
        for (const [kind, id] of Object.entries(TICKETS)) {
          await page.goto(`${base}/board?ticket=${id}`);
          await page.waitForSelector('.drawer > .tabs', { timeout: 20_000 });
          await page.waitForTimeout(500);
          // Scrolled to the tab's content: what stays in place, and the room left between them.
          const m = await page.evaluate<{ room: number; bar: number; window: number }>(ROOM);
          expect(m.room / m.window, `${kind} ${id}: ${Math.round(m.room)}px of ${m.window}px to read`).toBeGreaterThanOrEqual(0.6);
          // The action bar is one row, whatever buttons it has.
          expect(m.bar, `${kind} ${id}: the action bar is ${Math.round(m.bar)}px tall`).toBeLessThan(70);
        }
        await ctx.close();
      });
    }
  }
});

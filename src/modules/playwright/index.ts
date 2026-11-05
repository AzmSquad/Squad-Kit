import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { squadHome } from '../../core/home.js';
import { blockedFrom } from '../browser/addresses.js';
import { BrowserSetupError, StepFailure, type Browser, type BrowserModule, type BrowserPage, type BrowserStep, type BrowserTarget } from '../browser/types.js';

/**
 * Playwright as squad-kit's own screenshot browser. It is not part of the npm package (the package has a size cap):
 * squad-kit installs one pinned version under its own folder the first time a proof needs it, loads it from there,
 * and uses its headless Chromium. The browser build goes in Playwright's usual cache, so a computer that already has
 * it downloads nothing. Both are got before a step's clock starts (prepare), each on a limit of its own.
 */

/** The one line said while squad-kit downloads its browser. */
export const SETTING_UP = "Setting up squad-kit's screenshot browser. This happens only once.";

/** A stable version whose Chromium headless shell (build 1248) is often in the cache already. */
export const PLAYWRIGHT_VERSION = '1.64.1';

export function playwrightDir(): string {
  return path.join(squadHome(), 'tools', 'playwright');
}

/** Runs one program and says whether it worked, with the end of what it printed. */
export type Runner = (file: string, args: string[], o: { cwd: string; timeoutMs: number }) => Promise<{ ok: boolean; output: string }>;

const run: Runner = (file, args, o) =>
  new Promise((resolve) => {
    // npm's own settings from a parent npm or pnpm run would point the install somewhere else.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
    execFile(
      file,
      args,
      // Getting the browser never removes the browsers other Playwright installs on this computer use.
      { cwd: o.cwd, timeout: o.timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: process.platform === 'win32', env: { ...env, npm_config_update_notifier: 'false', ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_SKIP_BROWSER_GC: '1' } },
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}\n${stderr}\n${err ? err.message : ''}`.trim().slice(-4000) }),
    );
  });

/** One job per key at a time: a second caller waits for the first one's result instead of starting its own. */
const flights = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, job: () => Promise<T>): Promise<T> {
  const going = flights.get(key);
  if (going) return going as Promise<T>;
  const p = job().finally(() => flights.delete(key));
  flights.set(key, p);
  return p;
}

function installedVersion(dir: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'playwright-core', 'package.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The pinned Playwright, installed under `dir` on first need, once even when two tickets ask at the same moment. It
 * is installed into a folder beside it and moved in place when complete, so a cut-off install never looks ready.
 * Returns the file to load.
 */
export async function readyPlaywright(o: { dir?: string; run?: Runner; onLine?: (text: string) => void } = {}): Promise<string> {
  const dir = o.dir ?? playwrightDir();
  const entry = path.join(dir, 'node_modules', 'playwright-core', 'index.mjs');
  if (installedVersion(dir) === PLAYWRIGHT_VERSION && fs.existsSync(entry)) return entry;
  await singleFlight(`install:${dir}`, async () => {
    if (installedVersion(dir) === PLAYWRIGHT_VERSION) return;
    o.onLine?.(SETTING_UP);
    const part = `${dir}.part-${process.pid}-${Date.now()}`;
    fs.mkdirSync(part, { recursive: true });
    fs.writeFileSync(path.join(part, 'package.json'), `${JSON.stringify({ name: 'squad-kit-screenshots', private: true }, null, 2)}\n`);
    const args = ['install', `playwright-core@${PLAYWRIGHT_VERSION}`, '--save-exact', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline', '--loglevel=error'];
    const r = await (o.run ?? run)(npmCommand(), args, { cwd: part, timeoutMs: 5 * 60_000 });
    if (!r.ok || installedVersion(part) !== PLAYWRIGHT_VERSION) {
      fs.rmSync(part, { recursive: true, force: true });
      throw new BrowserSetupError(`Installing Playwright ${PLAYWRIGHT_VERSION} did not work`, `npm ${args.join(' ')} in ${part}: ${r.output}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(part, dir);
  });
  return entry;
}

function npmCommand(): string {
  const beside = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (fs.existsSync(beside)) return beside;
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Gets Chromium's headless shell for the pinned version, without removing browsers other installs use. */
function installBrowser(dir: string, runner: Runner): Promise<{ ok: boolean; output: string }> {
  const cli = path.join(dir, 'node_modules', 'playwright-core', 'cli.js');
  return runner(process.execPath, [cli, 'install', '--only-shell', '--no-remove', 'chromium'], { cwd: dir, timeoutMs: 10 * 60_000 });
}

/** Where Playwright keeps its browsers on this computer, the way it finds the folder itself. */
function browsersDir(dir: string): string {
  const set = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (set === '0') return path.join(dir, 'node_modules', 'playwright-core', '.local-browsers');
  if (set) return path.resolve(set);
  const home = os.homedir();
  const cache =
    process.platform === 'darwin' ? path.join(home, 'Library', 'Caches')
    : process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'))
    : (process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'));
  return path.join(cache, 'ms-playwright');
}

/**
 * True when the headless shell of the pinned version is fully in Playwright's cache; null when squad-kit cannot
 * tell (a build made for one platform only), and then the install itself looks.
 */
export function browserThere(dir: string): boolean | null {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')) as { browsers?: { name: string; revision: string; revisionOverrides?: object }[] };
    const shell = json.browsers?.find((b) => b.name === 'chromium-headless-shell');
    if (!shell || shell.revisionOverrides) return null;
    return fs.existsSync(path.join(browsersDir(dir), `chromium_headless_shell-${shell.revision}`, 'INSTALLATION_COMPLETE'));
  } catch {
    return null;
  }
}

/**
 * The browser build squad-kit itself runs from Playwright's shared cache, where the project's own commands may write
 * (installing their own browsers): that folder stays theirs to read, never to change. Nothing before the first install.
 */
export function ownBrowserFiles(dir = playwrightDir()): string[] {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')) as { browsers?: { name: string; revision: string }[] };
    const shell = json.browsers?.find((b) => b.name === 'chromium-headless-shell');
    return shell ? [path.join(browsersDir(dir), `chromium_headless_shell-${shell.revision}`)] : [];
  } catch {
    return [];
  }
}

/** Ready once in this process: the next calls look no further. */
const prepared = new Set<string>();

/**
 * The pinned Playwright and its Chromium on this computer, without starting it: installed the first time, with one
 * line said while it downloads. A second caller waits for the first one's install.
 */
export async function preparePlaywright(o: { dir?: string; run?: Runner; onLine?: (text: string) => void } = {}): Promise<void> {
  const dir = o.dir ?? playwrightDir();
  if (prepared.has(dir)) return;
  let said = false;
  const once = (text: string) => {
    if (said) return;
    said = true;
    o.onLine?.(text);
  };
  await readyPlaywright({ ...o, onLine: once });
  const there = browserThere(dir);
  if (!there) {
    if (there === false) once(SETTING_UP);
    const got = await singleFlight(`browser:${dir}`, () => installBrowser(dir, o.run ?? run));
    if (!got.ok) throw new BrowserSetupError('Getting Chromium did not work', got.output);
  }
  prepared.add(dir);
}

/* ── the little of Playwright's API squad-kit uses, loaded at run time ── */

interface PwLocator {
  count(): Promise<number>;
  or(other: PwLocator): PwLocator;
  first(): PwLocator;
  filter(o: { visible: boolean }): PwLocator;
  click(o: { timeout: number }): Promise<void>;
  fill(value: string, o: { timeout: number }): Promise<void>;
  selectOption(value: string, o: { timeout: number }): Promise<string[]>;
  check(o: { timeout: number }): Promise<void>;
  uncheck(o: { timeout: number }): Promise<void>;
  press(key: string, o: { timeout: number }): Promise<void>;
  hover(o: { timeout: number }): Promise<void>;
  waitFor(o: { state: 'visible'; timeout: number }): Promise<void>;
  ariaSnapshot(o: { timeout: number }): Promise<string>;
}
interface PwFrame {
  parentFrame(): PwFrame | null;
  url(): string;
}
interface PwRequest {
  url(): string;
  isNavigationRequest(): boolean;
  frame(): PwFrame;
}
interface PwRoute {
  request(): PwRequest;
  continue(): Promise<void>;
  abort(code: string): Promise<void>;
}
interface PwResponse {
  status(): number;
}
interface PwPage {
  goto(url: string, o: { timeout: number; waitUntil: 'load' | 'domcontentloaded' }): Promise<PwResponse | null>;
  url(): string;
  mainFrame(): PwFrame;
  getByRole(role: string, o?: { name?: string; exact?: boolean }): PwLocator;
  getByLabel(text: string, o: { exact: boolean }): PwLocator;
  getByText(text: string, o: { exact: boolean }): PwLocator;
  getByPlaceholder(text: string, o: { exact: boolean }): PwLocator;
  getByTestId(id: string): PwLocator;
  locator(css: string): PwLocator;
  keyboard: { press(key: string): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle', o: { timeout: number }): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(o: { animations: 'disabled'; caret: 'hide'; timeout: number }): Promise<Buffer>;
  on(event: 'dialog', fn: (d: { accept(): Promise<void> }) => void): void;
  on(event: 'framenavigated', fn: (f: PwFrame) => void): void;
  on(event: 'filechooser', fn: (c: unknown) => void): void;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  route(match: string, fn: (route: PwRoute) => Promise<void>): Promise<void>;
  on(event: 'page', fn: (p: PwPage) => void): void;
  close(): Promise<void>;
}
export interface PwBrowser {
  newContext(o: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface Pw {
  chromium: { launch(o: { headless: boolean; timeout: number }): Promise<PwBrowser> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A target named one way, exact or not. */
/** The roles a field named by its label can have. */
const FIELD_ROLES = ['textbox', 'combobox', 'listbox', 'searchbox', 'spinbutton', 'checkbox', 'radio', 'switch', 'slider'];

function locate(page: PwPage, t: BrowserTarget, exact: boolean): PwLocator {
  if (t.role) return page.getByRole(t.role, t.name ? { name: t.name, exact } : {});
  // A label's own text also holds what is inside it (a list's choices, for <label>Room <select>…</label>), so an exact
  // label is also matched as the name of a field, the way the page's accessibility tree shows it.
  if (t.label && exact) return FIELD_ROLES.reduce((loc, role) => loc.or(page.getByRole(role, { name: t.label!, exact: true })), page.getByLabel(t.label, { exact: true }));
  if (t.label) return page.getByLabel(t.label, { exact });
  if (t.placeholder) return page.getByPlaceholder(t.placeholder, { exact });
  if (t.text) return page.getByText(t.text, { exact });
  if (t.testId) return page.getByTestId(t.testId);
  return page.locator(t.css ?? '');
}

/**
 * The one thing a target means: an exact match first, then a looser one; of several, the first that shows. Waits
 * for it to appear, as pages draw after they load.
 */
async function find(page: PwPage, t: BrowserTarget, ms: number): Promise<PwLocator> {
  const until = Date.now() + ms;
  const ways = [locate(page, t, true), locate(page, t, false)];
  for (;;) {
    for (const loc of ways) {
      // A page that is changing over may not answer for a moment.
      const n = await loc.count().catch(() => 0);
      if (n === 1) return loc;
      if (n > 1) {
        const shown = loc.filter({ visible: true });
        return (await shown.count().catch(() => 0)) ? shown.first() : loc.first();
      }
    }
    if (Date.now() >= until) throw new StepFailure('missing', `Nothing on the page matches ${JSON.stringify(t)}`);
    await sleep(200);
  }
}

/** Playwright's own error, as one of the reasons squad-kit can put in words. */
function failure(err: unknown): StepFailure {
  if (err instanceof StepFailure) return err;
  const msg = (err as Error)?.message ?? String(err);
  if (/has been closed|Target closed/i.test(msg)) return new StepFailure('closed', msg);
  if (/did not find some options|not find option/i.test(msg)) return new StepFailure('option', msg);
  if (/element is not enabled|element is disabled/i.test(msg)) return new StepFailure('disabled', msg);
  if (/element is not visible|element is outside of the viewport/i.test(msg)) return new StepFailure('hidden', msg);
  if (/ERR_BLOCKED_BY_CLIENT/i.test(msg)) return new StepFailure('blocked', msg);
  if ((err as Error)?.name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(msg)) return new StepFailure('timeout', msg);
  return new StepFailure('other', msg);
}

function wrapPage(page: PwPage, context: PwContext, origin: string, stopped: { at: string | null }): BrowserPage {
  // Where the page tried to go outside the app, since the last step.
  let blocked: string | null = null;
  page.on('dialog', (d) => void d.accept().catch(() => undefined));
  // A file picker gets no file: with a listener, the page's own picker never opens, and nothing is chosen.
  page.on('filechooser', () => undefined);
  page.on('framenavigated', (f) => {
    // A redirect is not seen by the route below: a page that ended up outside the app is taken back off it.
    if (f.parentFrame() || f.url() === 'about:blank' || originOf(f.url()) === origin) return;
    // A navigation squad-kit stopped shows the browser's own error page: what it tried to open is the address stopped.
    blocked = f.url().startsWith('chrome-error://') && stopped.at ? stopped.at : f.url();
    stopped.at = null;
    void page.goto('about:blank', { timeout: 5000, waitUntil: 'load' }).catch(() => undefined);
  });
  const outside = () => {
    if (!blocked) return;
    const to = blocked;
    blocked = null;
    throw new StepFailure('blocked', `The page tried to open ${to}`, to);
  };
  const afterAction = async (ms: number) => {
    // A click may start loading another page: let it.
    await sleep(150);
    await page.waitForLoadState('load', { timeout: Math.min(ms, 5000) }).catch(() => undefined);
    outside();
  };
  return {
    async goto(url, ms) {
      blocked = null;
      try {
        const res = await page.goto(url, { timeout: ms, waitUntil: 'load' });
        outside();
        return res?.status() ?? null;
      } catch (err) {
        outside();
        throw failure(err);
      }
    },
    async act(step: BrowserStep, ms) {
      blocked = null;
      const until = Date.now() + ms;
      const left = () => Math.max(1000, until - Date.now());
      try {
        const loc = step.target ? await find(page, step.target, ms) : null;
        switch (step.action) {
          case 'click':
            await loc!.click({ timeout: left() });
            break;
          case 'fill':
            await loc!.fill(step.value ?? '', { timeout: left() });
            break;
          case 'select':
            await loc!.selectOption(step.value ?? '', { timeout: left() });
            break;
          case 'check':
            await loc!.check({ timeout: left() });
            break;
          case 'uncheck':
            await loc!.uncheck({ timeout: left() });
            break;
          case 'hover':
            await loc!.hover({ timeout: left() });
            break;
          case 'press':
            if (loc) await loc.press(step.key ?? 'Enter', { timeout: left() });
            else await page.keyboard.press(step.key ?? 'Enter');
            break;
          case 'wait':
            if (loc) await loc.waitFor({ state: 'visible', timeout: left() });
            else await page.waitForTimeout(Math.min(step.ms ?? 0, 5000));
            break;
          default:
            throw new StepFailure('other', `${step.action} is not a step the browser knows`);
        }
        await afterAction(left());
      } catch (err) {
        outside();
        throw failure(err);
      }
    },
    async settle(ms) {
      await page.waitForLoadState('load', { timeout: ms }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: Math.min(ms, 3000) }).catch(() => undefined);
      await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => undefined);
      await sleep(150);
    },
    async snapshot() {
      return page.locator('body').ariaSnapshot({ timeout: 5000 });
    },
    url() {
      return page.url();
    },
    async screenshot() {
      return page.screenshot({ animations: 'disabled', caret: 'hide', timeout: 15_000 });
    },
    async close() {
      await context.close().catch(() => undefined);
    },
  };
}

/**
 * Playwright's browser behind squad-kit's own interface: fresh pages that stay on the app, no downloads, no file
 * pickers, and nothing else on this computer or a private network reached from the page.
 */
export function wrapBrowser(browser: PwBrowser): Browser {
  return {
    async page(o) {
      const context = await browser.newContext({
        viewport: { width: o.width, height: o.height },
        deviceScaleFactor: 1,
        ...(o.phone ? { isMobile: true, hasTouch: true } : {}),
        acceptDownloads: false,
        serviceWorkers: 'block',
        ignoreHTTPSErrors: true,
      });
      // Only the app opens at the top of the page. Its fonts, scripts and pictures may load from the internet, but
      // nothing else on this computer or a private network: not the person's other apps, not the board itself.
      const stopped: { at: string | null } = { at: null };
      await context.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        let top = false;
        try {
          top = req.isNavigationRequest() && !req.frame().parentFrame();
        } catch {
          top = false;
        }
        if (top && originOf(url) !== o.origin) {
          stopped.at = url;
          return route.abort('blockedbyclient').catch(() => undefined);
        }
        if (blockedFrom(url, o.origin)) return route.abort('blockedbyclient').catch(() => undefined);
        return route.continue().catch(() => undefined);
      });
      const page = await context.newPage();
      // A new window the app opens is closed at once: the picture is of the page squad-kit opened.
      context.on('page', (p) => {
        if (p !== page) void p.close().catch(() => undefined);
      });
      return wrapPage(page, context, o.origin, stopped);
    },
    async close() {
      await browser.close().catch(() => undefined);
    },
  };
}

const MISSING_BROWSER = /Executable doesn't exist|playwright install|browserType\.launch: .*not found/i;

/** Starts headless Chromium from the pinned Playwright, getting either ready first when this computer lacks it. */
export async function launchPlaywright(o: { dir?: string; run?: Runner; onLine?: (text: string) => void } = {}): Promise<Browser> {
  const dir = o.dir ?? playwrightDir();
  await preparePlaywright(o);
  const entry = await readyPlaywright(o);
  let pw: Pw;
  try {
    pw = (await import(pathToFileURL(entry).href)) as Pw;
  } catch (err) {
    throw new BrowserSetupError('Playwright did not load', `${entry}: ${(err as Error).message}`);
  }
  const start = () => pw.chromium.launch({ headless: true, timeout: 60_000 });
  try {
    return wrapBrowser(await start());
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (!MISSING_BROWSER.test(msg)) throw new BrowserSetupError('Chromium did not start', msg);
  }
  o.onLine?.(SETTING_UP);
  const got = await singleFlight(`browser:${dir}`, () => installBrowser(dir, o.run ?? run));
  if (!got.ok) throw new BrowserSetupError('Getting Chromium did not work', got.output);
  try {
    return wrapBrowser(await start());
  } catch (err) {
    throw new BrowserSetupError('Chromium did not start', (err as Error).message ?? String(err));
  }
}

export const playwrightBrowser: BrowserModule = {
  name: 'playwright',
  label: 'Playwright',
  launch: (o = {}) => launchPlaywright(o.onLine ? { onLine: o.onLine } : {}),
  prepare: (o = {}) => preparePlaywright(o.onLine ? { onLine: o.onLine } : {}),
  ownFiles: () => ownBrowserFiles(),
};

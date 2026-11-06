import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { shotBrowser } from '../modules/registry.js';
import { BrowserSetupError, StepFailure, type Browser, type BrowserPage, type BrowserStep, type BrowserTarget } from '../modules/browser/types.js';

/**
 * squad-kit's own headless browser, run outside every agent's sandbox: it opens the app on this computer, does a few
 * fixed steps and takes the picture, or reads what the page shows. Agents ask for it through the window
 * (engine/window.ts), which checks every field first; this file checks them again and keeps the browser on the app.
 * What did not work comes back with why: short for the agent, plain for the person.
 */

export type ShotSize = 'desktop' | 'phone';

export const SIZES: Record<ShotSize, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
};

/** One picture an agent asks for: the page in the app to open, the steps to do there first, and the size. */
export interface ShotAsk {
  page: string;
  steps?: BrowserStep[];
  size?: ShotSize;
}

export interface TakenShot {
  /** The picture, as PNG bytes: the caller saves it, never through a link. */
  png: Buffer;
  /** Where the picture was taken: the path and query in the app, without the host. */
  page: string;
  /** The HTTP status the page answered with, when it said. */
  status?: number;
}

export interface FailedShot {
  /** The step that did not work, from 1. 0 is opening the page, or the picture itself. */
  step: number;
  /** That step in words: 'click the button named "Save"'. */
  what: string;
  /** Why, short, for the agent: 'no button named "Save" on the page'. */
  why: string;
  /** Why, in plain words for the person: 'squad-kit could not find the button "Save" on the screen.' */
  plain: string;
  /** Where the page was then: the path and query in the app. */
  page: string;
  /** The page's accessibility tree then, cut short. */
  snapshot: string;
  /** The page tried to open another website, which squad-kit stopped. */
  left?: boolean;
}

/** What one step may take. */
export const STEP_MS = 10_000;
/** What one call of a tool may take in all, well under the agent's own limit for a tool (about four minutes). */
export const CALL_MS = 150_000;
/** What getting squad-kit's browser onto this computer may take, the first time: it is downloaded then. */
export const SETUP_MS = 15 * 60_000;
/** The activity line while squad-kit's browser is set up. */
export const SETTING_UP = "Setting up squad-kit's screenshot browser. This happens only once.";
export const MAX_PAUSE_MS = 5000;
/** How much of a page's accessibility tree goes back to the agent. */
export const SNAPSHOT_CHARS = 4000;
export const MAX_STEPS = 15;
/** The longest page path, text to type, and name of a part of the page squad-kit takes. */
export const MAX_PAGE = 300;
export const MAX_VALUE = 500;
export const MAX_NAME = 200;

const STOPPED = 'You stopped the squad.';

/** The person's words when squad-kit's browser could not be set up. */
export const NO_BROWSER = 'squad-kit could not set up its screenshot browser. Check the internet connection, then press Try again.';
const NOT_HERE = 'squad-kit only opens an app on this computer, and the app address in Settings points somewhere else.';

/** squad-kit's browser cannot work right now. `message` is for the person; `detail` for engineers. */
export class ShotsUnavailable extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/* ── what squad-kit takes ─────────────────────────────── */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The names a server may print for itself on this computer, beside the ones a browser opens. */
const LOCAL_NAMES = new Set([...LOOPBACK, '0.0.0.0', '[::]']);

/**
 * The path of a full address on the app's own origin, whichever local name it uses (localhost, 127.0.0.1): an agent
 * that sends the app's own address asked for nothing outside the app. Null for anything else: another host or port,
 * another scheme, or a sign-in inside the address.
 */
export function pathOnApp(address: string, appUrl: string): string | null {
  let a: URL;
  let b: URL;
  try {
    a = new URL(address);
    b = new URL(appUrl);
  } catch {
    return null;
  }
  const port = (u: URL) => u.port || (u.protocol === 'https:' ? '443' : '80');
  if (a.protocol !== b.protocol || a.username || a.password || !LOCAL_NAMES.has(a.hostname) || !LOOPBACK.has(b.hostname) || port(a) !== port(b)) return null;
  return `${a.pathname}${a.search}${a.hash}`;
}

/** The app's origin, when its address is http(s) on this computer; null otherwise. */
export function appOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return LOOPBACK.has(u.hostname) ? u.origin : null;
}

/**
 * What is wrong with a page an agent named, or null for a path in the app: one "/" first, never a scheme, a host,
 * "//", a backslash, a ".." part (written or encoded), spaces or control characters, and not too long.
 */
export function pageProblem(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim()) return 'page is missing: give a path in the app, like "/book"';
  const s = p.trim();
  if (s.length > MAX_PAGE) return `page is longer than ${MAX_PAGE} characters`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return `page "${s.slice(0, 60)}" is a full address: give only the path in the app, like "/book"`;
  if (!s.startsWith('/')) return `page "${s.slice(0, 60)}" is not a path in the app: it starts with "/", like "/book"`;
  if (s.startsWith('//') || s.includes('\\')) return `page "${s.slice(0, 60)}" names another host: give only the path in the app`;
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return 'page has spaces or control characters';
  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return 'page is not a valid address path';
  }
  if (/(^|[/\\])\.\.([/\\?#]|$)/.test(decoded) || decoded.startsWith('//') || decoded.includes('\\')) return 'page may not go up a folder ("..") or name another host';
  return null;
}

/** The full address of a path in the app, never one outside it. */
export function addressIn(origin: string, p: string): string | null {
  if (pageProblem(p)) return null;
  const u = new URL(p.trim(), origin);
  return u.origin === origin ? u.href : null;
}

/** "/book?day=2", from a full address. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** The roles a page's parts can have (WAI-ARIA), as role targets name them. */
const ROLES = new Set(
  'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'.split(
    ' ',
  ),
);

const ACTIONS = new Set(['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'wait']);
const NEEDS_TARGET = new Set(['click', 'fill', 'select', 'check', 'uncheck', 'hover']);
const WAYS = ['role', 'label', 'placeholder', 'text', 'testId', 'css'] as const;
const STEP_FIELDS = new Set(['action', 'target', 'value', 'path', 'key', 'ms']);
const TARGET_FIELDS = new Set(['role', 'name', ...WAYS]);
/** The keys a step may press: one letter or digit, or a named key, with Shift at most. */
const KEY = /^(Shift\+)?([A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/;

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The target named the one way squad-kit uses, the best one it gives: role and name, then label, … css. */
export function oneWay(t: BrowserTarget): BrowserTarget {
  const way = WAYS.find((w) => filled(t[w]));
  if (!way) return {};
  if (way === 'role') return { role: t.role!.trim().toLowerCase(), ...(filled(t.name) ? { name: t.name } : {}) };
  return { [way]: t[way] };
}

function targetProblem(t: BrowserTarget): string | null {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'target must be an object';
  const extra = Object.keys(t).find((k) => !TARGET_FIELDS.has(k));
  if (extra) return `target has a field squad-kit does not take: "${extra.slice(0, 40)}"`;
  for (const k of TARGET_FIELDS) {
    const v = (t as Record<string, unknown>)[k];
    if (v !== undefined && typeof v !== 'string') return `target.${k} must be text`;
    if (typeof v === 'string' && v.length > MAX_NAME) return `target.${k} is longer than ${MAX_NAME} characters`;
  }
  const w = oneWay(t);
  if (!Object.keys(w).length) return 'target names nothing: give role and name, label, text, placeholder, testId or css';
  if (w.role && !ROLES.has(w.role)) return `"${t.role}" is not a role (like button, link, textbox, checkbox, heading)`;
  return null;
}

/** What is wrong with one step, or null. */
export function stepProblem(s: BrowserStep): string | null {
  if (!s || typeof s !== 'object' || Array.isArray(s) || !ACTIONS.has(s.action)) return `"${String((s as { action?: unknown })?.action).slice(0, 40)}" is not a step squad-kit knows`;
  const extra = Object.keys(s).find((k) => !STEP_FIELDS.has(k));
  if (extra) return `a step has a field squad-kit does not take: "${extra.slice(0, 40)}"`;
  if (s.value !== undefined && typeof s.value !== 'string') return 'value must be text';
  if (typeof s.value === 'string' && s.value.length > MAX_VALUE) return `value is longer than ${MAX_VALUE} characters`;
  if (s.action === 'goto') {
    const p = pageProblem(s.path);
    return p ? `goto: ${p.replace(/^page/, 'path')}` : null;
  }
  if (s.path !== undefined) return 'only goto takes a path';
  if (s.action === 'press' && (!filled(s.key) || !KEY.test(s.key))) return 'press needs key: one letter or digit, or a key like "Enter" or "Tab"';
  if (s.action !== 'press' && s.key !== undefined) return 'only press takes a key';
  if (s.ms !== undefined && (typeof s.ms !== 'number' || !Number.isFinite(s.ms) || s.ms < 0)) return 'ms must be a number of milliseconds';
  if (s.action === 'fill' && typeof s.value !== 'string') return 'fill needs value';
  if (s.action === 'select' && !filled(s.value)) return 'select needs value: the option to pick';
  if (s.action === 'wait' && !s.target && typeof s.ms !== 'number') return 'wait needs target (what to wait for) or ms';
  if (NEEDS_TARGET.has(s.action) && !s.target) return `${s.action} needs target`;
  return s.target !== undefined ? targetProblem(s.target) : null;
}

/** What is wrong with a list of steps, or null. */
export function stepsProblem(steps: unknown): string | null {
  if (steps === undefined) return null;
  if (!Array.isArray(steps)) return 'steps must be a list';
  if (steps.length > MAX_STEPS) return `there are ${steps.length} steps, and squad-kit takes at most ${MAX_STEPS}`;
  for (const [i, st] of steps.entries()) {
    const p = stepProblem(st as BrowserStep);
    if (p) return `step ${i + 1}: ${p}`;
  }
  return null;
}

/* ── words ────────────────────────────────────────────── */

/** 'button named "Save"', 'field labelled "Email"': for the agent. */
export function targetWords(t: BrowserTarget): string {
  const w = oneWay(t);
  if (w.role) return w.name ? `${w.role} named "${w.name}"` : w.role;
  if (w.label) return `field labelled "${w.label}"`;
  if (w.placeholder) return `field with the placeholder "${w.placeholder}"`;
  if (w.text) return `text "${w.text}"`;
  if (w.testId) return `test id "${w.testId}"`;
  return `css "${w.css ?? ''}"`;
}

/** One step in words, as the agent wrote it. */
export function stepWords(s: BrowserStep): string {
  const t = s.target ? targetWords(s.target) : '';
  switch (s.action) {
    case 'goto':
      return `open ${s.path}`;
    case 'fill':
      return `fill the ${t} with "${s.value}"`;
    case 'select':
      return `pick "${s.value}" in the ${t}`;
    case 'press':
      return `press ${s.key}${t ? ` in the ${t}` : ''}`;
    case 'wait':
      return t ? `wait for the ${t}` : `wait ${Math.min(s.ms ?? 0, MAX_PAUSE_MS)} ms`;
    default:
      return `${s.action} the ${t}`;
  }
}

/** What people call a part of the page with this role. */
const ROLE_WORDS: Record<string, string> = {
  button: 'button',
  link: 'link',
  textbox: 'field',
  searchbox: 'search field',
  combobox: 'list',
  listbox: 'list',
  spinbutton: 'field',
  checkbox: 'tick box',
  switch: 'switch',
  radio: 'choice',
  option: 'choice',
  heading: 'heading',
  tab: 'tab',
  menuitem: 'menu item',
  img: 'picture',
  dialog: 'window',
  row: 'row',
  cell: 'cell',
};

/** 'the button "Save"', 'the field "Email"': for the person. */
function plainThing(t: BrowserTarget): string {
  const w = oneWay(t);
  if (w.role) return w.name ? `the ${ROLE_WORDS[w.role] ?? 'part'} "${w.name}"` : `the ${ROLE_WORDS[w.role] ?? 'part of the page'}`;
  if (w.label) return `the field "${w.label}"`;
  if (w.placeholder) return `the field "${w.placeholder}"`;
  if (w.text) return `the words "${w.text}"`;
  return 'a part of the page the Tester named';
}

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const firstLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? s).trim().slice(0, 200);

/** Why a step did not work: short for the agent, plain for the person. */
export function failureWords(step: BrowserStep | null, err: unknown, stepMs = STEP_MS): { why: string; plain: string } {
  const t = step?.target;
  if (err instanceof StepFailure) {
    switch (err.kind) {
      case 'missing':
        return t ? { why: `no ${targetWords(t)} on the page`, plain: `squad-kit could not find ${plainThing(t)} on the screen.` } : { why: 'nothing to act on', plain: 'The screen was not as expected.' };
      case 'hidden':
        return { why: `the ${t ? targetWords(t) : 'part'} is on the page but not visible`, plain: `${cap(t ? plainThing(t) : 'the part it needed')} is there but hidden.` };
      case 'disabled':
        return { why: `the ${t ? targetWords(t) : 'part'} is turned off (disabled)`, plain: `${cap(t ? plainThing(t) : 'the part it needed')} is there but cannot be used yet.` };
      case 'option':
        return step?.value
          ? { why: `no option "${step.value}" in the ${t ? targetWords(t) : 'list'}`, plain: `The list has no choice "${step.value}".` }
          : { why: `no such option in the ${t ? targetWords(t) : 'list'}`, plain: 'The list does not have that choice.' };
      case 'blocked':
        return { why: `the page tried to open ${err.address ?? 'another site'}, outside the app; squad-kit only opens the app`, plain: 'The app tried to open a page outside itself, which squad-kit does not do.' };
      case 'timeout':
        return { why: `it did not finish within ${Math.round(stepMs / 1000)} seconds`, plain: 'The screen took too long to react.' };
      case 'closed':
        return { why: 'the page closed', plain: 'The page closed by itself.' };
      default:
        return { why: firstLine(err.message), plain: 'The screen did not react as expected.' };
    }
  }
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/i.test((err as Error)?.message ?? '')) {
    return { why: 'the app did not answer', plain: 'The app stopped answering.' };
  }
  return { why: firstLine((err as Error)?.message ?? String(err)), plain: 'The screen did not react as expected.' };
}

/** A page's accessibility tree, cut at a line end near `max` characters. */
export function trimSnapshot(text: string, max = SNAPSHOT_CHARS): string {
  const s = (text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf('\n', max);
  return `${s.slice(0, cut > max / 2 ? cut : max)}\n… (cut short)`;
}

/** Technical words a project manager should never read in a stop message. */
const JARGON =
  /\b(sandbox(ed)?|mcp|ports?|pids?|process id|playwright|chromium|chrome|mach|sigtrap|sigkill|sigterm|selectors?|locators?|localhost|127\.0\.0\.1|https?|npx|npm|pnpm|pip|stack ?trace|exit (code|status)|permission denied|eperm|eacces|econnrefused|enoent|bootstrap_check_in|kill(ed)?|shell|bash|zsh|stderr|stdout|headless|seatbelt|cli|api|json|yaml|xpath|url|sudo|chmod|env(ironment)? var(iable)?s?|traceback|exception|undefined|git|config(uration)? files?)\b|\.squad\b|\.env\b|(^|[\s"'(])(~\/|\/(Users|home|private|tmp|var|etc|opt)\/)|[\w.-]+\/[\w./-]*\.(m?[jt]sx?|json|py|ya?ml|toml|sh|md|lock|cfg|ini)\b/i;
/** A variable name like ROOMFLOW_PORT. */
const VARIABLE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
/** An error's own name, code or status: "TypeError:", "EPIPE", "status code 529", "HTTP 503". */
const RAW_ERROR = /\b[A-Z]\w*(Error|Exception)\b|\bE[A-Z]{3,}\b/;
const RAW_STATUS = /\b(status( code)?|http|code|exit( code)?)\s*:?\s*\d{3}\b|\berrno\b/i;

/**
 * True when a line an agent wrote (a picture's note, what it skipped) has none of the technical words a project
 * manager should not need. Stops never rely on it: only squad-kit's own words reach a stop (engine/plain-stop.ts).
 */
export function isPlain(text: string): boolean {
  return !JARGON.test(text) && !VARIABLE.test(text) && !RAW_ERROR.test(text) && !RAW_STATUS.test(text);
}

/**
 * Technical words in an agent's note for the person, a little looser than JARGON: the browsers people use ("Chrome
 * and Edge") and plain English ("an exception to the rule") are fine in a note; tools and stack traces are not.
 */
const NOTE_JARGON = new RegExp(
  JARGON.source.replace('chromium|chrome|', 'chromium|').replace('traceback|exception|', 'traceback|') + '|\\b(python3?|docker|curl|wget|node_modules|stderr|devtools)\\b',
  'i',
);
/** An error's own name or code, never a word in capitals: "TypeError", "EADDRINUSE"; "EDIT" on a button is fine. */
const NOTE_ERROR = /\b[A-Z][a-z]\w*(Error|Exception)\b|\bE(ACCES|PERM|NOENT|ADDRINUSE|ADDRNOTAVAIL|CONNREFUSED|CONNRESET|CONNABORTED|PIPE|TIMEDOUT|EXIST|ISDIR|NOTDIR|NOTEMPTY|MFILE|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH|BUSY|INVAL|NOSPC|ROFS)\b/;
/** A status or exit code: "status code 500", "HTTP 503", "exit code 1". "Room code 101" is the business's own. */
const NOTE_STATUS = /\b(status code|http|exit code|exit status)\s*:?\s*\d{1,3}\b|\berrno\b/i;
/** A line of a stack trace: "at render (app.js:10:5)". */
const STACK = /\bat \S+ \(?[^\s()]+:\d+:\d+\)?/;

/** True when one sentence of an agent's note is plain: measures like "390 px" and "1280 wide" are. */
export function isPlainNote(sentence: string): boolean {
  return !NOTE_JARGON.test(sentence) && !VARIABLE.test(sentence) && !NOTE_ERROR.test(sentence) && !NOTE_STATUS.test(sentence) && !STACK.test(sentence);
}

/**
 * The plain sentences of an agent's note for the person (a picture's note, why a "done when" shows on no screen):
 * each sentence with technical words is left out on its own, and the rest stays. `left` is what was left out, for
 * the app log. `technical` also judges a sentence (the question filter's technical words).
 */
export function plainParts(text: string, technical: (sentence: string) => boolean = () => false): { kept: string; left: string } {
  const kept: string[] = [];
  const left: string[] = [];
  for (const s of text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean)) (isPlainNote(s) && !technical(s) ? kept : left).push(s);
  return { kept: kept.join(' '), left: left.join(' ') };
}

/* ── running it ───────────────────────────────────────── */

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepFailure('timeout', `${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** squad-kit's browser, started; with the person's words when it cannot be. A Stop ends the wait at once. */
async function openBrowser(signal?: AbortSignal, onLine?: (text: string) => void): Promise<Browser> {
  if (signal?.aborted) throw new Error(STOPPED);
  const launching = shotBrowser().launch(onLine ? { onLine } : {});
  let stopped: (() => void) | undefined;
  const onStop = new Promise<never>((_, reject) => {
    stopped = () => reject(new Error(STOPPED));
    signal?.addEventListener('abort', stopped, { once: true });
  });
  try {
    return await Promise.race([launching, onStop]);
  } catch (err) {
    if (signal?.aborted) {
      // A browser that started after the Stop is closed again.
      void launching.then((b) => b.close()).catch(() => undefined);
      throw new Error(STOPPED);
    }
    if (err instanceof BrowserSetupError) throw new ShotsUnavailable(NO_BROWSER, `${err.message}: ${err.detail}`);
    throw new ShotsUnavailable(NO_BROWSER, (err as Error).message ?? String(err));
  } finally {
    if (stopped) signal?.removeEventListener('abort', stopped);
  }
}

/** One browser for one agent run: started on first need, kept for its next calls, closed when the run ends. */
export class BrowserSession {
  private started: Promise<Browser> | null = null;
  private closed = false;

  constructor(private o: { signal?: AbortSignal; onLine?: (text: string) => void } = {}) {
    if (o.signal?.aborted) this.closed = true;
    else o.signal?.addEventListener('abort', () => void this.close(), { once: true });
  }

  /** The browser, started now if it is not yet. A failed start is tried again on the next call. */
  browser(): Promise<Browser> {
    if (this.closed) return Promise.reject(new Error(STOPPED));
    if (!this.started) {
      this.started = openBrowser(this.o.signal, this.o.onLine);
      this.started.catch(() => (this.started = null));
    }
    return this.started;
  }

  /** True once the browser has started at least once and is still open. */
  async ready(): Promise<boolean> {
    try {
      await this.browser();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const b = this.started;
    this.started = null;
    await b?.then((x) => x.close()).catch(() => undefined);
  }
}

/**
 * Opens a page of the app. A page that answers with an error status (a "Not found" page) is still a page: it opens and
 * its status comes back. Only a network failure is an error.
 */
async function open(page: BrowserPage, origin: string, p: string, ms: number): Promise<number | null> {
  const url = addressIn(origin, p);
  if (!url) throw new StepFailure('other', `"${p}" is not a path in the app`);
  return within(page.goto(url, ms), ms + 5000, `opening ${p}`);
}

/** What an agent is told about a page that answered with an error status. Nothing for a page that answered well. */
export function statusWords(status: number | null | undefined): string {
  return status && status >= 400 ? ` The page answered with error status ${status}.` : '';
}

function stillInApp(page: BrowserPage, origin: string): void {
  const at = page.url();
  if (at !== 'about:blank' && appOrigin(at) === origin) return;
  throw new StepFailure('blocked', `The page is at ${at}`, at);
}

async function snapshotOf(page: BrowserPage): Promise<string> {
  try {
    return trimSnapshot(await within(page.snapshot(), 6000, 'reading the page'));
  } catch {
    return '';
  }
}

export interface PageRun {
  /** The app's origin on this computer. */
  origin: string;
  /** The other parts of the same product, which a page may call. */
  also?: string[];
  stepMs?: number;
  /** When the whole call must end, as Date.now() counts. */
  deadline: number;
  signal?: AbortSignal;
}

/** Opens a page of the app at its size and does its steps. The page is at the end of them, still open. */
async function walk(browser: Browser, ask: ShotAsk, c: PageRun): Promise<{ page: BrowserPage; status: number | null } | { page: BrowserPage | null; failed: FailedShot }> {
  const stepMs = c.stepMs ?? STEP_MS;
  const phone = ask.size === 'phone';
  let page: BrowserPage | null = null;
  let at = 0;
  let step: BrowserStep | null = null;
  try {
    // No step runs past the call's own end.
    const left = () => Math.max(1000, Math.min(stepMs, c.deadline - Date.now()));
    page = await within(browser.page({ origin: c.origin, ...(c.also?.length ? { also: c.also } : {}), ...SIZES[phone ? 'phone' : 'desktop'], phone }), left(), 'opening a page');
    let status = await open(page, c.origin, ask.page, left());
    stillInApp(page, c.origin);
    for (const [i, raw] of (ask.steps ?? []).entries()) {
      at = i + 1;
      step = { ...raw, ...(raw.target ? { target: oneWay(raw.target) } : {}), ...(raw.action === 'wait' && typeof raw.ms === 'number' ? { ms: Math.max(0, Math.min(raw.ms, MAX_PAUSE_MS)) } : {}) };
      if (Date.now() >= c.deadline) throw new StepFailure('timeout', 'The call ran out of time');
      const ms = left();
      if (step.action === 'goto') status = await open(page, c.origin, step.path!, ms);
      else await within(page.act(step, ms), ms + 2000, stepWords(step));
      stillInApp(page, c.origin);
    }
    await page.settle(3000);
    stillInApp(page, c.origin);
    return { page, status };
  } catch (err) {
    if (c.signal?.aborted) {
      await page?.close().catch(() => undefined);
      throw new Error(STOPPED);
    }
    const words = failureWords(step, err, stepMs);
    const where = page ? page.url() : '';
    return {
      page,
      failed: {
        step: at,
        what: at && step ? stepWords(step) : `open ${ask.page}`,
        ...words,
        page: where && where !== 'about:blank' && appOrigin(where) === c.origin ? pathOf(where) : ask.page,
        snapshot: page ? await snapshotOf(page) : '',
        ...(err instanceof StepFailure && err.kind === 'blocked' ? { left: true } : {}),
      },
    };
  }
}

/** One picture: the page opened, its steps done, and the picture taken as bytes. The caller saves it. */
export async function shootOne(session: BrowserSession, ask: ShotAsk, c: PageRun): Promise<TakenShot | FailedShot> {
  const browser = await session.browser();
  const r = await walk(browser, ask, c);
  try {
    if ('failed' in r) return r.failed;
    const png = await within(r.page.screenshot(), 20_000, 'taking the picture');
    if (!png?.length) return { step: 0, what: 'save the picture', why: 'the browser gave no picture', plain: 'squad-kit could not save the picture.', page: pathOf(r.page.url()), snapshot: '' };
    return { png, page: pathOf(r.page.url()), ...(r.status ? { status: r.status } : {}) };
  } catch (err) {
    if (c.signal?.aborted) throw new Error(STOPPED);
    const words = failureWords(null, err, c.stepMs);
    return { step: 0, what: 'save the picture', ...words, page: ask.page, snapshot: '' };
  } finally {
    await r.page?.close().catch(() => undefined);
  }
}

/** What a page shows once its steps are done: where it ended and its accessibility tree, cut short. */
export async function lookAt(session: BrowserSession, ask: ShotAsk, c: PageRun): Promise<{ page: string; snapshot: string; status?: number } | FailedShot> {
  const browser = await session.browser();
  const r = await walk(browser, ask, c);
  try {
    if ('failed' in r) return r.failed;
    return { page: pathOf(r.page.url()), snapshot: await snapshotOf(r.page), ...(r.status ? { status: r.status } : {}) };
  } finally {
    await r.page?.close().catch(() => undefined);
  }
}

/**
 * Writes a new file and never writes through a link: anything already at the path, a link to nowhere included, makes
 * it give false (EEXIST) and write nothing. Other errors throw.
 */
export function writeNew(file: string, bytes: Buffer): boolean {
  const c = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(file, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW ?? 0), 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Gets squad-kit's browser onto this computer when it is not there yet, before any of a step's clocks start: the
 * first time it is downloaded, which can take minutes, so it has a limit of its own. Says one plain line when it
 * has to set it up. Throws ShotsUnavailable with the person's words.
 */
export async function prepareShots(o: { signal?: AbortSignal; onLine?: (text: string) => void; ms?: number } = {}): Promise<void> {
  const mod = shotBrowser();
  if (!mod.prepare) return;
  if (o.signal?.aborted) throw new Error(STOPPED);
  let timer: NodeJS.Timeout | undefined;
  let onStop: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserSetupError('Setting up the browser took too long', `It did not finish within ${Math.round((o.ms ?? SETUP_MS) / 60_000)} minutes`)), o.ms ?? SETUP_MS);
    onStop = () => reject(new Error(STOPPED));
    o.signal?.addEventListener('abort', onStop, { once: true });
  });
  try {
    await Promise.race([mod.prepare(o.onLine ? { onLine: o.onLine } : {}), limit]);
  } catch (err) {
    if (o.signal?.aborted) throw new Error(STOPPED);
    if (err instanceof BrowserSetupError) throw new ShotsUnavailable(NO_BROWSER, `${err.message}: ${err.detail}`);
    throw new ShotsUnavailable(NO_BROWSER, (err as Error).message ?? String(err));
  } finally {
    clearTimeout(timer);
    if (onStop) o.signal?.removeEventListener('abort', onStop);
  }
}

/**
 * One picture of the page at `url` (the first run's proof), saved as `file`, with no agent. Throws with the person's
 * words. The browser is set up first, on its own limit; then the picture has 90 seconds.
 */
export async function takeOne(url: string, file: string, o: { signal?: AbortSignal; onLine?: (text: string) => void } = {}): Promise<{ page: string }> {
  const origin = appOrigin(url);
  if (!origin) throw new ShotsUnavailable(NOT_HERE, `${url} is not an http(s) address on this computer`);
  await prepareShots(o);
  const session = new BrowserSession(o);
  const hard = setTimeout(() => void session.close(), 90_000);
  try {
    const page = pathOf(url) || '/';
    const r = await shootOne(session, { page: page.startsWith('/') ? page : '/' }, { origin, stepMs: 30_000, deadline: Date.now() + 60_000, ...(o.signal ? { signal: o.signal } : {}) });
    if (!('png' in r)) throw new ShotsUnavailable(r.plain, `${r.what}: ${r.why}`);
    // Written beside it, then moved in place: a link at `file` is replaced, never written through.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const part = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.part`);
    if (!writeNew(part, r.png)) throw new ShotsUnavailable('squad-kit could not save the picture.', `${part} is taken`);
    fs.renameSync(part, file);
    return { page: r.page };
  } finally {
    clearTimeout(hard);
    await session.close();
  }
}

/** The exact error behind a failure of squad-kit's browser, for engineers. */
export function shotsErrorDetail(err: unknown): string {
  if (err instanceof ShotsUnavailable) return err.detail;
  return (err as Error)?.message ?? String(err);
}

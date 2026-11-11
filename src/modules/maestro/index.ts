import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StepFailure, type BrowserStep, type BrowserTarget } from '../browser/types.js';
import { PhoneError } from '../phone/types.js';
import type { PhoneDriver, PhoneDriverModule, PhoneDriverStart } from '../phone-driver/types.js';

/**
 * Maestro taps through a phone app for squad-kit's pictures. One Maestro runs per booted device, in its own MCP mode
 * over stdio (`maestro mcp --no-viewer`): its Java starts once and its link to the device is kept, so each step takes
 * a second or two instead of a new Maestro of 20 seconds per flow (measured on a 16 GB Mac: up in 2 to 5 s, its first
 * step 7 to 17 s, then 0.5 to 5 s a step, reading the screen 0.2 s). squad-kit sends it one step at a time, so it knows
 * which step did not work. Its usage numbers stay off, and everything it writes goes in squad-kit's own folder: its
 * home folder is moved there, so the person's own ~/.maestro is never touched.
 */

/** What squad-kit tells Maestro about itself when it connects. */
const CLIENT = { name: 'squad-kit', version: '1' };
const START_MS = 120_000;
/** What one call to Maestro may take at most, besides the step's own time. */
const SLACK_MS = 30_000;

/** A part of the screen as Maestro reads it. Android's parts also say their kind (`cls`). */
interface Element {
  b?: string;
  txt?: string;
  a11y?: string;
  hint?: string;
  val?: string;
  rid?: string;
  cls?: string;
  c?: Element[];
}

export interface Part {
  /** Its words: what a person reads, or hears from the screen reader. */
  words: string;
  value?: string;
  hint?: string;
  id?: string;
  top: number;
  bottom: number;
}

/** Parts of the system around the app: the keyboard and its bar. Nothing of the app itself. */
const KEYBOARD = new Set(['UIKeyboardLayoutStar Preview', 'SystemInputAssistantView']);

/* ── Android's screen ─────────────────────────────────── */

/** Android's status bar, notifications and navigation: the system's, above and below every app. */
const ANDROID_SYSTEM = /^com\.android\.systemui:id\//;
/** The keyboard (Gboard, or Android's own) and its frame. Its suggestion strip repeats the words just typed. */
const ANDROID_KEYBOARD = /^com\.(google\.)?android\.inputmethod\.|^android:id\/(inputArea|input_method_)/;
/** Android's own frames around every window: ids with no words say nothing about the app. */
const ANDROID_FRAME = /^android:id\//;

/** "[24,142][378,198]": top and bottom. */
function bounds(b: string | undefined): { top: number; bottom: number } {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? '');
  return m ? { top: Number(m[2]), bottom: Number(m[4]) } : { top: 0, bottom: 0 };
}

/**
 * The parts of the app's screen, from Maestro's `inspect_screen`, in order: the status bar at the very top and the
 * keyboard are left out, and `keyboard` says whether one is open; `keys` are the keyboard's own parts with words, like
 * its suggestions. An Android screen is read by its own rules (androidParts).
 */
export function partsOf(json: string): { parts: Part[]; keyboard: boolean; keys: Part[] } {
  let tree: { elements?: Element[] };
  try {
    tree = JSON.parse(json) as { elements?: Element[] };
  } catch {
    return { parts: [], keyboard: false, keys: [] };
  }
  if (isAndroid(tree.elements ?? [])) return androidParts(tree.elements ?? []);
  const all: (Part & { keyboard?: boolean })[] = [];
  let keyboardTop = Infinity;
  const walk = (e: Element) => {
    const where = bounds(e.b);
    if (e.rid && KEYBOARD.has(e.rid)) keyboardTop = Math.min(keyboardTop, where.top);
    const words = (e.a11y || e.txt || e.hint || '').trim();
    if (words || e.rid) {
      all.push({
        words,
        ...where,
        ...(e.val && e.val !== words ? { value: e.val } : e.txt && e.a11y && e.txt !== e.a11y ? { value: e.txt } : {}),
        ...(e.hint && e.hint !== words ? { hint: e.hint } : {}),
        ...(e.rid ? { id: e.rid } : {}),
      });
    }
    for (const c of e.c ?? []) walk(c);
  };
  for (const e of tree.elements ?? []) walk(e);
  // The status bar sits above every app: its clock and battery are no part of the app.
  const parts = all.filter((p) => !(p.bottom <= 50 && p.top < 50 && p.bottom - p.top < 30) && p.top < keyboardTop && !(p.id && KEYBOARD.has(p.id)));
  // The outermost part names the whole app: it says nothing about the screen.
  if (parts.length > 1 && parts[0]!.top === 0 && parts[0]!.bottom >= Math.max(...parts.map((p) => p.bottom))) parts.shift();
  return { parts, keyboard: keyboardTop !== Infinity, keys: [] };
}

/** Android's parts say their kind; an iPhone's never do. */
function isAndroid(elements: Element[]): boolean {
  const seen = (e: Element): boolean => Boolean(e.cls?.startsWith('android.')) || (e.c ?? []).some(seen);
  return elements.some(seen);
}

/**
 * An Android screen: its sizes are pixels, not points, so nothing is told apart by size. The status bar and the
 * navigation (`com.android.systemui`) go whole, with everything inside them; so does the keyboard, whose suggestion
 * strip would otherwise match the words just typed: what the keyboard covers is left out, as on the iPhone. A field
 * that holds text says its label as its words and the text as its value.
 */
function androidParts(elements: Element[]): { parts: Part[]; keyboard: boolean; keys: Part[] } {
  const all: Part[] = [];
  const keys: Part[] = [];
  let keyboardTop = Infinity;
  let keyboard = false;
  const partOf = (e: Element): Part | null => {
    const typed = Boolean(e.hint && e.txt && !e.a11y);
    const words = (typed ? e.hint! : e.a11y || e.txt || e.hint || '').trim();
    if (!words && (!e.rid || ANDROID_FRAME.test(e.rid))) return null;
    return {
      words,
      ...bounds(e.b),
      ...(typed ? { value: e.txt! } : e.val && e.val !== words ? { value: e.val } : e.txt && e.a11y && e.txt !== e.a11y ? { value: e.txt } : {}),
      ...(e.hint && e.hint !== words ? { hint: e.hint } : {}),
      ...(e.rid ? { id: e.rid } : {}),
    };
  };
  const walk = (e: Element, inKeyboard: boolean) => {
    if (e.rid && ANDROID_SYSTEM.test(e.rid)) return;
    const kb = inKeyboard || Boolean(e.rid && ANDROID_KEYBOARD.test(e.rid));
    const p = partOf(e);
    if (kb) {
      keyboard = true;
      // The keyboard's top is where its first key or suggestion is: its frame covers the whole screen.
      if (p?.words) {
        keyboardTop = Math.min(keyboardTop, p.top);
        keys.push(p);
      }
    } else if (p) all.push(p);
    for (const c of e.c ?? []) walk(c, kb);
  };
  for (const e of elements) walk(e, false);
  const parts = all.filter((p) => p.top < keyboardTop);
  if (parts.length > 1 && parts[0]!.top === 0 && parts[0]!.bottom >= Math.max(...parts.map((p) => p.bottom))) parts.shift();
  return { parts, keyboard: keyboard && keyboardTop !== Infinity, keys };
}

/** The screen as text, one part a line, the way the browser's accessibility tree reads. */
export function screenWords(json: string): string {
  const { parts, keyboard } = partsOf(json);
  const lines = parts.map((p) => `- ${JSON.stringify(p.words || '')}${p.value ? ` showing ${JSON.stringify(p.value)}` : ''}${p.hint ? ` (hint ${JSON.stringify(p.hint)})` : ''}${p.id ? ` [id ${JSON.stringify(p.id)}]` : ''}`);
  if (keyboard) lines.push('- (the keyboard is open)');
  return lines.join('\n');
}

/** Text as an exact match in Maestro's words, which are a full-match regular expression that ignores case. */
export function exactly(text: string): string {
  return text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The words a target names, the one way squad-kit uses it: a phone screen has no roles or css, only words and ids. */
export function targetText(t: BrowserTarget): { text?: string; id?: string; why?: string } {
  if (t.testId?.trim()) return { id: t.testId.trim() };
  const words = t.name ?? t.label ?? t.placeholder ?? t.text;
  if (words?.trim()) return { text: words.trim() };
  if (t.css) return { why: 'a phone screen has no css: name the part by its words, like { "text": "Sign up" }' };
  return { why: `a ${t.role ?? 'part'} with no name: give the words on it, like { "role": "button", "name": "Save" }` };
}

/** The parts a target matches: exactly first, then any whose words hold it, as the browser does. */
export function matching(parts: Part[], t: { text?: string; id?: string }): { exact: boolean; found: Part[] } {
  if (t.id) return { exact: true, found: parts.filter((p) => p.id === t.id) };
  const want = (t.text ?? '').toLowerCase();
  const all = (p: Part) => [p.words, p.value, p.hint].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase());
  const exact = parts.filter((p) => all(p).some((x) => x === want));
  if (exact.length) return { exact: true, found: exact };
  return { exact: false, found: parts.filter((p) => all(p).some((x) => x.includes(want))) };
}

/** Roles a person presses: when several parts have the words, the lowest is the button (a screen's title is above it). */
const PRESSED = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'switch', 'radio', 'option']);

/** Keys a phone has, in Maestro's words. Others are typed, or have no key on a phone. */
const KEYS: Record<string, string> = { Enter: 'Enter', Backspace: 'Backspace', Delete: 'Backspace' };

const q = (s: string) => JSON.stringify(s);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The Maestro selector for a target on this screen: its words or id, and which one when several match. */
function selector(t: BrowserTarget, sel: { text?: string; id?: string }, m: { exact: boolean; found: Part[] }): string {
  if (sel.id) return `id: ${q(sel.id)}`;
  const text = m.exact ? exactly(sel.text!) : `.*${exactly(sel.text!)}.*`;
  // Maestro counts the parts its words match in screen order: a pressed thing is the lowest of them.
  const pick = m.found.length > 1 && PRESSED.has(t.role ?? '') ? m.found.length - 1 : 0;
  return `text: ${q(text)}${pick ? `\n    index: ${pick}` : ''}`;
}

/** Maestro's own error, as one of the reasons squad-kit can put in words. */
export function failureOf(text: string): StepFailure {
  const t = text.replace(/^Failed to run flow:\s*/i, '').trim();
  if (/Element not found|Assertion is false|not visible/i.test(t)) return new StepFailure('missing', t);
  if (/timed? ?out|timeout/i.test(t)) return new StepFailure('timeout', t);
  if (/App crashed|is not running|stopped responding/i.test(t)) return new StepFailure('closed', t);
  return new StepFailure('other', t);
}

/**
 * One Maestro in MCP mode, as a child squad-kit started, and how to stop it: its stop ends once the child has ended.
 * Tests give a made-up one.
 */
export type MaestroSpawn = (binary: string, args: string[], env: NodeJS.ProcessEnv) => { child: ChildProcess; stop(): void | Promise<void> };

const realSpawn: MaestroSpawn = (binary, args, env) => {
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  return { child, stop: () => stopChild(child) };
};

/** How long Maestro's Java gets to end by itself after it is asked to, before its group is killed. */
const END_MS = 3000;

/**
 * The child's whole group stops: Maestro's start script hands over to Java, which may start its own helpers. Asked
 * first, at once (so it also happens as squad-kit exits); a Java still there after END_MS is killed, with its group.
 */
export function stopChild(child: ChildProcess): Promise<void> {
  try {
    child.stdin?.end();
  } catch {
    // Already closed.
  }
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const signal = (s: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') child.kill(s);
      else process.kill(-child.pid!, s);
    } catch {
      // Already gone.
    }
  };
  signal('SIGTERM');
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(hard);
      clearTimeout(last);
      resolve();
    };
    child.once('exit', done);
    const hard = setTimeout(() => signal('SIGKILL'), END_MS);
    const last = setTimeout(done, END_MS + 1000);
  });
}

/** Maestro over MCP: a request and its answer, line by line on stdio. */
class Mcp {
  private next = 1;
  private waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private buf = '';
  private ended: Error | null = null;
  /** The end of what it printed on its own, for engineers. */
  said = '';

  constructor(readonly child: ChildProcess) {
    child.stdout?.on('data', (d: Buffer) => this.read(d.toString()));
    child.stderr?.on('data', (d: Buffer) => (this.said = (this.said + d.toString()).slice(-8000)));
    const gone = (why: string) => {
      this.ended ??= new Error(why);
      for (const w of this.waiting.values()) w.reject(this.ended);
      this.waiting.clear();
    };
    child.on('exit', (code) => gone(`Maestro ended (${code ?? 'stopped'})`));
    child.on('error', (err) => gone(err.message));
  }

  private read(text: string): void {
    this.buf += text;
    for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        const m = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof m.id !== 'number') continue;
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.reject(new Error(m.error.message ?? 'Maestro said no'));
        else w?.resolve(m.result);
      } catch {
        // Not one of its answers.
      }
    }
  }

  get alive(): boolean {
    return !this.ended;
  }

  send(method: string, params?: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  ask<T>(method: string, params: unknown, ms: number): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new StepFailure('timeout', `Maestro did not answer ${method} within ${Math.round(ms / 1000)} seconds`));
      }, ms);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

type ToolAnswer = { content?: { type?: string; text?: string }[]; isError?: boolean };
const textOf = (a: ToolAnswer) => (a.content ?? []).map((c) => c.text ?? '').join('\n');

/** Starts Maestro in MCP mode for one device. */
export async function openMaestro(o: PhoneDriverStart, spawnIt: MaestroSpawn = realSpawn): Promise<PhoneDriver> {
  if (!fs.existsSync(o.binary)) throw new PhoneError("squad-kit could not find Maestro, which taps through the app.", `${o.binary} is not there`);
  const home = path.join(o.dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Its usage numbers stay off.
    MAESTRO_CLI_NO_ANALYTICS: '1',
    MAESTRO_CLI_NO_UPDATE_NOTIFICATION: '1',
    // Its box about its own analysis service stays out of what it prints.
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    // Its home folder is squad-kit's: what it keeps (its helpers on the phone, logs) never goes to ~/.maestro.
    MAESTRO_OPTS: `${process.env.MAESTRO_OPTS ? `${process.env.MAESTRO_OPTS} ` : ''}-Duser.home=${home}`,
    ...(o.javaHome ? { JAVA_HOME: o.javaHome } : {}),
    // What the phone needs to be reached: an Android phone's SDK and adb keys, in squad-kit's folder.
    ...o.env,
  };
  const { child, stop } = spawnIt(o.binary, ['mcp', '--no-viewer', '--working-dir', o.dir], env);
  const mcp = new Mcp(child);
  const onAbort = () => void stop();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await mcp.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: CLIENT }, START_MS);
    mcp.send('notifications/initialized');
  } catch (err) {
    void stop();
    throw new PhoneError('Maestro did not start.', `${(err as Error).message}\n${mcp.said.slice(-2000)}`);
  }

  const call = async (name: string, args: Record<string, unknown>, ms: number): Promise<ToolAnswer> => mcp.ask<ToolAnswer>('tools/call', { name, arguments: { device_id: o.device, ...args } }, ms);
  const screen = async (ms: number): Promise<string> => {
    const a = await call('inspect_screen', {}, ms);
    if (a.isError) throw failureOf(textOf(a));
    return textOf(a);
  };
  /** One or more Maestro commands on the app, as one inline flow. */
  const run = async (appId: string, yaml: string, ms: number): Promise<void> => {
    const a = await call('run', { yaml: `appId: ${q(appId)}\n---\n${yaml}` }, ms + SLACK_MS);
    if (a.isError) throw failureOf(textOf(a));
    const said = textOf(a);
    if (/"success"\s*:\s*false/.test(said)) throw failureOf(said);
  };
  /**
   * The parts a target matches, waited for while the screen draws, up to `ms`. A part the keyboard covers shows once
   * the keyboard goes away: it goes only then, as putting it away takes Maestro a few seconds.
   */
  const find = async (appId: string, t: BrowserTarget, ms: number): Promise<{ sel: string; part: Part }> => {
    const named = targetText(t);
    if (named.why) throw new StepFailure('other', named.why);
    const until = Date.now() + ms;
    let hid = false;
    for (;;) {
      const seen = partsOf(await screen(Math.max(5000, until - Date.now())));
      const m = matching(seen.parts, named);
      // Words the keyboard also shows (its suggestions on Android) would be counted by Maestro too: it goes first.
      const echoed = seen.keyboard && !hid && matching(seen.keys, named).found.length > 0;
      if (m.found.length && !echoed) return { sel: selector(t, named, m), part: m.found[m.found.length > 1 && PRESSED.has(t.role ?? '') ? m.found.length - 1 : 0]! };
      if (seen.keyboard && !hid) {
        hid = true;
        await run(appId, '- hideKeyboard', Math.max(5000, until - Date.now()));
        continue;
      }
      if (Date.now() >= until) throw new StepFailure('missing', `Nothing on the screen matches ${JSON.stringify(t)}`);
      await sleep(400);
    }
  };
  /** True when the keyboard shows now. */
  const keyboardUp = async (ms: number): Promise<boolean> => partsOf(await screen(ms)).keyboard;

  const driver: PhoneDriver = {
    async act(appId: string, step: BrowserStep, ms: number) {
      const until = Date.now() + ms;
      const left = () => Math.max(1000, until - Date.now());
      switch (step.action) {
        case 'click':
        case 'check':
        case 'uncheck': {
          const { sel } = await find(appId, step.target!, ms);
          await run(appId, `- tapOn:\n    ${sel}`, left());
          return;
        }
        case 'fill': {
          // Its words go in place of what the field held, as in the browser: only a field that holds text is cleared.
          const { sel, part } = await find(appId, step.target!, ms);
          const held = part.value?.length ?? 0;
          return run(appId, `- tapOn:\n    ${sel}${held ? `\n- eraseText: ${held + 2}` : ''}\n- inputText: ${q(step.value ?? '')}`, left());
        }
        case 'select': {
          const { sel } = await find(appId, step.target!, ms);
          await run(appId, `- tapOn:\n    ${sel}`, left());
          const { sel: choice } = await find(appId, { text: step.value ?? '' }, left());
          return run(appId, `- tapOn:\n    ${choice}`, left());
        }
        case 'hover': {
          // On a phone, "hover" brings a part into view: the screen scrolls down until it shows.
          const named = targetText(step.target!);
          if (named.why) throw new StepFailure('other', named.why);
          const el = named.id ? `id: ${q(named.id)}` : `text: ${q(`.*${exactly(named.text!)}.*`)}`;
          return run(appId, `- scrollUntilVisible:\n    element:\n      ${el}\n    direction: DOWN\n    timeout: ${Math.round(left())}`, left());
        }
        case 'press': {
          if (step.target) await driver.act(appId, { action: 'click', target: step.target }, left());
          const key = step.key ?? 'Enter';
          // Escape puts the keyboard away, the nearest a phone has; with no keyboard up there is nothing to do.
          if (key === 'Escape') return (await keyboardUp(left())) ? run(appId, '- hideKeyboard', left()) : undefined;
          if (KEYS[key]) return run(appId, `- pressKey: ${KEYS[key]}`, left());
          if (/^(Shift\+)?[A-Za-z0-9]$/.test(key) || key === 'Space') return run(appId, `- inputText: ${q(key === 'Space' ? ' ' : key.slice(-1))}`, left());
          throw new StepFailure('other', `a phone has no ${key} key: use Enter, Backspace, Escape (it hides the keyboard), a letter or a digit`);
        }
        case 'wait': {
          if (!step.target) await sleep(Math.min(step.ms ?? 0, 5000));
          else await find(appId, step.target, ms);
          return;
        }
        default:
          throw new StepFailure('other', `${step.action} is not a step the phone knows`);
      }
    },
    async screenText(ms) {
      return screenWords(await screen(ms));
    },
    get alive() {
      return mcp.alive;
    },
    async close() {
      o.signal?.removeEventListener('abort', onAbort);
      await stop();
    },
  };
  return driver;
}

export const maestroDriver: PhoneDriverModule = {
  name: 'maestro',
  label: 'Maestro',
  open: (o) => openMaestro(o),
};

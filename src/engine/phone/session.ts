import path from 'node:path';
import { phoneDriver } from '../../modules/registry.js';
import { StepFailure, type BrowserStep } from '../../modules/browser/types.js';
import { PhoneError, type AppOnPhone, type PhoneModule, type PhoneSize } from '../../modules/phone/types.js';
import type { PhoneDriver } from '../../modules/phone-driver/types.js';
import { MAX_PAUSE_MS, failureWords, oneWay, stepWords, trimSnapshot, type FailedShot, type ShotAsk } from '../shots.js';
import { BuildFailed, buildForPhone, type PhoneKind } from './build.js';
import { ownDevice, phonesHome, type OwnDevice } from './devices.js';
import { aboutWords, noteStep, stepSeconds } from './times.js';
import { onDown, withPhone } from './turn.js';
import { phoneFor } from './which.js';
import type { PhoneSystem } from '../tools/which-phone.js';

/**
 * The Tester's pictures on squad-kit's own phone, for one agent run: the app is built for the phone in the story's
 * copy, put on squad-kit's hidden iPhone or iPad (or Android phone or tablet), opened fresh in the language asked for,
 * its page opened by the app's own link when it has one, and the Tester's steps tapped through by name; then the
 * picture. One Maestro runs per
 * booted device for every story, kept between pictures. What did not work comes back with why, short for the agent
 * and plain for the person, in the same words as the browser's (shots.ts).
 */

/** Where squad-kit runs Maestro from, and the Java it runs on when squad-kit got its own. */
export interface TapTools {
  maestro: string;
  javaHome?: string;
}

export interface PhoneSetup {
  /** The story's copy of the code: the app is built here. */
  cwd: string;
  kind: PhoneKind;
  /** The phone it runs on: the iPhone (the default) or Android. */
  system?: PhoneSystem;
  tools: TapTools;
  /** The system version for squad-kit's devices, when one is asked ("18.2"). Left out, the newest. */
  runtime?: string;
  /** The sizes the pictures may be taken at. Left out, phone and tablet. */
  sizes?: PhoneSize[];
  say(text: string): void;
  log?(text: string): void;
  signal?: AbortSignal;
  /** An app built already, instead of building one (the first run's check of this computer, tests). */
  app?: string;
}

/** One picture or look on the phone: a ShotAsk at phone or tablet size, in a language ("en", "ar"). */
export interface PhoneAsk extends Omit<ShotAsk, 'size'> {
  size?: PhoneSize;
  language?: string;
}

export interface PhoneShot {
  png: Buffer;
  /** Where the picture was taken: the page asked for, or "/" for the app's start screen. */
  page: string;
  /** The real device, for the picture's label: "iPhone 16 Pro", "Pixel 9". */
  device: string;
  /** A line for the agent, when the page could not be opened as asked. */
  said?: string;
}

export interface PhoneRun {
  /** When the whole call must end, as Date.now() counts. */
  deadline: number;
  stepMs: number;
  signal?: AbortSignal;
}

/** squad-kit's phone cannot work for this story right now. `message` is for the person; `detail` for engineers. */
export class PhoneUnavailable extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

const STOPPED = 'You stopped the squad.';
/** What the agent is told when its page has no link in this app. */
export const NO_LINKS = "This app has no links of its own, so squad-kit opened its start screen: use steps to reach the screen you need.";
/** The language the app opens in when the Tester asks for none. */
export const DEFAULT_LANGUAGE = 'en';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepFailure('timeout', `${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The app's own link for a page: "/book?day=2" is "myapp://book?day=2". */
export function linkFor(scheme: string, page: string): string {
  return `${scheme}://${page.replace(/^\/+/, '')}`;
}

/* ── one Maestro per booted device, for every story ───── */

const drivers = new Map<string, Promise<PhoneDriver>>();
/** The same, once started: what stops at once when squad-kit itself ends. */
const started = new Map<string, PhoneDriver>();
/** Devices whose Maestro has done its first step: its very first one puts its helper on the phone, which takes long. */
const warmed = new Set<string>();
/** The app squad-kit last put on each device, by the device and the app's id: another story's build is put back. */
const installed = new Map<string, string>();

function dropDriver(id: string): Promise<void> {
  const d = drivers.get(id);
  drivers.delete(id);
  started.delete(id);
  warmed.delete(id);
  return d ? d.then((x) => x.close()).catch(() => undefined) : Promise.resolve();
}

/** A device that went down, or started again clean: its Maestro goes, and nothing is on it any more. */
function deviceDown(id: string): void {
  void dropDriver(id);
  for (const key of [...installed.keys()]) if (key.startsWith(`${id}:`)) installed.delete(key);
}

// A device that shuts down takes its Maestro with it, and so does squad-kit when it ends.
onDown(deviceDown);
process.once('exit', () => {
  for (const d of started.values()) void d.close();
});

/** Every Maestro squad-kit runs stops: the board stops. Resolves once each has ended. */
export function closeDrivers(): Promise<void> {
  return Promise.all([...drivers.keys()].map((id) => dropDriver(id))).then(() => undefined);
}

/**
 * Maestro ready on a device: started, and its first step done (which puts its helper on the phone). For `squad phone
 * start`, so the first pictures wait for nothing.
 */
export async function readyToTap(phone: PhoneModule, id: string, tools: TapTools): Promise<void> {
  const driver = await driverFor(id, tools, phone);
  if (warmed.has(id)) return;
  await driver.screenText(180_000);
  warmed.add(id);
}

async function driverFor(id: string, tools: TapTools, phone: PhoneModule): Promise<PhoneDriver> {
  const have = drivers.get(id);
  if (have) {
    const d = await have.catch(() => null);
    if (d?.alive) return d;
    drivers.delete(id);
  }
  // Maestro knows an Android phone by its serial, and reaches it with squad-kit's own adb keys.
  const env = phone.tapEnv?.();
  const opening = phoneDriver().open({ device: phone.tapId?.(id) ?? id, binary: tools.maestro, ...(tools.javaHome ? { javaHome: tools.javaHome } : {}), dir: path.join(phonesHome(), 'maestro'), ...(env && Object.keys(env).length ? { env } : {}) });
  drivers.set(id, opening);
  opening.then((d) => started.set(id, d)).catch(() => drivers.delete(id));
  return opening;
}

/** The words for a step that did not work, with what the screen showed then. */
async function failed(step: BrowserStep | null, at: number, err: unknown, page: string, driver: PhoneDriver | null, stepMs: number): Promise<FailedShot> {
  const words = err instanceof StepFailure ? failureWords(step, err, stepMs) : { why: (err as Error)?.message ?? String(err), plain: 'The app did not react as expected on the phone.' };
  let snapshot = '';
  try {
    snapshot = driver ? trimSnapshot(await driver.screenText(6000)) : '';
  } catch {
    snapshot = '';
  }
  return { step: at, what: at && step ? stepWords(step) : `open ${page}`, ...words, page, snapshot };
}

export class PhoneSession {
  private readying: Promise<void> | null = null;
  private app: { path: string; info: AppOnPhone } | null = null;
  private devices: Partial<Record<PhoneSize, OwnDevice>> = {};
  private closed = false;

  private phone: PhoneModule;

  constructor(
    private s: PhoneSetup,
    phone?: PhoneModule,
  ) {
    this.phone = phone ?? phoneFor(s.system ?? 'ios');
  }

  get sizes(): PhoneSize[] {
    return this.s.sizes ?? ['phone', 'tablet'];
  }

  /** What the phone is, for the Tester's tools: "iPhone simulator", "Android emulator". */
  get label(): string {
    return this.phone.label;
  }

  /** The real device of each size, for the pictures' labels: { phone: "iPhone 16 Pro" }. Known once ready. */
  labels(): Partial<Record<PhoneSize, string>> {
    return Object.fromEntries(Object.entries(this.devices).map(([k, d]) => [k, d!.model])) as Partial<Record<PhoneSize, string>>;
  }

  /** The app's own link names, once built: none means every picture starts on its start screen. */
  links(): string[] {
    return this.app?.info.schemes ?? [];
  }

  get appId(): string | undefined {
    return this.app?.info.appId;
  }

  /**
   * Gets everything ready before the agent's clock starts: the app built for the phone (or the last build, when the
   * code is the same), squad-kit's devices made when it has none, and its phone up with the app on it and Maestro
   * ready. Once, even when asked twice; a failed try is tried again on the next ask. Throws PhoneUnavailable.
   */
  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(STOPPED));
    if (!this.readying) {
      this.readying = this.getReady();
      this.readying.catch(() => (this.readying = null));
    }
    return this.readying;
  }

  private async getReady(): Promise<void> {
    const o = this.s;
    try {
      let app = o.app;
      if (!app) app = (await buildForPhone(o.cwd, o.kind, { system: o.system ?? 'ios', phone: this.phone, say: o.say, ...(o.log ? { log: o.log } : {}), ...(o.signal ? { signal: o.signal } : {}) })).app;
      const info = await this.phone.appInfo(app);
      this.app = { path: app, info };
      for (const size of this.sizes) this.devices[size] = await ownDevice(this.phone, size, o.runtime ? { runtime: o.runtime } : {});
      // The phone comes up now, with the app and Maestro ready, so the first picture does not wait for them.
      await withPhone(this.phone, this.sizes[0]!, async (turn) => {
        if (turn.fresh) deviceDown(turn.device.id);
        await this.installOn(turn.device.id, turn.fresh);
        await this.warm(turn.device.id);
      }, this.turnOptions());
    } catch (err) {
      if (o.signal?.aborted || this.closed) throw new Error(STOPPED);
      if (err instanceof BuildFailed || err instanceof PhoneError) throw new PhoneUnavailable(err.message, err.detail);
      throw new PhoneUnavailable(`squad-kit could not get its ${this.phone.words.phone} ready.`, (err as Error)?.stack ?? String(err));
    }
  }

  private turnOptions() {
    return { ...(this.s.runtime ? { runtime: this.s.runtime } : {}), say: this.s.say, ...(this.s.log ? { log: this.s.log } : {}), ...(this.s.signal ? { signal: this.s.signal } : {}) };
  }

  /** Puts this story's app on the device when the one there is another's, or the device is new. */
  private async installOn(id: string, fresh: boolean): Promise<void> {
    const app = this.app!;
    const key = `${id}:${app.info.appId}`;
    if (!fresh && installed.get(key) === app.path) return;
    const t0 = Date.now();
    this.s.say(`Putting the app on squad-kit's ${this.phone.words.phone}, ${aboutWords(stepSeconds('install', undefined, this.phone))}`);
    await this.phone.install(id, app.path, this.s.signal ? { signal: this.s.signal } : {});
    noteStep('install', (Date.now() - t0) / 1000, undefined, this.phone);
    installed.set(key, app.path);
    this.s.log?.(`squad-kit put ${app.path} on its phone ${id} in ${Math.round((Date.now() - t0) / 1000)} s`);
  }

  /** Maestro on the device, ready: its first step ever there puts its helper on the phone, said with its usual time. */
  private async warm(id: string): Promise<PhoneDriver> {
    const driver = await driverFor(id, this.s.tools, this.phone);
    if (warmed.has(id)) return driver;
    this.s.say(`Getting squad-kit's ${this.phone.words.phone} ready to tap through the app, ${aboutWords(stepSeconds('first-run', undefined, this.phone))}`);
    const t0 = Date.now();
    await driver.screenText(180_000);
    noteStep('first-run', (Date.now() - t0) / 1000, undefined, this.phone);
    warmed.add(id);
    return driver;
  }

  /** One picture: the app opened fresh, its page, its steps, then the picture of the screen. The caller saves it. */
  async shoot(ask: PhoneAsk, c: PhoneRun): Promise<PhoneShot | FailedShot> {
    const r = await this.walk(ask, c, true);
    return r;
  }

  /** What the screen shows once the steps are done, as text. */
  async look(ask: PhoneAsk, c: PhoneRun): Promise<{ page: string; snapshot: string; device: string; said?: string } | FailedShot> {
    const r = await this.walk(ask, c, false);
    if ('step' in r) return r;
    return { page: r.page, snapshot: r.snapshot, device: r.device, ...(r.said ? { said: r.said } : {}) };
  }

  private async walk(ask: PhoneAsk, c: PhoneRun, picture: true): Promise<PhoneShot | FailedShot>;
  private async walk(ask: PhoneAsk, c: PhoneRun, picture: false): Promise<{ page: string; snapshot: string; device: string; said?: string } | FailedShot>;
  private async walk(ask: PhoneAsk, c: PhoneRun, picture: boolean): Promise<(PhoneShot & { snapshot: string }) | PhoneShot | FailedShot | { page: string; snapshot: string; device: string; said?: string }> {
    await this.ready();
    const size = ask.size ?? 'phone';
    if (!this.sizes.includes(size)) throw new PhoneUnavailable(`squad-kit has no ${size} for this app.`, `Sizes: ${this.sizes.join(', ')}`);
    const app = this.app!;
    const appId = app.info.appId;
    const language = ask.language?.trim() || DEFAULT_LANGUAGE;
    return withPhone(this.phone, size, async (turn) => {
      const id = turn.device.id;
      const device = turn.device.model;
      if (turn.fresh) deviceDown(id);
      if (c.signal?.aborted || this.closed) throw new Error(STOPPED);
      let page = '/';
      let said: string | undefined;
      let driver: PhoneDriver | null = null;
      let at = 0;
      let step: BrowserStep | null = null;
      const open = async (p: string) => {
        if (p === '/' || !p.trim()) return;
        const scheme = app.info.schemes[0];
        if (!scheme) {
          said = NO_LINKS;
          return;
        }
        await this.phone.openLink(id, linkFor(scheme, p));
        page = p;
      };
      try {
        await this.installOn(id, turn.fresh);
        driver = await this.warm(id);
        // Fresh every time, in the language asked: nothing is left from the picture before.
        await this.phone.terminate(id, appId);
        await this.phone.launch(id, appId, { language });
        await open(ask.page);
        await settle(driver);
        const stepMs = c.stepMs;
        let typed = false;
        for (const [i, raw] of (ask.steps ?? []).entries()) {
          at = i + 1;
          step = { ...raw, ...(raw.target ? { target: oneWay(raw.target) } : {}), ...(raw.action === 'wait' && typeof raw.ms === 'number' ? { ms: Math.max(0, Math.min(raw.ms, MAX_PAUSE_MS)) } : {}) };
          if (Date.now() >= c.deadline) throw new StepFailure('timeout', 'The call ran out of time');
          const ms = Math.max(1000, Math.min(stepMs, c.deadline - Date.now()));
          if (step.action === 'goto') {
            await open(step.path ?? '/');
            await settle(driver);
            continue;
          }
          // The keyboard a field brings up goes away only when it covers the part a step needs (maestro/index.ts).
          driver = await this.tapped(id, appId, driver, step, ms);
          typed = step.action === 'fill' || (step.action === 'press' && step.key !== 'Escape' && step.key !== 'Enter');
        }
        at = 0;
        step = null;
        // The picture shows the screen, not the keyboard over it: put away when it is up.
        if (typed) await driver.act(appId, { action: 'press', key: 'Escape' }, 8000).catch(() => undefined);
        await settle(driver);
        if (!picture) return { page, snapshot: trimSnapshot(await driver.screenText(10_000)), device, ...(said ? { said } : {}) };
        const png = await within(this.phone.screenshot(id), 30_000, 'taking the picture');
        if (!png.length) return { step: 0, what: 'save the picture', why: 'the phone gave no picture', plain: 'squad-kit could not save the picture.', page, snapshot: '' };
        return { png, page, device, ...(said ? { said } : {}) };
      } catch (err) {
        if (c.signal?.aborted || this.s.signal?.aborted || this.closed) throw new Error(STOPPED);
        return failed(step, at, err, page, driver, c.stepMs);
      }
    }, this.turnOptions());
  }

  /** One step; once more with a new Maestro when the old one ended by itself. A step that did not work throws. */
  private async tapped(id: string, appId: string, driver: PhoneDriver, step: BrowserStep, ms: number): Promise<PhoneDriver> {
    try {
      await within(driver.act(appId, step, ms), ms + 40_000, stepWords(step));
      return driver;
    } catch (err) {
      if (err instanceof StepFailure || driver.alive) throw err;
      this.s.log?.(`Maestro ended on squad-kit's phone ${id}; squad-kit starts it again: ${(err as Error).message}`);
      void dropDriver(id);
      const again = await this.warm(id);
      await within(again.act(appId, step, ms), ms + 40_000, stepWords(step));
      return again;
    }
  }

  async close(): Promise<void> {
    // Maestro and the phone stay up for the next picture of any story; the phone shuts down when unused (turn.ts).
    this.closed = true;
  }
}

/** Waits a moment for the screen to draw: until two looks in a row read the same, 6 seconds at most. */
async function settle(driver: PhoneDriver): Promise<void> {
  const until = Date.now() + 6000;
  let last = '';
  while (Date.now() < until) {
    const now = await driver.screenText(5000).catch(() => '');
    if (now && now === last) return;
    last = now;
    await sleep(500);
  }
}

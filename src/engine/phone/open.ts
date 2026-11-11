import fs from 'node:fs';
import { PhoneError, type PhoneModule } from '../../modules/phone/types.js';
import { treeOf } from '../lane.js';
import { BuildFailed, buildForPhone, lastBuild, type PhoneKind } from './build.js';
import { ownDevice, type OwnDevice } from './devices.js';
import { aboutWords, stepSeconds } from './times.js';
import { endHold, holdPhone, restarted, shutDownGently, withPhone } from './turn.js';
import { phoneFor } from './which.js';
import type { PhoneSystem } from '../tools/which-phone.js';

/**
 * An app opened on squad-kit's own phone for a person, from Start in Your apps or Try it yourself: built for the
 * phone, put on it, started in the language asked for, and shown in the phone's window: the Simulator window, or the
 * Android emulator's, which opens first (a hidden emulator can only show one by starting again, from its clean state,
 * in about 5 seconds), with the app put on after. That window is the one squad-kit ever opens, and only here. Each step says what it does and about how long is left, from this
 * computer's own times. While it is open the person holds the phone, so stories' pictures wait; one left open gives the
 * phone back to a waiting story after a while. When the person closes the window, squad-kit sees it and stops too.
 */

export type OpenStep = 'build' | 'phone' | 'install' | 'open';

export interface PhoneOpenView {
  state: 'starting' | 'running' | 'stopped' | 'failed';
  step?: OpenStep;
  /** The step now and about how long is left in all: "Building the app for the iPhone, about 4 minutes left". */
  line?: string;
  secondsLeft?: number;
  /** The real device, once it runs: "iPhone 16 Pro". */
  device?: string;
  language?: string;
  since?: string;
  /** Why it did not start, in one plain sentence; `detail` is for engineers. */
  error?: string;
  detail?: string;
  /** Why it stopped by itself, in plain words: "You closed the iPhone window, so squad-kit stopped the app." */
  ended?: string;
}

export interface PhoneOpenSetup {
  /** The app's folder: squad-kit's copy of main, or the story's own copy. */
  dir: string;
  kind: PhoneKind;
  /** The phone it opens on: the iPhone (the default) or Android. */
  system?: PhoneSystem;
  /** Where the person opened it, in their words: "Your apps", "Try it yourself". */
  by: string;
  /** The button that opens it again: "Start", "Try it yourself". */
  again: string;
  language?: string;
  /** A story waiting this long for the phone ends the hold (try-app.ts TRY_YIELDS_AFTER_MS). */
  yieldAfterMs: number;
  log?(text: string): void;
  /** It ended by itself: the person closed the window, or a story needed the phone. With the plain words. */
  onEnd?(words: string): void;
  /** How often squad-kit looks whether the window is still open. */
  watchMs?: number;
}

/** About how long opening it in the window takes, once the app is on the phone. */
const OPEN_SECONDS = 5;
const WATCH_MS = 3000;
const STOPPED = 'You stopped it.';

export class PhoneOpen {
  private v: PhoneOpenView = { state: 'starting' };
  private readonly ctl = new AbortController();
  /** The steps it takes, with the time each usually takes here. */
  private plan: { step: OpenStep; seconds: number }[] = [];
  private stepAt = Date.now();
  private device: OwnDevice | null = null;
  private appId: string | null = null;
  private release: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  readonly settled: Promise<void>;

  private phone: PhoneModule;

  constructor(
    private s: PhoneOpenSetup,
    phone?: PhoneModule,
  ) {
    this.phone = phone ?? phoneFor(s.system ?? 'ios');
    if (s.language) this.v.language = s.language;
    this.settled = this.go();
  }

  /** How it stands now, with the time left counted down. */
  view(): PhoneOpenView {
    const v = { ...this.v };
    if (v.state !== 'starting' || !v.step) return v;
    const at = this.plan.findIndex((p) => p.step === v.step);
    const now = this.plan[at];
    const spent = (Date.now() - this.stepAt) / 1000;
    const left = Math.round(Math.max(3, (now?.seconds ?? 0) - spent) + this.plan.slice(at + 1).reduce((n, p) => n + p.seconds, 0));
    return { ...v, secondsLeft: left, line: `${this.stepWords(v.step)}, ${aboutWords(left)} left` };
  }

  private stepWords(step: OpenStep): string {
    const word = this.phone.words.phone;
    const open = this.phone.windowRestarts ? `Opening the ${word} in its window` : `Opening the app in the ${word} window`;
    return { build: `Building the app for the ${word}`, phone: `Starting squad-kit's ${word}`, install: `Putting the app on the ${word}`, open }[step];
  }

  private at(step: OpenStep): void {
    if (this.ctl.signal.aborted) throw new Error(STOPPED);
    this.v.step = step;
    this.stepAt = Date.now();
  }

  private async go(): Promise<void> {
    const signal = this.ctl.signal;
    try {
      // Another app the person opened on the phone (Your apps, Try it yourself) closes first: one at a time.
      await endHold('replaced');
      const system = this.s.system ?? 'ios';
      const built = lastBuild(this.s.dir, system);
      const fresh = Boolean(built && fs.existsSync(built.app) && built.tree && built.tree === (await treeOf(this.s.dir)));
      const own = await ownDevice(this.phone, 'phone');
      this.device = own;
      // Android's window comes first, as the emulator starts again for it; the iPhone's last, over the app.
      const first = Boolean(this.phone.windowRestarts);
      const open = { step: 'open' as const, seconds: OPEN_SECONDS };
      this.plan = [
        ...(fresh ? [] : [{ step: 'build' as const, seconds: stepSeconds('build', undefined, this.phone) }]),
        ...(own.state === 'booted' ? [] : [{ step: 'phone' as const, seconds: stepSeconds('boot', undefined, this.phone) }]),
        ...(first && own.state === 'booted' ? [open] : []),
        { step: 'install', seconds: stepSeconds('install', undefined, this.phone) },
        ...(first ? [] : [open]),
      ];
      this.at(fresh ? (first && own.state === 'booted' ? 'open' : 'install') : 'build');
      const { app } = await buildForPhone(this.s.dir, this.s.kind, { system, phone: this.phone, signal, ...(this.s.log ? { log: this.s.log } : {}) });
      const info = await this.phone.appInfo(app);
      this.appId = info.appId;
      if (this.plan.some((p) => p.step === 'phone')) this.at('phone');
      await withPhone(
        this.phone,
        'phone',
        async (turn) => {
          this.device = turn.device;
          if (first) {
            // The one window squad-kit opens: the person asked to see the app. A phone started for it has it already.
            if (!turn.fresh) {
              this.at('open');
              await this.phone.openWindow(turn.device.id);
            }
            // Started again from its clean state: nothing of before is on it, nor its tapping tool.
            restarted(turn.device.id);
          }
          this.at('install');
          await this.phone.install(turn.device.id, app, { signal });
          await this.phone.terminate(turn.device.id, info.appId);
          await this.phone.launch(turn.device.id, info.appId, this.s.language ? { language: this.s.language } : {});
          if (!first) {
            this.at('open');
            // The one window squad-kit opens: the person asked to see the app.
            await this.phone.openWindow(turn.device.id);
          }
          // Held from here, inside the turn, so no story's pictures slip in before.
          this.release = holdPhone(this.phone, { by: this.s.by, yieldAfterMs: this.s.yieldAfterMs, end: (why) => void this.endBy(why) });
        },
        { person: true, window: true, signal, ...(this.s.log ? { log: this.s.log } : {}) },
      );
      if (signal.aborted) throw new Error(STOPPED);
      this.v = { state: 'running', device: this.device!.model, since: new Date().toISOString(), ...(this.s.language ? { language: this.s.language } : {}) };
      this.s.log?.(`squad-kit opened ${info.appId} on its ${this.device!.model} ${this.device!.id} for ${this.s.by}`);
      this.watch();
    } catch (err) {
      if (signal.aborted) return;
      this.release?.();
      this.release = null;
      const plain = err instanceof BuildFailed || err instanceof PhoneError ? err : null;
      this.v = { state: 'failed', error: plain?.message ?? `The app did not open on the ${this.phone.words.phone}.`, detail: (plain?.detail ?? (err as Error)?.stack ?? String(err)).slice(-4000) };
    }
  }

  /** Looks now and then whether the window is still open: closed by the person, it stops too, and never opens again by itself. */
  private watch(): void {
    let looking = false;
    this.timer = setInterval(() => {
      if (looking || this.v.state !== 'running' || !this.device) return;
      looking = true;
      void this.phone
        .windowShows(this.device.id)
        .then((shows) => (shows ? undefined : this.endBy('closed')))
        .catch(() => undefined)
        .finally(() => (looking = false));
    }, this.s.watchMs ?? WATCH_MS);
    this.timer.unref?.();
  }

  /** It ends by itself: the window closed, a story needed the phone, or another app the person opened replaced it. */
  private async endBy(why: 'closed' | 'yield' | 'replaced'): Promise<void> {
    if (this.v.state !== 'running') return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const word = this.phone.words.phone;
    const words =
      why === 'closed'
        ? `You closed the ${word} window, so squad-kit stopped the app.`
        : why === 'yield'
          ? `squad-kit closed the app on its ${word}: a story needs the ${word} for its pictures. Press ${this.s.again} again later.`
          : `squad-kit closed the app on its ${word}, as you opened another one there.`;
    // The window the person closed stays closed; the app closes for the story or the other app, nothing else.
    if (why !== 'closed' && this.device && this.appId) await this.phone.terminate(this.device.id, this.appId).catch(() => undefined);
    this.v = { state: 'stopped', ended: words, ...(this.v.device ? { device: this.v.device } : {}) };
    this.release?.();
    this.release = null;
    this.s.onEnd?.(words);
  }

  /** Stop: the app closes and squad-kit's phone shuts down. A start on its way ends where it is. */
  async stop(): Promise<void> {
    this.ctl.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.settled.catch(() => undefined);
    const dev = this.device;
    if (dev && this.appId) await this.phone.terminate(dev.id, this.appId).catch(() => undefined);
    this.release?.();
    this.release = null;
    if (dev) await shutDownGently(this.phone, dev.id, this.s.log).catch(() => undefined);
    if (this.v.state !== 'failed') this.v = { state: 'stopped', ...(this.v.device ? { device: this.v.device } : {}) };
  }
}

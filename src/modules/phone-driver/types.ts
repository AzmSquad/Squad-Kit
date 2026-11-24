import type { BrowserStep } from '../browser/types.js';

/**
 * Taps through an app on a phone by what shows on its screen, for the Tester's pictures: the same steps the browser
 * takes (click, fill, select, press, wait, and reading the screen), done by squad-kit outside any agent's sandbox.
 * Each tapping tool is one module behind this interface (ADR-002). A step that did not work throws a StepFailure
 * (browser/types.ts), so squad-kit says why in the same plain words as for a web page.
 */

/**
 * The phone's own buttons and moves, as the key of a "press" step: Home shows the home screen (the app's icon and its
 * name), SwipeLeft and SwipeRight turn its pages, Landscape turns the phone sideways and Portrait turns it back. Every
 * tapping tool does them, on the iPhone and Android alike.
 */
export const PHONE_MOVES = ['Home', 'SwipeLeft', 'SwipeRight', 'Landscape', 'Portrait'] as const;
export type PhoneMove = (typeof PHONE_MOVES)[number];
export const isPhoneMove = (key: string | undefined): key is PhoneMove => (PHONE_MOVES as readonly string[]).includes(key ?? '');

export interface PhoneDriverStart {
  /** The device, by its exact id: the tool never picks one itself. */
  device: string;
  /** The tool's own program, where squad-kit got it (or the person's own copy). */
  binary: string;
  /** The Java it runs on, when squad-kit got its own. */
  javaHome?: string;
  /** squad-kit's own folder for everything the tool writes: nothing goes to the person's home folder. */
  dir: string;
  /** What the phone needs in the tool's environment to reach it (phone/types.ts tapEnv). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface PhoneDriver {
  /** One step on the screen of the app with this id (never goto: squad-kit opens pages itself). Throws StepFailure. */
  act(appId: string, step: BrowserStep, timeoutMs: number): Promise<void>;
  /** What the screen shows, as text: each part's kind and its words, one per line, like the browser's accessibility tree. */
  screenText(timeoutMs: number): Promise<string>;
  /** False once the tool has ended by itself: squad-kit starts it again. */
  readonly alive: boolean;
  /** Ends the tool, its whole group, and resolves once it has ended. */
  close(): Promise<void>;
}

export interface PhoneDriverModule {
  name: string;
  /** For people: "Maestro". */
  label: string;
  /** Starts the tool on one device, ready for steps on any app there. Throws PhoneError (phone/types.ts) when it cannot start. */
  open(o: PhoneDriverStart): Promise<PhoneDriver>;
}

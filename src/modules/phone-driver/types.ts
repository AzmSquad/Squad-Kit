import type { BrowserStep } from '../browser/types.js';

/**
 * Taps through an app on a phone by what shows on its screen, for the Tester's pictures: the same steps the browser
 * takes (click, fill, select, press, wait, and reading the screen), done by squad-kit outside any agent's sandbox.
 * Each tapping tool is one module behind this interface (ADR-002). A step that did not work throws a StepFailure
 * (browser/types.ts), so squad-kit says why in the same plain words as for a web page.
 */

export interface PhoneDriverStart {
  /** The device, by its exact id: the tool never picks one itself. */
  device: string;
  /** The tool's own program, where squad-kit got it (or the person's own copy). */
  binary: string;
  /** The Java it runs on, when squad-kit got its own. */
  javaHome?: string;
  /** squad-kit's own folder for everything the tool writes: nothing goes to the person's home folder. */
  dir: string;
  signal?: AbortSignal;
}

export interface PhoneDriver {
  /** One step on the screen of the app with this id (never goto: squad-kit opens pages itself). Throws StepFailure. */
  act(appId: string, step: BrowserStep, timeoutMs: number): Promise<void>;
  /** What the screen shows, as text: each part's kind and its words, one per line, like the browser's accessibility tree. */
  screenText(timeoutMs: number): Promise<string>;
  /** False once the tool has ended by itself: squad-kit starts it again. */
  readonly alive: boolean;
  close(): Promise<void>;
}

export interface PhoneDriverModule {
  name: string;
  /** For people: "Maestro". */
  label: string;
  /** Starts the tool on one device, ready for steps on any app there. Throws PhoneError (phone/types.ts) when it cannot start. */
  open(o: PhoneDriverStart): Promise<PhoneDriver>;
}

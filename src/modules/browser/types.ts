/**
 * A headless browser squad-kit drives itself for the proof screenshots, outside any agent's sandbox: agents only
 * write the plan. Each browser library is one module behind this interface (ADR-002).
 */

/** What one step of a shot plan does. `goto` is opened by squad-kit itself, through BrowserPage.goto. */
export type BrowserAction = 'goto' | 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'hover' | 'wait';

/** One thing on the page, named one way. Role and name is the best way; css is the last resort. */
export interface BrowserTarget {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  testId?: string;
  css?: string;
}

export interface BrowserStep {
  action: BrowserAction;
  target?: BrowserTarget;
  /** fill: the text to type. select: the option's text or value. */
  value?: string;
  /** goto: a path in the app, starting with "/". */
  path?: string;
  /** press: a key, like "Enter" or "Tab". */
  key?: string;
  /** wait without a target: a pause, at most 5000. */
  ms?: number;
}

/** Why a step did not work, for squad-kit to say in words. */
export type StepFailureKind = 'missing' | 'hidden' | 'disabled' | 'option' | 'blocked' | 'timeout' | 'closed' | 'other';

export class StepFailure extends Error {
  constructor(
    readonly kind: StepFailureKind,
    message: string,
    /** For "blocked": the address the page tried to open. */
    readonly address?: string,
  ) {
    super(message);
  }
}

/** The browser could not be set up or started here. `detail` is the exact error, for engineers. */
export class BrowserSetupError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

export interface BrowserPage {
  /** Opens an address and gives the HTTP status it answered with. Only `origin` may open at the top of the page. */
  goto(url: string, timeoutMs: number): Promise<number | null>;
  /** One step on the page (not goto). Throws StepFailure. */
  act(step: BrowserStep, timeoutMs: number): Promise<void>;
  /** Waits a little for the page to finish loading and drawing. */
  settle(timeoutMs: number): Promise<void>;
  /** The page's accessibility tree as text: roles, names and text, the way a screen reader sees it. */
  snapshot(): Promise<string>;
  /** The address the page is at now. */
  url(): string;
  /** A PNG of what shows in the window, at the page's size, as bytes: squad-kit saves it itself. */
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface Browser {
  /**
   * A fresh page, with nothing kept from another one, where only `origin` may open at the top, and nothing on this
   * computer or a private network but `origin` and `also`, the other parts of the same product, may load at all
   * (browser/addresses.ts).
   */
  page(o: { origin: string; also?: string[]; width: number; height: number; phone?: boolean }): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserModule {
  name: string;
  /** For people, for example "Playwright". */
  label: string;
  /** Starts a headless browser, getting it ready on this computer the first time. Throws BrowserSetupError. */
  launch(o?: { onLine?: (text: string) => void }): Promise<Browser>;
  /**
   * Gets the browser onto this computer when it is not there yet, without starting it, so a first download never
   * runs inside a step's clock. Says one line through `onLine` when it has to download. Throws BrowserSetupError.
   */
  prepare?(o?: { onLine?: (text: string) => void }): Promise<void>;
  /**
   * The files squad-kit runs from outside any guard to take its pictures, where they sit in a cache the project's own
   * commands may write in: those commands may not change them, so nothing they leave there runs with squad-kit.
   */
  ownFiles?(): string[];
}

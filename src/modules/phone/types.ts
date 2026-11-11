/**
 * A phone on this computer that squad-kit runs itself, hidden, for the Tester's pictures: a simulator or an emulator.
 * Each product is one module behind this interface (ADR-002). squad-kit only ever touches the devices it made itself,
 * by their exact id: never anybody else's.
 */

/** A phone or a tablet. */
export type PhoneSize = 'phone' | 'tablet';

/** One kind of device the phone tool can make: "iPhone 16 Pro". */
export interface PhoneModel {
  id: string;
  name: string;
  size: PhoneSize;
}

/** One version of the phone's system this computer can run, with the devices it can make, newest first. */
export interface PhoneRuntime {
  id: string;
  /** "18.2". */
  version: string;
  models: PhoneModel[];
}

export type PhoneState = 'booted' | 'booting' | 'shutdown' | 'shutting-down' | 'other';

/** A device on this computer, anybody's: squad-kit only changes the ones it made. */
export interface PhoneDevice {
  id: string;
  name: string;
  state: PhoneState;
  /** The runtime's id. */
  runtime: string;
}

/** What a built app says about itself. */
export interface AppOnPhone {
  /** Its id on the phone: "dev.squadkit.sampleApp". */
  appId: string;
  /** The link names it answers to ("myapp" for myapp://), when it declares any: a page then opens by its link. */
  schemes: string[];
}

/** The long steps whose time squad-kit learns on this computer: building the app, starting the phone, putting the app on it, the first tap. */
export type PhoneStep = 'build' | 'boot' | 'install' | 'first-run';

/** Where a phone's own tools are on this computer, as squad-kit's tools found them (engine/tools). */
export interface PhoneTools {
  /** The phone maker's tools folder: an Android SDK. */
  sdk?: string;
  /** squad-kit's own folder for the phone's devices and settings: nothing goes to the person's home folder. */
  home?: string;
  /** The Java home its tools run on. */
  java?: string;
}

/** A phone command that did not work. `message` is for people; `detail` is what the tool printed, for engineers. */
export class PhoneError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

export interface PhoneModule {
  name: string;
  /** For people: "iPhone simulator". */
  label: string;
  /** The word for its phone and its tablet: "iPhone", "iPad". */
  words: Record<PhoneSize, string>;
  /** Its system's name, before a version: "iOS", "Android". */
  system: string;
  /**
   * How long each long step takes the first time, in seconds, and the key squad-kit keeps the time measured here under.
   * Left out: the iPhone's.
   */
  times?: Record<PhoneStep, { key: string; guess: number }>;
  /**
   * Its window opens only by starting the device again, from the clean state it boots from: the app goes on after the
   * window opens, never before (Start, Try it yourself).
   */
  windowRestarts?: boolean;
  /** Tells it where its tools are on this computer, before it is used. A phone that needs none leaves it out. */
  useTools?(tools: PhoneTools): void;
  /** The id the tapping tool knows a device by, when it is not the device's own: an Android phone's serial. */
  tapId?(id: string): string;
  /** What the tapping tool needs in its environment to reach this phone. */
  tapEnv?(): Record<string, string>;
  /**
   * Ends what the phone started beside its devices, once none of them runs (Android: the adb server squad-kit started
   * itself, never one that ran before). The idle shutdown and the board's stop call it.
   */
  release?(): Promise<void>;
  /** Why it cannot run on this computer, in plain words ("An iPhone simulator needs a Mac."), or null when it can. */
  notHere(): string | null;
  /** The system versions this computer can run, newest first. */
  runtimes(): Promise<PhoneRuntime[]>;
  /** Every device on this computer and its state: squad-kit looks at all of them, and changes only its own. */
  devices(): Promise<PhoneDevice[]>;
  /** Makes a new device, and gives its id. */
  create(name: string, model: string, runtime: string): Promise<string>;
  /** Starts a device hidden, with no window, and waits until it is up. */
  boot(id: string, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  /** Puts a built app on a device, in place of the one there. */
  install(id: string, app: string, o?: { signal?: AbortSignal }): Promise<void>;
  /** What a built app says about itself. */
  appInfo(app: string): Promise<AppOnPhone>;
  /** Opens the app, fresh, in a language ("en", "ar"). */
  launch(id: string, appId: string, o?: { language?: string }): Promise<void>;
  /** Opens one of the app's own links: "myapp://book". */
  openLink(id: string, url: string): Promise<void>;
  /** A PNG of what the screen shows, as bytes. */
  screenshot(id: string): Promise<Buffer>;
  /** Closes the app, if it runs. */
  terminate(id: string, appId: string): Promise<void>;
  /** Shuts a device down. */
  shutdown(id: string): Promise<void>;
  /** Opens the device's window for a person (Start, Try it yourself). Never used for the Tester's pictures. */
  openWindow(id: string): Promise<void>;
  /**
   * Whether a window still shows the device: false once the person closed it (or the device shut down). squad-kit only
   * looks; it never opens it again by itself.
   */
  windowShows(id: string): Promise<boolean>;
}

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BrowserStep } from '../modules/browser/types.js';
import { HEALED_LINE } from './cache-home.js';
import { CHECK_SILENT_MS, runCommand, startApp, tail, testCount, type RunningApp } from './checks.js';
import { TurnTimeout, appIn, minutes, startPastOther, stopAppsIn, takeTurn, untilEnded, waitWords, type Turn, type TurnKind } from './copy-turn.js';
import { fileAlone } from './failed-tests.js';
import { MAX_PICTURES } from './proof-verdict.js';
import type { GuardSpec } from './project-guard.js';
import {
  BrowserSession,
  CALL_MS,
  MAX_NAME,
  MAX_PAGE,
  MAX_STEPS,
  MAX_VALUE,
  STEP_MS,
  SIZES,
  ShotsUnavailable,
  appOrigin,
  lookAt,
  pageProblem,
  pathOnApp,
  shootOne,
  shotsErrorDetail,
  statusWords,
  stepsProblem,
  writeNew,
  type FailedShot,
  type ShotAsk,
  type ShotSize,
} from './shots.js';
import { readWorkbook, sheetsText, type Sheet } from './spreadsheet.js';
import type { PhoneSize } from '../modules/phone/types.js';
import type { PhoneAsk, PhoneRun, PhoneShot } from './phone/session.js';

/**
 * The window: squad-kit's own tools for an agent, served over MCP for one run (engine/window-server.ts). The agent
 * presses a tool and fills its fields; squad-kit checks every field, does the job itself outside the agent's guard,
 * and hands the result back. There is no free command: screenshots and pages of the story's own app on this
 * computer, its app started from the project's own start command, the project's own saved checks, and "I am stuck". A
 * request that breaks a check is refused, said in a plain line on the story, and counted: three in a run stop the
 * agent. Every call answers well
 * within the agent's own limit for a tool: a slow start goes on in the background and the call says so. Nothing the
 * window starts outlives its run.
 */

export type WindowTool = 'take_screenshots' | 'look_at_page' | 'start_app' | 'stop_app' | 'app_status' | 'run_checks' | 'add_part' | 'ask_api' | 'i_am_stuck';

export const APP_TOOLS: WindowTool[] = ['take_screenshots', 'look_at_page', 'start_app', 'stop_app', 'app_status'];
export const ALL_TOOLS: WindowTool[] = [...APP_TOOLS, 'run_checks', 'i_am_stuck'];

export { MAX_PICTURES };
/** The most pictures one call may ask for. */
export const MAX_SHOTS_PER_CALL = 10;
/** Refusals in one run before squad-kit stops the agent. */
export const REFUSALS_TO_STOP = 3;
/**
 * Calls in the wrong shape (a field misnamed or in the wrong place) one run may make. They do no harm and never count
 * as refusals; past this many, squad-kit ends the step in plain words, so a run never goes round in circles.
 */
export const MISTAKES_TO_STOP = 15;
/** How many times a run may say it is stuck before squad-kit says it already tried. */
export const MAX_STUCK = 5;
/** The largest picture that goes back to the agent. */
const MAX_IMAGE_BYTES = 4_500_000;
/**
 * The most picture bytes that go back to the agent in one run. A picture goes back only in the call that took it, and
 * real pages come to well under 100 KB each; past this, a page heavy with photos is saved and named but not sent, so
 * it cannot outgrow the agent's conversation.
 */
export const MAX_IMAGE_BYTES_SENT = 16_000_000;

/** True for the bytes of a PNG file. */
function isPng(b: Buffer): boolean {
  return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** What i_am_stuck keeps of each field, and the most it takes at all. */
const STUCK_KEEP = 2000;
const HUGE = 20_000;

/** The plain stop the person sees when the agent kept asking for what it may not do. */
export function tooManyWords(who: string): string {
  return `The ${who} kept asking for things it may not do, so squad-kit stopped it.`;
}

/** The plain stop the person sees when the agent kept calling squad-kit's tools in the wrong shape. */
export function tooManyMistakesWords(who: string): string {
  return `The ${who} kept using squad-kit's tools the wrong way, so squad-kit ended this step. Press Try again to try once more.`;
}

export interface WindowApp {
  /** The story's own copy of the code: the app runs from here. */
  cwd: string;
  /** The project's own start command, from its settings. Never one an agent sends. */
  start: string;
  /** The app's usual address, from the project's settings. */
  url: string;
  /** squad-kit's own guard for the app (engine/project-guard.ts): the app cannot read secrets. Null where none. */
  guard?: GuardSpec;
  /** A product: this starts all of it and answers with the part a person opens, in place of `start`. */
  run?(): Promise<RunningApp>;
  /** And this stops all of it. */
  after?(): void;
  /** The addresses of the product's parts. A page may call these, as a web app calls its API. */
  reach?(): string[];
}

/** The project's checks an agent may ask squad-kit to run. */
export type CheckName = 'test' | 'lint' | 'build';
const CHECK_NAMES: CheckName[] = ['test', 'lint', 'build'];
/** A check in words for the story's activity. */
const CHECK_WORDS: Record<CheckName, string> = { test: 'the tests', lint: 'the code check', build: 'the build' };

/**
 * squad-kit's own phone for the pictures (engine/phone/session.ts), in place of its browser: a mobile project whose
 * iPhone or Android tools are ready. The pictures are taken on real devices, each labelled with its name.
 */
export interface WindowPhone {
  /** The sizes the pictures may be taken at: phone, and tablet when the app has one. */
  readonly sizes: PhoneSize[];
  /** What the phone is: "iPhone simulator", "Android emulator". Left out: an iPhone simulator. */
  readonly label?: string;
  /** The real device of each size: { phone: "iPhone 16 Pro", tablet: "iPad Air 11-inch (M2)" }. Known once ready. */
  labels(): Partial<Record<PhoneSize, string>>;
  /** The app's own link names: none means every picture starts on the app's start screen. */
  links(): string[];
  /** Builds the app and gets the phone up, once. Throws PhoneUnavailable. */
  ready(): Promise<void>;
  shoot(ask: PhoneAsk, c: PhoneRun): Promise<PhoneShot | FailedShot>;
  look(ask: PhoneAsk, c: PhoneRun): Promise<{ page: string; snapshot: string; device: string; said?: string } | FailedShot>;
  close(): Promise<void>;
}

export interface WindowChecks {
  /** The story's own copy of the code: the checks run here. */
  cwd: string;
  /** The project's saved commands, read at each call. Never one an agent sends. */
  commands(): Partial<Record<CheckName, string>>;
  /** squad-kit's own guard for the checks: they cannot read secrets, and a browser can start. Null where none. */
  guard?: GuardSpec;
  /** A check starts: the card's line says so. */
  onStart?(name: CheckName): void;
  /** A check ran to its end: whether it passed, and whether it ran one test file alone. Never for a run cut off. */
  onEnd?(name: CheckName, ok: boolean, alone: boolean): void;
  /**
   * A run starts, before its first command: the checks it runs, and `only` when it was asked for one test file. What
   * comes back, when anything does, is told what ran once every check of the run ran to its end; never for a run cut off.
   */
  onRun?(run: { names: CheckName[]; only?: string }): Promise<((ran: CheckRun[]) => Promise<void>) | undefined>;
  /** A story with several parts: each part's own checks, by the part's id. run_checks must then say which. */
  parts?(): Record<string, WindowChecks>;
}

export interface WindowSetup {
  ticket: string;
  step: string;
  /** Who the plain lines name: "Tester". */
  who: string;
  tools: WindowTool[];
  /** The story's app. Left out, the app tools answer that this step has none. */
  app?: WindowApp;
  /** The pictures are taken on squad-kit's own phone instead of its browser (a phone app with its tools ready). */
  phone?: WindowPhone;
  /** The label every browser picture gets: "Web version" when a phone app's web version stands in for the phone. */
  pictureLabel?: string;
  /** The project's own checks. Left out, run_checks answers that this step has none. */
  checks?: WindowChecks;
  /** The running product's parts the Tester may ask, by id. There is no field for a host: only these addresses. */
  api?(): Record<string, { name: string; url: string }>;
  /** Adds a part's copy to the story's folder, and says what it did. Left out, add_part answers that this step cannot. */
  addPart?(part: string): Promise<string>;
  /** An app squad-kit already started for this step. The window owns it from now on and stops it at the end. */
  running?: RunningApp;
  proofDir: string;
  /** Pictures are saved as `<prefix>-<n>.png` in the proof folder. */
  prefix: string;
  /** The run's Stop. */
  signal?: AbortSignal;
  /** A plain line in the story's activity. */
  say(text: string): void;
  /** A line for engineers, in the app log. */
  log?(text: string): void;
  /** A sign of life while a call works, for the watchdog: the agent itself is quiet meanwhile. */
  beat?(): void;
  /** Before squad-kit starts the app: nothing squad-kit left running may hold its address. */
  beforeStart?(): Promise<void>;
  /**
   * Before squad-kit starts the app in its copy `dir`: what a finished check or step left running there stops, never
   * what squad-kit runs now (a check still running, an app it keeps). With `only`, just that process, when it is such a
   * leftover. True when something was stopped.
   */
  clearCopy?(dir: string, only?: number): Promise<boolean>;
  /** A busy port or a program in the agent's way: what squad-kit settled, in words for the agent. Null when not that. */
  inTheWay?(text: string): Promise<string | null>;
  /**
   * At the end of the run, the app squad-kit started may go on to the next step that uses it, instead of stopping: true
   * when it was taken. It then runs on, and is no longer the window's.
   */
  keep?(app: RunningApp): boolean;
  /** Tests use less. callMs is the time one call may take in all, waiting its turn included. turnMs: the app's wait for its copy's turn. */
  limits?: { callMs?: number; stepMs?: number; appWaitMs?: number; turnMs?: number };
}

export interface Refusal {
  tool: string;
  /** For engineers: what broke which check. */
  why: string;
  /** The plain line on the story. */
  line: string;
  at: string;
}

/** A call in the wrong shape, for engineers. */
export interface ShapeMistake {
  tool: string;
  why: string;
  at: string;
}

export interface TakenPicture {
  file: string;
  /** Where it was taken, as the path in the app. */
  page: string;
  size: ShotSize | PhoneSize | 'answer';
  /** The device it was taken on, for people: "iPhone 16 Pro", "Web version". */
  device?: string;
  /** A saved call to the API, not a picture: what was asked. */
  call?: string;
}

export interface StuckReport {
  what: string;
  why: string;
  did: string[];
}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDef {
  name: WindowTool;
  description: string;
  inputSchema: object;
}

const STR = { type: 'string' } as const;

/** One right call of each kind, in the tools' descriptions and in every answer to a call in the wrong shape. */
export const EXAMPLES = {
  target: '{ "role": "button", "name": "Book" }',
  step: '{ "action": "fill", "target": { "label": "Date" }, "value": "2026-12-03" }',
  look: '{ "page": "/book" }',
  shot: '{ "page": "/book", "steps": [{ "action": "click", "target": { "role": "button", "name": "Book" } }], "size": "phone" }',
  shots:
    '{ "shots": [{ "page": "/book", "steps": [{ "action": "fill", "target": { "label": "Date" }, "value": "2026-12-03" }, { "action": "click", "target": { "role": "button", "name": "Book" } }, { "action": "wait", "target": { "text": "Booked" } }], "size": "phone" }] }',
  stuck: '{ "what": "The app does not start", "why": "start_app said the address is already in use" }',
  checks: '{ "which": "test" }',
  only: '{ "only": "tests/e2e/booking.spec.ts:42" }',
} as const;

const TARGET = {
  type: 'object',
  description: `The part of the page, named one way inside this object, never on the step itself: role and name (best), label, text, placeholder, testId or css. Example: ${EXAMPLES.target}.`,
  properties: { role: STR, name: STR, label: STR, text: STR, placeholder: STR, testId: STR, css: STR },
  additionalProperties: false,
} as const;
const STEPS = {
  type: 'array',
  maxItems: MAX_STEPS,
  description: `What to do on the page first, in order. Each step has an "action" and names its part of the page inside "target". goto (path), click, fill (value), select (value), check, uncheck, press (key, like "Enter"), hover, wait (target, or ms up to 5000). Example: [${EXAMPLES.step}, { "action": "click", "target": ${EXAMPLES.target} }].`,
  items: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'wait'] },
      target: TARGET,
      value: { type: 'string', maxLength: MAX_VALUE },
      path: { type: 'string', maxLength: MAX_PAGE, description: 'For goto only: a path in the app, like "/rooms".' },
      key: STR,
      ms: { type: 'integer', minimum: 0, maximum: 5000 },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;
const PAGE = { type: 'string', maxLength: MAX_PAGE, description: 'The page to open: a path in the app, starting with "/", like "/book". The field is "page" (not "path" or "url"), never a full address.' } as const;
const SIZE = { type: 'string', enum: ['desktop', 'phone'], description: 'desktop is 1280x800 (the default), phone is 390x844.' } as const;
const NONE = { type: 'object', properties: {}, additionalProperties: false } as const;

const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const MAX_API_CALLS = 20;
/** What is kept of an answer: enough to judge it, and no more. A file it answers with is saved whole. */
const MAX_API_ANSWER = 100 * 1024;
const MAX_API_FILE = 50 * 1024 * 1024;
const MAX_API_BODY = 100 * 1024;
const API_WAIT_MS = 60_000;
const API_TEXT = /^(text\/|application\/(json|xml|problem\+json|[\w.+-]*\+json|[\w.+-]*\+xml|javascript|x-www-form-urlencoded))/i;
const API_FILE_TYPES: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const DEFS: Record<WindowTool, Omit<ToolDef, 'name'>> = {
  take_screenshots: {
    description: `squad-kit opens its own browser on this story's app (it starts the app if needed), does the steps, and takes one picture per shot, after its steps. The pictures come back to you, with each file name and the page it ended on, and are saved in the proof folder. Limits: at most ${MAX_SHOTS_PER_CALL} shots in one call, and at most ${MAX_PICTURES} pictures in all in this step, counting each one you take again, so plan one picture per part or case of each "done when". Asking for more is refused, and refused requests can stop the step. Look at each picture and take a wrong one again. Each answer lists every picture you took in this step: name those files in your final answer, no others. Example: ${EXAMPLES.shots}`,
    inputSchema: {
      type: 'object',
      properties: {
        shots: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_SHOTS_PER_CALL,
          items: { type: 'object', properties: { page: PAGE, steps: STEPS, size: SIZE }, required: ['page'], additionalProperties: false },
        },
      },
      required: ['shots'],
      additionalProperties: false,
    },
  },
  look_at_page: {
    description: `squad-kit opens a page of this story's app in its own browser, does the steps, and gives back the address it ended at and the page's accessibility tree (its roles, names and text), cut short. Use it to find the names of fields and buttons. Example: ${EXAMPLES.look}, or with steps: { "page": "/", "steps": [{ "action": "click", "target": ${EXAMPLES.target} }] }`,
    inputSchema: { type: 'object', properties: { page: PAGE, steps: STEPS, size: SIZE }, required: ['page'], additionalProperties: false },
  },
  start_app: {
    description: "squad-kit starts this story's own copy of the app with the project's own start command, on a free port when the usual one is taken, and gives back the address and the last lines it printed. It takes no fields. Example: {}",
    inputSchema: NONE,
  },
  stop_app: {
    description: 'squad-kit stops the app it started for this step. It stops only what squad-kit started. It takes no fields. Example: {}',
    inputSchema: NONE,
  },
  app_status: {
    description: 'Whether the app squad-kit started for this step runs and answers, its address, and the last lines it printed. It takes no fields. Example: {}',
    inputSchema: NONE,
  },
  run_checks: {
    description: `squad-kit runs the project's own saved checks in this story's copy of the code, inside its own guard, where a browser can start: browser tests work here, not in your shell. "which" picks one (test, lint or build); left out, all of them run, one after another. "only" runs one test file on its own with the project's own test tool, much faster than all the tests: use it while you fix a test, then squad-kit runs all the checks again at the end. It gives back pass or fail for each, with the last lines it printed, and runs each once: a failure is not run again. It runs only the saved commands and takes no command of yours. A long run goes on in the background, and calling this again gives its result. Example: ${EXAMPLES.checks}, or ${EXAMPLES.only}`,
    inputSchema: {
      type: 'object',
      properties: {
        which: { type: 'string', enum: CHECK_NAMES, description: 'Which check to run. Left out, all of them.' },
        only: { type: 'string', description: 'One test file in this copy to run on its own, as the test output names it, with its line for a browser test (tests/e2e/booking.spec.ts:42). Only the tests run then.' },
      },
      additionalProperties: false,
    },
  },
  ask_api: {
    description: `squad-kit asks the running product's API for you, on this computer, and saves exactly what was asked and answered. Use it for a "done when" no page of the app shows. It has no field for a host: it only reaches the parts of this product. Name the saved file in your answer like a picture. At most ${MAX_API_CALLS} calls in a step.`,
    inputSchema: {
      type: 'object',
      properties: {
        part: { type: 'string', description: 'The id of the part to ask.' },
        method: { type: 'string', enum: API_METHODS, description: 'GET unless said otherwise.' },
        path: { type: 'string', description: 'The path on that part, with any query, like /price?item=3.' },
        body: { description: 'What to send, for POST, PUT or PATCH: text, or an object sent as JSON.' },
        headers: { type: 'object', description: 'More headers, when the part needs them.', additionalProperties: { type: 'string' } },
      },
      required: ['part', 'path'],
      additionalProperties: false,
    },
  },
  add_part: {
    description: "Call this when the story needs a part of the product it has no copy of yet, to read it or change it. squad-kit adds that part's copy to this story's folder, on the same branch name, and says where. The person is not asked.",
    inputSchema: {
      type: 'object',
      properties: { part: { type: 'string', description: 'The id of the part.' } },
      required: ['part'],
      additionalProperties: false,
    },
  },
  i_am_stuck: {
    description: `Call this when something technical is in your way: the app does not start, a port is busy, the browser does not work, a command or a file is refused. squad-kit tries its known fixes (its browser, a free port, starting the app again) and says what it did. Never ask the person about it. Example: ${EXAMPLES.stuck}`,
    inputSchema: {
      type: 'object',
      properties: { what: { type: 'string', description: 'What does not work.' }, why: { type: 'string', description: 'What you saw: the error or the output.' } },
      required: ['what', 'why'],
      additionalProperties: false,
    },
  },
};

/** The words for squad-kit's phone in the tools: "a real iPhone 16 Pro (phone) or iPad Air 11-inch (M2) (tablet)". */
function phoneWords(labels: Partial<Record<PhoneSize, string>>): string {
  const sizes = (Object.keys(labels) as PhoneSize[]).map((k) => `${labels[k]} (${k})`);
  return sizes.length ? `a real ${sizes.join(' or ')}` : 'a real phone';
}

/** One right call on the phone, for its tools' descriptions. */
const PHONE_SHOTS =
  '{ "shots": [{ "page": "/", "steps": [{ "action": "fill", "target": { "label": "Name" }, "value": "Sara" }, { "action": "click", "target": { "role": "button", "name": "Sign up" } }, { "action": "wait", "target": { "text": "Welcome Sara" } }], "size": "phone", "language": "ar" }] }';

/**
 * take_screenshots and look_at_page on squad-kit's phone: the same steps and words as in the browser, with the real
 * devices, the app's start screen or its own links for a page, and a language.
 */
function phoneDefs(sizes: PhoneSize[], labels: Partial<Record<PhoneSize, string>>, links: string[], label = 'iPhone simulator'): Record<'take_screenshots' | 'look_at_page', Omit<ToolDef, 'name'>> {
  const size = { type: 'string', enum: sizes, description: sizes.map((k) => `${k} is the ${labels[k] ?? k}`).join(', ') + (sizes.length > 1 ? ' (phone is the default).' : '.') };
  const page = {
    type: 'string',
    maxLength: MAX_PAGE,
    description: links.length
      ? `The screen to open: "/" is the app's start screen; another path opens by the app's own link (${links[0]}://…), like "/book".`
      : `"/", the app's start screen. This app has no links of its own, so every shot starts there: use steps to reach the screen you need.`,
  };
  const language = { type: 'string', pattern: '^[a-z]{2}$', description: 'The language the app opens in: "en" (the default) or "ar", or another two-letter code.' };
  const steps = {
    ...STEPS,
    description: `What to do on the screen first, in order, by the words on it. Each step has an "action" and names its part of the screen inside "target", by its words: role and name (like a button's words), label, text or placeholder; or testId, its id. A phone screen has no css. click (taps), fill (value; it replaces the field's text), select (value: the choice to tap after it), press (key: Enter, Backspace, Escape to put the keyboard away, a letter or digit), hover (scrolls down until the part shows), wait (target, or ms up to 5000). Example: [{ "action": "fill", "target": { "label": "Name" }, "value": "Sara" }, { "action": "click", "target": { "role": "button", "name": "Sign up" } }].`,
  };
  const where = phoneWords(labels);
  return {
    take_screenshots: {
      description: `squad-kit opens this story's app on ${where}: ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} it runs itself, hidden, on this computer. Each shot starts the app fresh in its language, does the steps by tapping through the app by the words on the screen, and takes one picture after its steps. The pictures come back to you, with each file name, the screen and the device, and are saved in the proof folder. Limits: at most ${MAX_SHOTS_PER_CALL} shots in one call, and at most ${MAX_PICTURES} pictures in all in this step, counting each one you take again, so plan one picture per part or case of each "done when". Asking for more is refused, and refused requests can stop the step. Look at each picture and take a wrong one again. Each answer lists every picture you took in this step: name those files in your final answer, no others. Example: ${PHONE_SHOTS}`,
      inputSchema: {
        type: 'object',
        properties: {
          shots: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_SHOTS_PER_CALL,
            items: { type: 'object', properties: { page, steps, size, language }, required: ['page'], additionalProperties: false },
          },
        },
        required: ['shots'],
        additionalProperties: false,
      },
    },
    look_at_page: {
      description: `squad-kit opens this story's app on ${where}, does the steps, and gives back what the screen shows as text: the words of each part, one a line, with what a field holds. Use it to find the words on fields and buttons. It saves no picture. Example: { "page": "/" }, or with steps: { "page": "/", "steps": [{ "action": "click", "target": { "text": "Sign up" } }], "language": "ar" }`,
      inputSchema: { type: 'object', properties: { page, steps, size, language }, required: ['page'], additionalProperties: false },
    },
  };
}

/** run_checks on a story with several parts: squad-kit takes the folder from its own list of parts, never a path. */
const RUN_CHECKS_BY_PART: Omit<ToolDef, 'name'> = {
  ...DEFS.run_checks,
  inputSchema: {
    type: 'object',
    properties: {
      which: { type: 'string', enum: CHECK_NAMES, description: 'Which check to run. Left out, all of them.' },
      part: { type: 'string', description: 'The id of the part to run them in. There is no other way to choose a folder.' },
    },
    required: ['part'],
    additionalProperties: false,
  },
};

/** One check squad-kit ran for an agent. */
export interface CheckRun {
  name: CheckName;
  command: string;
  ok: boolean;
  output: string;
  seconds: number;
  /** squad-kit ended it: it printed nothing for too long, ran past its time, or the run was stopped. */
  ended?: boolean;
  /** The one test file it ran, when the agent asked for one. */
  only?: string;
  /** Why it ran something else than asked, for the agent. */
  note?: string;
}

/** The longest test file name run_checks takes. */
const MAX_ONLY = 300;

const text = (t: string): ToolContent => ({ type: 'text', text: t });
const ok = (t: string): ToolResult => ({ content: [text(t)] });
const error = (t: string): ToolResult => ({ content: [text(t)], isError: true });

/** The fields of a call that a tool does not take, or null when it takes the call as it is. */
function extraFields(args: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(args).filter((k) => !allowed.includes(k));
}

/** The first value in a call longer than `max` characters, anywhere in it. */
function hugeValue(v: unknown, max: number, depth = 0): boolean {
  if (typeof v === 'string') return v.length > max;
  if (depth > 6 || !v || typeof v !== 'object') return false;
  return Object.values(v as Record<string, unknown>).some((x) => hugeValue(x, max, depth + 1));
}

/** Why a page is not merely wrong but outside the app: a scheme, another host, "..". Null when it is only a mistake or fine. */
function outsideApp(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const s = p.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || s.includes('\\')) return `page "${s.slice(0, 80)}" is outside the app`;
  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return `page "${s.slice(0, 80)}" is not a valid path`;
  }
  if (decoded.startsWith('//') || decoded.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || /(^|[/\\])\.\.([/\\?#]|$)/.test(decoded)) return `page "${s.slice(0, 80)}" goes outside the app`;
  return null;
}

/** The goto paths of a call's steps, for the same check. */
function gotoPaths(steps: unknown): unknown[] {
  return Array.isArray(steps) ? steps.filter((x) => x && typeof x === 'object' && (x as BrowserStep).action === 'goto').map((x) => (x as BrowserStep).path) : [];
}

/** The fields a target takes. A step may name them on itself by mistake: they are moved into its target. */
const TARGET_KEYS = ['role', 'name', 'label', 'text', 'placeholder', 'testId', 'css'];
const STEP_KEYS = ['action', 'target', 'value', 'path', 'key', 'ms'];
const ACTION_KEYS = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'wait'];
/** A field that asks squad-kit to run something. Never a slip: always refused. */
const COMMAND_FIELD = /^(commands?|cmd|scripts?|exec|execute|shell|bash|sh|eval|javascript|program)$/i;

/** The first field anywhere in a call that asks squad-kit to run something, or null. */
function commandField(v: unknown, depth = 0): string | null {
  if (depth > 6 || !v || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (COMMAND_FIELD.test(k)) return k;
    const inner = commandField(x, depth + 1);
    if (inner) return inner;
  }
  return null;
}

/** A call in the wrong shape: what is wrong, and the right shape to use, with an example. */
export interface WrongShape {
  wrong: string;
  help: string;
}

/**
 * A page call as squad-kit takes it, with the common slips put right: "path" or "url" for "page", and a step that
 * names its part of the page on itself instead of inside "target". What cannot be put right safely is a shape
 * mistake, with the right shape. Every field is still checked after, as if the agent had sent it right.
 */
export function pageCall(raw: Record<string, unknown>, tool: string, more: string[] = []): { ask: Record<string, unknown> } | WrongShape {
  const ask = { ...raw };
  const example = tool === 'look_at_page' ? EXAMPLES.look : EXAMPLES.shot;
  for (const alias of ['path', 'url']) {
    if (ask[alias] === undefined) continue;
    if (ask.page !== undefined) return { wrong: `it got both "page" and "${alias}"`, help: `Give the page once, as "page": ${EXAMPLES.look}.` };
    ask.page = ask[alias];
    delete ask[alias];
  }
  const extra = Object.keys(ask).find((k) => !['page', 'steps', 'size', ...more].includes(k));
  if (extra) return { wrong: `${tool === 'look_at_page' ? 'look_at_page' : 'a shot'} takes page, steps${more.length ? ', size and language' : ' and size'}, and got "${short(extra, 40)}"`, help: `Use: ${example}.` };
  if (ask.steps === undefined || ask.steps === null) return { ask };
  if (!Array.isArray(ask.steps)) return { wrong: 'steps is not a list', help: `Use: "steps": [${EXAMPLES.step}].` };
  const steps: Record<string, unknown>[] = [];
  for (const [i, s] of ask.steps.entries()) {
    const fixed = stepCall(s, i + 1);
    if ('wrong' in fixed) return fixed;
    steps.push(fixed.step);
  }
  return { ask: { ...ask, steps } };
}

/** One step as squad-kit takes it: its part of the page moved into "target" when it was named on the step itself. */
function stepCall(raw: unknown, n: number): { step: Record<string, unknown> } | WrongShape {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { wrong: `step ${n} is not an object`, help: `A step looks like ${EXAMPLES.step}.` };
  const s = { ...(raw as Record<string, unknown>) };
  // { "fill": { … } }: the action named as a field, which squad-kit does not guess.
  const named = s.action === undefined ? Object.keys(s).find((k) => ACTION_KEYS.includes(k)) : undefined;
  if (named) {
    const value = named === 'fill' || named === 'select' ? ', "value": "Sprint review"' : '';
    return { wrong: `step ${n} names its action as a field ("${named}")`, help: `Give it as "action", with the part of the page inside "target": { "action": "${named}", "target": { "role": "textbox", "name": "Title" }${value} }.` };
  }
  const loose = TARGET_KEYS.filter((k) => s[k] !== undefined);
  if (loose.length) {
    if (s.target !== undefined) return { wrong: `step ${n} has a target and also ${loose.map((k) => `"${k}"`).join(', ')} on the step itself`, help: `Put them all inside "target": ${EXAMPLES.step}.` };
    s.target = Object.fromEntries(loose.map((k) => [k, s[k]]));
    for (const k of loose) delete s[k];
  }
  const extra = Object.keys(s).find((k) => !STEP_KEYS.includes(k));
  if (extra) {
    const help = ['for', 'until', 'selector', 'element'].includes(extra) ? `Name what to wait for or act on inside "target": { "action": "wait", "target": { "text": "Booked" } }.` : `A step takes only these fields. Use: ${EXAMPLES.step}.`;
    return { wrong: `step ${n} takes action, target, value, path, key and ms, and got "${short(extra, 40)}"`, help };
  }
  const t = s.target;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const bad = Object.keys(t).find((k) => !TARGET_KEYS.includes(k));
    if (bad) return { wrong: `the target of step ${n} takes role and name, label, text, placeholder, testId or css, and got "${short(bad, 40)}"`, help: `Use: "target": ${EXAMPLES.target}.` };
  }
  return { step: s };
}

/** Words that tell what kind of technical trouble an agent is stuck on. */
const ABOUT_BROWSER = /\b(browser|chrom(e|ium)|playwright|puppeteer|headless|screenshots?|sandbox|seatbelt|mach|bootstrap_check_in|sigtrap)\b/i;
const ABOUT_PORT = /\b(ports?|eaddrinuse|address (already )?in use|already in use|listen(ing)?)\b/i;
const ABOUT_APP = /\b(app|server|start(ed|ing)?|not (answer|respond)ing|connection refused|econnrefused|refused to connect|crash(ed)?|down)\b/i;
/** A website the project's network level does not let its commands reach: what the sandbox and its proxy say. */
const ABOUT_SITE = /not_allowlisted|on the deny list|deny network-outbound|connect tunnel failed|network allowlist|not allowed for this project|\b(site|host|domain|website|download)s? (is |was |were )?(not allowed|blocked|closed)\b/i;

/** The way around a closed website, for the agent: nothing is broken, so there is nothing to fix or to ask. */
const SITE_CLOSED =
  'That site is closed for this project on purpose, and squad-kit does not open it: nothing here is broken. Do not try to reach it another way, and never ask the person to open it. Get what you need from an official package registry or from what is already in this copy, or go on without it.';

const STOPPED = 'You stopped the squad.';
/** What a call answers once the run is stopped or over. */
const STOPPED_CALL = 'You were stopped. squad-kit takes no more calls in this run.';
/** What a call answers while the app starts in the background: the start goes on past the call. */
export const STILL_STARTING = 'The app is still starting. Call app_status in a moment.';
/** What run_checks says when squad-kit stopped the app first: the tests may start their own, one per folder. */
export const STOPPED_FOR_CHECKS = 'squad-kit stopped the app it started for you, so the tests could start their own. Call start_app again when you need it.';
/** And app_status, until the app starts again. */
const STOPPED_FOR_CHECKS_STATUS = 'The app is not running: squad-kit stopped it before the checks ran, so the tests could start their own. Call start_app when you need it.';
/** What a call answers while squad-kit's browser is still being set up (the first time, it is downloaded). */
export const BROWSER_STARTING = "squad-kit is still setting up its screenshot browser. Call this again in a moment; do not start a browser yourself.";
/** And while squad-kit's phone gets ready: the app is built and the phone starts, the first time. */
export const PHONE_STARTING = 'squad-kit is still getting its phone ready (it builds the app and starts the phone). Call this again in a moment; do not start a simulator or an emulator yourself.';

/**
 * How much of a call's time each part may use: the app and the browser are waited for until 70% of it, pictures are
 * taken until 90%, and start_app waits until 95%. The rest is room for the answer.
 */
const WAIT_SHARE = 0.7;
const SHOOT_SHARE = 0.9;
const START_SHARE = 0.95;

/** One call's clock: when it came in, and the time it may take in all, waiting its turn included. */
interface CallClock {
  at: number;
  ms: number;
}
const by = (c: CallClock, share: number) => c.at + Math.round(c.ms * share);

type Settled<T> = { ok: T } | { err: unknown } | 'late';

/** What a promise ended with, or "late" when `at` comes first or the Stop fires. The work itself goes on. */
function settleBy<T>(p: Promise<T>, at: number, signal: AbortSignal): Promise<Settled<T>> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (v: Settled<T>) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onStop);
      resolve(v);
    };
    const onStop = () => done('late');
    timer = setTimeout(() => done('late'), Math.min(2 ** 31 - 1, Math.max(0, at - Date.now())));
    signal.addEventListener('abort', onStop, { once: true });
    if (signal.aborted) onStop();
    p.then(
      (ok) => done({ ok }),
      (err: unknown) => done({ err }),
    );
  });
}

export class AgentWindow {
  readonly key = randomBytes(24).toString('hex');
  readonly refusals: Refusal[] = [];
  /** Calls in the wrong shape: answered with the right shape, never counted as refusals. */
  readonly mistakes: ShapeMistake[] = [];
  readonly stuck: StuckReport[] = [];
  /** Every picture this run took, by file name. */
  readonly pictures = new Map<string, TakenPicture>();
  private apiCalls = 0;
  private imageBytesSent = 0;
  private app: RunningApp | null;
  /** The app squad-kit is starting for this run. It starts in the background, so a slow start never holds a call. */
  private starting: Promise<RunningApp> | null = null;
  /** Why the last start did not work, for app_status. */
  private startFailed: string | null = null;
  /** What the start waits for in the app's copy (copy-turn.ts): a check running there, for the calls to say. */
  private waitsFor: TurnKind | null = null;
  /** Takes the app off its copy's list (copy-turn.ts appIn), once it is no longer this window's. */
  private leaveCopy: (() => void) | null = null;
  /** squad-kit stopped the app so the checks in its copy could run: app_status says so until it starts again. */
  private stoppedForChecks = false;
  private session: BrowserSession;
  private closed = false;
  /**
   * The window's own Stop: it fires with the run's Stop, when the run ends, and when the agent is stopped for its
   * refusals. What the window is starting (the app, its browser) ends with it.
   */
  private readonly ctl = new AbortController();
  private readonly signal: AbortSignal;
  /** The checks running for this run: they go on in the background, so a long test run never holds a call. */
  private checksJob: { asked?: string; done: Promise<CheckRun[]> } | null = null;
  /** Calls run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private reserved = 0;
  private stopped = false;
  private onTooMany: (() => void)[] = [];

  constructor(private s: WindowSetup) {
    this.app = null;
    this.hold(s.running ?? null);
    this.signal = s.signal ? AbortSignal.any([s.signal, this.ctl.signal]) : this.ctl.signal;
    this.session = new BrowserSession(this.sessionOptions());
  }

  private sessionOptions() {
    return { signal: this.signal, onLine: (t: string) => this.s.say(t) };
  }

  get ticket(): string {
    return this.s.ticket;
  }

  get step(): string {
    return this.s.step;
  }

  get tools(): WindowTool[] {
    return this.s.tools;
  }

  /** What to do on the third refusal: squad-kit stops the agent. */
  whenTooMany(fn: () => void): void {
    this.onTooMany.push(fn);
  }

  /** Three refusals: the agent is stopped. */
  get tooMany(): boolean {
    return this.refusals.length >= REFUSALS_TO_STOP;
  }

  /** More calls in the wrong shape than a run may make: the step is ended, in plain words. */
  get tooManyMistakes(): boolean {
    return this.mistakes.length > MISTAKES_TO_STOP;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The run ended, was stopped, or its agent was: nothing more is done for it. */
  private get over(): boolean {
    return this.closed || this.stopped || this.signal.aborted;
  }

  /** The exact pictures this run took (name, page, size), for the agent to pick from in its final answer. */
  pictureList(): string {
    if (!this.pictures.size) return 'You took no pictures in this step yet.';
    const rows = [...this.pictures.values()].map((p) => (p.call ? `- ${p.file}: the saved answer to ${p.call}` : `- ${p.file}: ${p.page}, ${p.size}${p.device ? ` (${p.device})` : ''}`));
    return `The pictures you took in this step. In your final answer, name only these files:\n${rows.join('\n')}`;
  }

  /** The tools this run may use, as MCP lists them. */
  listTools(): ToolDef[] {
    const phone = this.s.phone ? phoneDefs(this.s.phone.sizes, this.s.phone.labels(), this.s.phone.links(), this.s.phone.label) : null;
    return this.s.tools.map((name) => ({ name, ...(name === 'run_checks' && this.s.checks?.parts ? RUN_CHECKS_BY_PART : phone && (name === 'take_screenshots' || name === 'look_at_page') ? phone[name] : DEFS[name]) }));
  }

  /**
   * One refusal: the agent gets a clear error, the story a plain line, the app log the details. The third one in a
   * run stops the agent, and the window takes no call after it. The question filter counts its refusals here too.
   */
  refuse(tool: string, why: string, line: string): ToolResult {
    this.refusals.push({ tool, why, line, at: new Date().toISOString() });
    this.s.say(line);
    this.s.log?.(`Refused the ${this.s.who}'s ${tool} on ${this.s.ticket} (${this.s.step}): ${why}`);
    if (this.tooMany && !this.stopped) {
      this.stopped = true;
      this.ctl.abort();
      for (const fn of this.onTooMany) fn();
      return error(`squad-kit refused this: ${why}. That is the ${REFUSALS_TO_STOP}rd refusal in this step, so squad-kit stops you now.`);
    }
    return error(`squad-kit refused this: ${why}. squad-kit does only what its tools say, on this story's own app. ${REFUSALS_TO_STOP - this.refusals.length} more refused ${REFUSALS_TO_STOP - this.refusals.length === 1 ? 'request stops' : 'requests stop'} this step.`);
  }

  /**
   * A call in the wrong shape: a field misnamed or in the wrong place. Nothing is refused, as nothing unsafe was
   * asked: the agent gets the right shape with an example and calls again. It never counts toward the stop for
   * refusals, and the story gets no line; past MISTAKES_TO_STOP in a run, squad-kit ends the step.
   */
  mistake(tool: string, why: string, help: string): ToolResult {
    this.mistakes.push({ tool, why, at: new Date().toISOString() });
    this.s.log?.(`The ${this.s.who}'s ${tool} on ${this.s.ticket} (${this.s.step}) was in the wrong shape: ${why}`);
    if (this.tooManyMistakes && !this.stopped) {
      this.stopped = true;
      this.ctl.abort();
      for (const fn of this.onTooMany) fn();
      this.s.say(`The ${this.s.who} kept calling squad-kit's tools in the wrong shape, so squad-kit ended the step.`);
      return error(`This call is in the wrong shape: ${why}. That is more than ${MISTAKES_TO_STOP} calls in the wrong shape in this step, so squad-kit ends it now.`);
    }
    return error(`This call is in the wrong shape, so squad-kit did nothing: ${why}. ${help} Fix it and call again.`);
  }

  /**
   * A tool call, checked, then done one at a time. Its clock starts now, waiting its turn included, so the agent gets
   * an answer well within its own limit for a tool. A call after the run ended, or after a Stop, does nothing.
   */
  call(name: string, args: unknown): Promise<ToolResult> {
    const clock: CallClock = { at: Date.now(), ms: this.s.limits?.callMs ?? CALL_MS };
    const job = this.queue.then(() => this.handle(name, args, clock));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async handle(name: string, raw: unknown, clock: CallClock): Promise<ToolResult> {
    this.s.beat?.();
    try {
      return await this.handleCall(name, raw, clock);
    } finally {
      this.s.beat?.();
    }
  }

  private async handleCall(name: string, raw: unknown, clock: CallClock): Promise<ToolResult> {
    if (this.closed) return error('This run has ended. squad-kit no longer takes calls for it.');
    if (this.stopped) {
      return error(this.tooManyMistakes ? 'squad-kit ended this step after too many calls in the wrong shape. It takes no more calls in this run.' : `squad-kit stopped you after ${REFUSALS_TO_STOP} refused requests. It takes no more calls in this run.`);
    }
    if (this.signal.aborted) return error(STOPPED_CALL);
    const who = this.s.who;
    if (!this.s.tools.includes(name as WindowTool)) {
      return this.mistake(String(name).slice(0, 60), `there is no tool "${String(name).slice(0, 60)}" in this step`, `The tools of this step are ${this.s.tools.join(', ')}.`);
    }
    const args = (raw ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || Array.isArray(args)) return this.mistake(name, 'the fields are not an object', `Send an object of fields, like ${name === 'take_screenshots' ? EXAMPLES.shots : name === 'look_at_page' ? EXAMPLES.look : name === 'i_am_stuck' ? EXAMPLES.stuck : '{}'}.`);
    // A field that asks squad-kit to run something is refused for safety; the app tools say it their own way.
    const run = name === 'start_app' || name === 'stop_app' ? null : commandField(args);
    if (run) return this.refuse(name, `it asked squad-kit to run something ("${short(run, 40)}")`, `The ${who} asked squad-kit to run a command. squad-kit refused.`);
    if (hugeValue(args, name === 'i_am_stuck' ? HUGE : MAX_VALUE * 4)) return this.mistake(name, 'a value is far too long', 'Keep each value short: a page path, a label, a value to type.');
    try {
      switch (name as WindowTool) {
        case 'take_screenshots':
          return await this.screenshots(args, clock);
        case 'look_at_page':
          return await this.look(args, clock);
        case 'start_app':
          return await this.startApp(args, clock);
        case 'stop_app':
          return await this.stopApp(args);
        case 'app_status':
          return await this.status(args);
        case 'run_checks':
          return await this.checksInTurn(args, clock);
        case 'add_part':
          return await this.addPart(args);
        case 'ask_api':
          return await this.askApi(args, clock);
        case 'i_am_stuck':
          return await this.iAmStuck(args, clock);
      }
    } catch (err) {
      if (this.over) return error(STOPPED_CALL);
      this.s.log?.(`The ${who}'s ${name} on ${this.s.ticket} did not work: ${(err as Error).stack ?? String(err)}`);
      return error(`squad-kit could not do this: ${(err as Error).message}. Call i_am_stuck if it keeps happening.`);
    }
    return error(`squad-kit has no tool "${name}".`);
  }

  /**
   * The checks every page call shares, after its slips are put right (pageCall): the page and the steps. The call as
   * squad-kit takes it, or the answer for the agent: a refusal for a page outside the app, a shape mistake for the rest.
   * `at` names the shot in a list ("shots[1]: ").
   */
  private checkPage(tool: string, raw: Record<string, unknown>, at = ''): { ask: Record<string, unknown> } | ToolResult {
    const who = this.s.who;
    const phone = this.s.phone;
    const shaped = pageCall(raw, tool, phone ? ['language'] : []);
    if ('wrong' in shaped) return this.mistake(tool, `${at}${shaped.wrong}`, shaped.help);
    const ask = this.onOwnApp(shaped.ask);
    for (const p of [ask.page, ...gotoPaths(ask.steps)]) {
      const out = outsideApp(p);
      if (out) return this.refuse(tool, out, `The ${who} asked to open another website. squad-kit refused.`);
    }
    const example = tool === 'look_at_page' ? EXAMPLES.look : EXAMPLES.shot;
    if (hugeValue(ask, MAX_VALUE)) return this.mistake(tool, `${at}a value is longer than ${MAX_VALUE} characters`, 'Keep each value short: a page path, a label, a value to type.');
    const page = pageProblem(ask.page);
    if (page) return this.mistake(tool, `${at}${page}`, `Use: ${example}.`);
    const steps = stepsProblem(ask.steps);
    if (steps) return this.mistake(tool, `${at}${steps}`, `A step looks like ${EXAMPLES.step}.`);
    if (phone) {
      const sizes: string[] = phone.sizes;
      if (ask.size !== undefined && !sizes.includes(ask.size as string)) return this.mistake(tool, `${at}size is ${sizes.map((x) => `"${x}"`).join(' or ')} on this phone app`, `Use: ${PHONE_SHOTS}.`);
      if (ask.language !== undefined && (typeof ask.language !== 'string' || !/^[a-z]{2}$/.test(ask.language))) return this.mistake(tool, `${at}language is a two-letter code, like "en" or "ar"`, `Use: ${PHONE_SHOTS}.`);
      const css = (Array.isArray(ask.steps) ? (ask.steps as BrowserStep[]) : []).findIndex((x) => x?.target?.css !== undefined);
      if (css >= 0) return this.mistake(tool, `${at}step ${css + 1} names its part by css, and a phone screen has none`, 'Name it by the words on it: { "text": "Sign up" }, { "label": "Name" } or { "role": "button", "name": "Save" }.');
      return { ask };
    }
    if (ask.size !== undefined && ask.size !== 'desktop' && ask.size !== 'phone') return this.mistake(tool, `${at}size is "desktop" or "phone"`, `Use: ${example}.`);
    return { ask };
  }

  /**
   * The app's own full address, under any local name for it, is only its path: "http://localhost:62307/book" is "/book"
   * while the app runs there. It is no refusal: another host or port stays one.
   */
  private onOwnApp(ask: Record<string, unknown>): Record<string, unknown> {
    const running = this.app && !this.app.ended?.() ? this.app.url : this.s.app?.url;
    if (!running) return ask;
    const own = (p: unknown) => (typeof p === 'string' && /^https?:/i.test(p.trim()) ? (pathOnApp(p.trim(), running) ?? p) : p);
    return {
      ...ask,
      ...(ask.page !== undefined ? { page: own(ask.page) } : {}),
      ...(Array.isArray(ask.steps) ? { steps: ask.steps.map((x: Record<string, unknown>) => (x?.action === 'goto' && x.path !== undefined ? { ...x, path: own(x.path) } : x)) } : {}),
    };
  }

  private async screenshots(args: Record<string, unknown>, clock: CallClock): Promise<ToolResult> {
    const who = this.s.who;
    const extra = extraFields(args, ['shots']);
    if (extra.length) return this.mistake('take_screenshots', `it takes only "shots", and got "${short(extra[0]!, 40)}"`, `Put each picture in "shots": ${EXAMPLES.shots}.`);
    const shots = args.shots;
    if (!Array.isArray(shots) || !shots.length) return this.mistake('take_screenshots', 'shots is missing', `Give at least one: ${EXAMPLES.shots}.`);
    if (shots.length > MAX_SHOTS_PER_CALL || this.pictures.size + this.reserved + shots.length > MAX_PICTURES) {
      const left = Math.max(0, MAX_PICTURES - this.pictures.size - this.reserved);
      return this.refuse(
        'take_screenshots',
        shots.length > MAX_SHOTS_PER_CALL
          ? `${shots.length} shots in one call, and one call takes at most ${MAX_SHOTS_PER_CALL}. Split them over calls: this step may take ${MAX_PICTURES} pictures in all, and ${left} are left`
          : `${shots.length} more pictures, and this step may take ${MAX_PICTURES} in all, with ${left} left. Take only the ones you still need, one per part or case of a "done when"`,
        `The ${who} asked for more pictures than squad-kit takes in one step. squad-kit refused.`,
      );
    }
    const asks: ShotAsk[] = [];
    const phoneAsks: PhoneAsk[] = [];
    for (const [i, s] of shots.entries()) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return this.mistake('take_screenshots', `shots[${i}] is not an object`, `Each shot looks like ${EXAMPLES.shot}.`);
      const checked = this.checkPage('take_screenshots', s as Record<string, unknown>, `shots[${i}]: `);
      if ('content' in checked) return checked;
      const x = checked.ask as { page: string; steps?: BrowserStep[]; size?: string; language?: string };
      if (this.s.phone) phoneAsks.push({ page: x.page.trim(), steps: x.steps ?? [], ...(x.size ? { size: x.size as PhoneSize } : {}), ...(x.language ? { language: x.language } : {}) });
      else asks.push({ page: x.page.trim(), steps: x.steps ?? [], ...(x.size ? { size: x.size as ShotSize } : {}) });
    }
    if (this.s.phone) return this.phoneShots(this.s.phone, phoneAsks, clock);
    const origin = await this.origin(by(clock, WAIT_SHARE));
    if (typeof origin !== 'string') return origin;
    const notReady = await this.browserBy(by(clock, WAIT_SHARE));
    if (notReady) return notReady;
    this.reserved += asks.length;
    const deadline = by(clock, SHOOT_SHARE);
    const content: ToolContent[] = [];
    let failed = 0;
    try {
      for (const [i, ask] of asks.entries()) {
        if (this.over) break;
        if (Date.now() >= deadline) {
          failed += 1;
          content.push(text(`Shot ${i + 1} (${ask.page}): not taken, the call ran out of time (${Math.round(clock.ms / 1000)} seconds in all). Call again for it.`));
          continue;
        }
        this.s.beat?.();
        const r = await shootOne(this.session, ask, { origin, ...this.alsoReach(), stepMs: this.s.limits?.stepMs ?? STEP_MS, deadline, signal: this.signal });
        if (this.over) break;
        if ('png' in r) {
          const file = this.save(r.png);
          const size = ask.size ?? 'desktop';
          this.pictures.set(file, { file, page: r.page, size: size as ShotSize, ...(this.s.pictureLabel ? { device: this.s.pictureLabel } : {}) });
          const { width, height } = SIZES[size as ShotSize];
          content.push(text(`Shot ${i + 1}: saved as ${file}, at ${r.page} (${size}, ${width}x${height}${this.s.pictureLabel ? `, ${this.s.pictureLabel}` : ''}).${statusWords(r.status)}`));
          // Only a real PNG of a size the agent's AI can take goes back as a picture.
          if (isPng(r.png) && r.png.length <= MAX_IMAGE_BYTES) {
            if (this.imageBytesSent + r.png.length > MAX_IMAGE_BYTES_SENT) content.push(text('This picture is saved and counts, but squad-kit does not send it back: this step has sent back enough large pictures. Do not take it again; squad-kit\'s own check looks at it.'));
            else {
              this.imageBytesSent += r.png.length;
              content.push({ type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' });
            }
          } else content.push(text(`squad-kit could not send this picture back (${isPng(r.png) ? 'it is too large' : 'it is not a PNG picture'}); take it again.`));
        } else {
          failed += 1;
          content.push(text(this.failedText(i + 1, ask, r)));
        }
      }
    } catch (err) {
      return this.browserError(err);
    } finally {
      this.reserved -= asks.length;
    }
    if (this.over) return error(STOPPED_CALL);
    const left = MAX_PICTURES - this.pictures.size;
    content.push(text(`${left} of the ${MAX_PICTURES} pictures this step may take are left.${failed ? ' Fix the shots that did not work and call again for them.' : ''}`));
    if (this.pictures.size) content.push(text(this.pictureList()));
    return { content, ...(failed === asks.length ? { isError: true } : {}) };
  }

  private failedText(n: number, ask: { page: string }, f: FailedShot): string {
    if (f.left) this.s.say(`The page tried to open another website while the ${this.s.who} took a picture. squad-kit kept it on the app.`);
    const at = f.step ? `step ${f.step} (${f.what})` : f.what;
    const seen = f.snapshot ? `\nWhat the page showed then, cut short:\n${f.snapshot}` : '';
    return `Shot ${n} (${ask.page}) did not work at ${at}: ${f.why}. The page was at ${f.page || '(not opened)'}.${seen}`;
  }

  private async look(args: Record<string, unknown>, clock: CallClock): Promise<ToolResult> {
    const checked = this.checkPage('look_at_page', args);
    if ('content' in checked) return checked;
    const fields = checked.ask;
    if (this.s.phone) {
      const ask: PhoneAsk = { page: String(fields.page).trim(), steps: (fields.steps as BrowserStep[]) ?? [], ...(fields.size ? { size: fields.size as PhoneSize } : {}), ...(fields.language ? { language: String(fields.language) } : {}) };
      return this.phoneLook(this.s.phone, ask, clock);
    }
    const origin = await this.origin(by(clock, WAIT_SHARE));
    if (typeof origin !== 'string') return origin;
    const notReady = await this.browserBy(by(clock, WAIT_SHARE));
    if (notReady) return notReady;
    const ask: ShotAsk = { page: String(fields.page).trim(), steps: (fields.steps as BrowserStep[]) ?? [], ...(fields.size ? { size: fields.size as ShotSize } : {}) };
    try {
      const r = await lookAt(this.session, ask, { origin, ...this.alsoReach(), stepMs: this.s.limits?.stepMs ?? STEP_MS, deadline: by(clock, SHOOT_SHARE), signal: this.signal });
      if (this.over) return error(STOPPED_CALL);
      if ('why' in r) return error(this.failedText(1, ask, r));
      return ok(`The page is at ${r.page}.${statusWords(r.status)}\nWhat it shows (its accessibility tree: roles, names and text), cut short:\n${r.snapshot || '(nothing readable)'}`);
    } catch (err) {
      return this.browserError(err);
    }
  }

  /**
   * The pictures on squad-kit's phone: no app to start and no browser, the phone itself. It is got ready first (the app
   * built, the phone up), waited for until 70% of the call; then each shot opens the app fresh and takes its picture.
   */
  private async phoneShots(phone: WindowPhone, asks: PhoneAsk[], clock: CallClock): Promise<ToolResult> {
    const notReady = await this.phoneBy(phone, by(clock, WAIT_SHARE));
    if (notReady) return notReady;
    this.reserved += asks.length;
    const deadline = by(clock, SHOOT_SHARE);
    const content: ToolContent[] = [];
    let failed = 0;
    try {
      for (const [i, ask] of asks.entries()) {
        if (this.over) break;
        if (Date.now() >= deadline) {
          failed += 1;
          content.push(text(`Shot ${i + 1} (${ask.page}): not taken, the call ran out of time (${Math.round(clock.ms / 1000)} seconds in all). Call again for it.`));
          continue;
        }
        this.s.beat?.();
        const r = await phone.shoot(ask, { deadline, stepMs: this.s.limits?.stepMs ?? STEP_MS, signal: this.signal });
        if (this.over) break;
        if ('png' in r) {
          const file = this.save(r.png);
          const size = ask.size ?? 'phone';
          this.pictures.set(file, { file, page: r.page, size, device: r.device });
          content.push(text(`Shot ${i + 1}: saved as ${file}, at ${r.page} (${size}, ${r.device}${ask.language ? `, language ${ask.language}` : ''}).${r.said ? ` ${r.said}` : ''}`));
          if (isPng(r.png) && r.png.length <= MAX_IMAGE_BYTES && this.imageBytesSent + r.png.length <= MAX_IMAGE_BYTES_SENT) {
            this.imageBytesSent += r.png.length;
            content.push({ type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' });
          } else content.push(text("This picture is saved and counts, but squad-kit does not send it back. Do not take it again; squad-kit's own check looks at it."));
        } else {
          failed += 1;
          content.push(text(this.failedText(i + 1, ask, r)));
        }
      }
    } catch (err) {
      return this.phoneError(err);
    } finally {
      this.reserved -= asks.length;
    }
    if (this.over) return error(STOPPED_CALL);
    const left = MAX_PICTURES - this.pictures.size;
    content.push(text(`${left} of the ${MAX_PICTURES} pictures this step may take are left.${failed ? ' Fix the shots that did not work and call again for them.' : ''}`));
    if (this.pictures.size) content.push(text(this.pictureList()));
    return { content, ...(failed === asks.length ? { isError: true } : {}) };
  }

  private async phoneLook(phone: WindowPhone, ask: PhoneAsk, clock: CallClock): Promise<ToolResult> {
    const notReady = await this.phoneBy(phone, by(clock, WAIT_SHARE));
    if (notReady) return notReady;
    try {
      const r = await phone.look(ask, { deadline: by(clock, SHOOT_SHARE), stepMs: this.s.limits?.stepMs ?? STEP_MS, signal: this.signal });
      if (this.over) return error(STOPPED_CALL);
      if ('why' in r) return error(this.failedText(1, ask, r));
      return ok(`The screen is at ${r.page} on the ${r.device}.${r.said ? ` ${r.said}` : ''}\nWhat it shows (the words of each part, one a line), cut short:\n${r.snapshot || '(nothing readable)'}`);
    } catch (err) {
      return this.phoneError(err);
    }
  }

  /** squad-kit's phone, waited for until `at`: null once it is ready, else what the agent is told. Getting ready goes on. */
  private async phoneBy(phone: WindowPhone, at: number): Promise<ToolResult | null> {
    const r = await settleBy(phone.ready(), at, this.signal);
    if (this.over) return error(STOPPED_CALL);
    if (r === 'late') return error(PHONE_STARTING);
    return 'err' in r ? this.phoneError(r.err) : null;
  }

  private phoneError(err: unknown): ToolResult {
    if (this.over) return error(STOPPED_CALL);
    const detail = (err as { detail?: string })?.detail;
    this.s.log?.(`squad-kit's phone did not work for ${this.s.ticket}: ${(err as Error)?.message ?? String(err)}${detail ? `\n${detail}` : ''}`);
    return error(`squad-kit's phone could not take this: ${(err as Error)?.message ?? String(err)}${detail ? ` (${detail.slice(0, 600)})` : ''}. Call i_am_stuck if it keeps happening, and never start a simulator or an emulator yourself.`);
  }

  /**
   * squad-kit's browser, waited for until `at` at most: null once it runs, else what the agent is told. A first
   * start that is still setting it up goes on in the background, so the next call finds it ready.
   */
  private async browserBy(at: number): Promise<ToolResult | null> {
    const r = await settleBy(this.session.browser(), at, this.signal);
    if (this.over) return error(STOPPED_CALL);
    if (r === 'late') return error(BROWSER_STARTING);
    return 'err' in r ? this.browserError(r.err) : null;
  }

  private browserError(err: unknown): ToolResult {
    if (this.over) return error(STOPPED_CALL);
    if (err instanceof ShotsUnavailable) {
      this.s.log?.(`squad-kit's browser did not start for ${this.s.ticket}: ${err.detail}`);
      return error(`squad-kit's browser could not start: ${shotsErrorDetail(err).slice(0, 600)}. Call i_am_stuck so squad-kit tries to set it up again.`);
    }
    throw err;
  }

  /** What a page may call past the app itself: the other parts of its product. */
  private alsoReach(): { also?: string[] } {
    const also = (this.s.app?.reach?.() ?? []).map(appOrigin).filter((o): o is string => Boolean(o));
    return also.length ? { also } : {};
  }

  /** The app's origin, started first when it is not running and waited for until `at`; or the error for the agent. */
  private async origin(at: number): Promise<string | ToolResult> {
    const app = await this.ensureApp(at);
    if ('fail' in app) return app.fail;
    const origin = appOrigin(app.app.url);
    if (!origin) return error("The app's address in the project's settings is not on this computer, so squad-kit does not open it.");
    return origin;
  }

  /**
   * The app this step runs: squad-kit's own, started when it is not running. The start goes on in the background;
   * the call waits for it until `at` at most, then says the app is still starting.
   */
  private async ensureApp(at: number): Promise<{ app: RunningApp } | { fail: ToolResult; late?: true }> {
    const a = this.s.app;
    if (!a) return { fail: error('This step has no app squad-kit can start: the project has no start command or address in its settings.') };
    if (!appOrigin(a.url)) return { fail: error("The app's address in the project's settings is not on this computer, so squad-kit does not open it.") };
    if (this.app && !this.app.ended?.()) return { app: this.app };
    this.hold(null);
    const r = await settleBy(this.startInBackground(a), at, this.signal);
    if (this.over) return { fail: error(STOPPED_CALL) };
    if (r === 'late') {
      const again = this.s.tools.includes('app_status') ? 'Call app_status in a moment.' : 'Call this again in a moment.';
      // Waiting for the copy's turn is said as it is: the tests run first, then the app starts.
      if (this.waitsFor) return { fail: error(`${waitWords(this.waitsFor, 'app')} ${again}`), late: true };
      return { fail: error(this.s.tools.includes('app_status') ? STILL_STARTING : 'The app is still starting. Call this again in a moment.'), late: true };
    }
    if ('err' in r) {
      const why = (r.err as { detail?: string })?.detail ?? (r.err as Error)?.message ?? String(r.err);
      return { fail: error(`squad-kit could not start the app: ${why.slice(0, 1500)}\nCall i_am_stuck if you think squad-kit can fix it; otherwise say in your answer what is missing.`) };
    }
    return { app: r.ok };
  }

  /**
   * Starts the app once, in the background, in its copy's turn (copy-turn.ts): a check running in that copy ends
   * first, as its own server would be in the way. An app that comes up after the run ended is stopped at once.
   */
  private startInBackground(a: WindowApp): Promise<RunningApp> {
    if (this.starting) return this.starting;
    this.startFailed = null;
    this.stoppedForChecks = false;
    const who = this.s.who;
    let job: Promise<RunningApp> | null = null;
    job = (async () => {
      let turn: Turn | null = null;
      try {
        turn = await this.appTurn(a.cwd);
        await this.s.beforeStart?.().catch(() => undefined);
        // What a finished check left running in the app's own copy (its test server) stops first. A product keeps today's way.
        if (!a.run) await this.s.clearCopy?.(a.cwd).catch(() => false);
        if (this.over) throw new Error(STOPPED);
        const app = a.run ? await a.run() : await this.startPastOther(a);
        if (this.over) {
          app.stop();
          throw new Error(STOPPED);
        }
        this.hold(app);
        // The address is for the agent and engineers; the story gets one plain line.
        this.s.say(`squad-kit started the app for the ${who}`);
        this.s.log?.(`squad-kit started the app at ${app.url} for the ${who} on ${this.s.ticket}`);
        return app;
      } catch (err) {
        if (!this.over) {
          // The exact words are for the agent and engineers; the story gets one plain line.
          this.startFailed = (err as Error)?.message ?? String(err);
          this.s.log?.(`squad-kit could not start the app for the ${who} on ${this.s.ticket}: ${this.startFailed}`);
          this.s.say(`squad-kit could not start the app for the ${who}.`);
        }
        throw err;
      } finally {
        this.waitsFor = null;
        turn?.release();
        if (this.starting === job) this.starting = null;
      }
    })();
    this.starting = job;
    job.catch(() => undefined);
    return job;
  }

  /**
   * The app this window runs now. It is on its copy's list (copy-turn.ts appIn), so a run of the checks there stops it
   * first: run_checks and app_status then say so, and the story gets one plain line. A product keeps today's way.
   */
  private hold(app: RunningApp | null): void {
    this.leaveCopy?.();
    this.leaveCopy = null;
    this.app = app;
    const a = this.s.app;
    if (!app || !a || a.run) return;
    this.leaveCopy = appIn(a.cwd, async () => {
      if (this.app !== app || app.ended?.()) return false;
      this.hold(null);
      app.stop();
      this.stoppedForChecks = true;
      this.s.say(`squad-kit stopped the app for the ${this.s.who}, so the tests could run`);
      this.s.log?.(`squad-kit stopped the app at ${app.url} for the ${this.s.who} on ${this.s.ticket}, before the checks in its copy`);
      await untilEnded(app);
      return true;
    });
  }

  /**
   * The app's copy's turn: at once when nothing runs there, else after the checks running there, said once on the story.
   * After the cap, the start does not happen, and the agent is told why in plain words.
   */
  private async appTurn(dir: string): Promise<Turn> {
    try {
      return await takeTurn(dir, 'app', {
        signal: this.signal,
        ...(this.s.limits?.turnMs !== undefined ? { waitMs: this.s.limits.turnMs } : {}),
        onWait: (holder) => {
          this.waitsFor = holder;
          if (holder === 'checks') this.s.say(`The app waits for the tests running in this story's copy, then starts for the ${this.s.who}`);
        },
      });
    } catch (err) {
      if (!(err instanceof TurnTimeout)) throw err;
      this.s.log?.(`The app for the ${this.s.who} on ${this.s.ticket} did not start: it ${err.message}`);
      throw new Error(`${err.holder === 'checks' ? 'the tests in this copy were' : 'another start of the app in this copy was'} still running after ${minutes(err.ms)}, so squad-kit did not start the app. ${err.holder === 'checks' && this.s.tools.includes('run_checks') ? 'Call run_checks for their result, then start_app again' : 'Try again in a moment'}`);
    }
  }

  /**
   * The app, started; once more when its framework said another dev server already runs in this copy and squad-kit
   * could stop that very process (a leftover of this copy, never what squad-kit runs now).
   */
  private startPastOther(a: WindowApp): Promise<RunningApp> {
    const start = () => startApp(a.cwd, a.start, a.url, this.s.limits?.appWaitMs, this.signal, a.guard, { onHealed: (detail) => this.healed(detail) });
    return startPastOther(
      start,
      async (pid) => !this.over && Boolean(this.s.clearCopy && (await this.s.clearCopy(a.cwd, pid))),
      (text) => this.s.log?.(`${text}, for the ${this.s.who} on ${this.s.ticket}`),
    );
  }

  private async startApp(args: Record<string, unknown>, clock: CallClock): Promise<ToolResult> {
    const extra = extraFields(args, []);
    if (extra.length) return this.refuse('start_app', `start_app takes no fields, and it got "${extra[0]!.slice(0, 40)}"`, `The ${this.s.who} asked to start the app its own way. squad-kit refused.`);
    const was = this.app && !this.app.ended?.() ? this.app : null;
    const r = await this.ensureApp(by(clock, START_SHARE));
    if ('fail' in r) return r.fail;
    return ok(`${was ? 'The app already runs' : 'The app runs'} at ${r.app.url}.${r.app.lines?.() ? `\nThe last lines it printed:\n${r.app.lines(15)}` : ''}`);
  }

  private async stopApp(args: Record<string, unknown>): Promise<ToolResult> {
    const extra = extraFields(args, []);
    if (extra.length) return this.refuse('stop_app', `stop_app takes no fields, and it got "${extra[0]!.slice(0, 40)}"`, `The ${this.s.who} asked to stop a program squad-kit did not start. squad-kit refused.`);
    if (this.starting) return ok('The app is still starting. Call app_status in a moment, then stop_app once it runs.');
    if (!this.app || this.app.ended?.()) {
      this.hold(null);
      return ok('squad-kit has not started the app in this step, so there is nothing to stop. squad-kit stops only what it started.');
    }
    const at = this.app.url;
    this.s.app?.after?.();
    this.app.stop();
    this.hold(null);
    this.s.say(`squad-kit stopped the app for the ${this.s.who}`);
    this.s.log?.(`squad-kit stopped the app at ${at} for the ${this.s.who} on ${this.s.ticket}`);
    return ok(`Stopped the app squad-kit started at ${at}.`);
  }

  private async status(args: Record<string, unknown>): Promise<ToolResult> {
    const extra = extraFields(args, []);
    if (extra.length) return this.mistake('app_status', `app_status takes no fields, and it got "${short(extra[0]!, 40)}"`, 'Call it with {}.');
    if (!this.s.app) return ok('This step has no app squad-kit can start.');
    if (this.starting && this.waitsFor) return ok(`${waitWords(this.waitsFor, 'app')} Call app_status again in a moment.`);
    if (this.starting) return ok('The app is still starting. Call app_status again in a moment.');
    if (!this.app || this.app.ended?.()) {
      if (this.stoppedForChecks) return ok(STOPPED_FOR_CHECKS_STATUS);
      const failed = this.startFailed ? `\nThe last start did not work: ${this.startFailed.slice(0, 1500)}` : '';
      return ok(`The app is not running. start_app starts it, and take_screenshots starts it when needed.${failed}${this.app?.lines?.() ? `\nThe last lines it printed:\n${this.app.lines(15)}` : ''}`);
    }
    const answers = await fetch(this.app.url, { signal: AbortSignal.timeout(3000) }).then((r) => r.status < 500).catch(() => false);
    return ok(`The app runs at ${this.app.url} and ${answers ? 'answers' : 'does not answer right now'}.${this.app.lines?.() ? `\nThe last lines it printed:\n${this.app.lines(15)}` : ''}`);
  }

  /**
   * run_checks in its copy's turn (copy-turn.ts): an app starting in the same copy goes first, and the run holds the
   * turn until it ends, in the background too, so an app start waits for it. A run going on already holds the turn: the
   * call only asks it for its result. Before a new run, the app squad-kit runs in that copy stops (stopAppsIn): the one
   * started for this agent, then the answer says so, or one kept for the proof. Nothing else.
   */
  private async checksInTurn(args: Record<string, unknown>, clock: CallClock): Promise<ToolResult> {
    const dir = this.checksJob ? null : this.checksDir(args);
    if (!dir) return this.runChecks(args, clock);
    let turn: Turn;
    try {
      turn = await takeTurn(dir, 'checks', { signal: this.signal, waitMs: Math.max(0, by(clock, WAIT_SHARE) - Date.now()) });
    } catch (err) {
      if (this.over) return error(STOPPED_CALL);
      if (err instanceof TurnTimeout) return ok(`${waitWords(err.holder, 'checks')} Call run_checks again in a moment.`);
      throw err;
    }
    try {
      const mine = this.app && !this.app.ended?.() ? this.app : null;
      if (this.hasChecks(dir)) await stopAppsIn(dir);
      const told = Boolean(mine && this.app !== mine && this.stoppedForChecks);
      const r = await this.runChecks(args, clock);
      const job = this.checksJob;
      if (job) job.done.then(turn.release, turn.release);
      else turn.release();
      return told ? { ...r, content: [text(STOPPED_FOR_CHECKS), ...r.content] } : r;
    } catch (err) {
      turn.release();
      throw err;
    }
  }

  /** True when the copy has a saved check to run at all: with none, run_checks runs nothing, and the app is left alone. */
  private hasChecks(dir: string): boolean {
    const whole = this.s.checks;
    const parts = whole?.parts?.();
    const c = (parts ? Object.values(parts).find((p) => p.cwd === dir) : undefined) ?? whole;
    const commands = c?.commands() ?? {};
    return CHECK_NAMES.some((n) => commands[n]?.trim());
  }

  /** The copy run_checks runs in for these fields: the story's, or the part's it names. Null when this step has no checks. */
  private checksDir(args: Record<string, unknown>): string | null {
    const whole = this.s.checks;
    if (!whole) return null;
    const parts = whole.parts?.();
    const part = typeof args.part === 'string' ? args.part.trim() : '';
    return (parts ? (parts[part] ?? Object.values(parts)[0] ?? whole) : whole).cwd;
  }

  /**
   * The project's own saved checks, in the story's copy, inside squad-kit's guard. There is no command field: what runs
   * comes from the project's settings. A long run goes on in the background, past this call: the next call gets its result.
   */
  private async runChecks(args: Record<string, unknown>, clock: CallClock): Promise<ToolResult> {
    const byPart = Boolean(this.s.checks?.parts);
    const extra = extraFields(args, byPart ? ['which', 'only', 'part'] : ['which', 'only']);
    if (extra.length) return this.mistake('run_checks', `run_checks takes only ${byPart ? '"which", "only" and "part"' : '"which" and "only"'}, and got "${short(extra[0]!, 40)}"`, `Use: ${EXAMPLES.checks}, ${EXAMPLES.only}, or {} for all of them.`);
    const which = args.which as CheckName | undefined;
    if (which !== undefined && !CHECK_NAMES.includes(which)) return this.mistake('run_checks', 'which is "test", "lint" or "build"', `Use: ${EXAMPLES.checks}, or {} for all of them.`);
    if (args.only !== undefined && (typeof args.only !== 'string' || !args.only.trim() || args.only.length > MAX_ONLY || /[\n\r\0]/.test(args.only))) return this.mistake('run_checks', 'only is one test file of this copy, as text', `Use: ${EXAMPLES.only}.`);
    const only = typeof args.only === 'string' ? args.only.trim() : undefined;
    if (only && which && which !== 'test') return this.mistake('run_checks', 'only names a test file, so which is "test" or left out', `Use: ${EXAMPLES.only}.`);
    const whole = this.s.checks;
    if (!whole) return ok('This step has no checks squad-kit can run.');
    const parts = whole.parts?.();
    const part = typeof args.part === 'string' ? args.part.trim() : '';
    // A story with several parts: squad-kit takes the folder from its own list, never from what the agent sends.
    if (parts && Object.keys(parts).length > 1 && !part) return this.mistake('run_checks', 'part is missing, and this story has several', `Say which: ${Object.keys(parts).join(', ')}.`);
    if (parts && part && !parts[part]) return this.mistake('run_checks', `this story has no copy of the part "${short(part, 40)}"`, `Its parts: ${Object.keys(parts).join(', ')}. Call add_part for another.`);
    const c = parts ? (parts[part] ?? Object.values(parts)[0] ?? whole) : whole;
    // The file is one of this copy's: squad-kit looks, and never runs a test tool on a name it cannot find here.
    const file = only ? path.normalize(only.replace(/:\d+$/, '')) : '';
    if (only && !this.checksJob && (path.isAbsolute(file) || file.startsWith('..') || !fs.existsSync(path.join(c.cwd, file)))) return this.mistake('run_checks', `this story's copy has no file "${short(only, 80)}"`, `Name a test file inside this copy, as the test output names it. Use: ${EXAMPLES.only}.`);
    const job = this.checksJob ?? this.startChecks(c, only ? 'test' : which, only);
    if (!job) return ok(`The project has no saved ${which || only ? `${which ?? 'test'} command` : 'test, lint or build command'} yet. Add the script to the project's own files (package.json and the like): squad-kit finds it there, then call this again.`);
    const r = await settleBy(job.done, by(clock, START_SHARE), this.signal);
    if (this.over) return error(STOPPED_CALL);
    if (r === 'late') return ok('The checks are still running. Call run_checks again in a moment for the result; it does not start them twice.');
    this.checksJob = null;
    if ('err' in r) return error(`squad-kit could not run the checks: ${(r.err as Error)?.message ?? String(r.err)}. Call i_am_stuck if it keeps happening.`);
    const asked = only ? `only ${only}` : which;
    const earlier = job.asked !== asked ? `This is the result of the run you started before it (${job.asked ?? 'all the checks'}). Call again for the one you asked for now.\n` : '';
    return ok(`${earlier}${r.ok.map(checkAnswer).join('\n\n')}`);
  }

  /** A check squad-kit ran once more with a home of the project's own: one plain line on the story, the details in the log. */
  private healed(detail: string): void {
    this.s.log?.(detail);
    this.s.say(HEALED_LINE);
  }

  /**
   * Starts the saved checks in the background, or null when the project has none of them. `only`: one test file on its
   * own, with the project's own test tool; when squad-kit cannot run one file with it, all the tests run, and the answer
   * says why. Each check runs once: an agent often expects a new test to fail first, so a failure is not run again.
   */
  private startChecks(c: WindowChecks, which: CheckName | undefined, only?: string): { asked?: string; done: Promise<CheckRun[]> } | null {
    const commands = c.commands();
    const names = (which ? [which] : CHECK_NAMES).filter((n) => commands[n]?.trim());
    if (!names.length) return null;
    const done = (async () => {
      // No server squad-kit left in another copy may hold a port the tests need.
      await this.s.beforeStart?.().catch(() => undefined);
      // What the run is, for the checks step: squad-kit may note the copy's code now (WindowChecks.onRun).
      const noted = await c.onRun?.({ names, ...(only ? { only } : {}) }).catch(() => undefined);
      const out: CheckRun[] = [];
      for (const name of names) {
        if (this.over) break;
        const saved = commands[name]!.trim();
        const alone = only ? fileAlone(c.cwd, saved, only) : null;
        const command = alone?.command ?? saved;
        const note = only && !alone ? `squad-kit cannot run one test file on its own with this project's tests, so it ran all of them.` : undefined;
        c.onStart?.(name);
        this.s.log?.(`squad-kit runs ${alone ? `${only} on its own` : name} for the ${this.s.who} on ${this.s.ticket}: ${command}`);
        const r = await runCommand(c.cwd, command, undefined, { silentMs: CHECK_SILENT_MS, signal: this.signal, onOutput: () => this.s.beat?.(), onHealed: (detail) => this.healed(detail), ...(c.guard ? { guard: c.guard } : {}) });
        if (this.over) break;
        out.push({ name, command, ...r, ...(alone ? { only } : {}), ...(note ? { note } : {}) });
        this.s.say(`squad-kit ran ${alone ? 'one test file' : CHECK_WORDS[name]} for the ${this.s.who}: ${r.ok ? 'passed' : 'did not pass'}`);
        c.onEnd?.(name, r.ok, Boolean(alone));
      }
      if (noted && !this.over && out.length === names.length) await noted(out).catch(() => undefined);
      return out;
    })();
    done.catch(() => undefined);
    // What the agent asked for, so a later call for something else is told which run this was.
    const asked = only ? `only ${only}` : which;
    const job = { ...(asked ? { asked } : {}), done };
    this.checksJob = job;
    return job;
  }

  /** The API, asked by squad-kit: only a part of this product, only its own address, and the call is saved as it happened. */
  private async askApi(args: Record<string, unknown>, clock: CallClock): Promise<ToolResult> {
    const example = '{ "part": "api", "method": "GET", "path": "/price?item=3" }';
    const extra = extraFields(args, ['part', 'method', 'path', 'body', 'headers']);
    if (extra.length) return this.refuse('ask_api', `ask_api has no field "${short(extra[0]!, 40)}"`, `The ${this.s.who} asked the API in a way squad-kit does not offer. squad-kit refused.`);
    const parts = this.s.api?.() ?? {};
    if (!Object.keys(parts).length) return ok('This step has no API squad-kit can ask.');
    const id = typeof args.part === 'string' ? args.part.trim() : '';
    const part = parts[id];
    if (!part) return this.mistake('ask_api', id ? `this product has no part "${short(id, 40)}"` : 'part is missing', `Its parts: ${Object.keys(parts).join(', ')}. Use: ${example}.`);
    const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    if (!API_METHODS.includes(method)) return this.mistake('ask_api', `method is one of ${API_METHODS.join(', ')}`, `Use: ${example}.`);
    const asked = typeof args.path === 'string' ? args.path.trim() : '';
    let origin: string;
    let target: URL;
    try {
      origin = new URL(part.url).origin;
      target = new URL(asked, origin);
    } catch {
      return this.mistake('ask_api', 'path is not a path on this part', `Use: ${example}.`);
    }
    if (!asked.startsWith('/') || asked.startsWith('//') || target.origin !== origin) {
      return this.refuse('ask_api', `the path "${short(asked, 80)}" leaves ${origin}`, `The ${this.s.who} asked to reach another address with the API tool. squad-kit refused.`);
    }
    if (this.apiCalls >= MAX_API_CALLS) return this.mistake('ask_api', `this step has made its ${MAX_API_CALLS} calls`, 'Hand in what you have, and put the rest in offScreen with why.');
    const body = args.body === undefined || args.body === null ? undefined : typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    if (body && Buffer.byteLength(body) > MAX_API_BODY) return this.mistake('ask_api', 'body is too long', 'Send less.');
    if (body && (method === 'GET')) return this.mistake('ask_api', 'a GET sends no body', `Use another method, or put it in the path. ${example}.`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((args.headers ?? {}) as Record<string, unknown>)) {
      if (typeof v !== 'string' || /^(host|connection|content-length|transfer-encoding)$/i.test(k) || /[\r\n]/.test(k + v)) return this.mistake('ask_api', `the header "${short(k, 40)}" cannot be sent`, 'Leave it out.');
      headers[k] = v;
    }
    if (body && !Object.keys(headers).some((k) => /^content-type$/i.test(k))) headers['content-type'] = typeof args.body === 'string' ? 'text/plain' : 'application/json';
    const up = await this.ensureApp(by(clock, START_SHARE));
    if ('fail' in up) return up.fail;
    this.apiCalls += 1;
    const n = this.apiCalls;
    let res: Response;
    try {
      res = await fetch(target, { method, headers, redirect: 'manual', ...(body ? { body } : {}), signal: AbortSignal.any([this.signal, AbortSignal.timeout(API_WAIT_MS)]) });
    } catch (err) {
      if (this.over) return error(STOPPED_CALL);
      return error(`${part.name} did not answer ${method} ${asked}: ${(err as Error).message}. Is that the right address on it? Call i_am_stuck if it keeps happening.`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    const type = contentType.split(';')[0]!.trim().toLowerCase();
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = !type || API_TEXT.test(type);
    const stem = `${this.s.prefix ?? this.s.ticket.toLowerCase()}-api-${n}`;
    const record: Record<string, unknown> = { part: part.name, method, path: asked, ...(body ? { body: body.slice(0, MAX_API_ANSWER) } : {}), status: res.status, contentType };
    if (text) {
      const answer = bytes.subarray(0, MAX_API_ANSWER).toString('utf8');
      record.answer = answer;
      if (bytes.length > MAX_API_ANSWER) record.cut = true;
    } else {
      const own = API_FILE_TYPES[type] ?? 'bin';
      const name = `${stem}-answer.${own}`;
      if (bytes.length > MAX_API_FILE) return error(`${part.name} answered with a file of ${bytes.length} bytes, too big to keep. Say so in your answer.`);
      fs.writeFileSync(path.join(this.s.proofDir, name), bytes);
      record.file = name;
      record.bytes = bytes.length;
      const sheets = own === 'xlsx' ? readWorkbook(bytes) : null;
      if (sheets) record.sheets = sheets;
    }
    const file = `${stem}.api.json`;
    fs.writeFileSync(path.join(this.s.proofDir, file), JSON.stringify(record, null, 2));
    this.pictures.set(file, { file, page: '', size: 'answer', call: `${method} ${asked} on ${part.name}` });
    // The exact call and answer are in the saved file, for engineers: an address can hold someone's email.
    this.s.say(`squad-kit asked ${part.name} for the ${this.s.who}, and kept the answer`);
    const sheets = record.sheets as Sheet[] | undefined;
    const kept = `A file of ${bytes.length} bytes (${type}), saved as ${record.file as string}. squad-kit keeps it for the person to open.`;
    const shown = text ? String(record.answer).slice(0, 8000) : sheets ? `${kept}\n\nWhat it holds:\n\n${sheetsText(sheets).slice(0, 8000)}` : kept;
    return ok(`${part.name} answered ${res.status}${contentType ? ` (${contentType})` : ''}. Saved as ${file}: name that file in your answer for the "done when" it proves.\n\n${shown}${text && bytes.length > 8000 ? '\n(cut here)' : ''}`);
  }

  private async addPart(args: Record<string, unknown>): Promise<ToolResult> {
    const extra = extraFields(args, ['part']);
    if (extra.length) return this.mistake('add_part', `add_part takes only "part", and got "${short(extra[0]!, 40)}"`, 'Use: { "part": "api" }.');
    const part = typeof args.part === 'string' ? args.part.trim() : '';
    if (!part) return this.mistake('add_part', 'part is missing', 'Use: { "part": "api" }.');
    if (!this.s.addPart) return ok('This step cannot add a part.');
    return ok(await this.s.addPart(part));
  }

  private async iAmStuck(args: Record<string, unknown>, clock: CallClock): Promise<ToolResult> {
    const extra = extraFields(args, ['what', 'why']);
    if (extra.length) return this.mistake('i_am_stuck', `i_am_stuck takes what and why, and it got "${short(extra[0]!, 40)}"`, `Use: ${EXAMPLES.stuck}.`);
    const what = typeof args.what === 'string' ? args.what.trim().slice(0, STUCK_KEEP) : '';
    const why = typeof args.why === 'string' ? args.why.trim().slice(0, STUCK_KEEP) : '';
    if (!what) return this.mistake('i_am_stuck', 'what is missing', `Say what does not work: ${EXAMPLES.stuck}.`);
    if (this.stuck.length >= MAX_STUCK) return ok('squad-kit already tried its fixes in this step. Do what you can without it, and say in your answer what is missing.');
    const who = this.s.who;
    // The agent's own technical words go to the app log and the engineer details, never to the story's activity.
    this.s.log?.(`The ${who} said it is stuck on ${this.s.ticket} (${this.s.step}): ${what}${why ? ` (${why})` : ''}`);
    const said = `${what}\n${why}`;
    /** What squad-kit did, for the agent; and the same in plain words, for the story. */
    const did: string[] = [];
    const plain: string[] = [];
    const browser = !this.s.phone && (this.s.tools.includes('take_screenshots') || this.s.tools.includes('look_at_page'));
    // A window that only looks at pages has the app started for it too: squad-kit restarts one that does not answer.
    const app = Boolean(this.s.app) && (this.s.tools.includes('start_app') || this.s.tools.includes('look_at_page'));
    // A closed website: nothing to restart, and the story already has its line. The agent is told the way around.
    const site = ABOUT_SITE.test(said);
    if (site) did.push(SITE_CLOSED);
    const any = !site && !ABOUT_BROWSER.test(said) && !ABOUT_PORT.test(said) && !ABOUT_APP.test(said);
    // A browser cannot start in the agent's own shell: its tests that open one go through run_checks.
    if (this.s.tools.includes('run_checks') && ABOUT_BROWSER.test(said) && !site) {
      did.push('A browser cannot start in your shell. To run tests that open a browser, call run_checks: squad-kit runs them where a browser can start.');
      plain.push(`The ${who} was stuck on a browser test. squad-kit told it how to run it.`);
    }
    if (ABOUT_PORT.test(said) && !site && this.s.inTheWay) {
      const settled = await this.s.inTheWay(said).catch(() => null);
      if (this.over) return error(STOPPED_CALL);
      if (settled) {
        did.push(settled);
        plain.push(`The ${who} was stuck because another program was in the way. squad-kit dealt with it.`);
      }
    }
    if (browser && ((ABOUT_BROWSER.test(said) && !site) || any)) {
      // A fresh browser; the old one closes in the background.
      const old = this.session;
      this.session = new BrowserSession(this.sessionOptions());
      void old.close();
      const r = await settleBy(this.session.browser(), by(clock, WAIT_SHARE), this.signal);
      if (this.over) return error(STOPPED_CALL);
      if (r === 'late') {
        did.push(BROWSER_STARTING);
        plain.push(`The ${who} was stuck on the screenshot browser. squad-kit is setting it up again.`);
      } else if ('ok' in r) {
        did.push("squad-kit's own browser works. Use take_screenshots and look_at_page for pictures and pages; do not start a browser yourself.");
        plain.push(`The ${who} was stuck on the screenshot browser. squad-kit started its own browser again, and it works.`);
      } else {
        this.s.log?.(`squad-kit's browser did not start for ${this.s.ticket}: ${shotsErrorDetail(r.err)}`);
        did.push(`squad-kit's own browser still does not start: ${shotsErrorDetail(r.err).slice(0, 400)}.`);
        plain.push(`The ${who} was stuck on the screenshot browser, and squad-kit could not fix it.`);
      }
    }
    if (this.s.phone && !site) {
      const r = await settleBy(this.s.phone.ready(), by(clock, WAIT_SHARE), this.signal);
      if (this.over) return error(STOPPED_CALL);
      if (r === 'late') {
        did.push(PHONE_STARTING);
        plain.push(`The ${who} was stuck on the phone. squad-kit is still getting it ready.`);
      } else if ('ok' in r) {
        did.push("squad-kit's phone works. Use take_screenshots and look_at_page for pictures and screens; never start a simulator, an emulator or a browser yourself.");
        plain.push(`The ${who} was stuck on the phone. squad-kit checked it, and it works.`);
      } else {
        did.push(`squad-kit's phone does not work: ${(r.err as Error)?.message ?? String(r.err)}`);
        plain.push(`The ${who} was stuck on the phone, and squad-kit could not fix it.`);
      }
    }
    if (app && (((ABOUT_APP.test(said) || ABOUT_PORT.test(said)) && !site) || any)) {
      const running = this.app && !this.app.ended?.() ? this.app : null;
      const answers = running ? await fetch(running.url, { signal: AbortSignal.timeout(3000) }).then((r) => r.status < 500).catch(() => false) : false;
      if (this.over) return error(STOPPED_CALL);
      if (running && answers) {
        did.push(`The app runs and answers at ${running.url}.`);
        plain.push(`The ${who} was stuck on the app. squad-kit checked it, and the app works.`);
      } else {
        // An app that does not answer is started again; one that is starting already is waited for.
        if (!this.starting) {
          this.app?.stop();
          this.hold(null);
        }
        const r = await this.ensureApp(by(clock, START_SHARE));
        if ('app' in r) {
          did.push(`squad-kit started the app again: it answers at ${r.app.url}.`);
          plain.push(`The ${who} was stuck starting the app. squad-kit restarted it.`);
        } else if (this.over) {
          return error(STOPPED_CALL);
        } else if (r.late) {
          did.push(STILL_STARTING);
          plain.push(`The ${who} was stuck starting the app. squad-kit is starting it again.`);
        } else {
          did.push(`squad-kit tried to start the app again, and it did not start.${this.s.tools.includes('app_status') ? ' app_status says why.' : ''}`);
          plain.push(`The ${who} was stuck starting the app, and squad-kit could not start it.`);
        }
      }
    }
    if (!did.length) {
      did.push('squad-kit noted it. Decide what you can yourself.');
      plain.push(`The ${who} was stuck on something technical. squad-kit noted it.`);
    }
    this.stuck.push({ what, why, did });
    for (const line of plain) this.s.say(line);
    this.s.log?.(`squad-kit tried for the ${who} on ${this.s.ticket}: ${did.join(' ')}`);
    return ok(`${did.join('\n')}\nIf it still does not work, carry on with what you can and say in your answer what is missing. Never ask the person about it.`);
  }

  /**
   * Saves a picture as the next free name in the proof folder: `<prefix>-<n>.png`. Pictures stay until the ticket
   * goes, so a name is never used twice (the board keeps pictures by name). Each file is made new and never written
   * through a link, so nothing outside the proof folder is written; a name anything already has is skipped.
   */
  private save(png: Buffer): string {
    fs.mkdirSync(this.s.proofDir, { recursive: true });
    for (let n = 1; n <= 10_000; n += 1) {
      const name = `${this.s.prefix}-${n}.png`;
      if (!this.pictures.has(name) && writeNew(path.join(this.s.proofDir, name), png)) return name;
    }
    throw new Error('squad-kit found no free name for the picture in the proof folder');
  }

  /**
   * The run ended: its key stops working, the window's own Stop fires, its browser closes and the app squad-kit
   * started stops. An app or a browser still starting stops as soon as it is up.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ctl.abort();
    await this.session.close();
    await this.s.phone?.close().catch(() => undefined);
    const app = this.app;
    this.hold(null);
    // Handed on to the next step that uses it (keep): it runs on, and is no longer this window's to stop.
    if (app && !app.ended?.() && this.s.keep?.(app)) return;
    app?.stop();
    this.s.app?.after?.();
  }

  /** What a stopped run says to engineers: every refusal. */
  refusalDetail(): string {
    return this.refusals.map((r) => `${r.tool}: ${r.why}`).join('\n');
  }

  /** What a step ended for its calls in the wrong shape says to engineers: each of them. */
  mistakeDetail(): string {
    return this.mistakes.map((m) => `${m.tool}: ${m.why}`).join('\n');
  }
}

/**
 * The tools a run gets: every tool for a step that works in the story's copy of an app, only Look at a page beside "I
 * am stuck" for a step that reads it (no pictures saved, no starting or stopping the app), the project's checks for a
 * step that builds in a copy with no app yet, else only "I am stuck".
 */
export function toolsFor(o: { app: boolean; look?: boolean; checks?: boolean; parts?: boolean }): WindowTool[] {
  if (o.app) return o.parts ? [...APP_TOOLS, 'run_checks', 'add_part', 'i_am_stuck'] : ALL_TOOLS;
  return [...(o.look ? (['look_at_page'] as const) : []), ...(o.checks ? (['run_checks'] as const) : []), ...(o.parts ? (['add_part'] as const) : []), 'i_am_stuck'];
}

/** One check's result, as the agent reads it. */
function checkAnswer(r: CheckRun): string {
  const none = r.name === 'test' && r.ok && testCount(r.output) === 0;
  return `${r.note ? `${r.note}\n` : ''}${r.name}${r.only ? ` (only ${r.only})` : ''}: ${r.ok ? (none ? 'passed, but it found no tests' : 'passed') : 'failed'} in ${Math.round(r.seconds)} seconds (${r.command}).\nThe last lines it printed:\n${tail(r.output, 30)}`;
}

/** Text the person never sees: a value cut for a log line. */
export function short(s: string, n = MAX_NAME): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

import fs from 'node:fs';
import { boardExists, readMeta, type BoardPaths } from '../../board/store.js';
import type { BoardMeta, Ticket } from '../../board/types.js';
import { squadHome } from '../../core/home.js';
import { computerReady, type ComputerReady } from '../computer-ready.js';
import { gitVersion } from '../git.js';
import { ACTION_DOING, ACTION_WORDS, CATALOG, KIND_WORDS, PLATFORM_WORDS, toolEntry, type Priority, type System, type ToolAction, type ToolEntry, type ToolId } from './catalog.js';
import { detectAll, foundFile, readFound, realHost, systemOf, writeFound, type DetectHost, type Found, type FoundBook } from './detect.js';
import { atLeast, PAIR_RULES, tooOld, updateRecommended } from './fit.js';
import { clearHalfGets, firstGuess, gettingNow, GetTrouble, lastTrouble, startGets, type Getting, type ToolSource } from './get.js';
import { acceptAndroid, androidAccepted, androidLicenses, freeBytes, roomTrouble, type License } from './android.js';
import { choosePhone, IPHONE_ONLY, type PhoneSystem } from './which-phone.js';
import { projectKinds, type PlaceKinds, type Platform } from './kinds.js';
import { kindsOfCommands } from '../find-commands.js';
import { reposOf } from '../repos.js';
import { usesAndroid } from '../android-env.js';
import { addUpdateLooks, flutterUpdateLook, startUpdate, updateGuess, updateWarning } from './update.js';

/**
 * What a project needs on this computer, for the Tools page and for the steps that need a tool: `projectTools` gives
 * the page's lines, `blockedBy` the Required tools missing or too old for one action, with the message and the link.
 * A story never fails over a missing tool: it waits with that message and goes on by itself once the tool is there.
 */

export type { ToolAction, ToolId } from './catalog.js';
export type { Getting } from './get.js';
export type { PhoneSystem } from './which-phone.js';

export type ToolState = 'ready' | 'missing' | 'too-old' | 'getting' | 'updating' | 'not-here';

export interface ToolLine {
  id: ToolId;
  name: string;
  gives: string;
  priority: Priority;
  state: ToolState;
  version?: string;
  /** Too old: the oldest version that works. */
  needs?: string;
  /** Too old by a pair of tools: why, "Xcode 27 needs it for iPhone builds". */
  why?: string;
  note?: string;
  /** Not on this computer: why, "needs a Mac". */
  notHere?: string;
  installer: 'squad-kit' | 'you';
  /** You install it: why squad-kit can't, in one line. */
  reason?: string;
  steps: string[];
  link: string;
  /** Where it is needed, in words: "Building, Checks, Phone pictures". */
  usedFor: string;
  actions: ToolAction[];
  /** The actions it stops now: a Required tool missing or too old for them. */
  blocks: ToolAction[];
  getting?: Getting;
  /** Why the last Get it or Update did not work. */
  trouble?: string;
  /** The terminal command for its button. */
  command: string;
  /** Too old, and squad-kit can update your copy safely: the warning to OK first, the usual time, and the command. */
  update?: { warning: string; seconds: number; command: string };
  /** Too old, and squad-kit can't update your copy: why, in one line. The steps say how to do it yourself. */
  cantUpdate?: string;
  /** Ready, and older than its makers recommend: the version they recommend. It stops nothing; the steps say how to update. */
  recommended?: string;
  /** Its maker's license comes first: whether you accepted it, and the command that shows it and asks. */
  license?: { accepted: boolean; command: string };
  /** squad-kit gets it: how much room it takes ("about 20 GB") and about how long the first time takes, in seconds. */
  size?: string;
  seconds?: number;
}

export interface ToolsView {
  system: System;
  /** When this computer's tools were last checked. */
  checkedAt: string | null;
  checking: boolean;
  /** What squad-kit found the project is made of, in one sentence. */
  summary: string;
  places: PlaceKinds[];
  lines: ToolLine[];
  getting: Getting | null;
}

export interface ToolBlock {
  action: ToolAction;
  tools: { id: ToolId; name: string; state: ToolState; version?: string; needs?: string }[];
  /** What can't happen, why, as one sentence: "squad-kit can't build this story yet: Flutter isn't on this computer." */
  text: string;
  /** The card's line while the story waits. */
  status: string;
  /** The line on the Tools page: "/tools#flutter". */
  link: string;
  /** Nothing is known yet: this computer is being checked. */
  checking?: true;
}

/* ── this computer's tools, kept and checked again ─────── */

let host: () => DetectHost = realHost;

/** Tests check a made-up computer. Null goes back to the real one. */
export function useDetectHost(h: DetectHost | null): void {
  host = h ? () => h : realHost;
  kept = null;
}

let kept: { file: string; mtime: number; book: FoundBook | null } | null = null;

/** What the last check found, read again only when its file changed. */
export function foundNow(): FoundBook | null {
  const file = foundFile();
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (kept?.file === file && kept.mtime === mtime) return kept.book;
  kept = { file, mtime, book: readFound() };
  return kept.book;
}

let running: Promise<FoundBook> | null = null;
let lastCheck = 0;

/** "Is your computer ready?" asks the AI tool its version, which takes a moment: the page's polls reuse it a minute. */
let readyKept: { at: number; value: ComputerReady } | null = null;
const READY_MS = 60_000;

function readyNow(): ComputerReady {
  if (!readyKept || Date.now() - readyKept.at > READY_MS) readyKept = { at: Date.now(), value: computerReady() };
  return readyKept.value;
}

/** Checks every tool on this computer again (Check again), and keeps what it found. One check at a time. */
export function checkTools(): Promise<FoundBook> {
  if (running) return running;
  // While squad-kit updates a tool, the checks never run it half way: the check after the update looks at everything.
  const asWas = gettingNow()?.step === 'update' ? foundNow() : null;
  if (asWas) return Promise.resolve(asWas);
  const home = squadHome();
  readyKept = null;
  running = (async () => {
    // A download cut off by a closed squad-kit left a folder: it goes now, unless one is running.
    if (!gettingNow()) clearHalfGets(home);
    // Whether squad-kit can update Flutter itself is looked at with the rest: a few short git commands that only read.
    const book = await addUpdateLooks(host(), await detectAll(host(), home));
    writeFound(book, home);
    kept = null;
    return book;
  })().finally(() => {
    running = null;
    lastCheck = Date.now();
  });
  return running;
}

/** How often squad-kit looks again by itself while a story waits for a tool. */
const LOOK_AGAIN_MS = 10 * 60_000;
/** A story looked at checks again, at most this often. */
const LOOKED_AT_MS = 60_000;

/** Checks again beside everything else, unless a check ran just now. */
export function checkSoon(within = LOOKED_AT_MS): void {
  if (running || Date.now() - lastCheck < within) return;
  void checkTools().catch(() => undefined);
}

/* ── the lines ──────────────────────────────────────────── */

const RANK: Record<Priority, number> = { required: 3, recommended: 2, optional: 1 };

/**
 * What a tool is to these places: its priority, what it is used for, and what it stops. With the phone an app for both
 * phones uses (`phone`), what only the other phone needs is Optional and stops nothing.
 */
function matches(e: ToolEntry, places: PlaceKinds[], phone?: PhoneSystem) {
  const needs = e.needs
    .filter((n) => n.kinds === 'any' || places.some((p) => (n.kinds as string[]).some((k) => p.kinds.includes(k as never)) && (!n.platform || p.platforms.includes(n.platform))))
    .map((n) => (phone && n.platform && n.platform !== 'web' && n.platform !== phone ? { ...n, priority: 'optional' as const } : n));
  if (!needs.length) return null;
  const priority = needs.reduce<Priority>((a, n) => (RANK[n.priority] > RANK[a] ? n.priority : a), 'optional');
  const uniq = (xs: ToolAction[]) => (Object.keys(ACTION_WORDS) as ToolAction[]).filter((a) => xs.includes(a));
  return { priority, actions: uniq(needs.flatMap((n) => n.for)), required: uniq(needs.filter((n) => n.priority === 'required').flatMap((n) => n.for)) };
}

function stepsOf(e: ToolEntry, system: System): string[] {
  return [...(e.steps?.[system] ?? e.steps?.all ?? [])];
}

/**
 * A copy that is too old, or older than recommended: the steps to update it, by the tool that looks after it; the install
 * steps when it has none.
 */
function updateStepsOf(e: ToolEntry, system: System, f: Found | undefined): string[] {
  const u = e.updateSteps;
  if (!u) return stepsOf(e, system);
  const by = f?.update?.managedBy ?? f?.managedBy;
  return [...((by ? u[by] : undefined) ?? u.all ?? stepsOf(e, system))];
}

/** Git and the AI tool, as "Is your computer ready?" sees them. */
function asToday(e: ToolEntry, ready: ComputerReady): Pick<ToolLine, 'state' | 'version' | 'needs' | 'note' | 'name'> {
  if (e.id === 'git') {
    const version = gitVersion() ?? undefined;
    if (ready.git.step === 'install-git') return { state: 'missing', name: e.name };
    if (ready.git.step === 'update-git') return { state: 'too-old', name: e.name, ...(version ? { version } : {}), needs: e.min! };
    return { state: 'ready', name: e.name, ...(version ? { version } : {}) };
  }
  const name = ready.tool.label ?? e.name;
  if (ready.tool.step === 'install-tool') return { state: 'missing', name };
  if (ready.tool.step === 'sign-in') return { state: 'missing', name, note: `${name} is here. Sign in once, and the squad can work.` };
  return { state: 'ready', name };
}

/** The lines for the places of a project, from what the last check found. Git and the AI tool need `ready`. */
export function linesFor(places: PlaceKinds[], book: FoundBook | null, system: System, ready?: ComputerReady, phone?: PhoneSystem): ToolLine[] {
  const platforms = new Set<Platform>(places.flatMap((p) => p.platforms));
  const versions = Object.fromEntries(Object.entries(book?.tools ?? {}).flatMap(([id, f]) => (f?.state === 'found' && f.version ? [[id, f.version]] : []))) as Partial<Record<ToolId, string>>;
  const getting = gettingNow();
  const out: ToolLine[] = [];
  for (const e of CATALOG) {
    const m = matches(e, places, phone);
    if (!m || (e.asToday && !ready)) continue;
    const base = {
      id: e.id,
      gives: e.gives,
      priority: m.priority,
      installer: e.installer,
      ...(e.installer === 'you' && e.why ? { reason: e.why } : {}),
      steps: stepsOf(e, system),
      link: e.link,
      usedFor: m.actions.map((a) => ACTION_WORDS[a]).join(', '),
      actions: m.actions,
      command: e.installer === 'squad-kit' ? `squad tools get ${e.id}` : 'squad tools check',
      ...(e.installer === 'squad-kit' ? { seconds: firstGuess(e.id), ...(e.size ? { size: e.size } : {}) } : {}),
      ...(e.license ? { license: { accepted: accepted(e.id), command: `squad tools accept ${e.id}` } } : {}),
    };
    let line: ToolLine;
    if (e.asToday) {
      line = { ...base, ...asToday(e, ready!), blocks: [] };
    } else {
      const f = book?.tools[e.id];
      const old = f?.state === 'found' ? tooOld(e.id, e.min, versions, platforms) : null;
      const mine = getting?.tool === e.id;
      const state: ToolState = mine ? (getting.step === 'update' ? 'updating' : 'getting') : !f || f.state === 'missing' ? 'missing' : f.state === 'not-here' ? 'not-here' : old ? 'too-old' : 'ready';
      // While squad-kit updates it, every step that needs it waits: the tool is half new until it is done.
      const blocks = state === 'ready' ? [] : state === 'too-old' ? m.required.filter((a) => !old?.for || old.for.includes(a)) : m.required;
      const trouble = lastTrouble(e.id);
      const olderCopy = state === 'too-old' || state === 'updating';
      // Ready, but older than its makers recommend: it stops nothing, and its line says so, with the steps to update it.
      const later = state === 'ready' ? updateRecommended(f?.version, e.recommended) : null;
      const look = e.update && state === 'too-old' ? f?.update : undefined;
      const seconds = look && !look.cant ? updateGuess(e.id) : 0;
      line = {
        ...base,
        ...((olderCopy || later) && e.updateSteps ? { steps: updateStepsOf(e, system, f) } : {}),
        name: e.name,
        state,
        ...(f?.version ? { version: f.version } : {}),
        ...(old ? { needs: old.needs, ...(old.why ? { why: old.why } : {}) } : {}),
        ...(later ? { recommended: later } : {}),
        ...(f?.note || e.note || later ? { note: [later ? `An update to ${later} or newer is recommended.` : '', f?.note, e.note].filter(Boolean).join(' ') } : {}),
        ...(state === 'not-here' && e.notHere ? { notHere: e.notHere } : {}),
        blocks,
        ...(mine ? { getting } : {}),
        ...(trouble && state !== 'ready' ? { trouble } : {}),
        ...(look && !look.cant ? { update: { warning: updateWarning(e, system, seconds), seconds, command: `squad tools update ${e.id}` } } : {}),
        ...(look?.cant ? { cantUpdate: look.cant } : {}),
      };
    }
    out.push(line);
  }
  return out;
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "This project has a Flutter app for iPhone, Android and web." */
export function projectWords(places: PlaceKinds[]): string {
  const parts = [
    ...new Set(
      places.flatMap((p) =>
        p.kinds.map((k) => {
          const phones = k === 'flutter' || k === 'react-native' ? p.platforms.map((x) => PLATFORM_WORDS[x]) : [];
          return `${KIND_WORDS[k]}${phones.length ? ` for ${list(phones)}` : ''}`;
        }),
      ),
    ),
  ];
  return parts.length ? `This project has ${list(parts)}.` : 'squad-kit found no app here that needs more than every project needs.';
}

function metaOf(bp: BoardPaths): BoardMeta | null {
  try {
    return boardExists(bp) ? readMeta(bp) : null;
  } catch {
    return null;
  }
}

/** The Tools page: what this project needs on this computer. The first time, it checks the computer first. */
export async function projectTools(bp: BoardPaths): Promise<ToolsView> {
  const places = projectKinds(bp.root, metaOf(bp));
  const book = foundNow() ?? (await checkTools());
  const system = book.system ?? systemOf();
  return {
    system,
    checkedAt: book.at ?? null,
    checking: Boolean(running),
    summary: projectWords(places),
    places,
    lines: linesFor(places, book, system, readyNow(), phoneSystem(bp, 'pictures') ?? undefined),
    getting: gettingNow(),
  };
}

/* ── what a block says ──────────────────────────────────── */

export const TOOLS_CHECKING = "Checking this computer's tools for this story";
const GOES_ON = (n: number) => `Goes on by itself once ${n === 1 ? "it's" : "they're"} there`;
const CANT_HERE = "It can't go on on this computer";

/** True for the card's line of a story that waits for a tool. */
export function waitsForTools(status: string | undefined): boolean {
  if (!status) return false;
  return status === TOOLS_CHECKING || (status.startsWith('Waits for ') && (/\. Goes on by itself once (?:it's|they're) there$/.test(status) || status.endsWith(`. ${CANT_HERE}`)));
}

/** "about 40 seconds left", "about 2 minutes left". */
function leftWords(seconds: number): string {
  return seconds < 90 ? `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds left` : `about ${Math.round(seconds / 60)} minutes left`;
}

/**
 * A block while squad-kit gets its own tools for it (Maestro, Java): the download's progress and its time left, so the
 * story says it as it goes. Null when that is not what it waits for.
 */
function gettingBlock(action: ToolAction, lines: ToolLine[]): ToolBlock | null {
  const g = gettingNow();
  if (!g || g.step === 'update' || !lines.length || !lines.every((l) => (l.state === 'getting' || l.state === 'missing') && l.installer === 'squad-kit') || !lines.some((l) => l.id === g.tool)) return null;
  const names = list(lines.map((l) => l.name));
  const pct = g.step === 'download' && g.total ? `${Math.min(99, Math.floor((g.done / g.total) * 100))}%, ` : g.step === 'unpack' ? 'unpacking, ' : '';
  const left = `${pct}${leftWords(g.secondsLeft)}`;
  return {
    action,
    tools: lines.map((l) => ({ id: l.id, name: l.name, state: l.state })),
    text: `squad-kit is getting ${names} now (${left}): it needs ${lines.length === 1 ? 'it' : 'them'} to ${ACTION_DOING[action]}.`,
    status: `Waits for ${names}, which squad-kit is getting now (${left}). ${GOES_ON(lines.length)}`,
    link: `/tools#${lines[0]!.id}`,
  };
}

export function blockOf(action: ToolAction, lines: ToolLine[]): ToolBlock {
  const getting = gettingBlock(action, lines);
  if (getting) return getting;
  const absent = lines.filter((l) => l.state === 'missing' || l.state === 'getting');
  const old = lines.filter((l) => l.state === 'too-old');
  const updating = lines.filter((l) => l.state === 'updating');
  const away = lines.filter((l) => l.state === 'not-here');
  const reasons = [
    ...(absent.length ? [`${list(absent.map((l) => l.name))} ${absent.length === 1 ? "isn't" : "aren't"} on this computer`] : []),
    ...old.map((l) => `${l.name}${l.version ? ` ${l.version}` : ''} is too old: it needs ${l.needs} or newer`),
    ...updating.map((l) => `squad-kit is updating ${l.name} now`),
    ...away.map((l) => `${l.name} ${toolEntry(l.id)?.notHere ?? "can't run on this computer"}`),
  ];
  const onlyAway = away.length === lines.length;
  const text = `squad-kit can't ${ACTION_DOING[action]} ${onlyAway ? 'on this computer' : 'yet'}: ${reasons.join('; ')}.`;
  const what = list([...absent.map((l) => l.name), ...[...old, ...updating].map((l) => `a newer ${l.name}`), ...away.map((l) => l.name)]);
  const status = onlyAway ? `Waits for ${what}, which ${away.length === 1 ? (toolEntry(away[0]!.id)?.notHere ?? 'needs another computer') : 'need another computer'}. ${CANT_HERE}` : `Waits for ${what} on this computer. ${GOES_ON(lines.length)}`;
  return {
    action,
    tools: lines.map((l) => ({ id: l.id, name: l.name, state: l.state, ...(l.version ? { version: l.version } : {}), ...(l.needs ? { needs: l.needs } : {}) })),
    text,
    status,
    link: `/tools#${lines[0]!.id}`,
  };
}

/* ── blocking an action ─────────────────────────────────── */

type StoryWhere = Pick<Ticket, 'parts' | 'repo' | 'worktree' | 'copies'>;

/** Reading a project's files is quick but not free: the kinds of the same places are kept a little while. */
const kindsKept = new Map<string, { at: number; places: PlaceKinds[] }>();
const KINDS_MS = 15_000;

function placesFor(bp: BoardPaths, meta: () => BoardMeta | null, story?: StoryWhere): PlaceKinds[] {
  const key = JSON.stringify([bp.root, story?.worktree ?? null, story?.parts ?? null, story?.repo ?? null, story?.copies?.map((c) => c.dir) ?? null]);
  const k = kindsKept.get(key);
  if (k && Date.now() - k.at < KINDS_MS) return k.places;
  const m = meta();
  const places = projectKinds(bp.root, m, story);
  // A new project with no files yet: its first story's saved commands say what kind of app it becomes.
  if (!places.length && m?.scan?.empty) {
    const k = kindsOfCommands(m.commands ?? {});
    if (k.kinds.length) places.push({ place: '.', ...k });
  }
  if (kindsKept.size > 200) kindsKept.clear();
  kindsKept.set(key, { at: Date.now(), places });
  return places;
}

/**
 * The Required tools missing or too old for an action, for the whole project or one story's parts, with the message
 * and the link; null when nothing stops it. It uses what the last check found and never waits for a check: with
 * nothing found yet, it says so and a check starts beside. Git and the AI tool are checked as today, never here.
 */
export function blockedBy(bp: BoardPaths, action: ToolAction, story?: StoryWhere, phone?: PhoneSystem): ToolBlock | null {
  // On a phone, only the chosen phone's tools count: an app for both phones never waits for the other one's.
  const system = PHONE_ACTIONS.includes(action) ? (phone ?? phoneSystem(bp, action, story) ?? undefined) : undefined;
  const all = placesFor(bp, () => metaOf(bp), story);
  const places = system ? all.map((p) => ({ ...p, platforms: p.platforms.filter((x) => x === system || x === 'web') })) : all;
  const needing = CATALOG.filter((e) => !e.asToday && matches(e, places)?.required.includes(action));
  if (!needing.length) return null;
  const book = foundNow();
  if (!book) {
    checkSoon(0);
    return { action, tools: [], text: `squad-kit is checking this computer's tools before it can ${ACTION_DOING[action]}.`, status: TOOLS_CHECKING, link: '/tools', checking: true };
  }
  const lines = linesFor(places, book, book.system).filter((l) => l.blocks.includes(action));
  if (!lines.length) return null;
  // While a story waits, squad-kit looks again by itself now and then, so it goes on once the tool is there.
  checkSoon(LOOK_AGAIN_MS);
  return blockOf(action, lines);
}

/* ── which phone ────────────────────────────────────────── */

const PHONE_ACTIONS: ToolAction[] = ['pictures', 'start-app', 'try-it'];

/**
 * The phone a project's app (or one story's) uses for an action: the one it builds for, or for an app for both, the
 * project's setting, else the iPhone on a Mac when the tools only the iPhone needs are ready, else Android
 * (which-phone.ts). Null when it builds for no phone.
 */
export function phoneSystem(bp: BoardPaths, action: ToolAction, story?: StoryWhere): PhoneSystem | null {
  const meta = metaOf(bp);
  const computer = foundNow()?.system ?? systemOf();
  for (const p of placesFor(bp, () => meta, story)) {
    const chosen = choosePhone(p, meta?.phone, computer, () => iphoneReady(bp, action, story));
    if (chosen) return chosen;
  }
  return null;
}

/** True when nothing only the iPhone needs stops this action: Xcode, its simulator, CocoaPods, or a Flutter too old for this Xcode. */
function iphoneReady(bp: BoardPaths, action: ToolAction, story?: StoryWhere): boolean {
  const b = blockedBy(bp, action, story, 'ios');
  if (!b) return true;
  if (b.checking) return true;
  const pairs = new Set(PAIR_RULES.filter((r) => r.platform === 'ios').map((r) => r.tool));
  return !b.tools.some((t) => IPHONE_ONLY.includes(t.id) || (t.state === 'too-old' && pairs.has(t.id)));
}

/** The action a squad step needs its tools for. */
const ACTION_OF: Record<string, ToolAction> = { build: 'build', unstick: 'build', test: 'checks' };

/** What a story about to take a step waits for, if anything: the live squad holds it with this. */
export function toolsHold(bp: BoardPaths, t: Ticket, phase: string): ToolBlock | null {
  const action = ACTION_OF[phase];
  return action ? (blockedBy(bp, action, t) ?? commandsBlock(bp, t, action)) : null;
}

/**
 * A build or a check whose own command builds an Android app (`flutter build apk`, `./gradlew assembleDebug`) needs
 * squad-kit's Android tools and Java 17 or newer, whatever kind of app the project is: it waits for them with the Tools
 * page's line while they are missing or too old.
 */
export function commandsBlock(bp: BoardPaths, t: Pick<Ticket, 'repo' | 'parts' | 'worktree' | 'copies'>, action: ToolAction): ToolBlock | null {
  if (action !== 'build' && action !== 'checks') return null;
  const meta = metaOf(bp);
  if (!meta) return null;
  const commands = reposOf(meta)
    .filter((r) => !t.repo || r.path === t.repo)
    .flatMap((r) => [r.commands.test, r.commands.lint, r.commands.build]);
  if (!commands.some((c) => usesAndroid(c))) return null;
  const book = foundNow();
  if (!book) return null;
  const places = placesFor(bp, () => meta, t).map((p) => ({ ...p, platforms: [...new Set([...p.platforms, 'android' as const])] }));
  const lines = linesFor(places.length ? places : [{ place: '.', kinds: ['android'], platforms: ['android'] }], book, book.system, undefined, 'android').filter((l) => (l.id === 'android' || l.id === 'java') && l.state !== 'ready');
  return lines.length ? blockOf(action, lines) : null;
}

/**
 * A story read for the board: when it waits for a tool, what it waits for, with the link (never saved). Looking at
 * the story checks the computer again beside, so it goes on soon after the tool is installed.
 */
export function toolWaitOf(bp: BoardPaths, t: Ticket, lookedAt = false): { toolWait?: ToolBlock } {
  if (!waitsForTools(t.status)) return {};
  if (lookedAt) checkSoon();
  // A phone app's pictures wait for its phone tools at the proof (engine/phone/plan.ts).
  const action = t.squad?.phase === 'proof' ? 'pictures' : (ACTION_OF[t.squad?.phase ?? ''] ?? 'build');
  const b = blockedBy(bp, action, t);
  return b ? { toolWait: b } : {};
}

/* ── Get it ─────────────────────────────────────────────── */

const fits = (e: ToolEntry | undefined, book: FoundBook | null): boolean => {
  const f = e ? book?.tools[e.id] : undefined;
  return Boolean(e && f?.state === 'found' && (!e.min || !f.version || atLeast(f.version, e.min)));
};

/**
 * Get it: squad-kit gets a tool of its own, and what it needs with it when this computer has none, beside everything
 * else. Each one is checked again once it is in, so its line turns Ready.
 */
export function getToolNow(id: string, opts: { source?: (id: ToolId) => Promise<ToolSource>; free?: number | null } = {}): Getting {
  const e = toolEntry(id);
  if (!e) throw new Error(`squad-kit knows no tool called "${id}". See them all: squad tools`);
  if (e.installer !== 'squad-kit') throw new Error(`squad-kit can't get ${e.name} itself: ${e.why ?? 'you install it'}. The Tools page shows the steps.`);
  const book = foundNow();
  if (book?.tools[e.id]?.state === 'not-here') throw new Error(`squad-kit can't get ${e.name} here: it ${e.notHere ?? "can't run on this computer"}.`);
  if (fits(e, book)) throw new Error(`${e.name}${book?.tools[e.id]?.version ? ` ${book.tools[e.id]!.version}` : ''} is here already, so there is nothing to get.`);
  // Its maker's license is the person's to accept: Get it waits for their Accept, and squad-kit never gives it.
  if (e.license && !accepted(e.id)) throw new Error(`Google's license for the ${e.name} needs your Accept first. Read it on the Tools page and press Accept, or run: squad tools accept ${e.id}`);
  if (e.size) {
    const trouble = roomTrouble(opts.free !== undefined ? opts.free : freeBytes(squadHome()));
    if (trouble) throw new Error(trouble);
  }
  const before = (e.before ?? []).filter((w) => !fits(toolEntry(w), book));
  const also = (e.with ?? []).filter((w) => !fits(toolEntry(w), book) && !before.includes(w));
  return startGets([...before, e.id, ...also], { ...(opts.source ? { source: opts.source } : {}), after: () => void checkTools().catch(() => undefined) });
}

/* ── Accept ─────────────────────────────────────────────── */

/** Whether the person accepted a tool's license. */
function accepted(id: ToolId): boolean {
  return id === 'android' ? Boolean(androidAccepted()) : true;
}

export interface LicenseView {
  tool: ToolId;
  name: string;
  /** Each license in full, as its maker gives it. */
  licenses: License[];
  accepted: boolean;
}

/** A tool's license, in full from its maker, for the person to read before Accept. */
export async function toolLicense(id: string, o: { fetch?: typeof fetch } = {}): Promise<LicenseView> {
  const e = toolEntry(id);
  if (!e) throw new Error(`squad-kit knows no tool called "${id}". See them all: squad tools`);
  if (!e.license) throw new Error(`${e.name} has no license to accept here.`);
  try {
    const licenses = await androidLicenses({ system: foundNow()?.system ?? systemOf(), ...(o.fetch ? { fetch: o.fetch } : {}) });
    return { tool: e.id, name: e.name, licenses, accepted: accepted(e.id) };
  } catch (err) {
    throw new Error(err instanceof GetTrouble ? err.message : `squad-kit could not read the license of the ${e.name}.`);
  }
}

/**
 * Accept: the person accepted the license they were shown. `ids` are the licenses they saw: each must be one the maker
 * gives now, so an Accept of an old or other text never counts.
 */
export async function acceptToolNow(id: string, ids: string[], o: { fetch?: typeof fetch } = {}): Promise<LicenseView> {
  const view = await toolLicense(id, o);
  const shown = view.licenses.filter((l) => ids.includes(l.id));
  if (!ids.length || shown.length !== view.licenses.length) throw new Error(`Read every license of the ${view.name} first, then press Accept.`);
  acceptAndroid(shown);
  return { ...view, accepted: true };
}

/* ── Update ─────────────────────────────────────────────── */

/**
 * Update Flutter: squad-kit runs the tool's own update on your copy, beside everything else, only when that is safe and
 * only with your OK, as the update reaches every project that uses it. It looks at the folder once more right before,
 * and checks the computer again once it is done, so the line turns Ready and a story waiting for it goes on.
 */
export async function updateToolNow(bp: BoardPaths, id: string, opts: { ok?: boolean } = {}): Promise<Getting> {
  const e = toolEntry(id);
  if (!e) throw new Error(`squad-kit knows no tool called "${id}". See them all: squad tools`);
  if (!e.update) throw new Error(`squad-kit can't update ${e.name} itself. The Tools page shows the steps.`);
  const l = (await projectTools(bp)).lines.find((x) => x.id === e.id);
  if (!l) throw new Error(`This project doesn't use ${e.name}, so squad-kit leaves it as it is.`);
  if (l.state === 'updating') throw new Error(`squad-kit is updating ${e.name} now.`);
  if (l.state === 'ready') throw new Error(`${e.name}${l.version ? ` ${l.version}` : ''} is new enough already, so there is nothing to update.`);
  if (l.state !== 'too-old') throw new Error(`${e.name} isn't on this computer, so there is nothing to update. The Tools page shows how to install it.`);
  if (l.cantUpdate) throw new Error(`${l.cantUpdate} The Tools page shows the steps.`);
  if (!l.update) throw new Error(`squad-kit has not looked at your ${e.name} folder yet. Press Check again, then try again.`);
  if (!opts.ok) throw new Error(`${l.update.warning} squad-kit updates it only after you say OK.`);
  // Looked at again right before: the folder may have changed since the last check.
  const f = foundNow()?.tools[e.id];
  const look = f ? await flutterUpdateLook(host(), f) : undefined;
  if (!f?.where || !look || look.cant) throw new Error(`${look?.cant ?? "squad-kit can't update it here: it could not look inside its folder."} The Tools page shows the steps.`);
  return startUpdate(e.id, f.where, { after: () => void checkTools().catch(() => undefined) });
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import {
  STUDIO_ID,
  VERSION_DIR,
  chatFile,
  checkedStudioId,
  componentFile,
  componentsDir,
  designSystemDir,
  designSystemFile,
  designSystemVersionDir,
  designSystemsDir,
  frameFile,
  screenDir,
  screenFile,
  screensDir,
  sketchDir,
  sketchFile,
  sketchesDir,
  studioLockFile,
  thumbnailFile,
  tokensFile,
  variantDir,
  variantMetaFile,
} from './studio-paths.js';

/**
 * The Studio's store (AB-128.1): sketches and design systems saved inside the project, in `.squad/studio/`, so the
 * team gets them through git the way it gets tickets. Every Studio save, read and delete goes through this module.
 *
 * Each item (one design system, one sketch) is its own folder of plain YAML, JSON and HTML. Versions (v1, v2 …) only
 * grow: a saved version is never written again, so every variant stays pickable. Each item is read back with a change
 * stamp made from its files; every change brings the stamp it last read and is refused with "Changed elsewhere,
 * reload" when the files have changed since (AB-129.1), here, in another tab, or through a git pull.
 */

/* ── Saved shapes ───────────────────────────────────────── */

/** `system.yaml`. */
interface SystemFile {
  name: string;
  default: boolean;
  /** The current version. */
  version: number;
}

/** `sketch.yaml`. */
interface SketchFile {
  name: string;
  designSystem: { id: string; version: number } | null;
  /** The frames each screen is drawn in: desktop, tablet, mobile … */
  frames: string[];
}

export const SCREEN_STATUSES = ['draft', 'ready'] as const;
export type ScreenStatus = (typeof SCREEN_STATUSES)[number];

/** `screen.yaml`. */
interface ScreenFile {
  name: string;
  order: number;
  status: ScreenStatus;
  /** The chosen variant's version, or null before the first one is drawn. */
  chosen: number | null;
}

/** `v1/meta.yaml` beside a variant's frames. */
interface VariantMetaFile {
  madeAt: string;
  /** Who drew it: a person or the AI Designer. */
  madeBy?: string;
  note?: string;
}

/* ── What a read gives back ─────────────────────────────── */

export interface DesignSystemVersion {
  version: number;
  tokens: Record<string, unknown>;
  /** Component id → its HTML. */
  components: Record<string, string>;
}

export interface DesignSystem {
  id: string;
  name: string;
  isDefault: boolean;
  /** The current version. */
  version: number;
  versions: DesignSystemVersion[];
  /** A fingerprint of every shared file in the folder; every change must bring the one it read. */
  stamp: string;
}

export interface ScreenVariant extends VariantMetaFile {
  version: number;
  /** Frame id → its HTML. */
  frames: Record<string, string>;
}

export interface SketchScreen {
  id: string;
  name: string;
  order: number;
  status: ScreenStatus;
  chosen: number | null;
  variants: ScreenVariant[];
}

export interface Sketch {
  id: string;
  name: string;
  designSystem: { id: string; version: number } | null;
  frames: string[];
  screens: SketchScreen[];
  stamp: string;
}

/** A file in `.squad/studio/` that could not be read (a merge both people changed, a broken edit). */
export interface BrokenStudioItem {
  kind: StudioKind;
  id: string;
  problem: string;
}

export interface StudioContents {
  designSystems: DesignSystem[];
  sketches: Sketch[];
  broken: BrokenStudioItem[];
}

export type StudioKind = 'design-system' | 'sketch';

export interface StudioItem {
  kind: StudioKind;
  id: string;
}

/* ── Files ──────────────────────────────────────────────── */

/** Names a save is still writing (`… .tmp`) and hidden files (.DS_Store) are not part of the Studio. */
function counts(name: string): boolean {
  return !name.startsWith('.') && !name.endsWith('.tmp');
}

function readYamlFile(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return yaml.load(text);
  } catch {
    throw problem(`The file ${file}`);
  }
}

function folders(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && counts(e.name))
    .map((e) => e.name)
    .sort();
}

/** The version folders in a folder, oldest first. */
function versionsIn(dir: string): number[] {
  return folders(dir)
    .map((name) => VERSION_DIR.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** The `<id>.html` files in a folder, by id. */
function htmlFiles(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const id = name.endsWith('.html') ? name.slice(0, -'.html'.length) : '';
    if (STUDIO_ID.test(id) && fs.statSync(path.join(dir, name)).isFile()) out[id] = fs.readFileSync(path.join(dir, name), 'utf8');
  }
  return out;
}

function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Every shared file in an item's folder, as paths inside it with `/`, sorted by name. */
function sharedFiles(dir: string, inside = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!counts(e.name)) continue;
    const rel = inside ? `${inside}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...sharedFiles(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * The change stamp of an item's folder: a short fingerprint of every shared file's name and text, sorted by name.
 * It comes from the files alone, so the same files give the same stamp on every computer, and any change (here, in
 * another tab, or through a git pull) gives a new one. Null when the item has no files.
 */
export function stampOfFolder(dir: string): string | null {
  const files = sharedFiles(dir);
  if (!files.length) return null;
  const h = createHash('sha1');
  for (const rel of files) h.update(`${rel}\n${sha1(fs.readFileSync(path.join(dir, ...rel.split('/'))))}\n`);
  return h.digest('hex').slice(0, 16);
}

export function studioItemDir(bp: BoardPaths, item: StudioItem): string {
  return item.kind === 'design-system' ? designSystemDir(bp, item.id) : sketchDir(bp, item.id);
}

/** The item's change stamp now, or null when it is not in the project. */
export function studioStamp(bp: BoardPaths, item: StudioItem): string | null {
  return stampOfFolder(studioItemDir(bp, item));
}

/**
 * Writes through a temp file, the way the store does, so a reader never sees half a file. A file whose text is
 * unchanged is left alone, so a save that changes nothing makes no change in git. Folders appear only here.
 */
function writeShared(file: string, text: string | Buffer): void {
  if (fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(text))) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Writes a whole new version folder (v1, v2 …) at once: its files go into a temp folder that is then renamed, so a
 * reader sees all of the version or none of it. A saved version is never written again.
 */
function writeNewVersion(dir: string, files: Record<string, string>): void {
  if (fs.existsSync(dir)) throw new Error(`${path.basename(dir)} is already saved, and a saved version never changes. Reload and save again.`);
  const tmp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const [file, text] of Object.entries(files)) {
      const inTmp = path.join(tmp, path.relative(dir, file));
      fs.mkdirSync(path.dirname(inTmp), { recursive: true });
      fs.writeFileSync(inTmp, text, 'utf8');
    }
    fs.mkdirSync(tmp, { recursive: true });
    fs.renameSync(tmp, dir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

function dumpYaml(data: unknown): string {
  return yaml.dump(JSON.parse(JSON.stringify(data)), { lineWidth: 110, noRefs: true });
}

/* ── The project's Studio lock ──────────────────────────── */

/** Longer than any Studio change takes: an older lock was left by a run that ended. */
const LOCK_LEFT_MS = 30_000;
/** How long a change waits for another one to finish. */
const LOCK_WAIT_MS = 5_000;
/** Locks this process holds now, so a change inside a change does not wait for itself. */
const holding = new Set<string>();

function lockLeftBehind(file: string): boolean {
  let held: { pid?: number; at?: string };
  try {
    held = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof held;
  } catch {
    // Being written right now, or gone: not left behind unless it is old.
    try {
      return Date.now() - fs.statSync(file).mtimeMs > LOCK_LEFT_MS;
    } catch {
      return false;
    }
  }
  if (!held.pid || (held.at && Date.now() - Date.parse(held.at) > LOCK_LEFT_MS)) return true;
  if (held.pid === process.pid) return !holding.has(file);
  try {
    process.kill(held.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Runs `fn` while holding the project's Studio lock, shared by the console and terminal commands. */
function holdStudio<T>(bp: BoardPaths, fn: () => T): T {
  const file = studioLockFile(bp);
  if (holding.has(file)) return fn();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (lockLeftBehind(file)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error('The Studio is saving something else right now. Try again in a moment.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  holding.add(file);
  try {
    return fn();
  } finally {
    holding.delete(file);
    fs.rmSync(file, { force: true });
  }
}

/* ── Reading ────────────────────────────────────────────── */

function problem(what: string): Error {
  return new Error(`${what} could not be read. Nothing is lost. An engineer can look at it.`);
}

function positive(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 1;
}

function readSystemFile(file: string): SystemFile {
  const raw = readYamlFile(file);
  if (!isPlain(raw) || typeof raw.name !== 'string' || !positive(raw.version)) throw problem(`The design system file ${file}`);
  return { name: raw.name, default: raw.default === true, version: raw.version };
}

function readSketchFile(file: string): SketchFile {
  const raw = readYamlFile(file);
  if (!isPlain(raw) || typeof raw.name !== 'string') throw problem(`The sketch file ${file}`);
  const ds = raw.designSystem;
  const designSystem = isPlain(ds) && typeof ds.id === 'string' && STUDIO_ID.test(ds.id) && positive(ds.version) ? { id: ds.id, version: ds.version } : null;
  const frames = Array.isArray(raw.frames) ? raw.frames.filter((f): f is string => typeof f === 'string' && STUDIO_ID.test(f)) : [];
  return { name: raw.name, designSystem, frames };
}

function readScreenFile(file: string): ScreenFile {
  const raw = readYamlFile(file);
  if (!isPlain(raw) || typeof raw.name !== 'string') throw problem(`The screen file ${file}`);
  return {
    name: raw.name,
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 0,
    status: (SCREEN_STATUSES as readonly unknown[]).includes(raw.status) ? (raw.status as ScreenStatus) : 'draft',
    chosen: positive(raw.chosen) ? raw.chosen : null,
  };
}

function readVariantMeta(file: string): VariantMetaFile {
  const raw = fs.existsSync(file) ? readYamlFile(file) : {};
  const meta: VariantMetaFile = { madeAt: isPlain(raw) && typeof raw.madeAt === 'string' ? raw.madeAt : '' };
  if (isPlain(raw) && typeof raw.madeBy === 'string') meta.madeBy = raw.madeBy;
  if (isPlain(raw) && typeof raw.note === 'string') meta.note = raw.note;
  return meta;
}

function readTokens(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw problem(`The tokens file ${file}`);
  }
  if (!isPlain(raw)) throw problem(`The tokens file ${file}`);
  return raw;
}

/** One design system with all its versions, or null when the project has none by that id. */
export function readDesignSystem(bp: BoardPaths, id: string): DesignSystem | null {
  const file = designSystemFile(bp, id);
  if (!fs.existsSync(file)) return null;
  const stamp = stampOfFolder(designSystemDir(bp, id));
  const system = readSystemFile(file);
  const versions = versionsIn(designSystemDir(bp, id)).map((version) => ({
    version,
    tokens: readTokens(tokensFile(bp, id, version)),
    components: htmlFiles(componentsDir(bp, id, version)),
  }));
  return { id, name: system.name, isDefault: system.default, version: system.version, versions, stamp: stamp ?? '' };
}

function readScreen(bp: BoardPaths, sketch: string, id: string): SketchScreen {
  const screen = readScreenFile(screenFile(bp, sketch, id));
  const variants = versionsIn(screenDir(bp, sketch, id)).map((version) => {
    const frames = htmlFiles(variantDir(bp, sketch, id, version));
    return { version, ...readVariantMeta(variantMetaFile(bp, sketch, id, version)), frames };
  });
  return { id, ...screen, variants };
}

/** One sketch with its screens and every variant, or null when the project has none by that id. */
export function readSketch(bp: BoardPaths, id: string): Sketch | null {
  const file = sketchFile(bp, id);
  if (!fs.existsSync(file)) return null;
  const stamp = stampOfFolder(sketchDir(bp, id));
  const sketch = readSketchFile(file);
  const screens = folders(screensDir(bp, id))
    .filter((s) => STUDIO_ID.test(s) && fs.existsSync(screenFile(bp, id, s)))
    .map((s) => readScreen(bp, id, s))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { id, ...sketch, screens, stamp: stamp ?? '' };
}

/** The ids of the items of one kind in the project. Reading never makes a folder. */
function idsIn(dir: string): string[] {
  return folders(dir).filter((id) => STUDIO_ID.test(id));
}

/** Every design system and sketch in the project, each with its change stamp. A file that cannot be read is listed in `broken`. */
export function readStudio(bp: BoardPaths): StudioContents {
  const out: StudioContents = { designSystems: [], sketches: [], broken: [] };
  for (const id of idsIn(designSystemsDir(bp))) {
    try {
      const ds = readDesignSystem(bp, id);
      if (ds) out.designSystems.push(ds);
    } catch (err) {
      out.broken.push({ kind: 'design-system', id, problem: (err as Error).message });
    }
  }
  for (const id of idsIn(sketchesDir(bp))) {
    try {
      const sk = readSketch(bp, id);
      if (sk) out.sketches.push(sk);
    } catch (err) {
      out.broken.push({ kind: 'sketch', id, problem: (err as Error).message });
    }
  }
  return out;
}

/* ── Changes ────────────────────────────────────────────── */

/** What a change says when the files changed since the caller read them (AB-129.1). */
export const CHANGED_ELSEWHERE = 'Changed elsewhere, reload';

/** A change brought an old stamp: someone else changed the item first. Nothing was written. */
export class StudioChangedElsewhere extends Error {
  constructor() {
    super(CHANGED_ELSEWHERE);
    this.name = 'StudioChangedElsewhere';
  }
}

const KIND_WORDS: Record<StudioKind, string> = { 'design-system': 'design system', sketch: 'sketch' };

/**
 * The one check every Studio change makes, saves, variant picks and later deletes alike. `stamp` is the one the
 * caller last read; null means a brand-new item, refused when the project already has one by that id.
 */
export function checkStudioStamp(bp: BoardPaths, item: StudioItem, stamp: string | null): void {
  const now = studioStamp(bp, item);
  if (stamp === null) {
    if (now !== null) throw new Error(`This project already has a ${KIND_WORDS[item.kind]} called "${item.id}". Reload to see it.`);
    return;
  }
  if (now !== stamp) throw new StudioChangedElsewhere();
}

/**
 * Runs one change to one item under the project's Studio lock: works out the stamp again, stops with "Changed
 * elsewhere, reload" before writing anything when it differs, then writes. Later Studio changes (delete, archive) go
 * through here too.
 */
export function changeStudioItem<T>(bp: BoardPaths, item: StudioItem, stamp: string | null, write: () => T): T {
  checkedStudioId(item.id);
  return holdStudio(bp, () => {
    checkStudioStamp(bp, item, stamp);
    return write();
  });
}

const MAX_NAME = 120;

function checkedName(name: unknown, what: string): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new Error(`Give the ${what} a name.`);
  if (n.length > MAX_NAME || /[\r\n]/.test(n)) throw new Error(`The ${what}'s name must be one line of up to ${MAX_NAME} letters.`);
  return n;
}

/** A short id from a name: "Checkout" → "checkout", "Order history" → "order-history". */
export function studioIdFor(name: string): string {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  // A name with no Latin letters (Arabic, Japanese …) still gets a short id that stays the same for the same name.
  return id || `item-${sha1(name).slice(0, 8)}`;
}

function checkedHtml(files: unknown, what: string): Record<string, string> {
  if (files === undefined) return {};
  if (!isPlain(files)) throw new Error(`The ${what} must be HTML by id.`);
  const out: Record<string, string> = {};
  for (const [id, html] of Object.entries(files)) {
    if (typeof html !== 'string') throw new Error(`The ${what} "${id.slice(0, 40)}" must be HTML text.`);
    out[checkedStudioId(id)] = html;
  }
  return out;
}

function checkedTokens(tokens: unknown): Record<string, unknown> {
  if (tokens === undefined) return {};
  if (!isPlain(tokens)) throw new Error('The design tokens must be named values (colours, fonts, spacing …).');
  return JSON.parse(JSON.stringify(tokens)) as Record<string, unknown>;
}

function tokensText(tokens: Record<string, unknown>): string {
  return `${JSON.stringify(tokens, null, 2)}\n`;
}

function sameHtml(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a).sort();
  return keys.join('\n') === Object.keys(b).sort().join('\n') && keys.every((k) => a[k] === b[k]);
}

export interface DesignSystemInput {
  /** Left out, it is made from the name. */
  id?: string;
  name: string;
  isDefault?: boolean;
  tokens?: Record<string, unknown>;
  /** Component id → its HTML. */
  components?: Record<string, string>;
}

/**
 * Saves a design system. With no stamp it is new: version 1 with its tokens and components. With the stamp the caller
 * read, its name and default are saved, and tokens or components that differ from the current version become the next
 * version; saved versions never change.
 */
export function saveDesignSystem(bp: BoardPaths, input: DesignSystemInput, stamp: string | null = null): DesignSystem {
  const name = checkedName(input.name, 'design system');
  const id = checkedStudioId(input.id ?? studioIdFor(name));
  const tokens = checkedTokens(input.tokens);
  const components = checkedHtml(input.components, 'component');
  return changeStudioItem(bp, { kind: 'design-system', id }, stamp, () => {
    const before = stamp === null ? null : readDesignSystem(bp, id);
    const current = before?.versions.find((v) => v.version === before.version);
    // Left out, the tokens or the components stay as the current version has them.
    const nextTokens = input.tokens === undefined && current ? current.tokens : tokens;
    const nextComponents = input.components === undefined && current ? current.components : components;
    const same = current !== undefined && tokensText(current.tokens) === tokensText(nextTokens) && sameHtml(current.components, nextComponents);
    let version = before?.version ?? 1;
    if (!same) {
      version = before ? Math.max(0, ...before.versions.map((v) => v.version)) + 1 : 1;
      const files: Record<string, string> = { [tokensFile(bp, id, version)]: tokensText(nextTokens) };
      for (const [c, html] of Object.entries(nextComponents)) files[componentFile(bp, id, version, c)] = html;
      writeNewVersion(designSystemVersionDir(bp, id, version), files);
    }
    const system: SystemFile = { name, default: input.isDefault ?? before?.isDefault ?? false, version };
    writeShared(designSystemFile(bp, id), dumpYaml(system));
    return readDesignSystem(bp, id)!;
  });
}

export interface ScreenInput {
  /** Left out, it is made from the name. */
  id?: string;
  name: string;
  order?: number;
  status?: ScreenStatus;
}

export interface SketchInput {
  /** Left out, it is made from the name. */
  id?: string;
  name: string;
  designSystem?: { id: string; version: number } | null;
  /** The frames each screen is drawn in: desktop, tablet, mobile … */
  frames: string[];
  /** Screens to add or rename, reorder and mark; a screen left out stays as it is. */
  screens?: ScreenInput[];
}

/**
 * Saves a sketch and its screens. With no stamp it is new. A new screen has no variant yet; its first one comes from
 * addVariant. A screen's chosen variant changes only through addVariant and pickVariant.
 */
export function saveSketch(bp: BoardPaths, input: SketchInput, stamp: string | null = null): Sketch {
  const name = checkedName(input.name, 'sketch');
  const id = checkedStudioId(input.id ?? studioIdFor(name));
  if (!Array.isArray(input.frames) || !input.frames.length) throw new Error('Give the sketch at least one frame, like desktop.');
  const frames = [...new Set(input.frames.map((f) => checkedStudioId(f)))];
  const ds = input.designSystem ?? null;
  if (ds) {
    checkedStudioId(ds.id);
    if (!Number.isInteger(ds.version) || ds.version < 1 || !fs.existsSync(tokensFile(bp, ds.id, ds.version))) {
      throw new Error(`This project has no design system "${ds.id}" version ${ds.version}.`);
    }
  }
  const screens = (input.screens ?? []).map((s, i) => {
    const screenName = checkedName(s.name, 'screen');
    const status = s.status ?? 'draft';
    if (!(SCREEN_STATUSES as readonly string[]).includes(status)) throw new Error(`A screen is ${SCREEN_STATUSES.join(' or ')}.`);
    return { id: checkedStudioId(s.id ?? studioIdFor(screenName)), name: screenName, order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : i + 1, status };
  });
  if (new Set(screens.map((s) => s.id)).size !== screens.length) throw new Error('Two screens in the sketch have the same name.');
  return changeStudioItem(bp, { kind: 'sketch', id }, stamp, () => {
    const sketch: SketchFile = { name, designSystem: ds ? { id: ds.id, version: ds.version } : null, frames };
    writeShared(sketchFile(bp, id), dumpYaml(sketch));
    for (const s of screens) {
      const file = screenFile(bp, id, s.id);
      const before = fs.existsSync(file) ? readScreenFile(file) : null;
      const screen: ScreenFile = { name: s.name, order: s.order, status: s.status, chosen: before?.chosen ?? null };
      writeShared(file, dumpYaml(screen));
    }
    return readSketch(bp, id)!;
  });
}

export interface VariantInput {
  /** Frame id → its HTML; every frame must be one of the sketch's frames. */
  frames: Record<string, string>;
  madeBy?: string;
  note?: string;
  /** Mark it as the chosen variant. The first variant of a screen is always chosen. */
  choose?: boolean;
}

function existingScreen(bp: BoardPaths, sketch: string, screen: string): ScreenFile {
  checkedStudioId(screen);
  const file = screenFile(bp, sketch, screen);
  if (!fs.existsSync(file)) throw new Error(`The sketch "${sketch}" has no screen "${screen}".`);
  return readScreenFile(file);
}

/** Adds a variant of a screen as its next version. Every earlier variant stays as it was. */
export function addVariant(bp: BoardPaths, sketch: string, screen: string, input: VariantInput, stamp: string): Sketch {
  checkedStudioId(sketch);
  const frames = checkedHtml(input.frames, 'frame');
  if (!Object.keys(frames).length) throw new Error('A variant needs at least one frame.');
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const allowed = readSketchFile(sketchFile(bp, sketch)).frames;
    const other = Object.keys(frames).find((f) => !allowed.includes(f));
    if (other) throw new Error(`The sketch "${sketch}" has no frame "${other}". Add it to the sketch first.`);
    const before = existingScreen(bp, sketch, screen);
    const version = Math.max(0, ...versionsIn(screenDir(bp, sketch, screen))) + 1;
    const meta: VariantMetaFile = { madeAt: new Date().toISOString() };
    if (typeof input.madeBy === 'string' && input.madeBy.trim()) meta.madeBy = input.madeBy.trim().slice(0, MAX_NAME);
    if (typeof input.note === 'string' && input.note.trim()) meta.note = input.note.trim();
    const files: Record<string, string> = { [variantMetaFile(bp, sketch, screen, version)]: dumpYaml(meta) };
    for (const [f, html] of Object.entries(frames)) files[frameFile(bp, sketch, screen, version, f)] = html;
    writeNewVersion(variantDir(bp, sketch, screen, version), files);
    if (input.choose || before.chosen === null) writeShared(screenFile(bp, sketch, screen), dumpYaml({ ...before, chosen: version }));
    return readSketch(bp, sketch)!;
  });
}

/** Marks one saved variant of a screen as the chosen one. The others stay, pickable later. */
export function pickVariant(bp: BoardPaths, sketch: string, screen: string, version: number, stamp: string): Sketch {
  checkedStudioId(sketch);
  return changeStudioItem(bp, { kind: 'sketch', id: sketch }, stamp, () => {
    const before = existingScreen(bp, sketch, screen);
    if (!versionsIn(screenDir(bp, sketch, screen)).includes(version)) throw new Error(`The screen "${screen}" has no variant ${version}.`);
    writeShared(screenFile(bp, sketch, screen), dumpYaml({ ...before, chosen: version }));
    return readSketch(bp, sketch)!;
  });
}

/* ── This computer's part: thumbnails and AI Designer chats ── */

/**
 * A thumbnail of one variant of a screen. It goes only into this computer's folder for the project, never into
 * `.squad/`, and is not part of any stamp: a teammate makes their own.
 */
export function saveThumbnail(bp: BoardPaths, sketch: string, screen: string, version: number, png: Buffer): string {
  existingScreen(bp, checkedStudioId(sketch), screen);
  if (!Buffer.isBuffer(png) || !png.length) throw new Error('The thumbnail is empty.');
  const file = thumbnailFile(bp, sketch, screen, version);
  writeShared(file, png);
  return file;
}

export function readThumbnail(bp: BoardPaths, sketch: string, screen: string, version: number): Buffer | null {
  const file = thumbnailFile(bp, sketch, screen, version);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

export interface StudioChat {
  /** What the chat is about, when it is about one screen. */
  screen?: string;
  messages: { role: 'person' | 'designer'; text: string; at?: string }[];
}

/** An AI Designer chat about a sketch. Like thumbnails, it stays on this computer and is not part of any stamp. */
export function saveChat(bp: BoardPaths, sketch: string, chat: string, contents: StudioChat): string {
  checkedStudioId(sketch);
  if (!fs.existsSync(sketchFile(bp, sketch))) throw new Error(`This project has no sketch "${sketch}".`);
  if (contents.screen !== undefined) checkedStudioId(contents.screen);
  if (!Array.isArray(contents.messages)) throw new Error('A chat is a list of messages.');
  const file = chatFile(bp, sketch, chat);
  writeShared(file, `${JSON.stringify(contents, null, 2)}\n`);
  return file;
}

export function readChat(bp: BoardPaths, sketch: string, chat: string): StudioChat | null {
  const file = chatFile(bp, sketch, chat);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StudioChat;
  } catch {
    return null;
  }
}

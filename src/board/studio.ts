import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import {
  chatFile,
  checkedStudioId,
  componentFile,
  designSystemFile,
  designSystemVersionDir,
  designSystemsDir,
  frameFile,
  screenDir,
  screenFile,
  sketchFile,
  thumbnailFile,
  tokensFile,
  variantDir,
  variantMetaFile,
} from './studio-paths.js';
import { dumpYaml, idsIn, plainFile, sha1, versionsIn, writeNewVersion, writeShared } from './studio-files.js';
import { holdStudio } from './studio-lock.js';
import {
  SCREEN_STATUSES,
  readDesignSystem,
  readScreenFile,
  readSketch,
  readSketchFile,
  studioStamp,
  type DesignSystem,
  type ScreenFile,
  type ScreenStatus,
  type Sketch,
  type SketchFile,
  type StudioItem,
  type StudioKind,
  type SystemFile,
  type VariantMetaFile,
} from './studio-read.js';

/**
 * The Studio's store (AB-128.2): sketches and design systems saved inside the project, in `.squad/studio/`, so the
 * team gets them through git the way it gets tickets. Every Studio save, read and delete goes through this module:
 * later Studio stories import from here only. Its parts: studio-paths.ts (every location, from BoardPaths),
 * studio-read.ts (the saved shapes, the reads and the default design system), studio-files.ts (listing, the change
 * stamp and writing) and studio-lock.ts (one change at a time per project).
 *
 * Each item (one design system, one sketch) is its own folder of plain YAML, JSON and HTML. Versions (v1, v2 …) only
 * grow: a saved version is never written again, so every variant stays pickable. Each item is read back with a change
 * stamp made from its files; every change brings the stamp it last read and is refused with "Changed elsewhere,
 * reload" when the files have changed since (AB-129.1), here, in another tab, or through a git pull.
 */

export {
  SCREEN_STATUSES,
  defaultDesignSystemOf,
  readDefaultDesignSystem,
  readDesignSystem,
  readSketch,
  readStudio,
  studioItemDir,
  studioStamp,
  type BrokenStudioItem,
  type DesignSystem,
  type DesignSystemVersion,
  type ScreenStatus,
  type ScreenVariant,
  type Sketch,
  type SketchScreen,
  type StudioContents,
  type StudioItem,
  type StudioKind,
} from './studio-read.js';
export { stampOfFolder } from './studio-files.js';

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
  tokens?: Record<string, unknown>;
  /** Component id → its HTML. */
  components?: Record<string, string>;
}

/** Another design system is already saved in the project, readable or not. */
function otherDesignSystemSaved(bp: BoardPaths, id: string): boolean {
  return idsIn(designSystemsDir(bp)).some((other) => other !== id && plainFile(designSystemFile(bp, other)));
}

/**
 * Saves a design system. With no stamp it is new: version 1 with its tokens and components, marked default only when
 * no other design system is saved yet (AB-158.1). With the stamp the caller read, its name is saved, and tokens or
 * components that differ from the current version become the next version; saved versions never change, and the
 * default mark and the made time stay as they were.
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
    const system: SystemFile = before
      ? { name, default: before.markedDefault, version, madeAt: before.madeAt || new Date().toISOString() }
      : { name, default: !otherDesignSystemSaved(bp, id), version, madeAt: new Date().toISOString() };
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
    if (!Number.isInteger(ds.version) || ds.version < 1 || !plainFile(tokensFile(bp, ds.id, ds.version))) {
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
      const before = plainFile(file) ? readScreenFile(file) : null;
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
  if (!plainFile(file)) throw new Error(`The sketch "${sketch}" has no screen "${screen}".`);
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
  if (!plainFile(sketchFile(bp, sketch))) throw new Error(`This project has no sketch "${sketch}".`);
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

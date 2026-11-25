import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import {
  STUDIO_ID,
  componentsDir,
  designSystemDir,
  designSystemFile,
  designSystemsDir,
  screenDir,
  screenFile,
  screensDir,
  sketchDir,
  sketchFile,
  sketchesDir,
  tokensFile,
  variantDir,
  variantMetaFile,
} from './studio-paths.js';
import { folders, htmlFiles, idsIn, plainDir, plainFile, problem, readYamlFile, stampOfFolder, versionsIn } from './studio-files.js';

/**
 * The Studio's saved shapes and its reads (AB-128.2). Later stories import these through studio.ts, the one Studio
 * module. Reading never writes a file and never makes a folder (AB-127.1).
 */

/* ── Saved shapes ───────────────────────────────────────── */

/** `system.yaml`. */
export interface SystemFile {
  name: string;
  /** The default mark (AB-158.1): written only on the first design system made in the project, never moved by a save. */
  default: boolean;
  /** The current version. */
  version: number;
  /** When it was made, for working out the default when there are none or several marked. */
  madeAt: string;
}

/** `sketch.yaml`. */
export interface SketchFile {
  name: string;
  designSystem: { id: string; version: number } | null;
  /** The frames each screen is drawn in: desktop, tablet, mobile … */
  frames: string[];
}

export const SCREEN_STATUSES = ['draft', 'ready'] as const;
export type ScreenStatus = (typeof SCREEN_STATUSES)[number];

/** `screen.yaml`. */
export interface ScreenFile {
  name: string;
  order: number;
  status: ScreenStatus;
  /** The chosen variant's version, or null before the first one is drawn. */
  chosen: number | null;
}

/** `v1/meta.yaml` beside a variant's frames. */
export interface VariantMetaFile {
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
  /**
   * What its own system.yaml says. Two can be marked after a merge, or none after a hand edit: the project's one
   * default is worked out by defaultDesignSystemOf, never by this alone.
   */
  markedDefault: boolean;
  /** The current version. */
  version: number;
  madeAt: string;
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
  /** The project's one default design system's id, worked out on read (AB-158.1), or null when it has none. */
  defaultDesignSystem: string | null;
  sketches: Sketch[];
  broken: BrokenStudioItem[];
}

export type StudioKind = 'design-system' | 'sketch';

export interface StudioItem {
  kind: StudioKind;
  id: string;
}

/* ── Stamps ─────────────────────────────────────────────── */

export function studioItemDir(bp: BoardPaths, item: StudioItem): string {
  return item.kind === 'design-system' ? designSystemDir(bp, item.id) : sketchDir(bp, item.id);
}

/** The item's change stamp now, or null when it is not in the project. */
export function studioStamp(bp: BoardPaths, item: StudioItem): string | null {
  return stampOfFolder(studioItemDir(bp, item));
}

/* ── Reading ────────────────────────────────────────────── */

function positive(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 1;
}

/** A time as written: squad-kit writes text, and a time typed without quotes reads back as a date. */
function timeText(x: unknown): string {
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? '' : x.toISOString();
  return typeof x === 'string' ? x : '';
}

function readSystemFile(file: string): SystemFile {
  const raw = readYamlFile(file);
  if (!isPlain(raw) || typeof raw.name !== 'string' || !positive(raw.version)) throw problem(`The design system file ${file}`);
  return { name: raw.name, default: raw.default === true, version: raw.version, madeAt: timeText(raw.madeAt) };
}

export function readSketchFile(file: string): SketchFile {
  const raw = readYamlFile(file);
  if (!isPlain(raw) || typeof raw.name !== 'string') throw problem(`The sketch file ${file}`);
  const ds = raw.designSystem;
  const designSystem = isPlain(ds) && typeof ds.id === 'string' && STUDIO_ID.test(ds.id) && positive(ds.version) ? { id: ds.id, version: ds.version } : null;
  const frames = Array.isArray(raw.frames) ? raw.frames.filter((f): f is string => typeof f === 'string' && STUDIO_ID.test(f)) : [];
  return { name: raw.name, designSystem, frames };
}

export function readScreenFile(file: string): ScreenFile {
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
  const raw = plainFile(file) ? readYamlFile(file) : {};
  const meta: VariantMetaFile = { madeAt: isPlain(raw) ? timeText(raw.madeAt) : '' };
  if (isPlain(raw) && typeof raw.madeBy === 'string') meta.madeBy = raw.madeBy;
  if (isPlain(raw) && typeof raw.note === 'string') meta.note = raw.note;
  return meta;
}

function readTokens(file: string): Record<string, unknown> {
  if (!plainFile(file)) return {};
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
  // A link to a folder or a file is not part of the Studio: the stamp leaves it out, so a read does too.
  if (!plainDir(designSystemDir(bp, id)) || !plainFile(file)) return null;
  const stamp = stampOfFolder(designSystemDir(bp, id));
  const system = readSystemFile(file);
  const versions = versionsIn(designSystemDir(bp, id)).map((version) => ({
    version,
    tokens: readTokens(tokensFile(bp, id, version)),
    components: htmlFiles(componentsDir(bp, id, version)),
  }));
  return { id, name: system.name, markedDefault: system.default, version: system.version, madeAt: system.madeAt, versions, stamp: stamp ?? '' };
}

/** A made time to compare: one that cannot be read counts as made last. */
function madeTime(madeAt: string): number {
  const t = Date.parse(madeAt);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * The project's one default design system (AB-158.1): the oldest one marked default; when none is marked, the oldest
 * one; on equal times, the lower id. It holds on any files git brings in, such as two teammates' first design systems
 * merged into one project, and it only reads: nothing is written to settle a tie.
 */
export function defaultDesignSystemOf(systems: Pick<DesignSystem, 'id' | 'markedDefault' | 'madeAt'>[]): string | null {
  const marked = systems.filter((s) => s.markedDefault);
  const pool = marked.length ? marked : systems;
  const oldest = [...pool].sort((a, b) => madeTime(a.madeAt) - madeTime(b.madeAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return oldest?.id ?? null;
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
  if (!plainDir(sketchDir(bp, id)) || !plainFile(file)) return null;
  const stamp = stampOfFolder(sketchDir(bp, id));
  const sketch = readSketchFile(file);
  const screens = folders(screensDir(bp, id))
    .filter((s) => STUDIO_ID.test(s) && plainFile(screenFile(bp, id, s)))
    .map((s) => readScreen(bp, id, s))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { id, ...sketch, screens, stamp: stamp ?? '' };
}

/**
 * Every design system and sketch in the project, each with its change stamp, and the one default design system. A file
 * that cannot be read is listed in `broken`. Reading writes nothing and makes no folder.
 */
export function readStudio(bp: BoardPaths): StudioContents {
  const out: StudioContents = { designSystems: [], defaultDesignSystem: null, sketches: [], broken: [] };
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
  out.defaultDesignSystem = defaultDesignSystemOf(out.designSystems);
  return out;
}

/** The project's default design system's id, the same answer readStudio gives, for later stories (a new sketch, "Make default", delete). */
export function readDefaultDesignSystem(bp: BoardPaths): string | null {
  const systems: DesignSystem[] = [];
  for (const id of idsIn(designSystemsDir(bp))) {
    try {
      const ds = readDesignSystem(bp, id);
      if (ds) systems.push(ds);
    } catch {
      // A design system that cannot be read is not the default; readStudio lists it as broken.
    }
  }
  return defaultDesignSystemOf(systems);
}

import path from 'node:path';
import { boardExists, readMeta, type BoardPaths } from '../../board/store.js';
import type { BoardMeta, Ticket } from '../../board/types.js';
import { shotPhone } from '../../modules/registry.js';
import { readFound, ownTool } from '../tools/detect.js';
import { blockedBy, checkTools, getToolNow, type ToolBlock } from '../tools/index.js';
import { gettingNow, lastTrouble, type ToolSource } from '../tools/get.js';
import { toolEntry, type ToolId } from '../tools/catalog.js';
import { kindsOf, placesOf } from '../tools/kinds.js';
import type { PhoneKind } from './build.js';
import { appLanguages } from './languages.js';
import type { TapTools } from './session.js';

/**
 * How a story's pictures are taken: on squad-kit's own iPhone when its app is an iPhone app (Flutter, React Native or
 * native) and the tools for it are ready; else of the app's web version, when it has one, said on the story in one
 * plain line; else none, and the story waits with the reason until the tools are there. It never fails a story over a
 * missing tool. A project that is not a phone app keeps its browser pictures as before.
 */

export type PicturesWay =
  | { way: 'phone'; kind: PhoneKind; dir: string; tools: TapTools }
  | { way: 'web'; line: string; link: string }
  | { way: 'wait'; block: ToolBlock; getting?: true }
  | { way: 'browser' };

/** What the web version's pictures are labelled with on a phone project. */
export const WEB_VERSION = 'Web version';

type StoryWhere = Pick<Ticket, 'parts' | 'repo' | 'worktree' | 'copies'>;

function metaOf(bp: BoardPaths): BoardMeta | null {
  try {
    return boardExists(bp) ? readMeta(bp) : null;
  } catch {
    return null;
  }
}

/** The story's iPhone app: the folder (in its copy, when it has one) and its kind. Null when it has none. */
export function iphoneApp(bp: BoardPaths, story?: StoryWhere): { dir: string; kind: PhoneKind } | null {
  for (const p of placesOf(bp.root, metaOf(bp), story)) {
    const k = kindsOf(p.dir);
    if (k.kinds.includes('flutter') && k.platforms.includes('ios')) return { dir: p.dir, kind: 'flutter' };
    if (k.kinds.includes('react-native') && k.platforms.includes('ios')) return { dir: p.dir, kind: 'react-native' };
    if (k.kinds.includes('ios')) return { dir: p.dir, kind: 'ios' };
  }
  return null;
}

/** Maestro and the Java it runs on: squad-kit's own copies first, else the person's own Maestro the last check found. */
export function tapTools(): TapTools | null {
  const own = ownTool('maestro');
  const found = readFound()?.tools.maestro;
  const maestro = own?.binary ?? (found?.state === 'found' && found.where ? found.where : null);
  if (!maestro) return null;
  const java = ownTool('java');
  // squad-kit's own Java: its program is <home>/bin/java, and Maestro is given that home.
  const javaHome = java ? path.dirname(path.dirname(java.binary)) : undefined;
  return { maestro, ...(javaHome ? { javaHome } : {}) };
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * The story's one plain line when it took pictures of the web version: "iPhone pictures need Xcode. squad-kit took
 * pictures of the web version meanwhile."
 */
export function webLine(block: ToolBlock): string {
  const word = shotPhone().words.phone;
  const away = block.tools.filter((x) => x.state === 'not-here');
  // The simulator comes with Xcode: with Xcode missing, Xcode is the one thing to get.
  const xcode = block.tools.some((x) => x.id === 'xcode' && x.state === 'missing');
  const tools = block.tools.filter((x) => !(xcode && x.id === 'simulator'));
  const needs = away.length ? 'a Mac' : list(tools.map((x) => (x.state === 'too-old' || x.state === 'updating' ? `a newer ${x.name}` : x.name)));
  return `${word} pictures need ${needs || 'more tools'}. squad-kit took pictures of the web version meanwhile.`;
}

/**
 * How this story's pictures are taken now. `web` says whether the project can start its web version (a start command
 * and an address). With nothing known about this computer yet, it is checked first.
 */
/* ── squad-kit's own tools, got by itself ───────────────── */

let source: ((id: ToolId) => Promise<ToolSource>) | undefined;

/** Tests get from a made-up source, never the internet. Null goes back to the official one. */
export function useGetSource(fn: ((id: ToolId) => Promise<ToolSource>) | null): void {
  source = fn ?? undefined;
}

/**
 * squad-kit gets its own tools for the phone pictures (Maestro, and Java for it) by itself the first time they are
 * needed, with the same Get as the Tools page: only when they are all that is missing, so Xcode is ready, and never
 * again by itself after a try that did not work (the Tools line then says why, with Get it). True while it gets them.
 */
export function getOwnTools(block: ToolBlock): boolean {
  // Tests never get anything from the internet: only from the made-up source they give (useGetSource).
  if (process.env.SQUAD_KIT_NO_AUTO_GET === '1' && !source) return false;
  if (block.checking || !block.tools.length) return false;
  if (!block.tools.every((x) => toolEntry(x.id)?.installer === 'squad-kit' && (x.state === 'missing' || x.state === 'getting'))) return false;
  const now = gettingNow();
  if (now) return block.tools.some((x) => x.id === now.tool);
  if (block.tools.some((x) => lastTrouble(x.id))) return false;
  // Maestro brings Java with it when this computer has none.
  const first = block.tools.find((x) => x.id === 'maestro') ?? block.tools[0]!;
  try {
    getToolNow(first.id, source ? { source } : {});
    return true;
  } catch {
    return Boolean(gettingNow());
  }
}

/** Waits while squad-kit gets its own tools for the phone, at most `ms`; a Stop ends the wait. */
export async function untilGot(signal?: AbortSignal, ms = 20 * 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (gettingNow() && Date.now() < until && !signal?.aborted) await new Promise((r) => setTimeout(r, 1000));
}

export async function picturesWay(bp: BoardPaths, story: StoryWhere, web: boolean): Promise<PicturesWay> {
  const app = iphoneApp(bp, story);
  if (!app) return { way: 'browser' };
  let block = blockedBy(bp, 'pictures', story);
  if (block?.checking) {
    await checkTools().catch(() => undefined);
    block = blockedBy(bp, 'pictures', story);
  }
  // Only squad-kit's own tools are missing: it gets them now, and the pictures wait for that short download.
  if (block && getOwnTools(block)) return { way: 'wait', block: blockedBy(bp, 'pictures', story) ?? block, getting: true };
  const tools = block ? null : tapTools();
  if (!block && tools && !shotPhone().notHere()) return { way: 'phone', ...app, tools };
  // Ready by the tools' own lines, but no Maestro squad-kit can run: it counts as missing.
  const why: ToolBlock = block ?? { action: 'pictures', tools: [{ id: 'maestro', name: 'Maestro', state: 'missing' }], text: "squad-kit can't take the phone pictures yet: Maestro isn't on this computer.", status: 'Waits for Maestro on this computer. Goes on by itself once it\'s there', link: '/tools#maestro' };
  if (web) return { way: 'web', line: webLine(why), link: why.link };
  return { way: 'wait', block: why };
}

/**
 * The tools a story waits for before its pictures: those squad-kit gets by itself, while it gets them, and the others
 * when they are missing and it has no web version to show meanwhile. Null otherwise.
 */
export function picturesHold(bp: BoardPaths, story: StoryWhere, web: boolean): ToolBlock | null {
  if (!iphoneApp(bp, story)) return null;
  const block = blockedBy(bp, 'pictures', story);
  if (!block) return null;
  if (getOwnTools(block)) return blockedBy(bp, 'pictures', story) ?? block;
  return web ? null : block;
}

/* ── Start and Try it yourself on the phone ───────────── */

/** Start in Your apps, or Try it yourself, on squad-kit's iPhone: whether they can, and what with. */
export interface PhoneStartPlan {
  /** The iPhone app's folder in the project, or in the story's copy. */
  dir: string;
  kind: PhoneKind;
  /** The tools for it are here: Start opens it on the iPhone. */
  ready: boolean;
  /** Why not, in one plain sentence, with the Tools page line. */
  why?: string;
  link?: string;
  /** The languages to pick from next to Start (English first); empty when there is nothing to pick. */
  languages: string[];
}

/** How Start (or Try it yourself) can open the app on squad-kit's iPhone. Null when it is no iPhone app. */
export function phoneStartPlan(bp: BoardPaths, action: 'start-app' | 'try-it', story?: StoryWhere): PhoneStartPlan | null {
  const app = iphoneApp(bp, story);
  if (!app) return null;
  const languages = appLanguages(app.dir, app.kind);
  const notHere = shotPhone().notHere();
  if (notHere) return { ...app, ready: false, why: notHere, link: '/tools#xcode', languages };
  const block = blockedBy(bp, action, story);
  return { ...app, ready: !block, ...(block ? { why: block.text, link: block.link } : {}), languages };
}

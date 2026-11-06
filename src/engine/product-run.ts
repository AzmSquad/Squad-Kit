import fs from 'node:fs';
import path from 'node:path';
import { partsOf, partsToRun } from '../board/parts.js';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { BoardMeta, ProductPart, RepoInfo, Ticket } from '../board/types.js';
import { AddressTaken, CHECK_SILENT_MS, runCommand, startApp, tail, type RunningApp } from './checks.js';
import { DOCKER_STOP_MS, DOCKER_WAIT_MS, composeRun, dockerGuard } from './compose-run.js';
import { copiesOf } from './copies.js';
import { fillOwnCopy } from './local-files.js';
import { leaveProduct, waitForProduct, type HoldKind, type ProductHold } from './product-lock.js';
import { dockerBlockedWords, guardSupport, ticketGuard, type GuardSpec } from './project-guard.js';
import { repoFor, reposOf } from './repos.js';
import { SETUP_MS, dependencyPrint, updateCopy } from './run-app.js';

/**
 * The whole product, for a story. Everything a story's change touches runs together, each part on its usual address: the
 * parts the story changed from its own copies, the others from a copy of the newest main. Those use the values kept for
 * stories too, never the person's own. A project with one part starts its one app as it always did.
 */

/** A part squad-kit starts, and where. */
export interface ProductPlace {
  part: ProductPart;
  repo: RepoInfo;
  dir: string;
  start: string;
  url: string;
  /** In the story's own copy, not the copy of main. */
  fromStory: boolean;
}

export interface ProductPlan {
  places: ProductPlace[];
  /** The part a person opens: nothing else here relies on it. The one squad-kit takes pictures of. */
  front?: ProductPlace;
  /** Why it cannot run yet, in words for the person. */
  why?: string;
}

export class ProductError extends Error {
  constructor(
    message: string,
    /** The exact words, for engineers. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** squad-kit's own copy of main for a repo a story did not change. Not the one Your apps runs: this one has the story values. */
export function mainCopyDir(bp: BoardPaths, repo: string): string {
  return path.join(productCopiesDir(bp), repo.replace(/[^\w.-]+/g, '-'));
}

export const productCopiesDir = (bp: BoardPaths): string => path.join(bp.localDir, 'product');

/** The parts a story changed: what the Architect named, else the parts in its repo. */
function changedParts(meta: BoardMeta, t: Ticket): string[] {
  if (t.parts?.length) return t.parts;
  const repo = repoFor(meta, t).path;
  return partsOf(meta).filter((p) => p.repo === repo).map((p) => p.id);
}

export function productPlan(bp: BoardPaths, meta: BoardMeta, t: Ticket): ProductPlan {
  const copies = copiesOf(meta, t);
  const parts = partsToRun(meta, changedParts(meta, t));
  const places: ProductPlace[] = [];
  for (const part of parts) {
    const repo = reposOf(meta).find((r) => r.path === part.repo);
    // Two parts in one repo start together, from the repo's one command.
    if (!repo || places.some((p) => p.repo.path === repo.path)) continue;
    const start = repo.commands.start?.trim();
    const url = (repo.commands.url ?? part.url)?.trim();
    if (!start) return { places: [], why: `squad-kit does not know how to start ${part.name} yet. An engineer can set it in Settings.` };
    if (!url) return { places: [], why: `squad-kit does not know the address of ${part.name} yet. An engineer can set it in Settings.` };
    const copy = copies.find((c) => c.repo.path === repo.path);
    places.push({ part, repo, dir: copy?.dir ?? mainCopyDir(bp, repo.path), start, url, fromStory: Boolean(copy) });
  }
  const needed = new Set(places.flatMap((p) => p.part.needs));
  const tops = places.filter((p) => !needed.has(p.part.id));
  const changed = changedParts(meta, t);
  return { places, ...(places.length ? { front: tops.find((p) => changed.includes(p.part.id)) ?? tops[0] ?? places.at(-1)! } : {}) };
}

const guardOf = (bp: BoardPaths, t: Ticket, dir: string): GuardSpec | undefined => {
  if (!guardSupport().on) return undefined;
  const allow = readMeta(bp).guard;
  return ticketGuard(bp, { cwd: dir, id: t.id, ...(allow ? { allow } : {}) });
};

/** A repo's copy of the newest main, with its own values and what it needs installed. */
async function readyMainCopy(bp: BoardPaths, t: Ticket, place: ProductPlace, signal?: AbortSignal): Promise<void> {
  const { dir, repo } = place;
  const { commit, fresh } = updateCopy(bp.root, repo, dir);
  fillOwnCopy(bp, repo.path, dir);
  const setup = repo.commands.setup?.trim();
  if (!setup) return;
  const print = dependencyPrint(dir, commit);
  const mark = `${dir}.setup`;
  if (!fresh && fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === print) return;
  const guard = guardOf(bp, t, dir);
  const r = await runCommand(dir, setup, SETUP_MS, { silentMs: CHECK_SILENT_MS, ...(signal ? { signal } : {}), ...(guard ? { guard } : {}) });
  if (!r.ok) throw new ProductError(dockerBlockedWords(r.output, guard) ?? `squad-kit could not set up ${place.part.name}.`, `${setup}\n${tail(r.output, 30)}`);
  // A setup can write the same files, like cp .env.example .env.dev: the values kept for stories go back over them.
  fillOwnCopy(bp, repo.path, dir);
  fs.writeFileSync(mark, print);
}

/** What runs for each holder of the running product. */
const running = new Map<string, { app: RunningApp; repo: string }[]>();
const keyOf = (bp: BoardPaths, holder: string) => `${bp.root}\n${holder}`;

/** Stops all of it, and lets the next one have the product. */
export function stopProduct(bp: BoardPaths, holder: string): void {
  const key = keyOf(bp, holder);
  for (const { app } of running.get(key) ?? []) app.stop();
  running.delete(key);
  leaveProduct(bp, holder);
}

export interface ProductStart {
  signal?: AbortSignal;
  /** Who holds the product now: this run waits, and the story says so once. */
  onWait?: (hold: ProductHold) => void;
  log?: (text: string) => void;
  waitMs?: number;
  limitMs?: number;
  lookMs?: number;
}

/**
 * Starts everything the story's change touches, in the order the parts rely on each other, and answers with the part a
 * person opens. Holds the product until `stopProduct`. Coming back starts only what is no longer running.
 */
export async function startProduct(bp: BoardPaths, t: Ticket, holder: string, kind: HoldKind, o: ProductStart = {}): Promise<RunningApp> {
  const plan = productPlan(bp, readMeta(bp), t);
  if (plan.why) throw new ProductError(plan.why);
  await waitForProduct(bp, holder, kind, { ...(o.signal ? { signal: o.signal } : {}), ...(o.onWait ? { onWait: o.onWait } : {}), ...(o.limitMs ? { limitMs: o.limitMs } : {}), ...(o.lookMs ? { lookMs: o.lookMs } : {}) });
  const key = keyOf(bp, holder);
  const list = running.get(key) ?? [];
  running.set(key, list);
  try {
    let front: RunningApp | undefined;
    for (const place of plan.places) {
      if (!place.fromStory) await readyMainCopy(bp, t, place, o.signal);
      const was = list.find((r) => r.repo === place.repo.path);
      if (was && was.app.ended?.()) list.splice(list.indexOf(was), 1);
      let app = was && !was.app.ended?.() ? was.app : undefined;
      if (!app) {
        o.log?.(`Starting ${place.part.name} (${place.fromStory ? "the story's copy" : 'main'}) at ${place.url}: ${place.start}`);
        app = await startPart(bp, t, place, o);
        list.push({ app, repo: place.repo.path });
      }
      if (place === plan.front) front = app;
    }
    return front!;
  } catch (err) {
    stopProduct(bp, holder);
    throw err;
  }
}

/** A Docker stack that is still stopping holds its addresses: the next start waits for it. */
const composeStops = new Map<string, Promise<void>>();

/** One part, on its usual address. A part that runs in Docker gets the one opening compose-run.ts allows. */
async function startPart(bp: BoardPaths, t: Ticket, place: ProductPlace, o: ProductStart): Promise<RunningApp> {
  await composeStops.get(place.url);
  // After its copy is ready: a guard says where a folder really is.
  const guard = guardOf(bp, t, place.dir);
  const compose = composeRun(readMeta(bp), place.repo.path, place.start, place.dir, bp.root);
  if (compose && 'why' in compose) throw new ProductError(compose.why);
  const own = compose && guard ? dockerGuard(guard, compose) : guard;
  try {
    const app = await startApp(place.dir, compose?.command ?? place.start, place.url, o.waitMs ?? (compose ? DOCKER_WAIT_MS : undefined), o.signal, own, { fixed: true, ...(compose ? { env: compose.env } : {}) });
    if (!compose) return app;
    return {
      ...app,
      stop: () => {
        app.stop();
        const stopped = runCommand(place.dir, compose.stop, DOCKER_STOP_MS, { ...(own ? { guard: own } : {}), env: compose.env }).then(() => undefined, () => undefined);
        composeStops.set(place.url, stopped);
        void stopped.then(() => composeStops.delete(place.url));
      },
    };
  } catch (err) {
    throw productFailure(err, place, own);
  }
}

/** A part that would not start, in one plain sentence, with the exact words for engineers. */
export function productFailure(err: unknown, place: Pick<ProductPlace, 'part'>, guard?: GuardSpec): ProductError {
  const message = (err as Error).message;
  if (err instanceof ProductError) return err;
  if (err instanceof AddressTaken) return new ProductError(`Another program on this computer is using the address of ${place.part.name}, so squad-kit could not run the product. Close that program, then press Try again.`, message);
  return new ProductError(dockerBlockedWords(message, guard) ?? `squad-kit could not start ${place.part.name}.`, message);
}

/** The words for a story that waits its turn. */
export function waitWords(hold: ProductHold): string {
  if (hold.kind === 'apps') return 'Waiting for Your apps: they use the same addresses. Stop them, and this goes on.';
  const who = hold.holder.replace(/^try:/, '');
  return hold.kind === 'try' ? `Waiting for you to finish trying ${who}: it uses the same addresses.` : `Waiting for ${who}: only one story at a time runs the product.`;
}

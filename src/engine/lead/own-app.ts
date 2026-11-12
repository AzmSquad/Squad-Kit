import fs from 'node:fs';
import path from 'node:path';
import { projectApps } from '../../board/apps.js';
import { runsAsProduct } from '../../board/parts.js';
import { readMeta, type BoardPaths } from '../../board/store.js';
import type { RepoInfo, Ticket } from '../../board/types.js';
import { CHECK_SILENT_MS, runCommand, startApp, tail, type RunningApp } from '../checks.js';
import { fillOwnCopy } from '../local-files.js';
import { ProductError, productPlan, startProduct, stopProduct, waitWords } from '../product-run.js';
import { guardSupport, ticketGuard, type GuardSpec } from '../project-guard.js';
import { reposOf } from '../repos.js';
import { SETUP_MS, dependencyPrint, updateCopy } from '../run-app.js';
import { setUpStoryDb } from '../story-db.js';
import { leadDir } from './store.js';

/**
 * The lead looks at the app only in its own copy: squad-kit's own copy of the newest main, set up with the values
 * kept for stories and its own database, started on a free port when the usual one is taken. It never uses the
 * person's running app, their checkout or their real database. A product runs the way Try it yourself runs one, under
 * the lead's own holder, so it takes its turn with the stories.
 */

/** Who holds the running product, and whose database it is: the lead's own, never a story's. */
export const LEAD_HOLDER = 'lead';

/** The words when the lead's copy would share the person's own database. It then does not start at all. */
export const NOT_YOUR_DATA = "squad-kit has no copy of your database for its own copy of the app yet, so the lead does not start it: it would use your real data. An engineer can make one on Harness, under Safety.";

/** How the lead's copy runs: one app from its own copy, or the whole product; and why it cannot, in plain words. */
export interface LeadAppPlan {
  product: boolean;
  name?: string;
  repo?: RepoInfo;
  dir?: string;
  start?: string;
  url?: string;
  /** The parts a product's API may be asked on, by id. */
  parts?: Record<string, { name: string; url: string }>;
  why?: string;
}

/** The lead stands in for a story with no copy of its own, so a product runs everything from copies of main. */
function asStory(): Ticket {
  return { id: 'LEAD', title: 'Squad lead', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'tickets', status: '', waiting: null, createdAt: new Date().toISOString(), createdBy: 'squad-kit', activity: [] };
}

/** The lead's own copy of a repo, in squad-kit's folder for the project. */
export function leadCopyDir(bp: BoardPaths, repo: string): string {
  return path.join(leadDir(bp), 'app', repo.replace(/[^\w.-]+/g, '-'));
}

export function leadAppPlan(bp: BoardPaths): LeadAppPlan {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') return { product: false, why: 'A sample board has no app to look at.' };
  if (runsAsProduct(meta)) {
    const plan = productPlan(bp, meta, asStory());
    if (plan.why || !plan.front) return { product: true, why: plan.why ?? 'squad-kit does not know how to run the product yet.' };
    return { product: true, name: plan.front.part.name, start: plan.front.start, url: plan.front.url, dir: plan.front.dir, parts: Object.fromEntries(plan.places.map((p) => [p.part.id, { name: p.part.name, url: p.url }])) };
  }
  const app = projectApps(meta)[0];
  const repo = app ? reposOf(meta).find((r) => r.path === app.repo) : undefined;
  if (!app || !repo) return { product: false, why: 'This project has no app to look at yet.' };
  if (!app.start) return { product: false, name: app.name, why: 'squad-kit does not know how to start the app yet. An engineer can set its start command in Settings.' };
  if (!app.url) return { product: false, name: app.name, why: "squad-kit does not know the app's address yet. An engineer can set it in Settings." };
  return { product: false, name: app.name, repo, dir: leadCopyDir(bp, repo.path), start: app.start, url: app.url };
}

function guardOf(bp: BoardPaths, dir: string): GuardSpec | undefined {
  if (!guardSupport().on) return undefined;
  const allow = readMeta(bp).guard;
  return ticketGuard(bp, { cwd: dir, id: LEAD_HOLDER, ...(allow ? { allow } : {}) });
}

/** The lead's copy, up to date with the newest main, with the values kept for stories, its own database and its setup. */
async function readyCopy(bp: BoardPaths, repo: RepoInfo, dir: string, signal?: AbortSignal): Promise<GuardSpec | undefined> {
  const { commit, fresh } = await updateCopy(bp.root, repo, dir, signal ? { signal } : {});
  await fillOwnCopy(bp, repo.path, dir);
  const db = await setUpStoryDb(bp, LEAD_HOLDER, dir, repo.path);
  // A copy that would share the person's own database never starts.
  if (db.state === 'as-before') throw new ProductError(NOT_YOUR_DATA, db.why);
  const guard = guardOf(bp, dir);
  const setup = repo.commands.setup?.trim();
  if (!setup) return guard;
  const print = await dependencyPrint(dir, commit);
  const mark = `${dir}.setup`;
  if (!fresh && fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === print) return guard;
  const r = await runCommand(dir, setup, SETUP_MS, { silentMs: CHECK_SILENT_MS, ...(signal ? { signal } : {}), ...(guard ? { guard } : {}) });
  if (!r.ok) throw new ProductError('squad-kit could not set up its own copy of the app.', `${setup}\n${tail(r.output, 30)}`);
  // A setup can write the values back over the ones kept for stories: they go back in.
  await fillOwnCopy(bp, repo.path, dir);
  fs.writeFileSync(mark, print);
  return guard;
}

/**
 * Starts the lead's own copy and answers once it answers. Something else at the app's address (the person's own app)
 * moves it to a free port. `onWait` says who holds a product it waits for.
 */
export async function startLeadApp(bp: BoardPaths, o: { signal?: AbortSignal; waitMs?: number; onWait?(words: string): void } = {}): Promise<RunningApp> {
  const plan = leadAppPlan(bp);
  if (plan.why) throw new ProductError(plan.why);
  if (plan.product) {
    return startProduct(bp, asStory(), LEAD_HOLDER, 'try', { ...(o.signal ? { signal: o.signal } : {}), ...(o.waitMs ? { waitMs: o.waitMs } : {}), ...(o.onWait ? { onWait: (hold) => o.onWait!(waitWords(hold)) } : {}) });
  }
  const guard = await readyCopy(bp, plan.repo!, plan.dir!, o.signal);
  return startApp(plan.dir!, plan.start!, plan.url!, o.waitMs, o.signal, guard);
}

/** Stops what the lead started: a product's every part, and lets the stories have it again. */
export function stopLeadApp(bp: BoardPaths, app?: RunningApp | null): void {
  app?.stop();
  if (leadAppPlan(bp).product) stopProduct(bp, LEAD_HOLDER);
}

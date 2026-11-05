import { now, readMeta, type BoardPaths } from './store.js';
import { BoardActionError } from './actions.js';
import type { BoardMeta } from './types.js';
import type { Tracker, TrackerLevels } from '../modules/tracker/types.js';
import type { Breakdown, BreakdownEpic, BreakdownFeature, BreakdownStory, SendPreview, TrackerLink } from './requirements-types.js';
import {
  addBreakdownActivity,
  isBreakdownMine,
  listBreakdowns,
  ownerOfBreakdown,
  readBreakdown,
  readBreakdownState,
  requireBreakdown,
  updateBreakdown,
  updateBreakdownState,
} from './requirements.js';
import { applySendChange, linkCount, linkTickets, planSend, sendBreakdown, type SendResult } from './requirements-sync.js';
import { sendTargetOf, sendTracker } from './requirements-tracker.js';
import { DemoTracker } from './demo-tracker.js';

/**
 * Send to the tracker, as a job: the button (or `squad requirements send`) only asks for it, and the squad runs it
 * beside everything else, never counted against the parallel limit, saving its progress item by item in this
 * computer's part of the breakdown. A send cut off by a restart carries on where it was, and makes no doubles. Each
 * item is saved into the breakdown as it is made, on a fresh read, so edits made while it runs are kept.
 */

const NO_TRACKER = 'This project has no tracker squad-kit can make items in. Connect one in Settings, then send.';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

type Part = BreakdownEpic | BreakdownFeature | BreakdownStory;

function parts(b: Breakdown): Part[] {
  return b.epics.flatMap((e) => [e, ...e.features, ...e.features.flatMap((f) => f.stories), ...e.stories]);
}

/** Never sent to this tracker before: the first send makes everything. */
function firstSend(b: Breakdown, module: string): boolean {
  return !parts(b).some((p) => p.tracker?.module === module);
}

/** What Send to <tracker> will do, for the dialog and `--preview`. Nothing is sent. */
export async function sendPreview(bp: BoardPaths, id: string): Promise<SendPreview> {
  const b = requireBreakdown(bp, id);
  const tracker = sendTracker(bp);
  if (!tracker) throw new BoardActionError(NO_TRACKER);
  const plan = planSend(b, tracker.name);
  let levels: TrackerLevels;
  try {
    levels = await tracker.levels();
  } catch (err) {
    throw new BoardActionError(`squad-kit could not read the item types ${tracker.label} uses: ${(err as Error).message}`);
  }
  const project = levels.project ?? sendTargetOf(bp)?.project;
  return {
    tracker: { module: tracker.name, label: tracker.label, ...(project ? { project } : {}) },
    levels: { epic: levels.epic, feature: levels.feature, story: levels.story, process: levels.process },
    counts: plan.counts,
    items: plan.items.length,
    // One for each "S-5 needs S-4", as counts.links counts them.
    links: linkCount(plan),
    first: firstSend(b, tracker.name),
  };
}

/** True while a send waits to run or runs. */
export function sending(s: { sync?: { status: string } }): boolean {
  return s.sync?.status === 'pending' || s.sync?.status === 'running';
}

/**
 * Send to the tracker (or Send changes): only an approved breakdown, only its owner. The squad runs it; this saves
 * that it is wanted and how much there is to do.
 */
export function requestSend(bp: BoardPaths, id: string): Breakdown {
  const b = requireBreakdown(bp, id);
  if (!isBreakdownMine(b, readMeta(bp))) throw new BoardActionError(`${b.id} is ${ownerOfBreakdown(b)}'s. Only their squad sends it.`);
  const tracker = sendTracker(bp);
  if (!tracker) throw new BoardActionError(NO_TRACKER);
  if (b.status !== 'approved' || !b.approved) throw new BoardActionError(`Approve ${b.id} first. Nothing is sent to ${tracker.label} before the breakdown is approved.`);
  const state = readBreakdownState(bp, b.id);
  if (sending(state)) throw new BoardActionError(`${b.id} is being sent to ${tracker.label} now: ${state.sync!.done} of ${state.sync!.of} done.`);
  const plan = planSend(b, tracker.name);
  const links = linkCount(plan);
  const of = plan.items.length + links;
  if (!of) throw new BoardActionError(`${tracker.label} has ${b.id} as it is now. Nothing changed since the last send.`);
  const first = firstSend(b, tracker.name);
  const what = [plan.items.length ? plural(plan.items.length, 'item') : '', links ? plural(links, 'link') : ''].filter(Boolean).join(' and ');
  updateBreakdownState(bp, b.id, (s) => {
    // An item the last send was making when it stopped is looked for before it is made again.
    const making = s.sync?.making;
    s.sync = { status: 'pending', done: 0, of, items: { done: 0, of: plan.items.length }, links: { done: 0, of: links }, ...(making ? { making } : {}), by: readMeta(bp).user.name, at: now() };
    addBreakdownActivity(s, 'you', first ? `Sending ${b.id} to ${tracker.label}: ${what}` : `Sending the changes to ${tracker.label}: ${what}`);
  });
  return b;
}

/** Every item this tracker has from the breakdowns, for a sample tracker that starts empty after a restart. */
function sentItems(bp: BoardPaths, module: string): { id: string; type: string; title: string }[] {
  return listBreakdowns(bp)
    .flatMap(parts)
    .map((p) => p.tracker)
    .filter((l): l is TrackerLink => l?.module === module)
    .map((l) => ({ id: l.id, type: l.type, title: l.ref }));
}

function doneWords(r: SendResult, label: string, tickets: string[]): string {
  const what = [r.created ? `${r.created} new` : '', r.updated ? `${r.updated} changed` : ''].filter(Boolean).join(' and ');
  const links = r.linked ? `${plural(r.linked, 'link')} between stories that need each other` : '';
  const items = what ? `${what} ${r.created + r.updated === 1 ? 'item' : 'items'}` : '';
  const lead = [items, links].filter(Boolean).join(', ') || 'nothing new';
  return `Sent to ${label}: ${lead}${tickets.length ? `. ${tickets.join(', ')} now move${tickets.length === 1 ? 's' : ''} forward there as ${tickets.length === 1 ? 'it builds' : 'they build'}` : ''}`;
}

/**
 * The send itself, run by the squad. Saves every item as it is made, and the progress, then links the tickets of
 * stories that started before they were sent. Stopped (the board closing) it waits to carry on; a tracker problem ends
 * it with the reason, and Send again carries on from there.
 */
export async function runSend(bp: BoardPaths, id: string, opts: { tracker: Tracker; signal?: AbortSignal }): Promise<SendResult | null> {
  const state = readBreakdownState(bp, id);
  if (!sending(state)) return null;
  const b = readBreakdown(bp, id);
  const tracker = opts.tracker;
  const fail = (error: string) =>
    updateBreakdownState(bp, id, (s) => {
      if (s.sync) s.sync = { ...s.sync, status: 'failed', error };
      addBreakdownActivity(s, 'squad', error);
    });
  if (!b) return null;
  if (tracker instanceof DemoTracker) tracker.remember(sentItems(bp, tracker.name));
  // Carrying on after a restart: what was done before counts.
  const before = state.sync!.done;
  const was = { items: state.sync!.items?.done ?? 0, links: state.sync!.links?.done ?? 0 };
  updateBreakdownState(bp, id, (s) => {
    if (s.sync) {
      s.sync.status = 'running';
      delete s.sync.error;
    }
  });
  let result: SendResult;
  try {
    result = await sendBreakdown(b, tracker, {
      save: (_b, change) => updateBreakdown(bp, id, (x) => applySendChange(x, change)),
      progress: (done, of, p) =>
        updateBreakdownState(bp, id, (s) => {
          if (s.sync) {
            s.sync = {
              ...s.sync,
              done: before + done,
              of: before + of,
              items: { done: was.items + p.items.done, of: was.items + p.items.of },
              links: { done: was.links + p.links.done, of: was.links + p.links.of },
            };
          }
        }),
      making: (key) =>
        updateBreakdownState(bp, id, (s) => {
          if (!s.sync) return;
          if (key) s.sync.making = key;
          else delete s.sync.making;
        }),
      ...(state.sync!.making ? { cutOff: state.sync!.making } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      by: state.sync!.by ?? b.owner,
    });
  } catch (err) {
    fail((err as Error).message);
    return null;
  }
  if (result.stopped) {
    updateBreakdownState(bp, id, (s) => s.sync && (s.sync.status = 'pending'));
    return result;
  }
  const linked = linkTickets(bp, requireBreakdown(bp, id));
  if (result.error) {
    fail(result.error);
    return result;
  }
  updateBreakdownState(bp, id, (s) => {
    s.sync = {
      status: 'done',
      done: before + result.done,
      of: before + result.of,
      ...(s.sync?.items ? { items: s.sync.items } : {}),
      ...(s.sync?.links ? { links: s.sync.links } : {}),
      ...(s.sync?.by ? { by: s.sync.by } : {}),
      at: now(),
    };
    addBreakdownActivity(s, 'squad', doneWords(result, tracker.label, linked));
  });
  return result;
}

/** My breakdowns with a send waiting to run, or cut off by a restart. */
export function sendsDue(bp: BoardPaths, meta: Pick<BoardMeta, 'user'> = readMeta(bp)): string[] {
  return listBreakdowns(bp)
    .filter((b) => isBreakdownMine(b, meta) && sending(readBreakdownState(bp, b.id)))
    .map((b) => b.id);
}

/** A squad's jobs beside the tickets: what runs (`__send:BR-1`), and how to stop each one. */
export interface SideJobs {
  running: Set<string>;
  stops: Map<string, AbortController>;
}

/** Starts every send that is due and not running yet, as `__send:<id>`, beside the squad's other work. */
export function startSends(bp: BoardPaths, meta: Pick<BoardMeta, 'user'>, jobs: SideJobs): void {
  for (const id of sendsDue(bp, meta)) {
    const key = `__send:${id}`;
    if (jobs.running.has(key)) continue;
    const tracker = sendTracker(bp);
    if (!tracker) {
      updateBreakdownState(bp, id, (s) => s.sync && Object.assign(s.sync, { status: 'failed', error: NO_TRACKER }));
      continue;
    }
    const stop = new AbortController();
    jobs.running.add(key);
    jobs.stops.set(key, stop);
    void runSend(bp, id, { tracker, signal: stop.signal })
      .catch(() => undefined)
      .finally(() => {
        jobs.running.delete(key);
        jobs.stops.delete(key);
      });
  }
}

/** The scripted squad's sends, one list per sample board. */
const demoJobs = new Map<string, SideJobs>();

export function demoSendJobs(bp: BoardPaths): SideJobs {
  let j = demoJobs.get(bp.root);
  if (!j) {
    j = { running: new Set(), stops: new Map() };
    demoJobs.set(bp.root, j);
  }
  return j;
}

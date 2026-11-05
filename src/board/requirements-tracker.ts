import { readMeta, type BoardPaths } from './store.js';
import type { Tracker } from '../modules/tracker/types.js';
import { trackerFor, trackerModule } from '../modules/registry.js';
import { demoTracker, type DemoTracker } from './demo-tracker.js';
import type { BreakdownView } from './requirements-types.js';

/**
 * The tracker a breakdown is sent to: the project's own, when its module can make items (abilities.create). The
 * sample board's scripted squad sends to a tracker kept in memory instead, slow enough that the progress shows. Only
 * the Tracker interface is used here, never a product (ADR-002).
 */

/** The sample boards' trackers, one per board, kept while the app runs. */
const demos = new Map<string, DemoTracker>();

/** How long each write to the sample tracker takes at speed 1. */
const DEMO_WRITE_MS = 400;

/** The tracker a breakdown can be sent to now, or null when the project has none that can make items. */
export function sendTracker(bp: BoardPaths): Tracker | null {
  const meta = readMeta(bp);
  if (meta.engine === 'demo') {
    let t = demos.get(bp.root);
    if (!t) {
      t = demoTracker({ levels: { project: meta.project }, delayMs: Math.round(DEMO_WRITE_MS / Math.max(0.1, meta.speed || 1)) });
      demos.set(bp.root, t);
    }
    return t;
  }
  try {
    const t = trackerFor(bp);
    return t?.abilities.create ? t : null;
  } catch {
    return null;
  }
}

/** The sample board's tracker, when there is one (tests look into it). */
export function demoSendTracker(bp: BoardPaths): DemoTracker | undefined {
  return demos.get(bp.root);
}

/** For the page: which tracker and which project the items go into ("Azure DevOps", project RoomFlow). */
export function sendTargetOf(bp: BoardPaths): BreakdownView['tracker'] {
  const t = sendTracker(bp);
  if (!t) return undefined;
  let project: string | undefined;
  try {
    const meta = readMeta(bp);
    project = meta.engine === 'demo' ? meta.project : trackerModule(t.name)?.read(bp.root).values.project?.trim() || undefined;
  } catch {
    project = undefined;
  }
  return { module: t.name, label: t.label, ...(project ? { project } : {}) };
}

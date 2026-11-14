import type { SquadConfig } from '../core/config.js';
import { trackerModule } from '../modules/registry.js';
import type { TrackerModule } from '../modules/tracker/types.js';
import type { CheckResult } from './doctor-engine.js';

/**
 * `squad doctor` for a tracker that signs in with its own tool (its module has no secret field): the same steps
 * Settings shows when something is missing on this computer, then who the tracker says is signed in.
 */

/**
 * The project's tracker module, when it signs in by itself: it has no token to paste, or none is saved and it opens
 * with its own sign-in (Azure DevOps with squad-kit's Microsoft sign-in, ADR-011). Null for the trackers doctor checks
 * the older way, by their saved token.
 */
export function selfSignedTracker(config: SquadConfig | undefined, root?: string): TrackerModule | null {
  const mod = config && config.tracker.type !== 'none' ? trackerModule(config.tracker.type) : undefined;
  if (!mod) return null;
  if (!mod.fields.some((f) => f.secret)) return mod;
  return root && !mod.read(root).hasSecret && mod.open(root) ? mod : null;
}

/** The sign-in on this computer: the tracker's tool found, signed in, and with the rights the settings need. */
export async function trackerSignInCheck(root: string, mod: TrackerModule): Promise<CheckResult> {
  const steps = (await mod.setupSteps?.(mod.read(root).values)) ?? [];
  if (!steps.length) return { id: 'tracker-cred', name: 'tracker credential resolves', status: 'ok', detail: `${mod.label}: signed in on this computer` };
  return {
    id: 'tracker-cred',
    name: 'tracker credential resolves',
    status: 'fail',
    detail: `${mod.label} needs, on this computer: ${steps.map((s, i) => `${i + 1}) ${s.say}${s.command ? `: ${s.command}` : ''}${s.link ? `: ${s.link}` : ''}`).join(' ')}`,
    fixHint: steps.find((s) => s.command)?.command ?? steps[0]!.link,
  };
}

/** Who the tracker says is signed in, with the saved settings, and its one plain line when it has one. */
export async function trackerReachCheck(root: string, mod: TrackerModule): Promise<CheckResult> {
  const name = 'tracker connectivity';
  const tracker = mod.open(root);
  if (!tracker) return { id: 'tracker-live', name, status: 'skip', detail: 'not set up' };
  try {
    const who = await tracker.whoAmI();
    const note = mod.read(root).note;
    return { id: 'tracker-live', name, status: note ? 'warn' : 'ok', detail: `${mod.label} as ${who}${note ? `. ${note}` : ''}` };
  } catch (err) {
    return { id: 'tracker-live', name, status: 'fail', detail: (err as Error).message };
  }
}

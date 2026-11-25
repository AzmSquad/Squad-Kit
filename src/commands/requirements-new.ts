import kleur from 'kleur';
import type { Command } from 'commander';
import * as ui from '../ui/index.js';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { Breakdown, BreakdownView } from '../board/requirements-types.js';
import { parallelLimit } from '../core/settings.js';
import { addTrackerStories } from '../board/epic-new.js';
import { squadRunsElsewhere } from '../board/lock.js';
import { andWords } from '../board/requirements.js';
import { trackerFor } from '../modules/registry.js';
import { board } from './board.js';
import { wrapArgs } from './wrap.js';

/**
 * A run from the tracker in the terminal (ADR-013): the new stories found under its epic, and `squad requirements
 * add-new`, the Add to the run button.
 */

/** "2 new stories on Azure DevOps: AB#2031 and AB#2032. Add them: squad requirements add-new BR-3", or null. */
export function trackerNewLine(v: Pick<BreakdownView, 'id' | 'source' | 'state'>): string | null {
  const fresh = v.state.trackerNew ?? [];
  if (!fresh.length) return null;
  const one = fresh.length === 1;
  return `${fresh.length} new ${one ? 'story' : 'stories'} on ${v.source.tracker?.label ?? 'the tracker'}: ${andWords(fresh.map((n) => `${n.ref} ${n.title}`))}. ${one ? 'It joins' : 'They join'} only when you add ${one ? 'it' : 'them'}: ${kleur.green(`squad requirements add-new ${v.id}`)}`;
}

/**
 * What `squad requirements approve` says. A run from the tracker builds by itself from the approval on, so it says it is
 * building now, and how to pause it.
 */
export function approvedWords(bp: BoardPaths, b: Pick<Breakdown, 'id' | 'source'>): string {
  if (b.source.kind !== 'tracker') return `${b.id} is approved. Start a story: squad requirements start ${b.id} <story>`;
  const meta = readMeta(bp);
  return `Approved. Building continuously, ${Math.min(parallelLimit(meta.parallel), meta.atOnce ?? Infinity)} at a time. Pause: squad requirements build ${b.id} --pause`;
}

export function addNewCommand(r: Command): void {
  r.command('add-new <id>')
    .description("Add to the run: the new stories found under a run's epic on the tracker; the Analyst fills them in")
    .action(
      wrapArgs(async (id: string) => {
        const bp = board();
        const tracker = trackerFor(bp);
        if (!tracker) throw new Error('No tracker is set up for this project. Run: squad config set tracker');
        const b = await addTrackerStories(bp, id, tracker);
        ui.success(`The new stories joined ${b.id}. The Analyst fills them in; they build once you read them and press Build continuously.`);
        ui.info(`Read them: squad requirements show ${b.id}    Then: squad requirements build ${b.id}`);
        if (readMeta(bp).engine === 'live' && !squadRunsElsewhere(bp)) ui.warning('The Analyst works while the board is open. Run `squad console` in another tab.');
      }),
    );
}

import type { EpicPreviewStory } from '../api/epic-types';
import type { BreakdownSource, BreakdownStory, BreakdownView } from '../api/requirements-types';
import type { BacklogGroup, WorkItemRow } from '../api/tracker-types';
import { money, readSteps, timeWords, type ReadStep } from './requirements';
import { shellArg, shellQuote } from './text';

/**
 * Build all: an Epic or Feature from the tracker built as one run. The words and the order its Backlog row, its dialog
 * and the Requirements screens show. The run itself is a breakdown whose source is the tracker item.
 */

/** A run of an item from the tracker, not a document. */
export function fromTracker(v: { source: Pick<BreakdownSource, 'kind'> }): boolean {
  return v.source.kind === 'tracker';
}

/** The tracker's name for a run, for "from Azure DevOps"; "the tracker" when the run does not say. */
export function trackerLabel(v: { source: Pick<BreakdownSource, 'tracker'> }): string {
  return v.source.tracker?.label || 'the tracker';
}

/** `squad backlog build AB#2001`, with `--sprint "Sprint 14"` when only the sprint's stories are ticked. */
export function buildCommand(ref: string, onlySprint?: string): string {
  return `squad backlog build ${shellArg(ref)}${onlySprint ? ` --sprint ${shellQuote(onlySprint)}` : ''}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a group holds in this list: "3 stories", "2 stories, 1 bug". */
export function holdsWords(items: Pick<WorkItemRow, 'isBug'>[]): string {
  const bugs = items.filter((i) => i.isBug).length;
  const stories = items.length - bugs;
  return [stories || !bugs ? plural(stories, 'story', 'stories') : '', bugs ? plural(bugs, 'bug') : ''].filter(Boolean).join(', ');
}

export interface RunLine {
  /** Building, Paused, Getting ready (the Analyst reads, asks, waits for the approval) or All merged. */
  state: string;
  /** "2 of 6 merged". */
  merged: string;
  pct: number;
  live: boolean;
  /** "1 needs you", or nothing. */
  you: string;
}

/** A run on its Backlog row, in a few words. */
export function runLine(run: NonNullable<BacklogGroup['run']>): RunLine {
  const all = run.stories > 0 && run.merged >= run.stories;
  const started = run.merged + run.building + run.needsYou > 0;
  return {
    // Approved and not building is paused, whether or not a story started yet; before the approval it is getting ready.
    state: all ? 'All merged' : run.on ? 'Building' : started || run.approved ? 'Paused' : 'Getting ready',
    merged: `${run.merged} of ${run.stories} merged`,
    pct: run.stories ? Math.round((run.merged / run.stories) * 100) : 0,
    live: run.on && !all,
    you: run.needsYou ? `${run.needsYou} ${run.needsYou === 1 ? 'needs' : 'need'} you` : '',
  };
}

export type PreviewLine = { kind: 'feature'; title: string } | { kind: 'story'; n: number; story: EpicPreviewStory; needs: string };

/**
 * The dialog's list: the stories in the order they build, numbered, with the feature's name wherever the feature
 * changes. A need on a story in the list says its number; one outside it says its ref. `sprintOnly`: only the stories
 * in the sprint.
 */
export function previewLines(stories: EpicPreviewStory[], sprintOnly: boolean, label: string): PreviewLine[] {
  const shown = sprintOnly ? stories.filter((s) => s.inSprint) : stories;
  const number = new Map<string, number>();
  shown.forEach((s, i) => {
    number.set(s.id, i + 1);
    number.set(s.ref, i + 1);
  });
  const lines: PreviewLine[] = [];
  let feature: string | undefined;
  shown.forEach((s, i) => {
    if (s.feature && s.feature !== feature) lines.push({ kind: 'feature', title: s.feature });
    feature = s.feature;
    const needs = s.needs.map((x) => String(number.get(x) ?? x));
    lines.push({ kind: 'story', n: i + 1, story: s, needs: needs.length ? `needs ${needs.join(', ')} · from ${label}` : '' });
  });
  return lines;
}

/** "About 6 hours and $40 of squad time": the dialog's estimate, a rough one said so. */
export function squadTimeWords(e: { minutes: number; costUsd?: number; rough: boolean }): string {
  return `About ${timeWords(e.minutes)}${e.costUsd === undefined ? '' : ` and ${money(e.costUsd)}`} of squad time${e.rough ? ', a rough guess' : ''}`;
}

/** Where a need of a run's story came from: the tracker's own link, or one the Analyst added. Nothing for a BRD. */
export function needFrom(v: Pick<BreakdownView, 'source'>, s: Pick<BreakdownStory, 'needsFrom'>, need: string): string {
  if (!fromTracker(v)) return '';
  const from = s.needsFrom?.[need];
  return from === 'analyst' ? 'added by the Analyst' : from === 'tracker' ? `from ${trackerLabel(v)}` : '';
}

/** The reading card of a run: the same steps as a BRD's, in a run's words. The Analyst fills gaps; it writes no parts. */
export function runReadSteps(v: Pick<BreakdownView, 'status' | 'source' | 'questions' | 'state' | 'counts'>): ReadStep[] {
  const label = trackerLabel(v);
  const n = v.counts.stories;
  const all = n === 1 ? 'the story' : `all ${n} stories`;
  const job = v.state.job;
  return readSteps(v).map((s): ReadStep => {
    if (s.key === 'text') return { ...s, title: `Copied ${plural(n, 'story', 'stories')} from ${label}`, sub: 'With their text, "done when" and links, as they are now. Nothing changes there yet.' };
    if (s.key === 'read') {
      // A run is read in one go: what the Analyst does now says more than a page count it does not have.
      const now = s.state === 'now' && job?.now && !job.at ? `${job.now}.` : s.sub;
      return { ...s, title: `Reading ${all}`, sub: s.state === 'done' ? `Read ${all}.` : s.state === 'todo' ? 'Once, with the epic and features around them.' : now };
    }
    if (s.key === 'questions') return { ...s, sub: s.state === 'done' ? s.sub.replace('the BRD was', 'the stories were') : 'Only for a real gap or two stories that clash, all at once. Small things it decides and writes down.' };
    return {
      ...s,
      title: 'Filling the gaps',
      sub: s.state === 'now' && job?.now ? s.sub : 'It keeps the stories as they are and adds only what is missing: "done when" where a story has none, a size, and needs, each with its reason.',
    };
  });
}

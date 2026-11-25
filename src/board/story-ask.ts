import type { BoardPaths } from './store.js';
import type { Breakdown } from './requirements-types.js';
import { placeWords, refWords, type StoryPlace } from './requirements.js';
import { breakdownDir } from './requirements-paths.js';
import { readCopy, sectionOf } from './epic-text.js';

/**
 * The ask of a story's ticket when it starts: its story, and where it comes from. A story of a run from the tracker
 * takes its item's own words from the run's copy, and says the epic and feature it sits under there (ADR-013).
 */
export function storyAsk(bp: BoardPaths, b: Breakdown, place: StoryPlace): string {
  const { story } = place;
  const from = b.source.tracker;
  if (b.source.kind !== 'tracker' || !from || !story.tracker) {
    return [story.story || story.title, `From ${b.id} › ${placeWords(place)}.`, `In the BRD: ${[refWords(story.ref), b.source.name].filter(Boolean).join(', in ')}.`].join('\n\n');
  }
  const own = sectionOf(readCopy(breakdownDir(bp, b.id)), story.tracker.ref) || story.story || story.title;
  const feature = place.feature && place.feature.tracker?.id !== from.id ? place.feature.title : '';
  const where = [`${from.ref} ${b.title}`, feature, story.tracker.ref].filter(Boolean).join(' › ');
  return `${own}\n\nFrom ${where}, on ${from.label}, built with ${b.id}.`;
}

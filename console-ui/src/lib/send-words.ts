import type { SendPreview } from '../api/requirements-types';

/**
 * Where a send puts each level, in the dialog's words. A tracker that cannot nest a level under its epic links it to
 * the epic instead (`levels.linked`), and the dialog says so.
 */

/** "under its epic", or "linked to its epic". */
export function featurePlace(levels: SendPreview['levels']): string {
  return levels.linked?.includes('feature') ? 'linked to its epic' : 'under its epic';
}

/** Where the stories go: under their feature, under (or linked to) their epic when they have no feature, or both. */
export function storyPlace(levels: SendPreview['levels'], counts: Pick<SendPreview['counts'], 'storiesUnderEpic' | 'features'>): string {
  if (!counts.storiesUnderEpic) return 'under its feature';
  const linked = levels.linked?.includes('story');
  if (!counts.features.all) return linked ? 'linked to its epic' : 'under its epic';
  return linked ? 'under its feature, or linked to its epic' : 'under its feature or epic';
}

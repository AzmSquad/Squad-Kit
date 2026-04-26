import type { ApiStory } from '~/api/types';

export function groupByFeature(stories: ApiStory[]): { feature: string; stories: ApiStory[] }[] {
  const map = new Map<string, ApiStory[]>();
  for (const s of stories) {
    const g = map.get(s.feature) ?? [];
    g.push(s);
    map.set(s.feature, g);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([feature, list]) => ({
      feature,
      stories: list.sort((x, y) => x.id.localeCompare(y.id)),
    }));
}

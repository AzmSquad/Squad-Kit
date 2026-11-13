import type { Sprint } from './types.js';

/**
 * The sprint a backlog opens on: the one running now, else the next one to start, else the newest. Never an old,
 * finished sprint while a newer one is there. A tracker's sprints without dates are taken in the order it gives them.
 */
export function sprintToShow(sprints: Sprint[], today = new Date().toISOString().slice(0, 10)): Sprint | null {
  const now = sprints.find((s) => s.current);
  if (now) return now;
  const dated = sprints.filter((s) => s.start).sort((a, b) => a.start!.localeCompare(b.start!));
  const next = dated.find((s) => s.start! > today);
  return next ?? dated[dated.length - 1] ?? sprints[sprints.length - 1] ?? null;
}

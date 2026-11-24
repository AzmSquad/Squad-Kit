import { listTickets, type BoardPaths } from '../../board/store.js';
import { isMerged } from '../../board/depends.js';
import { plainWords } from '../../core/for-people.js';
import { sprintToShow } from '../../modules/tracker/sprints.js';
import { backlogTree } from '../../modules/tracker/tree.js';
import type { Tracker, TrackerTree } from '../../modules/tracker/types.js';

/**
 * The Backlog page's answer (`GET /api/v1/backlog`): the sprints, the chosen sprint's items with the ticket each one is
 * on the board as, and, when the tracker nests its items, the epics and features above them. The tree never stops the
 * list: when it cannot be read, or is slow, the page shows the flat list for now and the log says why.
 */
export async function backlogView(bp: BoardPaths, tracker: Tracker, user: string | undefined, asked: string | undefined) {
  try {
    const sprints = tracker.abilities.sprints ? await tracker.sprints() : [];
    const sprint = asked === 'all' ? null : (sprints.find((s) => s.path === asked) ?? sprintToShow(sprints));
    const items = await tracker.list(sprint ? { sprint: sprint.path } : {});
    const onBoard = new Map(listTickets(bp).filter((t) => t.source.type === tracker.name).map((t) => [t.source.id ?? tracker.parseRef(t.source.ref ?? ''), t]));
    const tree = await treeOf(tracker, items);
    return {
      connected: true,
      user,
      sprints,
      sprint: sprint?.path ?? 'all',
      // The tracker had more than it reads at once: the page says only these are shown.
      ...(items.more ? { capped: true } : {}),
      items: items.map((w) => {
        const t = onBoard.get(w.id);
        return { ...w, ticket: t ? { id: t.id, stage: t.stage, status: t.status, ...(isMerged(t) ? { merged: true } : {}) } : null };
      }),
      // Only when there are epics or features: a bug under a story alone keeps the flat list.
      ...(tree && tree.groups.length ? { tree } : {}),
    };
  } catch (err) {
    return { connected: true, error: plainWords(err, 'Reading the backlog'), sprints: [], items: [] };
  }
}

/** How long the list waits for its tree. A slower tree comes with the next answer, from the minute's keep. */
const TREE_WAIT_MS = 5_000;

function treeOf(tracker: Tracker, items: Parameters<typeof backlogTree>[1]): Promise<TrackerTree | null> {
  return Promise.race([backlogTree(tracker, items), new Promise<null>((done) => setTimeout(() => done(null), TREE_WAIT_MS).unref())]);
}

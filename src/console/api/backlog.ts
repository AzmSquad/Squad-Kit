import type { Context, Hono } from 'hono';
import { listTickets, type BoardPaths } from '../../board/store.js';
import { startFromTracker } from '../../board/actions.js';
import { isMerged } from '../../board/depends.js';
import { epicPreview, importEpic, runAlreadyWords, runOfItem, trackerRuns } from '../../board/epic-import.js';
import { plainWords } from '../../core/for-people.js';
import { sprintToShow } from '../../modules/tracker/sprints.js';
import { backlogTree } from '../../modules/tracker/tree.js';
import type { Tracker, TrackerTree } from '../../modules/tracker/types.js';
import { act } from './act.js';

/**
 * The Backlog page's answer (`GET /api/v1/backlog`): the sprints, the chosen sprint's items with the ticket each one is
 * on the board as, and, when the tracker nests its items, the epics and features above them, each with its run when
 * one was started. The tree never stops the list: when it cannot be read, or is slow, the page shows the flat list for
 * now and the log says why.
 */
export async function backlogView(bp: BoardPaths, tracker: Tracker, user: string | undefined, asked: string | undefined) {
  try {
    const sprints = tracker.abilities.sprints ? await tracker.sprints() : [];
    const sprint = asked === 'all' ? null : (sprints.find((s) => s.path === asked) ?? sprintToShow(sprints));
    const items = await tracker.list(sprint ? { sprint: sprint.path } : {});
    const onBoard = new Map(listTickets(bp).filter((t) => t.source.type === tracker.name).map((t) => [t.source.id ?? tracker.parseRef(t.source.ref ?? ''), t]));
    const tree = await treeOf(tracker, items);
    const runs = tree?.groups.length ? trackerRuns(bp, tracker.name) : null;
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
      ...(tree && tree.groups.length ? { tree: { ...tree, groups: tree.groups.map((g) => (runs?.get(g.id) ? { ...g, run: runs.get(g.id) } : g)) } } : {}),
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

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

/** The tracker, signed in: what the routes below act on. */
export type TrackerStatus = () => Promise<{ tracker: Tracker | null; user?: string; error?: string }>;

/** The Backlog page: its list, Start on a story, and Build all on an epic or a feature (ADR-013). */
export function mountBacklogApi(app: Hono, bp: BoardPaths, trackerStatus: TrackerStatus): void {
  const connected = async (): Promise<Tracker> => {
    const status = await trackerStatus();
    if (!status.tracker) throw new Error(status.error ?? 'No tracker is connected. Add it in Settings.');
    return status.tracker;
  };

  app.get('/api/v1/backlog', async (c) => {
    const status = await trackerStatus();
    if (!status.tracker) return c.json({ connected: false, error: status.error ?? null, sprints: [], items: [] });
    return c.json(await backlogView(bp, status.tracker, status.user, c.req.query('sprint')));
  });

  // Start one story or bug: `squad pull <ref>`.
  app.post('/api/v1/backlog/:id/start', async (c) => act(c, async () => startFromTracker(bp, await connected(), c.req.param('id'))));

  // What Build all would run, for its dialog: `squad backlog build <ref> --preview`. `?sprint=` offers only its stories.
  app.get('/api/v1/backlog/:id/build', async (c) => act(c, async () => epicPreview(bp, await connected(), c.req.param('id'), { ...(c.req.query('sprint') ? { sprint: c.req.query('sprint')! } : {}) })));

  // Build all: `squad backlog build <ref> [--sprint <name>]`. The run's id; the Analyst reads it next. An item with a run
  // already answers that run, with `already` saying so, and the board opens it: new stories under it join there.
  app.post('/api/v1/backlog/:id/build', async (c) => {
    const b = await body<{ onlySprint?: unknown }>(c);
    return act(c, async () => {
      const tracker = await connected();
      const id = tracker.parseRef(c.req.param('id'));
      const had = id ? runOfItem(bp, tracker.name, id) : undefined;
      if (had) return { id: had, already: runAlreadyWords(tracker.refOf(id!), had) };
      const onlySprint = typeof b.onlySprint === 'string' && b.onlySprint.trim() ? b.onlySprint.trim() : undefined;
      const run = await importEpic(bp, tracker, c.req.param('id'), onlySprint ? { onlySprint } : {});
      return { id: run.id };
    });
  });
}

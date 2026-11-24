import kleur from 'kleur';
import { listTickets } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { nestBacklog } from '../board/backlog-tree.js';
import { trackerFor } from '../modules/registry.js';
import { sprintToShow } from '../modules/tracker/sprints.js';
import { backlogTree } from '../modules/tracker/tree.js';
import type { TrackerItemRow } from '../modules/tracker/types.js';
import { STAGE_NAME, board } from './board.js';

/**
 * `squad backlog`: the sprint's stories and bugs from the tracker, under their epics and features when it has them (as
 * the board's Tree), or a plain list with `--flat` (the board's List). Each item says its ticket, or how to start it.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);

export async function runBacklog(opts: { sprint?: string; all?: boolean; flat?: boolean }): Promise<void> {
  const bp = board();
  const tracker = trackerFor(bp);
  if (!tracker) throw new Error('No tracker is set up for this project. Run: squad config set tracker');
  const sprints = tracker.abilities.sprints ? await tracker.sprints() : [];
  const wanted = opts.sprint?.toLowerCase();
  const sprint = opts.all ? undefined : wanted ? sprints.find((s) => s.name.toLowerCase() === wanted || s.path.toLowerCase() === wanted) : (sprintToShow(sprints) ?? undefined);
  if (wanted && !sprint) throw new Error(`No sprint called "${opts.sprint}". Sprints: ${sprints.map((s) => s.name).join(', ')}`);
  const items = await tracker.list(sprint ? { sprint: sprint.path } : {});
  const tickets = listTickets(bp).filter((t) => t.source.type === tracker.name);
  // The tree never stops the list: when it cannot be read, the list shows flat.
  const tree = opts.flat ? null : await backlogTree(tracker, items);
  out();
  out(`  ${kleur.bold('Backlog')} ${kleur.gray(`${sprint ? sprint.name : 'everything open'} · ${items.length} open${items.more ? ` · only the first ${items.length} shown` : ''}`)}`);
  out();
  const w = Math.min(60, Math.max(10, ...items.map((i) => i.title.length)));
  for (const line of nestBacklog(items, tree)) {
    if (line.kind === 'loose') out(`  ${kleur.gray('Not in an epic')}`);
    else if (line.kind === 'group') out(`  ${'  '.repeat(line.depth)}${kleur.magenta(line.group.type.toUpperCase())} ${kleur.bold(line.group.ref)}  ${line.group.title}  ${kleur.gray(line.group.state)}`);
    else out(itemLine(line.item, line.depth, w, tickets));
  }
  out();
}

function itemLine(i: TrackerItemRow, depth: number, width: number, tickets: Ticket[]): string {
  const t = tickets.find((x) => x.source.id === i.id || x.source.ref === i.ref);
  const w = Math.max(10, width - depth * 2);
  const title = i.title.length > w ? `${i.title.slice(0, w - 1)}…` : i.title.padEnd(w);
  const kind = i.isBug ? kleur.red('bug ') : '    ';
  const where = t ? kleur.gray(`${t.id} ${t.stage === 'done' ? 'released' : STAGE_NAME[t.stage]}`) : kleur.green(`squad pull ${i.id}`);
  return `  ${'  '.repeat(depth)}${kleur.bold(i.ref.padStart(7))}  ${kind}${title}  ${kleur.gray(String(i.points ?? '').padStart(2))}  ${kleur.gray(i.state.padEnd(9))} ${where}`;
}

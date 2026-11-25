import kleur from 'kleur';
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { listTickets, readMeta } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { nestBacklog } from '../board/backlog-tree.js';
import { epicPreview, importEpic, runAlreadyWords, trackerRuns, type RunSummary } from '../board/epic-import.js';
import { squadRunsElsewhere } from '../board/lock.js';
import { trackerFor } from '../modules/registry.js';
import { sprintToShow } from '../modules/tracker/sprints.js';
import { backlogTree } from '../modules/tracker/tree.js';
import type { Tracker, TrackerGroup, TrackerItemRow } from '../modules/tracker/types.js';
import { STAGE_NAME, board } from './board.js';
import { wrapArgs } from './wrap.js';

/**
 * `squad backlog`: the sprint's stories and bugs from the tracker, under their epics and features when it has them (as
 * the board's Tree), or a plain list with `--flat` (the board's List). Each item says its ticket, or how to start it;
 * each epic and feature its run, or how to build all of it. `squad backlog build` is the board's Build all.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);

function trackerHere(): Tracker {
  const tracker = trackerFor(board());
  if (!tracker) throw new Error('No tracker is set up for this project. Run: squad config set tracker');
  return tracker;
}

export async function runBacklog(opts: { sprint?: string; all?: boolean; flat?: boolean }): Promise<void> {
  const bp = board();
  const tracker = trackerHere();
  const sprints = tracker.abilities.sprints ? await tracker.sprints() : [];
  const wanted = opts.sprint?.toLowerCase();
  const sprint = opts.all ? undefined : wanted ? sprints.find((s) => s.name.toLowerCase() === wanted || s.path.toLowerCase() === wanted) : (sprintToShow(sprints) ?? undefined);
  if (wanted && !sprint) throw new Error(`No sprint called "${opts.sprint}". Sprints: ${sprints.map((s) => s.name).join(', ')}`);
  const items = await tracker.list(sprint ? { sprint: sprint.path } : {});
  const tickets = listTickets(bp).filter((t) => t.source.type === tracker.name);
  // The tree never stops the list: when it cannot be read, the list shows flat.
  const tree = opts.flat ? null : await backlogTree(tracker, items);
  const runs = tree?.groups.length ? trackerRuns(bp, tracker.name) : new Map<string, RunSummary>();
  out();
  out(`  ${kleur.bold('Backlog')} ${kleur.gray(`${sprint ? sprint.name : 'everything open'} · ${items.length} open${items.more ? ` · only the first ${items.length} shown` : ''}`)}`);
  out();
  const w = Math.min(60, Math.max(10, ...items.map((i) => i.title.length)));
  for (const line of nestBacklog(items, tree)) {
    if (line.kind === 'loose') out(`  ${kleur.gray('Not in an epic')}`);
    else if (line.kind === 'group') out(`  ${'  '.repeat(line.depth)}${kleur.magenta(line.group.type.toUpperCase())} ${kleur.bold(line.group.ref)}  ${line.group.title}  ${kleur.gray(line.group.state)}  ${groupRun(line.group, runs.get(line.group.id))}`);
    else out(itemLine(line.item, line.depth, w, tickets));
  }
  out();
}

/** An epic's or feature's run, "BR-3 building · 2 of 6 merged · 1 needs you", or how to build all of it. */
function groupRun(g: TrackerGroup, run: RunSummary | undefined): string {
  if (!run) return kleur.green(`squad backlog build ${g.ref}`);
  const state = run.merged === run.stories ? 'all merged' : `${run.on ? 'building' : 'paused'} · ${run.merged} of ${run.stories} merged`;
  return kleur.gray(`${run.id} ${state}${run.needsYou ? ` · ${run.needsYou} ${run.needsYou === 1 ? 'needs' : 'need'} you` : ''}`);
}

function itemLine(i: TrackerItemRow, depth: number, width: number, tickets: Ticket[]): string {
  const t = tickets.find((x) => x.source.id === i.id || x.source.ref === i.ref);
  const w = Math.max(10, width - depth * 2);
  const title = i.title.length > w ? `${i.title.slice(0, w - 1)}…` : i.title.padEnd(w);
  const kind = i.isBug ? kleur.red('bug ') : '    ';
  const where = t ? kleur.gray(`${t.id} ${t.stage === 'done' ? 'released' : STAGE_NAME[t.stage]}`) : kleur.green(`squad pull ${i.id}`);
  return `  ${'  '.repeat(depth)}${kleur.bold(i.ref.padStart(7))}  ${kind}${title}  ${kleur.gray(String(i.points ?? '').padStart(2))}  ${kleur.gray(i.state.padEnd(9))} ${where}`;
}

/**
 * `squad backlog build <ref>`: Build all on an epic or a feature. Shows what would run, then starts the run on a yes:
 * the Analyst reads all of it once, asks once, and after one approval each story builds and merges by itself.
 */
async function runBuild(ref: string, opts: { sprint?: string; preview?: boolean; yes?: boolean }): Promise<void> {
  const bp = board();
  const tracker = trackerHere();
  const p = await epicPreview(bp, tracker, ref, opts.sprint ? { sprint: opts.sprint } : {});
  out();
  out(`  ${kleur.bold(`Build all of ${p.root.ref}`)} ${p.root.title} ${kleur.gray(`${p.root.type} on ${tracker.label}`)}`);
  if (p.run) {
    out(`  ${runAlreadyWords(p.root.ref, p.run)} Follow it: ${kleur.green(`squad requirements show ${p.run}`)}`);
    out();
    return;
  }
  const only = (s: (typeof p.stories)[number]) => !p.sprint || s.inSprint;
  p.stories.forEach((s, i) => {
    const needs = s.needs.length ? kleur.gray(`  needs ${s.needs.join(', ')} · from ${tracker.label}`) : '';
    const where = s.onBoard ? kleur.gray(`  on the board as ${s.onBoard}`) : '';
    out(`  ${String(i + 1).padStart(3)}. ${kleur.bold(s.ref)} ${s.isBug ? kleur.red('bug ') : ''}${s.title}${s.feature ? kleur.gray(` · ${s.feature}`) : ''}${needs}${where}${only(s) ? '' : kleur.gray('  not in the sprint')}`);
  });
  for (const l of p.leftOut) out(kleur.gray(`       Left out: ${l.ref} ${l.title}: ${l.why}`));
  out();
  out(`  The Analyst reads all of it once and asks you once. You approve once. Then each story builds and merges by itself, ${p.atOnce} at a time, and stops only when it needs you. Releasing stays yours.`);
  if (p.estimate) out(kleur.gray(`  About ${Math.max(1, Math.round(p.estimate.minutes / 60))} hours${p.estimate.costUsd !== undefined ? ` and $${p.estimate.costUsd.toFixed(2)} of AI at API prices` : ''}${p.estimate.rough ? ', a rough guess' : ''}.`));
  if (p.sprint) out(kleur.gray(`  ${p.sprint.count} of them are in ${p.sprint.name}${opts.sprint ? ': only those run' : ''}.`));
  out();
  if (opts.preview) {
    out(`  Start it: ${kleur.green(`squad backlog build ${p.root.ref}${opts.sprint ? ` --sprint "${opts.sprint}"` : ''}`)}`);
    out();
    return;
  }
  if (!opts.yes && !(await confirm({ message: `Read ${p.sprint && opts.sprint ? p.sprint.count : p.stories.length} stories and start the run?`, default: true }))) {
    ui.info('Nothing started.');
    return;
  }
  const run = await importEpic(bp, tracker, ref, opts.sprint ? { onlySprint: opts.sprint } : {});
  ui.success(`Started ${run.id} from ${p.root.ref}. The Analyst reads it now and asks you once. Follow it: squad requirements show ${run.id}`);
  if (readMeta(bp).engine === 'live' && !squadRunsElsewhere(bp)) ui.warning('The Analyst works while the board is open. Run `squad console` in another tab.');
}

/** `squad backlog`, and `squad backlog build` under it. */
export function backlogCommand(): Command {
  const c = new Command('backlog')
    .description("Show the sprint's stories and bugs from the tracker, under their epics and features when it has them")
    .enablePositionalOptions()
    .option('--sprint <name>', 'Which sprint, for example "Sprint 1" (default: the current one)')
    .option('--all', 'Everything open, in every sprint')
    .option('--flat', 'A plain list, without the epics and features above the items')
    // A command with commands under it gets no --project from the CLI's own loop, which only sees the last ones.
    .option('--project <name>', 'The project: its name, id or folder (default: the one this folder is in)')
    .action(wrapArgs(runBacklog));
  c.command('build <ref>')
    .description('Build all of an epic or a feature: one read, one round of questions, one approval, then each story builds and merges by itself')
    .option('--sprint <name>', 'Only the stories in this sprint, for example "Sprint 14"')
    .option('--preview', 'Show what would run, and start nothing')
    .option('-y, --yes', 'Skip the question')
    .action(wrapArgs(runBuild));
  return c;
}

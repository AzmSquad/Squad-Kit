import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { readMeta, readTicket, requireTicket } from '../board/store.js';
import { bringInLatest, chooseBuild, isMerged, setDependsOn, unmergedDeps, waitsForDependency } from '../board/depends.js';
import { cleanBranches, oldBranches } from '../engine/branches.js';
import { board } from './board.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);

/** Names from `--on RO-1 --on RO-3` or `--on RO-1,RO-3`. */
function idsOf(on: string[] | string | undefined): string[] {
  return (Array.isArray(on) ? on : on ? [on] : []).flatMap((x) => x.split(/[\s,]+/)).filter(Boolean);
}

/** `squad depends <ticket>`: what it depends on; `--on RO-1` names it, `--none` takes it away. */
export async function runDepends(ticketId: string, opts: { on?: string[]; none?: boolean }): Promise<void> {
  const bp = board();
  const ids = idsOf(opts.on);
  if (opts.none || ids.length) {
    const t = setDependsOn(bp, ticketId, opts.none ? [] : ids);
    ui.success(t.dependsOn?.length ? `${t.id} depends on ${t.dependsOn.join(', ')}.` : `${t.id} depends on no other ticket.`);
    if (t.waiting?.kind === 'depends') ui.info(`${t.waiting.summary}. Choose how to build: ${cmd(`squad build ${t.id} --on-branch`)}, ${cmd('--anyway')} or ${cmd('--wait')}`);
    return;
  }
  const t = requireTicket(bp, ticketId);
  out();
  if (!t.dependsOn?.length) {
    out(`  ${kleur.bold(t.id)} depends on no other ticket. Name one: ${cmd(`squad depends ${t.id} --on <ticket>`)}`);
    out();
    return;
  }
  out(`  ${kleur.bold(t.id)} depends on:`);
  for (const id of t.dependsOn) {
    const d = readTicket(bp, id);
    out(`    ${d && !isMerged(d) ? kleur.yellow('○') : kleur.green('✓')} ${kleur.bold(id)}  ${d ? `${d.title}  ${kleur.gray(isMerged(d) ? 'merged' : d.status)}` : kleur.gray('no longer on the board')}`);
  }
  const c = t.dependency;
  if (c) out(kleur.gray(`  ${c.way === 'branch' ? `Built on ${c.on.join(' and ')}'s branch` : c.way === 'anyway' ? `Built without ${c.on.join(' and ')}` : `Waits for ${c.on.join(' and ')}`}, chosen by ${c.by}.`));
  if (waitsForDependency(t) && unmergedDeps(bp, t).length) out(`  Choose how to build: ${cmd(`squad build ${t.id} --on-branch`)}   ${cmd(`squad build ${t.id} --anyway`)}   ${cmd(`squad build ${t.id} --wait`)}`);
  out();
}

/** `squad build <ticket> --on-branch | --anyway | --wait`: the ways out of "RO-2 needs RO-1, which is not merged yet". */
export async function runBuild(ticketId: string, opts: { onBranch?: boolean; anyway?: boolean; wait?: boolean }): Promise<void> {
  const bp = board();
  const ways = [opts.onBranch && 'branch', opts.anyway && 'anyway', opts.wait && 'wait'].filter(Boolean) as ('branch' | 'anyway' | 'wait')[];
  if (ways.length !== 1) {
    const t = requireTicket(bp, ticketId);
    throw new Error(`Say how ${t.id} builds: squad build ${t.id} --on-branch (from the branch of what it needs), --anyway (without it) or --wait (starts by itself once it is merged).`);
  }
  const t = chooseBuild(bp, ticketId, ways[0]!);
  ui.success(t.status);
  if (ways[0] === 'wait') ui.info(`Changed your mind? ${cmd(`squad build ${t.id} --on-branch`)} or ${cmd(`squad build ${t.id} --anyway`)}`);
  if (readMeta(bp).engine === 'live') ui.info('The squad works while the board is open: squad console');
}

/** `squad bring-in <ticket>`: the latest main comes into a ticket's copy; the checks, review and proof run again. */
export async function runBringIn(ticketId: string): Promise<void> {
  const bp = board();
  const t = bringInLatest(bp, ticketId);
  ui.success(t.baseWanted ? `${t.id}: the latest main comes in when the running step ends, before the checks.` : t.activity[0]?.text ?? 'Done.');
}

/** `squad branches`: the old branches of released tickets; `--clean` deletes them here, `--remote` on the remote too. */
export async function runBranches(opts: { clean?: boolean; remote?: boolean }): Promise<void> {
  const bp = board();
  if (readMeta(bp).engine !== 'live') throw new Error('The sample board has no git branches.');
  if (opts.clean) {
    const spin = ui.spinner('Deleting old ticket branches…');
    let r: ReturnType<typeof cleanBranches>;
    try {
      r = cleanBranches(bp, { remote: opts.remote });
    } finally {
      spin.stop();
    }
    if (r.deleted.length) ui.success(`Deleted ${r.deleted.length} old ${r.deleted.length === 1 ? 'branch' : 'branches'}: ${r.deleted.join(', ')}`);
    else ui.info('No old ticket branches to delete.');
    for (const f of r.failed) ui.warning(`Could not delete ${f}`);
    for (const k of r.kept) out(kleur.gray(`  Kept ${k.branch}: ${k.why}`));
    if (r.remoteLeft.length) ui.info(`${r.remoteLeft.length} on ${r.remoteLeft[0]!.remote} stay. Delete them there too: ${cmd('squad branches --clean --remote')}`);
    return;
  }
  const plan = oldBranches(bp);
  out();
  if (!plan.here.length && !plan.remote.length) out('  No old ticket branches. Branches of open tickets always stay.');
  if (plan.here.length) out(`  ${kleur.bold('On this computer')}  ${plan.here.map((b) => b.branch).join(', ')}`);
  if (plan.remote.length) out(`  ${kleur.bold(`On ${plan.remote[0]!.remote}`)}  ${plan.remote.map((b) => b.branch).join(', ')}`);
  for (const k of plan.kept) out(kleur.gray(`  Stays: ${k.branch}, ${k.why}`));
  out();
  if (plan.here.length || plan.remote.length) out(`  Delete them: ${cmd('squad branches --clean')}${plan.remote.length ? `   on the remote too: ${cmd('squad branches --clean --remote')}` : ''}`);
  out();
}

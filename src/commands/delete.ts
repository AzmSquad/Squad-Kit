import kleur from 'kleur';
import { confirm } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { requireTicket } from '../board/store.js';
import { archiveTicket, deletePlan, deleteTicket, unarchiveTicket } from '../engine/delete.js';
import { board } from './board.js';

const out = (s = '') => process.stdout.write(`${s}\n`);

/**
 * `squad delete <ticket>`: what goes and what stays, one confirm (or --yes), then the delete. For someone else's
 * ticket that its owner deleted, it is Remove from my board: this computer only.
 */
export async function runDelete(ticketId: string, opts: { yes?: boolean; remote?: boolean }): Promise<void> {
  const bp = board();
  const plan = deletePlan(bp, ticketId, { remote: opts.remote });
  const ask = plan.local ? `Remove ${plan.id} from your board?` : `Delete ${plan.id}?`;
  out();
  out(`  ${kleur.bold(ask)}  ${kleur.gray(plan.summary)}`);
  if (plan.refused) {
    out();
    throw new Error(plan.archive ? `${plan.refused} Run: squad archive ${plan.id}` : plan.refused);
  }
  if (plan.unfinished) out(`  ${kleur.yellow(`An earlier delete did not finish: ${plan.unfinished}. This finishes it.`)}`);
  out();
  out(`  ${kleur.bold('This removes')}`);
  for (const l of plan.removes) out(`    ${kleur.red('✗')} ${l}`);
  out(`  ${kleur.bold('This stays')}`);
  for (const l of plan.stays) out(`    ${kleur.green('✓')} ${l}`);
  for (const w of plan.warnings) out(`  ${kleur.yellow('!')} ${w}`);
  if (plan.pushed && !plan.remote) out(kleur.gray(`  ${plan.pushed.why} To delete it there too: squad delete ${plan.id} --remote`));
  out();
  if (!opts.yes && !(await confirm({ message: ask, default: false }))) {
    ui.info(plan.local ? 'Not removed.' : 'Not deleted.');
    return;
  }
  const spin = ui.spinner(plan.local ? `Removing ${plan.id}…` : `Deleting ${plan.id}…`);
  const r = await deleteTicket(bp, plan.id, { remote: plan.remote }).finally(() => spin.stop());
  for (const n of r.notes) ui.success(n);
  ui.success(plan.local ? `Removed ${r.id} from your board.` : `Deleted ${r.id}. Its cost stays in Usage.`);
}

/** `squad archive <ticket>`: a merged or released ticket leaves the board; `--undo` brings it back. */
export async function runArchive(ticketId: string, opts: { undo?: boolean }): Promise<void> {
  const bp = board();
  if (opts.undo) {
    const t = unarchiveTicket(bp, ticketId);
    ui.success(`${t.id} is back on the board.`);
    return;
  }
  if (requireTicket(bp, ticketId).archived) {
    ui.info(`${ticketId.toUpperCase()} is archived already. Bring it back: squad archive ${ticketId.toUpperCase()} --undo`);
    return;
  }
  const t = archiveTicket(bp, ticketId);
  ui.success(`Archived ${t.id}. It is off the board; its history stays in git and in .squad/.`);
  ui.info(`See archived tickets: squad board --archived. Bring it back: squad archive ${t.id} --undo`);
}

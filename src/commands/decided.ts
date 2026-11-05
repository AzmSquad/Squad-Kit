import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { requireTicket } from '../board/store.js';
import { changeDecided } from '../board/auto.js';
import { board } from './board.js';

const out = (s = '') => process.stdout.write(`${s}\n`);

/**
 * `squad decided RO-31`: what the squad decided for you on a ticket (Builds by itself). `squad decided RO-31 d2 "<text>"`
 * changes one: a small change on the ticket, or a new linked ticket once it is accepted.
 */
export async function runDecided(ticketId: string, decidedId: string | undefined, words: string[]): Promise<void> {
  const bp = board();
  if (!decidedId) {
    const t = requireTicket(bp, ticketId);
    out();
    if (!t.decided?.length) {
      out(`  Nothing was decided for you on ${kleur.bold(t.id)}.`);
      out();
      return;
    }
    out(`  ${kleur.bold('Decided for you')} on ${t.id}:`);
    for (const d of t.decided) {
      const changed = d.changed ? kleur.gray(`  changed by ${d.changed.by}: ${d.changed.text}${d.changed.ticket ? ` (${d.changed.ticket})` : ''}`) : '';
      out(`    ${kleur.bold(d.id)}  ${d.text}  ${kleur.gray(`by the ${d.by}`)}${changed}`);
    }
    out(kleur.gray(`  Change one: ${kleur.green(`squad decided ${t.id} <id> "<what it should be>"`)}`));
    out();
    return;
  }
  const text = words.join(' ').trim();
  if (!text) throw new Error(`Say what it should be instead: squad decided ${ticketId} ${decidedId} "<text>"`);
  const t = changeDecided(bp, ticketId, decidedId, text);
  const became = t.decided?.find((d) => d.id === decidedId.trim().toLowerCase())?.changed?.ticket ?? '';
  if (/^c\d+$/.test(became)) ui.success(`Proposed change ${became} on ${t.id}. The Analyst writes it into the spec, then approve it: squad propose ${t.id} --approve`);
  else ui.success(`${t.id} is accepted already, so the change became a new linked ticket, ${became}.`);
}

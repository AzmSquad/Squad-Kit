import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { KIND_NAMES } from '../board/proof-lock.js';
import { proveLine } from '../board/prove.js';
import { requireTicket } from '../board/store.js';
import { board } from './board.js';

const out = (s = '') => process.stdout.write(`${s}\n`);

/**
 * `squad prove <ticket> [line] [kind] [--why "…"] [--keeps | --no-keeps]`: how each "done when" of a spec is proved, the
 * same as the chip's menu on the board. With no line, it lists the lines and their kinds. Only before the spec is
 * approved. `--keeps`: a Test line that keeps something that already works, so its test passes before and after.
 */
export async function runProve(id: string, line: string | undefined, kind: string | undefined, opts: { why?: string; keeps?: boolean }): Promise<void> {
  const bp = board();
  if (line === undefined || kind === undefined) {
    const t = requireTicket(bp, id);
    out();
    out(`  ${kleur.bold(t.id)} ${t.title}`);
    for (const [i, c] of (t.criteria ?? []).entries()) {
      const k = c.proof ? `${KIND_NAMES[c.proof.kind]}${c.proof.keeps ? ', stays as it is' : ''}${c.proof.locked ? ', kept by squad-kit' : ''}` : 'as before';
      out(`    ${i + 1}. ${c.then}  ${kleur.gray(k)}${c.proof?.why ? kleur.gray(`: ${c.proof.why}`) : ''}`);
    }
    if (!t.criteria?.length) out('    The spec is not written yet.');
    out();
    out(kleur.gray(`  Change one: squad prove ${t.id} <line> <screen|data|api|test|none> [--why "…"] [--keeps | --no-keeps]`));
    return;
  }
  const t = proveLine(bp, id, Number(line), kind, opts.why, opts.keeps);
  const c = t.criteria![Number(line) - 1]!;
  ui.success(`"Done when" ${line} of ${t.id} is proved by ${KIND_NAMES[c.proof!.kind]}${c.proof!.keeps ? ', stays as it is,' : ''} now.`);
}

import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { readMeta, writeMeta } from '../board/store.js';
import { addPart, changePart, partsOf, removePart, type PartChange } from '../board/parts.js';
import type { ProductPart } from '../board/types.js';
import { board } from './board.js';

/** `squad parts`: what the product is made of, the same as the list in Settings, with every change as an option. */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);

export interface PartsOptions {
  add?: string;
  set?: string;
  off?: string;
  on?: string;
  remove?: string;
  name?: string;
  shared?: boolean;
  repo?: string;
  folder?: string;
  needs?: string;
  url?: string;
  atOnce?: string;
  delivery?: string;
}

function whereOf(p: ProductPart): string {
  if (p.shared) return 'shared by the parts';
  const repo = p.repo === '.' ? 'the project folder' : (p.repo ?? '');
  return p.folder ? `${repo}/${p.folder}` : repo;
}

function printParts(parts: ProductPart[]): void {
  out();
  out(`  ${kleur.bold('What the product is made of')}`);
  out();
  const wide = Math.max(...parts.map((p) => p.id.length));
  for (const p of parts) {
    const needs = p.needs.map((n) => parts.find((x) => x.id === n)?.name ?? n).join(', ');
    out(`  ${kleur.cyan(p.id.padEnd(wide))}  ${kleur.bold(p.name)}${p.off ? kleur.yellow('  not used') : p.noRun ? kleur.gray('  nothing starts here') : ''}`);
    out(`  ${' '.repeat(wide)}  ${kleur.gray([whereOf(p), p.url, needs ? `needs ${needs}` : ''].filter(Boolean).join(' · '))}`);
  }
  out();
  ui.info(`Correct one: ${cmd('squad parts --set api --needs db --url http://localhost:5180')}   Not used: ${cmd('squad parts --off <part>')}`);
}

export async function runParts(opts: PartsOptions): Promise<void> {
  const bp = board();
  if (opts.atOnce !== undefined) {
    const n = Number(opts.atOnce);
    if (opts.atOnce !== 'all' && !(Number.isInteger(n) && n >= 1 && n <= 5)) throw new Error('Say a number from 1 to 5, or all for the limit every project shares.');
    const { atOnce: _old, ...rest } = readMeta(bp);
    writeMeta(bp, opts.atOnce === 'all' ? rest : { ...rest, atOnce: n });
    ui.success(opts.atOnce === 'all' ? 'This project follows the limit every project shares.' : `${n === 1 ? 'One story' : `${n} stories`} of this project run at once.`);
    return;
  }
  if (opts.delivery !== undefined) {
    if (!['pr', 'push', 'auto'].includes(opts.delivery)) throw new Error('Say pr, push, or auto: a pull request when a code host is signed in.');
    const { delivery: _old, ...rest } = readMeta(bp);
    writeMeta(bp, opts.delivery === 'auto' ? rest : { ...rest, delivery: opts.delivery as 'pr' | 'push' });
    ui.success(opts.delivery === 'push' ? 'Finished work goes out pushed to the branch, as one plain commit per story, with no pull request.' : opts.delivery === 'pr' ? 'Finished work goes out by pull request.' : 'Finished work goes out by pull request when a code host is signed in.');
    return;
  }
  const change: PartChange = {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.shared ? { shared: true } : {}),
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts.folder !== undefined ? { folder: opts.folder } : {}),
    ...(opts.needs !== undefined ? { needs: opts.needs.split(',').map((n) => n.trim()).filter(Boolean) } : {}),
    ...(opts.url !== undefined ? { url: opts.url } : {}),
  };
  if (opts.add !== undefined) ui.success(`Added ${addPart(bp, { ...change, name: opts.add }).name}.`);
  else if (opts.set !== undefined) ui.success(`Saved ${changePart(bp, opts.set, change).name}.`);
  else if (opts.off !== undefined) ui.success(`${changePart(bp, opts.off, { off: true }).name} is marked Not used. No story starts it.`);
  else if (opts.on !== undefined) ui.success(`${changePart(bp, opts.on, { off: false }).name} is in use again.`);
  else if (opts.remove !== undefined) {
    removePart(bp, opts.remove);
    ui.success('Taken out.');
  } else printParts(partsOf(readMeta(bp)));
}

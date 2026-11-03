import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { readMeta, writeMeta } from '../board/store.js';
import { PACKAGE_HOSTS, parseHosts, sandboxStatus } from '../engine/sandbox.js';
import { board } from './board.js';

/**
 * `squad config set hosts`: the hosts the Builder's and Tester's commands may reach besides the package registries,
 * shared by the whole team in the project's settings. The same as the list in Settings.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);

/** Shows the allowed hosts and the sandbox on this computer, or sets the list (the hosts given replace it). */
export async function runHosts(hosts: string[], opts: { clear?: boolean } = {}): Promise<void> {
  const bp = board();
  const meta = readMeta(bp);
  if (!hosts.length && !opts.clear) {
    const now = meta.allowedHosts ?? [];
    out();
    out(`  ${kleur.bold('Hosts the squad may reach')}  ${now.length ? now.join(', ') : kleur.gray('only the package registries')}`);
    out(`  ${kleur.gray(`Package registries, always: ${PACKAGE_HOSTS.slice(0, 6).join(', ')} and ${PACKAGE_HOSTS.length - 6} more`)}`);
    for (const s of sandboxStatus()) out(`  ${kleur.gray(`${s.tool}: ${s.available ? `sandbox on, ${s.why}` : `no sandbox here: ${s.why}`}`)}`);
    out();
    ui.info(`Allow a host: ${cmd('squad config set hosts nexus.example.com')}   Allow none: ${cmd('squad config set hosts --clear')}`);
    return;
  }
  const { hosts: ok, bad } = parseHosts(opts.clear ? [] : hosts);
  if (bad.length) throw new Error(`"${bad[0]}" is not a host name. Write it like nexus.example.com, or *.example.com for all of its subdomains.`);
  writeMeta(bp, { ...meta, allowedHosts: ok });
  ui.success(ok.length ? `The squad may reach ${ok.join(', ')} too, from its next step.` : 'The squad reaches only the package registries now, from its next step.');
}

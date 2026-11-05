import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { readMeta, writeMeta } from '../board/store.js';
import type { ProjectGuard } from '../board/types.js';
import { PACKAGE_HOSTS, guardNote, parseHosts, sandboxStatus } from '../engine/sandbox.js';
import { allowPath, guardSupport } from '../engine/project-guard.js';
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
    const note = guardNote();
    if (note) out(`  ${kleur.yellow(note.title)}  ${note.text}`);
    out();
    ui.info(`Allow a host: ${cmd('squad config set hosts nexus.example.com')}   Allow none: ${cmd('squad config set hosts --clear')}`);
    return;
  }
  const { hosts: ok, bad } = parseHosts(opts.clear ? [] : hosts);
  if (bad.length) throw new Error(`"${bad[0]}" is not a host name. Write it like nexus.example.com, or *.example.com for all of its subdomains.`);
  writeMeta(bp, { ...meta, allowedHosts: ok });
  ui.success(ok.length ? `The squad may reach ${ok.join(', ')} too, from its next step.` : 'The squad reaches only the package registries now, from its next step.');
}

/**
 * `squad config set allow-read <path>` and `allow-write <path>`: a file or folder outside its copy that this
 * project's own commands (tests, setup, the app) may use, when the guard blocked one they truly need. The whole team
 * shares it, saved in `.squad/` where agents cannot change it. `--clear` takes the list away; no path shows it.
 */
export async function runGuardAllow(kind: 'read' | 'write', paths: string[], opts: { clear?: boolean } = {}): Promise<void> {
  const bp = board();
  const meta = readMeta(bp);
  const field = kind === 'read' ? 'allowRead' : 'allowWrite';
  const guard: ProjectGuard = meta.guard ?? {};
  const now = guard[field] ?? [];
  if (!paths.length && !opts.clear) {
    out();
    out(`  ${kleur.bold(`Extra ${kind === 'read' ? 'files the commands may read' : 'folders the commands may write in'}`)}  ${now.length ? now.join(', ') : kleur.gray('none')}`);
    const support = guardSupport();
    out(`  ${kleur.gray(support.on ? `The guard is on: ${support.why}` : `No guard here: ${support.why}`)}`);
    out();
    ui.info(`Allow one: ${cmd(`squad config set allow-${kind} ~/shared`)}   Allow none: ${cmd(`squad config set allow-${kind} --clear`)}`);
    return;
  }
  const next = opts.clear ? [] : [...new Set([...now, ...paths.map((p) => allowPath(p))])];
  const updated: ProjectGuard = { ...guard, [field]: next };
  // Drop empty lists so the setting disappears when nothing is allowed.
  if (!updated.allowRead?.length) delete updated.allowRead;
  if (!updated.allowWrite?.length) delete updated.allowWrite;
  writeMeta(bp, { ...meta, ...(updated.allowRead || updated.allowWrite ? { guard: updated } : { guard: undefined }) });
  ui.success(next.length ? `The project's commands may ${kind} ${next.join(', ')} too, from the next run.` : `The project's commands ${kind} only their copy and the caches now.`);
}

import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { readMeta, writeMeta } from '../board/store.js';
import type { ProjectGuard } from '../board/types.js';
import { DEFAULT_NETWORK, NETWORK_LEVELS, NETWORK_NAME, NETWORK_WORDS, PACKAGE_HOSTS, blockedSites, guardNote, hostsProblem, networkPolicy, parseHosts, parseNetwork, sandboxStatus } from '../engine/sandbox.js';
import { guardSupport, sharedPath } from '../engine/project-guard.js';
import { board } from './board.js';

/**
 * `squad config set hosts`: the hosts the Builder's and Tester's commands may reach besides the official package and
 * download sites, on Strict, shared by the whole team in the project's settings. The same as the list on Harness → Safety.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);

/** Shows the allowed hosts and the sandbox on this computer, or sets the list (the hosts given replace it). */
export async function runHosts(hosts: string[], opts: { clear?: boolean } = {}): Promise<void> {
  const bp = board();
  const meta = readMeta(bp);
  if (!hosts.length && !opts.clear) {
    const now = meta.allowedHosts ?? [];
    const level = parseNetwork(meta.network) ?? DEFAULT_NETWORK;
    out();
    out(`  ${kleur.bold('Network level')}  ${NETWORK_NAME[level]}: ${kleur.gray(NETWORK_WORDS[level])}`);
    out(`  ${kleur.bold('Hosts the project allows')}  ${now.length ? now.join(', ') : kleur.gray('none yet')}`);
    out(`  ${kleur.gray(`Official package and download sites, on Standard and Strict: ${PACKAGE_HOSTS.slice(0, 6).join(', ')} and ${PACKAGE_HOSTS.length - 6} more`)}`);
    if (level === 'standard') out(`  ${kleur.gray('On Standard the squad reaches any other site too, but the known-bad ones: the list counts on Strict.')}`);
    for (const s of sandboxStatus()) out(`  ${kleur.gray(`${s.tool}: ${s.available ? `sandbox on, ${s.why}` : `no sandbox here: ${s.why}`}`)}`);
    const note = guardNote();
    if (note) out(`  ${kleur.yellow(note.title)}  ${note.text}`);
    out();
    ui.info(`Allow a host: ${cmd('squad config set hosts nexus.example.com')}   Allow none: ${cmd('squad config set hosts --clear')}`);
    return;
  }
  const parsed = parseHosts(opts.clear ? [] : hosts);
  const problem = hostsProblem(parsed);
  if (problem) throw new Error(problem);
  const ok = parsed.hosts;
  writeMeta(bp, { ...meta, allowedHosts: ok });
  ui.success(ok.length ? `The squad may reach ${ok.join(', ')} too, from its next step.` : 'The project allows no site of its own now, from the next step: on Strict the squad reaches only the official package and download sites.');
}

/**
 * `squad config set network [standard|strict|off]`: how much of the internet the agents' commands and the project's own
 * commands reach, for the whole team (shared in `.squad/` through git, like the hosts). No level shows it, with the
 * sites refused lately on this computer.
 */
export async function runNetwork(setting: string | undefined): Promise<void> {
  const bp = board();
  const meta = readMeta(bp);
  if (setting === undefined) {
    const now = parseNetwork(meta.network) ?? DEFAULT_NETWORK;
    out();
    for (const l of NETWORK_LEVELS) out(`  ${l === now ? kleur.bold(`● ${l}`) : `○ ${l}`}${' '.repeat(10 - l.length)}${kleur.gray(NETWORK_WORDS[l])}`);
    if (now === 'off' && networkPolicy(now).commands === 'internet') out(`  ${kleur.yellow("On this computer, Off closes the internet for the agents only: the project's own setup, tests and app still reach it.")}`);
    const recent = blockedSites(bp).slice(0, 10);
    if (recent.length) {
      out();
      out(`  ${kleur.bold('Refused lately')}`);
      for (const b of recent) out(`  ${b.host}  ${kleur.gray(`${b.story}, ${NETWORK_NAME[b.level] ?? b.level}, ${b.at.slice(0, 16).replace('T', ' ')}`)}`);
    }
    out();
    ui.info(`Change it: ${cmd('squad config set network standard')} (or strict, off)`);
    return;
  }
  const level = parseNetwork(setting);
  if (!level) throw new Error(`"${setting}" is not a network level. Use standard, strict or off.`);
  writeMeta(bp, { ...meta, network: level });
  ui.success(`The network level is ${NETWORK_NAME[level]} now: ${NETWORK_WORDS[level]} It applies from the next step and the next command.`);
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
  const next = opts.clear ? [] : [...new Set([...now, ...paths.map((p) => sharedPath(p))])];
  const updated: ProjectGuard = { ...guard, [field]: next };
  // Drop empty lists so the setting disappears when nothing is allowed.
  if (!updated.allowRead?.length) delete updated.allowRead;
  if (!updated.allowWrite?.length) delete updated.allowWrite;
  writeMeta(bp, { ...meta, ...(updated.allowRead || updated.allowWrite ? { guard: updated } : { guard: undefined }) });
  ui.success(next.length ? `The project's commands may ${kind} ${next.join(', ')} too, from the next run.` : `The project's commands ${kind} only their copy and the caches now.`);
}

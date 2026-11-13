import kleur from 'kleur';
import { confirm } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { cancelSignIn, connectionsOf, disconnect, signInNow, startSignIn, type ConnectionRow } from '../engine/connections.js';
import { board } from './board.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const grey = (s: string) => kleur.gray(s);

const STATE: Record<ConnectionRow['state'], string> = {
  connected: kleur.green('Connected'),
  'not-connected': kleur.yellow('Not connected'),
  missing: kleur.yellow('Not connected: its tool is not on this computer'),
  unknown: kleur.yellow('Its tool did not answer just now: try squad connect --status again in a moment'),
  soon: grey('Coming in a next version'),
};

/** The Connections page as the terminal prints it. */
export function connectionLines(rows: ConnectionRow[]): string[] {
  const lines: string[] = [];
  for (const r of rows) {
    lines.push('', `  ${kleur.bold(r.label)}  ${STATE[r.state]}${r.account ? ` as ${r.account}` : ''}`, grey(`    ${r.what.en}`));
    if (r.for) lines.push(`    For ${r.for.repo}${r.for.into && r.for.into !== r.for.repo ? `: pull requests into ${r.for.into}` : ''}`);
    if (r.state !== 'connected') r.steps.forEach((s, i) => lines.push(`    ${i + 1}. ${s.text.en}${s.command ? `: ${kleur.green(s.command)}` : ''}${s.done ? grey(` (${s.done.en})`) : ''}`));
    for (const a of r.actions.filter((x) => x.id !== 'check')) lines.push(`    ${a.name}: ${kleur.green(a.command)}`);
  }
  return lines;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `squad connect`: every outside tool and its state (`--status` is the same). `squad connect <tool>`: signs in through
 * the tool's own sign-in: prints its one-time code and page, then waits until you approve it there. Ctrl-C cancels.
 */
export async function runConnect(name: string | undefined, opts: { status?: boolean }): Promise<void> {
  const bp = board();
  if (!name || opts.status) {
    for (const l of connectionLines((await connectionsOf(bp, { again: true })).rows)) out(l);
    out();
    return;
  }
  const f = await startSignIn(bp, name);
  if (f.state === 'failed') throw new Error(f.line ?? 'The sign-in did not start.');
  out();
  out(`  Open ${kleur.underline(f.url ?? '')} and type this code, then press Authorize:`);
  out();
  out(`      ${kleur.bold(f.code ?? '')}`);
  out();
  const stop = () => {
    cancelSignIn(name);
    out();
    ui.info('Cancelled. Nothing changed.');
    process.exit(130);
  };
  process.once('SIGINT', stop);
  const spin = ui.spinner('Waiting for you to approve it…');
  let now = signInNow(name);
  try {
    while (now?.state === 'waiting') {
      await wait(1000);
      now = signInNow(name);
    }
  } finally {
    spin.stop();
    process.off('SIGINT', stop);
  }
  if (now?.state !== 'done') throw new Error(now?.line ?? 'The sign-in did not finish.');
  const row = (await connectionsOf(bp)).rows.find((r) => r.name === name);
  ui.success(`Connected${row?.account ? ` as ${row.account}` : ''}.`);
}

/** `squad disconnect <tool>`: signs the tool out on this computer, for every app that uses it. Asks first, unless --yes. */
export async function runDisconnect(name: string, opts: { yes?: boolean }): Promise<void> {
  const bp = board();
  if (!opts.yes) {
    const asks = process.stdin.isTTY && process.env.CI !== 'true';
    if (!asks) throw new Error(`This signs ${name}'s tool out on this computer, for every app that uses it. To do it: squad disconnect ${name} --yes`);
    const ok = await confirm({ message: `Sign ${name}'s tool out on this computer? Every app here that uses it is signed out too.`, default: false });
    if (!ok) return;
  }
  ui.success((await disconnect(bp, name)).line);
}

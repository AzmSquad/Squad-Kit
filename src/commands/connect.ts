import kleur from 'kleur';
import { confirm, input } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { cancelSignIn, connectionInfo, connectionsOf, disconnect, pickSite, signInNow, startSignIn, type ConnectionRow } from '../engine/connections.js';
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
    lines.push('', `  ${kleur.bold(r.label)}  ${STATE[r.state]}${r.account && r.state === 'connected' ? ` as ${r.account}` : ''}`, grey(`    ${r.what.en}`));
    if (r.for) lines.push(`    For ${r.for.repo}${r.for.into && r.for.into !== r.for.repo ? `: pull requests into ${r.for.into}` : ''}`);
    if (r.line) lines.push(`    ${r.line.en}`);
    if (r.address?.now) lines.push(`    Stories from ${r.address.now}`);
    r.pick?.forEach((p, i) => lines.push(`      ${i + 1}. ${p.name} (${p.site})`));
    if (r.pick?.length) lines.push(`    Pick one: ${kleur.green(`squad connect ${r.name} --site <site>`)}`);
    if (r.address && r.state !== 'connected') lines.push(`    ${r.pick?.length ? 'Not in the list? ' : ''}Paste its address: ${kleur.green(`squad connect ${r.name} --site ${r.address.example}`)}`);
    if (r.token?.open) lines.push(`    Or paste a token: ${kleur.green(r.token.command)}`);
    if (r.state !== 'connected') r.steps.forEach((s, i) => lines.push(`    ${i + 1}. ${s.text.en}${s.command ? `: ${kleur.green(s.command)}` : ''}${s.done ? grey(` (${s.done.en})`) : ''}`));
    for (const a of r.actions.filter((x) => x.id !== 'check')) lines.push(`    ${a.name}: ${kleur.green(a.command)}`);
  }
  return lines;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The sign-in reaches several places and this project has none of its own (a Jira site): `--site`, else a number from
 * the list when a person is at the terminal.
 */
async function pickOne(bp: ReturnType<typeof board>, name: string, row: ConnectionRow, site?: string): Promise<void> {
  const list = row.pick ?? [];
  if (!site) {
    const asks = process.stdin.isTTY && process.env.CI !== 'true';
    const lines = list.map((p, i) => `  ${i + 1}. ${p.name} (${p.site})`);
    if (!asks) throw new Error(`${row.line?.en ?? 'Pick one.'}\n${lines.join('\n')}\nTo pick one: squad connect ${name} --site <site>`);
    out();
    out(`  ${row.line?.en ?? 'Pick one.'}`);
    lines.forEach((l) => out(l));
    const n = await input({ message: `Which one? (1-${list.length})`, validate: (v) => (Number(v) >= 1 && Number(v) <= list.length && Number.isInteger(Number(v)) ? true : `Type a number from 1 to ${list.length}.`) });
    site = list[Number(n) - 1]!.site;
  }
  ui.success((await pickSite(bp, name, site)).line);
}

/**
 * `squad connect`: every outside tool and its state (`--status` is the same). `squad connect <tool>`: signs in through
 * the tool's own sign-in: prints its one-time code and page (or only the page to approve on), then waits until you
 * approve it there. Ctrl-C cancels. `--site`: the place to use when the sign-in reaches several.
 */
export async function runConnect(name: string | undefined, opts: { status?: boolean; site?: string }): Promise<void> {
  const bp = board();
  if (!name || opts.status) {
    for (const l of connectionLines((await connectionsOf(bp, { again: true })).rows)) out(l);
    out();
    return;
  }
  const rowOf = async () => (await connectionsOf(bp)).rows.find((r) => r.name === name);
  // Signed in already, with only the place left to pick or paste: no new sign-in.
  const before = opts.site ? await rowOf() : undefined;
  if (before?.pick?.length) return pickOne(bp, name, before, opts.site);
  if (opts.site && before?.address) {
    ui.success((await pickSite(bp, name, opts.site)).line);
    // The place is set; a sign-in follows only when one is still needed.
    if (!(await rowOf())?.actions.some((a) => a.id === 'sign-in')) return;
  }
  // Ctrl-C stops the tool's sign-in from the start, also while it is still getting its code: the tool leads its own
  // group, so it would not stop with this terminal by itself.
  const stop = () => {
    try {
      cancelSignIn(name);
    } catch {
      // Nothing was started yet.
    }
    out();
    ui.info('Cancelled. Nothing changed.');
    process.exit(130);
  };
  process.once('SIGINT', stop);
  let now: ReturnType<typeof signInNow>;
  try {
    const f = await startSignIn(bp, name);
    if (f.state === 'failed') throw new Error(f.line ?? 'The sign-in did not start.');
    out();
    // The tool's page says what to press: Authorize on GitHub, Continue on Microsoft's, Accept on Atlassian's.
    const page = connectionInfo(name).codePage;
    if (f.code) {
      out(`  Open ${kleur.underline(f.url ?? '')} and type this code, then ${page ? page.then.en : 'press Authorize'}:`);
      out();
      out(`      ${kleur.bold(f.code)}`);
    } else {
      out(`  Open this link, then ${page ? page.then.en : 'approve squad-kit there'}:`);
      out();
      out(`      ${kleur.underline(f.url ?? '')}`);
    }
    out();
    const spin = ui.spinner('Waiting for you to approve it…');
    now = signInNow(name);
    try {
      while (now?.state === 'waiting') {
        await wait(1000);
        now = signInNow(name);
      }
    } finally {
      spin.stop();
    }
  } finally {
    process.off('SIGINT', stop);
  }
  if (now?.state !== 'done') throw new Error(now?.line ?? 'The sign-in did not finish.');
  const row = await rowOf();
  if (row?.pick?.length) return pickOne(bp, name, row, opts.site);
  // Signed in, with the place still to give: never "Connected" before squad-kit reaches it.
  if (row && row.state !== 'connected') {
    ui.info(row.line?.en ?? 'Signed in. Pick the place next.');
    if (row.address) out(`  Paste its address: ${kleur.green(`squad connect ${name} --site ${row.address.example}`)}`);
    return;
  }
  ui.success(`Connected${row?.account ? ` as ${row.account}` : ''}.`);
}

/** `squad disconnect <tool>`: signs the tool out on this computer, for every app that uses it. Asks first, unless --yes. */
export async function runDisconnect(name: string, opts: { yes?: boolean }): Promise<void> {
  const bp = board();
  if (!opts.yes) {
    const asks = process.stdin.isTTY && process.env.CI !== 'true';
    // squad-kit's own sign-in ends for squad-kit only; a tool's own sign-in ends for every app that uses it.
    const own = connectionInfo(name).ownSignIn;
    const what = own ? `This signs squad-kit out of ${name} on this computer. Your other sign-ins stay as they are.` : `This signs ${name}'s tool out on this computer, for every app that uses it.`;
    if (!asks) throw new Error(`${what} To do it: squad disconnect ${name} --yes`);
    const ok = await confirm({ message: own ? `Sign squad-kit out of ${name} on this computer?` : `Sign ${name}'s tool out on this computer? Every app here that uses it is signed out too.`, default: false });
    if (!ok) return;
  }
  ui.success((await disconnect(bp, name)).line);
}

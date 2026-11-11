import kleur from 'kleur';
import { confirm } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { openBoard } from '../board/move.js';
import type { BoardPaths } from '../board/store.js';
import { ACTION_WORDS } from '../engine/tools/catalog.js';
import { checkTools, getToolNow, projectTools, updateToolNow, type ToolLine, type ToolsView } from '../engine/tools/index.js';
import { gettingNow, lastTrouble, type Getting } from '../engine/tools/get.js';
import { boardApi, type BoardApi } from './app.js';

/**
 * `squad tools`: the Tools page in the terminal. What this project needs on this computer, `check` to look again after
 * installing something, `get <tool>` for the tools squad-kit gets itself, and `update <tool>` for your own copy of a
 * tool squad-kit can update safely, after the same warning and a yes. With the board open each command is the board's
 * own REST call, so both show the same; without it, the work runs here.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PRIORITY_WORDS = { required: 'Required', recommended: 'Recommended', optional: 'Optional' } as const;

/** "about 40 s left", or "about 4 min left" for longer. */
const left = (s: number) => (s >= 90 ? `about ${Math.round(s / 60)} min left` : `about ${s} s left`);

function progress(g: Getting): string {
  if (g.step === 'update') return `${(g.words ?? 'updating').toLowerCase()}, ${left(g.secondsLeft)}`;
  const pct = g.total ? ` ${Math.min(99, Math.floor((g.done / g.total) * 100))}%,` : '';
  return g.step === 'unpack' ? `unpacking, ${left(g.secondsLeft)}` : `downloading,${pct} ${left(g.secondsLeft)}`;
}

export function stateWords(l: ToolLine): string {
  switch (l.state) {
    case 'ready':
      return kleur.green(`Ready${l.version ? `, ${l.version}` : ''}`);
    case 'too-old':
      return kleur.yellow(`Too old: found ${l.version ?? 'an old version'}, needs ${l.needs} or newer${l.why ? ` (${l.why})` : ''}`);
    case 'getting':
      return kleur.cyan(`Getting it now${l.getting ? `: ${progress(l.getting)}` : ''}`);
    case 'updating':
      return kleur.cyan(`Updating it now${l.getting ? `: ${progress(l.getting)}` : ''}`);
    case 'not-here':
      return kleur.gray(`Not on this computer: it ${l.notHere ?? 'needs another computer'}`);
    default:
      return kleur.red('Missing');
  }
}

const MARK = { ready: kleur.green('✓'), 'too-old': kleur.yellow('!'), getting: kleur.cyan('↓'), updating: kleur.cyan('↑'), 'not-here': kleur.gray('–'), missing: kleur.red('✗') } as const;

/** The page, line by line, grouped by priority. */
export function printTools(v: ToolsView): void {
  out(v.summary);
  out(kleur.gray(v.checkedAt ? `Checked ${v.checkedAt.slice(0, 16).replace('T', ' ')} on this ${v.system === 'mac' ? 'Mac' : 'computer'}.` : 'Not checked yet.'));
  for (const p of ['required', 'recommended', 'optional'] as const) {
    const lines = v.lines.filter((l) => l.priority === p);
    if (!lines.length) continue;
    out();
    out(kleur.bold(PRIORITY_WORDS[p]));
    for (const l of lines) {
      out(`  ${MARK[l.state]} ${kleur.bold(l.name)}  ${stateWords(l)}`);
      out(kleur.gray(`      ${l.gives}. Used for: ${l.usedFor}`));
      if (l.blocks.length) out(kleur.yellow(`      Stops now: ${l.blocks.map((a) => ACTION_WORDS[a]).join(', ')}. Everything else keeps working.`));
      if (l.note) out(`      ${l.note}`);
      // Ready goes on only when an update is recommended: its steps follow.
      if ((l.state === 'ready' && !l.recommended) || l.state === 'not-here' || l.state === 'updating') continue;
      if (l.trouble) out(kleur.red(`      ${l.trouble}`));
      if (l.installer === 'squad-kit') {
        if (l.state !== 'getting') out(`      squad-kit gets it: ${cmd(l.command)}`);
        continue;
      }
      if (l.update) {
        out(`      squad-kit can update it: ${cmd(l.update.command)}`);
        out(kleur.gray(`      ${l.update.warning}`));
        out('      Or do it yourself:');
      } else if (l.cantUpdate) out(`      ${l.cantUpdate}`);
      else if (l.reason) out(`      You ${l.recommended ? 'update' : 'install'} it: squad-kit can't, as ${l.reason}.`);
      l.steps.forEach((s, i) => out(`        ${i + 1}. ${s}`));
      out(`      Official page: ${kleur.underline(l.link)}`);
    }
  }
  out();
  out(`After you install something: ${cmd('squad tools check')}`);
}

/**
 * Follows a download or an update until its line is Ready or says why not, and says one outcome only: never "is ready"
 * and a failure together. An update is about its own line; a download also about the tools that came with it.
 */
async function follow(read: () => Promise<ToolsView>, id: string, again = `squad tools get ${id}`): Promise<boolean> {
  const updating = again.includes(' update ');
  let last = '';
  for (;;) {
    const v = await read();
    const l = v.lines.find((x) => x.id === id);
    const g = v.getting;
    if (g) {
      const words = `${g.step === 'update' ? 'Updating' : 'Getting'} ${g.name}: ${progress(g)}`;
      if (words !== last) ui.step(words);
      last = words;
      await sleep(1000);
      continue;
    }
    // The tools that came with it, and the check after, are done too.
    const trouble = l?.trouble ?? (updating ? undefined : v.lines.find((x) => x.trouble)?.trouble);
    if (l?.state === 'ready' && !trouble) {
      ui.success(`${l.name} ${l.version ?? ''} is ready.`.replace(' .', '.'));
      return true;
    }
    if (v.checking) {
      await sleep(500);
      continue;
    }
    if (!trouble && l?.state === 'too-old') ui.failure(`${l.name} ${l.version ?? ''} is still too old: it needs ${l.needs} or newer. The steps: ${cmd('squad tools')}`.replace('  ', ' '));
    else ui.failure(trouble ?? `squad-kit could not ${updating ? 'update' : 'get'} it. Try again: ${cmd(again)}`);
    return false;
  }
}

/** Yes or no in the terminal; tests answer it themselves. */
export type Ask = (message: string) => Promise<boolean>;
const askHere: Ask = (message) => confirm({ message, default: false });

/**
 * One `squad tools` call on a project: through the open board's API when there is one, here otherwise. True when it
 * did what was asked.
 */
export async function toolsWith(bp: BoardPaths, api: BoardApi | null, action: string | undefined, tool: string | undefined, opts: { yes?: boolean; ask?: Ask } = {}): Promise<boolean> {
  const what = (action ?? 'show').trim().toLowerCase();
  const read = () => (api ? api.call<ToolsView>('GET', '/tools') : projectTools(bp));
  if (what === 'show' || what === 'list') {
    printTools(await read());
    return true;
  }
  if (what === 'check') {
    ui.step("Checking this computer's tools…");
    if (api) printTools(await api.call<ToolsView>('POST', '/tools/check'));
    else {
      await checkTools();
      printTools(await projectTools(bp));
    }
    return true;
  }
  if (what === 'get') {
    if (!tool) throw new Error(`Say which tool, for example: squad tools get maestro`);
    const id = tool.trim().toLowerCase();
    if (api) {
      await api.call<ToolsView>('POST', `/tools/${encodeURIComponent(id)}/get`);
      return follow(read, id);
    }
    getToolNow(id);
    ui.info('squad-kit is not open, so the download runs here. Keep this terminal open until it is done.');
    const ok = await follow(async () => {
      const v = await projectTools(bp);
      // Here the download runs in this process: its state is read straight from it.
      return { ...v, getting: gettingNow(), lines: v.lines.map((l) => ({ ...l, ...(lastTrouble(l.id) ? { trouble: lastTrouble(l.id) } : {}) })) };
    }, id);
    return ok;
  }
  if (what === 'update') {
    if (!tool) throw new Error(`Say which tool, for example: squad tools update flutter`);
    const id = tool.trim().toLowerCase();
    const l = (await read()).lines.find((x) => x.id === id);
    // The same warning as the board's, then a yes. Without one, the engine says why it can't, and nothing runs.
    let ok = Boolean(opts.yes);
    if (l?.update) {
      out(kleur.yellow(l.update.warning));
      if (!ok) {
        if (!opts.ask && !ui.isInteractive()) throw new Error(`squad-kit updates ${l.name} only after you say OK. To say it here: squad tools update ${id} --yes`);
        ok = await (opts.ask ?? askHere)(`Update ${l.name} for all projects?`);
        if (!ok) {
          ui.info(`Not now. ${l.name} stays as it is.`);
          return true;
        }
      }
    }
    if (api) {
      await api.call<ToolsView>('POST', `/tools/${encodeURIComponent(id)}/update`, { ok });
      return follow(read, id, `squad tools update ${id}`);
    }
    await updateToolNow(bp, id, { ok });
    ui.info('squad-kit is not open, so the update runs here. Keep this terminal open until it is done.');
    return follow(async () => {
      const v = await projectTools(bp);
      // Here the update runs in this process: its state is read straight from it.
      return { ...v, getting: gettingNow(), lines: v.lines.map((x) => ({ ...x, ...(lastTrouble(x.id) ? { trouble: lastTrouble(x.id) } : {}) })) };
    }, id, `squad tools update ${id}`);
  }
  throw new Error(`squad tools ${what}: there is no such action. Use squad tools, squad tools check, squad tools get <tool>, or squad tools update <tool>.`);
}

/** `squad tools [check | get <tool> | update <tool> [--yes]]` */
export async function runTools(action: string | undefined, tool: string | undefined, opts: { yes?: boolean } = {}): Promise<void> {
  const { bp } = openBoard(buildPaths(requireSquadRoot()).squadDir);
  const ok = await toolsWith(bp, boardApi(bp), action, tool, { yes: Boolean(opts.yes) });
  if (!ok) process.exitCode = 1;
}

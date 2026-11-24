import type { BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import { ACTION_DOING } from './catalog.js';
import { toolWaitOf } from './hold.js';
import { androidLines, foundNow, linesFor, metaOf, placesFor, type ToolBlock, type ToolLine } from './index.js';
import { TOOLS_CHECKING, waitsForTools } from './wait-words.js';

/**
 * A story that waits for a tool, as the Squad lead reads it: what is missing and why, in the Tools page's own words,
 * each way on with the steps (squad-kit gets it, updates it, the person installs it, or their own Android Studio), and
 * the way around it when there is one (Skip Android builds). The lead explains from these and offers the buttons they
 * name; the person presses them.
 */

const numbered = (xs: string[]) => xs.map((s, i) => `${i + 1}. ${s}`).join(' ');

function stateWords(l: ToolLine): string {
  if (l.state === 'ready') return `it is here${l.version ? `, ${l.version}` : ''}`;
  if (l.state === 'too-old') return `${l.version ?? 'the one here'} is too old: it needs ${l.needs} or newer${l.why ? ` (${l.why})` : ''}`;
  if (l.state === 'getting') return 'squad-kit is getting it now';
  if (l.state === 'updating') return 'squad-kit is updating it now';
  if (l.state === 'not-here') return `it can't run on this computer: it ${l.notHere ?? 'needs another computer'}`;
  return "it isn't on this computer";
}

/** What one tool line says the person can do about it, as facts with the board action that does it. */
function waysFor(l: ToolLine): string[] {
  const out: string[] = [];
  if ((l.state === 'missing' || l.state === 'too-old') && l.installer === 'squad-kit') {
    const license = l.license && !l.license.accepted;
    out.push(
      license
        ? `squad-kit gets it itself, but only after the person reads Google's license on the Tools page and presses Accept there; then Get it (board action get_tool, tool ${l.id})${l.size ? `. It takes ${l.size}` : ''}.`
        : `squad-kit gets it itself: Get it (board action get_tool, tool ${l.id})${l.size ? `. It takes ${l.size}` : ''}.`,
    );
  }
  if (l.update) out.push(`squad-kit can update it: Update (board action update_tool, tool ${l.id}). ${l.update.warning}`);
  else if (l.cantUpdate) out.push(l.cantUpdate);
  if (l.studioSteps?.length) out.push(`Or with the person's own Android Studio, which is on this computer: ${numbered(l.studioSteps)}`);
  if (l.installer === 'you' || (l.state === 'too-old' && !l.update)) out.push(`${l.state === 'too-old' ? 'To update it' : 'To install it'} yourself: ${numbered(l.steps)} Official page: ${l.link}`);
  return out;
}

/** What a story waits for, with the Tools page's lines of those tools; null when it waits for no tool. */
export function toolWaitLines(bp: BoardPaths, t: Ticket): { block: ToolBlock; lines: ToolLine[] } | null {
  if (!waitsForTools(t.status) || t.status === TOOLS_CHECKING) return null;
  const block = toolWaitOf(bp, t).toolWait;
  if (!block || block.checking) return null;
  const meta = metaOf(bp);
  const book = foundNow();
  const places = placesFor(bp, () => meta, t);
  const all = book ? [...linesFor(places, book, book.system), ...androidLines(places, book)] : [];
  const lines = block.tools.map((x) => all.find((l) => l.id === x.id)).filter((l): l is ToolLine => Boolean(l));
  return { block, lines };
}

/** The facts of a tool wait, for the lead: empty when the story waits for no tool. */
export function toolWaitFacts(bp: BoardPaths, t: Ticket): string[] {
  if (!waitsForTools(t.status) || t.status === TOOLS_CHECKING) return [];
  const w = toolWaitLines(bp, t);
  if (!w) return [`It waits for a tool on this computer: ${t.status}.`];
  const { block, lines } = w;
  const out = [`It waits for a tool on this computer before it can ${ACTION_DOING[block.action]}: ${block.text} Nothing failed, and no try is counted: it goes on by itself once ${block.tools.length === 1 ? "it's" : "they're"} there.`];
  for (const l of lines) {
    out.push(`- ${l.name}: ${stateWords(l)}.${l.note ? ` ${l.note}` : ''}`);
    for (const w of waysFor(l)) out.push(`  ${w}`);
  }
  if (block.steps?.length) out.push(`The person adds them in their own Android Studio: ${numbered(block.steps)}`);
  if (block.skip) out.push(`Or go around it: ${block.skip.label} (board action skip_android). ${block.skip.note}`);
  out.push(`Its line on the Tools page: ${block.link}.`);
  return out;
}

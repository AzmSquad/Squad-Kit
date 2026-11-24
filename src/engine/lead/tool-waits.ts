import { listTickets, type BoardPaths } from '../../board/store.js';
import { toolWaitLines } from '../tools/wait-facts.js';
import { actionCard } from './cards.js';
import type { LeadCard, NeedsYouItem } from './types.js';

/**
 * "Needs you" for a story that waits for a tool on this computer: the lead says it by itself, in the Tools page's own
 * words, with the buttons that move it on: Get it or Update when squad-kit can do it, and Skip Android builds when the
 * wait is a check that builds the Android app. Each needs the person's press; the item opens the tool's line.
 */

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The stories that wait for a tool, apart from those already listed. */
export function toolWaitItems(bp: BoardPaths, seen: Set<string>): NeedsYouItem[] {
  const out: NeedsYouItem[] = [];
  for (const t of listTickets(bp)) {
    if (seen.has(t.id) || t.stage === 'done' || t.archived) continue;
    const w = toolWaitLines(bp, t);
    if (!w) continue;
    const { block, lines } = w;
    const prefix = `now.${t.id}`;
    const cards: LeadCard[] = [];
    for (const l of lines) {
      // squad-kit's own tools: Get it brings one, or a newer one beside the person's own that is too old (FVM).
      if ((l.state === 'missing' || l.state === 'too-old') && l.installer === 'squad-kit' && !(l.license && !l.license.accepted)) cards.push(actionCard(`${prefix}.get_tool.${l.id}`, 'get_tool', { tool: l.id, why: `squad-kit gets ${l.name} itself${l.size ? `. It takes ${l.size}` : ''}.` }));
      if (l.update) cards.push(actionCard(`${prefix}.update_tool.${l.id}`, 'update_tool', { tool: l.id, why: l.update.warning }));
    }
    if (block.skip) cards.push(actionCard(`${prefix}.skip_android`, 'skip_android', { why: block.skip.note }));
    const what = block.status.replace(/\. (?:Goes on by itself|It can't go on).*$/, '');
    const many = block.tools.length > 1;
    out.push({
      id: `${prefix}.tools`,
      story: t.id,
      title: t.title,
      kind: 'other',
      words: `${t.id} ${what.charAt(0).toLowerCase()}${what.slice(1)}.`,
      more: cut(`${block.text} Nothing failed: it goes on by itself once ${many ? "they're" : "it's"} there.`, 240),
      cards: cards.slice(0, 4),
      open: block.link,
    });
  }
  return out;
}

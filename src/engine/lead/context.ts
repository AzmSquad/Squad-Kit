import { readTicket, type BoardPaths } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import { scrubbed } from './notes.js';
import { recentTrouble, storyLog, storyNow } from './story.js';
import type { LeadContext } from './types.js';

/**
 * Where a question was asked from, with its facts filled in by squad-kit itself: a story's state, its stop card and
 * checks, the slow or stuck facts and its log lines; an error page's words and squad-kit's latest errors. The person
 * never has to describe the problem: pressing "Ask the lead" on it is enough.
 */

/** The log lines a question starts with; the lead can read more itself. */
const FIRST_LOG_LINES = 15;

/** The story the context is about, when there is one on the board. */
export function contextStory(bp: BoardPaths, ctx: LeadContext): Ticket | null {
  const id = ctx.from === 'story' ? ctx.story : ctx.from === 'problem' ? ctx.story : undefined;
  return id ? readTicket(bp, id) : null;
}

/** The facts of where it was asked from, as lines, secrets taken out. */
export function contextFacts(bp: BoardPaths, ctx: LeadContext): string[] {
  const t = contextStory(bp, ctx);
  const lines: string[] = [];
  if ((ctx.from === 'story' || ctx.from === 'problem') && (ctx.from === 'story' || ctx.story) && !t) lines.push(`There is no story ${ctx.from === 'story' ? ctx.story : ctx.story} on this board.`);
  if (ctx.from === 'app') lines.push(`The page the person was on: ${ctx.path}${ctx.app ? `, in ${ctx.app}` : ''}.`);
  if (ctx.from === 'board' && ctx.page) lines.push(`The board page the person was on: ${ctx.page}.`);
  if (ctx.from === 'problem' && ctx.error) lines.push(`The error the person saw: ${scrubbed(bp, ctx.error)}`);
  if (t) {
    lines.push(...storyNow(bp, t));
    const log = storyLog(bp, t.id).slice(-FIRST_LOG_LINES);
    if (log.length) lines.push(`squad-kit's latest log lines for ${t.id}:`, ...log);
  } else if (ctx.from === 'problem') {
    const log = recentTrouble(bp).slice(-FIRST_LOG_LINES);
    if (log.length) lines.push("squad-kit's latest errors and warnings:", ...log);
  }
  return lines;
}

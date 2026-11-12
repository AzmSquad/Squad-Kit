import os from 'node:os';
import { readMeta, readTicket, type BoardPaths } from '../../board/store.js';
import { readInstalledPackage } from '../../core/package-info.js';
import { NEVER } from '../report.js';
import { scrubbed } from './notes.js';
import { recentTrouble, storyLog, storyNow } from './story.js';
import type { LeadContext, LeadConversation } from './types.js';

/**
 * "Prepare a report for an engineer": when the lead cannot fix it, a short report of what happened, the steps it
 * took, squad-kit's log lines and the versions, for the person to copy. No secrets: it is scrubbed like the log and
 * Report a problem. Nothing is sent: sending it is the person's own step.
 */

/** The story a conversation is about, from where it was asked or the story it named. */
function storyOf(c: LeadConversation): string | undefined {
  const ctx: LeadContext = c.context;
  if (ctx.from === 'story') return ctx.story;
  if (ctx.from === 'problem' && ctx.story) return ctx.story;
  for (const t of c.turns) for (const s of t.answer?.sources ?? []) if (s.kind === 'story') return s.ref;
  return c.story;
}

function where(ctx: LeadContext): string {
  switch (ctx.from) {
    case 'board':
      return `the board${ctx.page ? `, on ${ctx.page}` : ''}`;
    case 'app':
      return `the app${ctx.app ? ` ${ctx.app}` : ''}, on ${ctx.path}`;
    case 'story':
      return `story ${ctx.story}`;
    case 'problem':
      return `a "${ctx.problem}" card${ctx.story ? ` on ${ctx.story}` : ''}`;
  }
}

export function engineerReport(bp: BoardPaths, c: LeadConversation, at = new Date()): string {
  const meta = readMeta(bp);
  const id = storyOf(c);
  const t = id ? readTicket(bp, id) : null;
  const lines: string[] = [
    `# For an engineer: ${meta.project}`,
    '',
    `Prepared by squad-kit's Squad lead on ${at.toISOString().slice(0, 16).replace('T', ' ')}. Nothing was sent. ${NEVER}`,
    '',
    '## What happened',
    '',
    `Asked from ${where(c.context)}.`,
  ];
  if (c.context.from === 'problem' && c.context.error) lines.push('', 'The error on the page:', '', c.context.error);
  for (const turn of c.turns) {
    lines.push('', `Question: ${turn.ask.text}`);
    if (turn.answer) lines.push(`Answer: ${turn.answer.headline}`, turn.answer.body);
    if (turn.error) lines.push(`No answer: ${turn.error}`);
  }
  if (t) lines.push('', `## ${t.id} now`, '', ...storyNow(bp, t));
  lines.push('', '## The steps the lead took', '');
  for (const turn of c.turns) for (const s of turn.trace) lines.push(`- ${s.at.slice(11, 19)} ${s.text}`);
  const log = t ? storyLog(bp, t.id) : recentTrouble(bp);
  lines.push('', `## squad-kit's log${t ? ` for ${t.id}` : ', errors and warnings'}`, '', ...(log.length ? log : ['Nothing in the log for the last three days.']));
  lines.push('', '## Versions', '', `squad-kit ${readInstalledPackage().version}, Node ${process.version}, ${os.type()} ${os.release()} (${os.arch()})`);
  return scrubbed(bp, lines.join('\n'));
}

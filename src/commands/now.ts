import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { openBoard } from '../board/move.js';
import { boardExists, requireTicket, type BoardPaths } from '../board/store.js';
import { keepWaiting } from '../board/actions.js';
import { liveNow, type LiveNow } from '../board/now.js';
import { readUsual } from '../board/usual.js';
import { answerAsk, type AskOffer } from '../board/ask.js';
import type { Ticket } from '../board/types.js';

/**
 * The live status in the terminal: the same words as the board's card and Now tab, the Ask box as `squad ask`, and
 * "Give it 10 more minutes" as `squad wait --more 10m`.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const amber = (s: string) => kleur.yellow(s);

function board(): BoardPaths {
  const { bp } = openBoard(buildPaths(requireSquadRoot()).squadDir);
  if (!boardExists(bp)) throw new Error('This project has no board yet. Run `squad demo` to try squad-kit v1 with a sample board.');
  return bp;
}

/** ▰▰▰▱▱▱ for the step bar. */
function barText(now: LiveNow): string {
  return (now.bar ?? []).map((b) => (b === 'done' ? kleur.green('▰') : b === 'now' ? kleur.green('▰') : kleur.gray('▱'))).join('');
}

/** The ticket's live status as lines for the terminal, like the card and the Now tab on the board. */
export function nowLines(t: Ticket, now: LiveNow): string[] {
  const lines: string[] = [];
  const pad = '       ';
  if (now.state === 'working') {
    lines.push(`  ${kleur.bold('Now')}  ${now.line}`);
    lines.push(`${pad}${kleur.gray(now.time ?? '')}${now.bar?.length ? `   ${barText(now)}` : ''}`);
    lines.push(`${pad}${now.sentence}`);
    if (now.next) lines.push(`${pad}${kleur.gray('Next:')} ${now.next}`);
  } else {
    lines.push(`  ${kleur.bold('Now')}  ${now.state === 'you' ? amber(now.sentence) : now.sentence}`);
    if (now.next && now.state !== 'you') lines.push(`${pad}${now.next}`);
  }
  const s = now.slow;
  if (s) {
    lines.push('');
    lines.push(`  ${amber(s.title)}  ${kleur.gray(s.where)}`);
    lines.push(`${pad}${s.text}`);
    for (const f of s.facts) lines.push(`${pad}${kleur.gray(`${f.label}:`)} ${f.value}`);
    if (s.limit) lines.push(`${pad}${kleur.gray(s.limit)}`);
    const ways = s.kind === 'stuck' && s.canEnd ? [`squad unstick ${t.id}`] : [`squad wait ${t.id} --more 10m`];
    lines.push(`${pad}${[...ways, `squad stop ${t.id} --again`, `squad stop ${t.id}`].map(cmd).join(kleur.gray('   or   '))}`);
  }
  return lines;
}

/** `squad status <ticket>`: what is happening on it now. */
export async function runTicketStatus(ticketId: string): Promise<void> {
  const bp = board();
  const t = requireTicket(bp, ticketId);
  out();
  out(`  ${kleur.bold(t.id)}  ${kleur.bold(t.title)}`);
  for (const l of nowLines(t, liveNow(t, readUsual(bp)))) out(l);
  out();
}

function offerCommand(t: Ticket, o: AskOffer, question: string): string {
  const q = `"${question.replace(/"/g, '\\"')}"`;
  switch (o.do) {
    case 'propose':
      return `squad propose ${t.id} ${q}`;
    case 'note':
      return o.to ? `squad message ${t.id} --to ${o.to} ${q}` : `squad note ${t.id} ${q}`;
    case 'chat':
      return `squad chat ${t.id} --with ${o.to}`;
    case 'stop':
      return `squad stop ${t.id}`;
  }
}

/** `squad ask <ticket> <question>`: status questions answered at once from the live record, with no AI cost. */
export async function runAsk(ticketId: string, words: string[]): Promise<void> {
  const question = words.join(' ').trim();
  if (!question) throw new Error('Ask a question, for example: squad ask SK-12 "is there a problem?"');
  const bp = board();
  const t = requireTicket(bp, ticketId);
  const usual = readUsual(bp);
  const a = answerAsk(t, liveNow(t, usual), usual, question);
  out();
  out(`  ${kleur.bold('squad-kit')}${a.instant ? kleur.gray(a.lang === 'ar' ? '  إجابة فورية' : '  answered at once') : ''}`);
  for (const l of a.lines) out(`  ${l}`);
  if (a.offers.length) {
    out();
    for (const o of a.offers) out(`  ${o.label}${'note' in o ? kleur.gray(`  ${o.note}`) : ''}\n    ${cmd(offerCommand(t, o, question))}`);
  }
  out();
}

/** "1h", "10m", "90s" or a bare number of minutes, in minutes. */
export function parseMinutes(text: string | undefined): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(h|hours?|m|min|mins|minutes?|s|sec|seconds?)?\s*$/i.exec(text ?? '10');
  if (!m) throw new Error(`"${text}" is not a time. Use minutes, like --more 10m.`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit.startsWith('h') ? n * 60 : unit.startsWith('s') ? n / 60 : n;
}

/** `squad wait <ticket> --more 10m`: "Give it 10 more minutes" on a slow step. Its hard limit stays. */
export async function runWait(ticketId: string, opts: { more?: string }): Promise<void> {
  const bp = board();
  const minutes = Math.max(1, Math.round(parseMinutes(opts.more)));
  const t = keepWaiting(bp, ticketId, minutes);
  const limit = t.clock?.limit;
  ui.success(`OK, waiting. squad-kit stays quiet about ${t.id} for ${minutes} minute${minutes === 1 ? '' : 's'}.${limit ? ` The step still stops at ${limit} minutes.` : ''}`);
}

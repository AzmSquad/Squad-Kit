import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { readMeta, readTicket, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { costOverview, ticketCost, type TicketCost } from '../board/cost.js';
import { whatHappened } from '../board/happened.js';
import { howPaid, type PaymentInfo } from '../board/payment.js';
import { parseUsd, setBudget } from '../board/budget.js';
import { durationWords } from '../board/usual.js';
import { setPaymentChoice } from '../core/settings.js';
import { changedFiles } from '../console/api/cost.js';
import { QUALITY_NOTE } from '../engine/levels.js';
import { board } from './board.js';

/**
 * The Cost tab and "What happened" in the terminal: `squad show` prints both, `squad cost` the month, the budgets
 * and the averages per Quality setting, and `squad config set payment` and `squad config set budget` change them.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const amber = (s: string) => kleur.yellow(s);
const usd = (n: number) => (n < 0.005 ? 'under $0.01' : `$${n.toFixed(2)}`);
const pct = (share: number) => `${Math.round(share * 100)}%`;

function clock(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

/** "Claude Pro (found)", "API key (you set it)". */
function paidWords(p: PaymentInfo): string {
  const how = p.payment === 'subscription' ? `your ${p.name} plan` : 'an API key, paid per use';
  const why = p.from === 'you' ? 'you set it' : p.from === 'found' ? `${p.tool} says ${p.found?.label ?? 'so'}` : 'squad-kit could not tell, so it assumes a plan';
  return `${how} (${why})`;
}

/** The cost lines of `squad show`: the way the person pays first, then the size, where it went and the budget. */
export function costLines(c: TicketCost): string[] {
  const lines: string[] = [];
  const value = c.total.costUsd;
  if (c.payment.payment === 'subscription') {
    lines.push(`  ${kleur.bold('Cost')}  ${kleur.green(`Included in your ${c.payment.name} plan. No extra charge.`)}`);
    if (value !== undefined) lines.push(kleur.gray(`        Value of the work at API prices: ${usd(value)}. A value, not a bill. This month: ${usd(c.month.total.costUsd ?? 0)} of AI work for ${c.project}.`));
  } else {
    const b = c.budget;
    const spent = value !== undefined ? usd(value) : 'not reported';
    const of = b?.ticketUsd ? `, ${pct(b.ticketShare ?? 0)} of its ${usd(b.ticketUsd)} budget` : '';
    lines.push(`  ${kleur.bold('Cost')}  ${spent} on your API key${of}`);
    const month = b?.monthUsd ? `${usd(b.monthSpent)} of your ${usd(b.monthUsd)} budget (${pct(b.monthShare ?? 0)})` : usd(b?.monthSpent ?? c.month.total.costUsd ?? 0);
    lines.push(kleur.gray(`        This month for ${c.project}: ${month}`));
    for (const k of b?.over ?? []) lines.push(`        ${amber(k === 'ticket' ? 'Over its budget: the ticket waits for you before its next step.' : "Over this month's budget: tickets wait for you before their next step.")}`);
    for (const k of b?.warn ?? []) lines.push(`        ${amber(k === 'ticket' ? 'At 80% of its budget.' : "At 80% of this month's budget.")}`);
  }
  if (c.size) lines.push(`  ${kleur.bold('Size')}  ${c.size.size[0]!.toUpperCase()}${c.size.size.slice(1)}: ${c.size.words.charAt(0).toLowerCase()}${c.size.words.slice(1)}${c.why ? ` ${c.why}` : ''}`);
  if (c.where.parts.length) lines.push(`  ${kleur.bold('Where the work went')}  ${c.where.parts.map((p) => `${p.name} ${p.share < 0.01 ? 'under 1%' : pct(p.share)}`).join(' · ')}`);
  if (c.tip) lines.push(kleur.gray(`  Tip: ${c.tip}`));
  if (c.details.models) lines.push(kleur.gray(`  For engineers: ${c.details.models}${c.details.tokens ? `. ${c.details.tokens}` : ''}`));
  return lines;
}

/** The "What happened" lines of `squad show`: one per step, with its time and what it did. */
export function happenedLines(bp: BoardPaths, t: Ticket): string[] {
  const h = whatHappened(bp, t, { files: () => changedFiles(bp, t.id) });
  if (!h.steps.length) return [];
  const lines = [`  ${kleur.bold('What happened')}${h.seconds ? kleur.gray(`  ${h.steps.length} steps · ${durationWords(h.seconds)} in all`) : ''}`];
  for (const s of h.steps) {
    const mark = s.running ? kleur.green('●') : kleur.green('✓');
    const when = s.running ? 'now  ' : s.to ? clock(s.to) : '     ';
    const time = s.seconds !== undefined ? durationWords(s.seconds) : '';
    const notes = [time, ...s.notes].filter(Boolean).join(' · ');
    lines.push(`    ${mark} ${kleur.gray(when)}  ${s.name}${notes ? kleur.gray(`  ${notes}`) : ''}`);
    lines.push(`             ${s.summary}`);
  }
  return lines;
}

/** `squad cost [ticket]`: a ticket's cost, or the month, the budgets and the averages per Quality setting. */
export async function runCost(ticketId: string | undefined): Promise<void> {
  const bp = board();
  const pay = await howPaid(bp);
  if (ticketId) {
    const t = readTicket(bp, ticketId);
    if (!t) throw new Error(`No ticket ${ticketId.toUpperCase()} on this board.`);
    out();
    for (const l of costLines(ticketCost(bp, t, pay))) out(l);
    out();
    return;
  }
  const o = costOverview(bp, pay);
  out();
  out(`  ${kleur.bold('You pay with')}  ${paidWords(pay)}`);
  const month = o.month.total.costUsd ?? 0;
  out(
    pay.payment === 'subscription'
      ? `  ${kleur.bold('This month')}  ${usd(month)} of AI work for ${o.project} at API prices, covered by your plan. A value, not a bill.`
      : `  ${kleur.bold('This month')}  ${usd(month)}${o.budget.monthUsd ? ` of your ${usd(o.budget.monthUsd)} budget` : ''} for ${o.project}`,
  );
  if (pay.payment === 'api-key') {
    out(`  ${kleur.bold('Budgets')}  ${o.budget.ticketUsd ? `${usd(o.budget.ticketUsd)} per ticket` : 'none per ticket'} · ${o.budget.monthUsd ? `${usd(o.budget.monthUsd)} per month` : 'none per month'}`);
    for (const w of o.warnings) {
      const who = w.kind === 'ticket' ? `${w.id} ${w.title}` : 'This month';
      out(`    ${amber(w.over ? '●' : '○')} ${who}: ${usd(w.spent)} of ${usd(w.limit)} (${pct(w.share)})${w.over ? amber('. Waits for you before its next step') : ''}`);
    }
  }
  out();
  out(`  ${kleur.bold('Per Quality setting')}  ${kleur.gray(`average per accepted ticket on ${o.project}, once a setting has ${o.qualityAfter}`)}`);
  for (const q of o.quality) {
    const ready = q.tickets >= o.qualityAfter;
    const avg = ready ? [q.costUsd !== undefined ? `${usd(q.costUsd)} ${pay.payment === 'subscription' ? 'value' : 'each'}` : '', q.seconds !== undefined ? `${durationWords(q.seconds)} of squad time` : ''].filter(Boolean).join(', ') : `${q.tickets} of ${o.qualityAfter} tickets so far`;
    out(`    ${q.quality.padEnd(9)} ${avg}  ${kleur.gray(QUALITY_NOTE[q.quality])}`);
  }
  out();
  ui.info(`Change how you pay: ${cmd('squad config set payment subscription')} (or api-key, auto). Budgets: ${cmd('squad config set budget --ticket 5 --month 50')}`);
}

/** `squad config set payment [subscription|api-key|auto]`: show or set how the person pays for the AI. */
export async function runConfigPayment(mode: string | undefined): Promise<void> {
  const bp = board();
  if (mode === undefined) {
    const pay = await howPaid(bp);
    out();
    out(`  You pay with ${paidWords(pay)}.`);
    out();
    ui.info(`Change it: ${cmd('squad config set payment subscription')} (or api-key, or auto to let squad-kit find out)`);
    return;
  }
  const m = mode.trim().toLowerCase().replace(/^api$|^key$|^apikey$/, 'api-key').replace(/^plan$/, 'subscription');
  if (m !== 'subscription' && m !== 'api-key' && m !== 'auto') throw new Error(`"${mode}" is not a way to pay. Use subscription, api-key or auto.`);
  setPaymentChoice(m);
  const pay = await howPaid(bp);
  ui.success(
    m === 'auto'
      ? `squad-kit finds out how you pay: ${paidWords(pay)}.`
      : m === 'subscription'
        ? `Subscription: the Cost tab shows the value of the work, with no extra charge.`
        : `API key: the Cost tab shows real dollars. Set budgets: ${cmd('squad config set budget --ticket 5 --month 50')}`,
  );
}

/** `squad config set budget [--ticket <usd|off>] [--month <usd|off>]`: show or set the budgets, for an API key. */
export async function runConfigBudget(opts: { ticket?: string; month?: string }): Promise<void> {
  const bp = board();
  if (opts.ticket === undefined && opts.month === undefined) {
    const b = readMeta(bp).budget ?? {};
    out();
    out(`  Per ticket: ${b.ticketUsd ? usd(b.ticketUsd) : 'none'}   Per month: ${b.monthUsd ? usd(b.monthUsd) : 'none'}`);
    out(kleur.gray('  Budgets count when you pay with an API key. At 80% the ticket and the board say so; at 100% the ticket waits for you between two steps.'));
    out();
    ui.info(`Change them: ${cmd('squad config set budget --ticket 5 --month 50')} (off takes one away)`);
    return;
  }
  const change: { ticketUsd?: number | null; monthUsd?: number | null } = {};
  if (opts.ticket !== undefined) change.ticketUsd = parseUsd(opts.ticket);
  if (opts.month !== undefined) change.monthUsd = parseUsd(opts.month);
  const b = setBudget(bp, change);
  const pay = await howPaid(bp);
  ui.success(`Budgets: ${b.ticketUsd ? `${usd(b.ticketUsd)} per ticket` : 'none per ticket'}, ${b.monthUsd ? `${usd(b.monthUsd)} per month` : 'none per month'}.`);
  if (pay.payment !== 'api-key') ui.info(`They count when you pay with an API key. You pay with ${paidWords(pay)}.`);
}

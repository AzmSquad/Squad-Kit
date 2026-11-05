import { addActivity, now, readTicket, type BoardPaths } from './store.js';
import type { AgentQuestion, Ticket } from './types.js';
import { addDecided, askWords } from './auto.js';
import { allStories, readBreakdown } from './requirements.js';
import { SUGGESTED } from '../engine/auto-prompts.js';

/**
 * The sample squad on the Builds by itself track: a few scripted "Decided for you" lines, and the one stop the sample
 * board shows (the canvas's Stop screen): the court portal's refund story clashes with how the portal refunds court
 * fees today, which an earlier ticket built. No AI runs.
 */

/** True once the Architect stopped for the clash on this ticket: its answer carries the work on. */
function askedBefore(t: Ticket): boolean {
  return t.activity.some((a) => a.who === 'architect' && a.text.startsWith('Asked you:'));
}

/** The earlier ticket that built cancelling a hearing, from the same breakdown, when there is one. */
function cancelTicket(bp: BoardPaths, t: Ticket): { id: string; title: string } | null {
  const b = t.breakdown ? readBreakdown(bp, t.breakdown.id) : null;
  const s = b ? allStories(b).find(({ story }) => /cancel/i.test(story.title) && story.key !== t.breakdown!.item && story.ticket && readTicket(bp, story.ticket)) : undefined;
  return s ? { id: s.story.ticket!, title: s.story.title } : null;
}

/** What the person answered to the BRD's own refund clash (4.4 against 6.3), when the breakdown asked it. */
function refundAnswer(bp: BoardPaths, t: Ticket): 'full' | 'late-kept' | null {
  const q = t.breakdown ? readBreakdown(bp, t.breakdown.id)?.questions.find((x) => x.id === 'q1' && /refund/i.test(x.text)) : undefined;
  const choice = q?.answer?.choice;
  if (!choice || choice === 'Other') return null;
  return /48 hours/.test(choice) ? 'late-kept' : 'full';
}

/**
 * A story about refunds stops at the plan: the BRD (section 4.4, and the person's answer) sends the fee back to the
 * card that paid, but cancelling a hearing today keeps it as credit for the lawyer's next booking, as an earlier
 * ticket built it. Changes `t` in place; true when it stopped.
 */
export function demoClash(bp: BoardPaths, t: Ticket): boolean {
  if (t.track !== 'auto' || !/refund/i.test(t.title) || askedBefore(t)) return false;
  const earlier = cancelTicket(bp, t);
  const answer = refundAnswer(bp, t);
  const built = earlier ? `That was built in ${earlier.id} (${earlier.title})` : 'That was built in an earlier ticket';
  const rule = answer === 'late-kept' ? 'goes back to the card that paid, unless a party cancels less than 48 hours before' : 'goes back in full to the card that paid';
  const text = `Cancelling a hearing today keeps the court fee as credit for the lawyer's next booking. ${built}. The BRD says the fee ${rule}. Which one is right from now on?`;
  const sources: NonNullable<AgentQuestion['sources']> = [
    { text: 'BRD 4.4 Refunds, page 3', section: '4.4', page: 3 },
    ...(answer ? [{ text: 'Your answer to question 1' }] : []),
    ...(earlier ? [{ text: `${earlier.id} ${earlier.title}`, ticket: earlier.id }] : []),
  ];
  t.agentQuestion = {
    from: 'architect',
    text,
    options: [
      `Refund to the card that paid, as the BRD says. Change how the portal refunds today ${SUGGESTED}`,
      'Keep the credit for the next booking. Update this story and the breakdown',
      'Refund to the card for hearings booked from this release on. Keep the credit for the ones booked before',
    ],
    // Which stories wait for the answer, the board works out from the breakdown.
    why: 'This changes where lawyers and parties get their money back, so the squad does not guess.',
    kind: 'clash',
    sources,
    at: now(),
  };
  const words = askWords('Architect', 'clash');
  t.live = false;
  t.squad = null;
  t.status = words.status;
  t.waiting = { kind: 'ask', summary: words.summary };
  addActivity(t, 'architect', `Read the code and found that cancelling a hearing keeps the fee as credit, as ${earlier ? earlier.id : 'an earlier ticket'} built it`);
  addActivity(t, 'architect', `Asked you: ${text}`);
  return true;
}

/** One scripted "Decided for you" line from the Architect (with the design) or the Builder (when the build ends). */
export function demoDecided(t: Ticket, by: 'architect' | 'builder'): void {
  const refund = /refund/i.test(t.title);
  const text = refund
    ? by === 'architect'
      ? 'The refund goes back to the card that paid.'
      : 'The lawyer gets an email and an SMS when the fee is refunded.'
    : by === 'architect'
      ? 'It goes on the screens people already use, not on a new page.'
      : 'Each message on the screen says in one line what to do next.';
  addDecided(t, by, [text]);
}

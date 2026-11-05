import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, draftRelease, readTicket, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { tick } from '../src/board/engine.js';
import * as actions from '../src/board/actions.js';
import { stopOf } from '../src/board/auto.js';
import type { Ticket } from '../src/board/types.js';

/** The sample squad on the Builds by itself track: from the breakdown to merged with no person, and the refund stop. */

let tmp: string;
let bp: BoardPaths;

const STORY = {
  id: 'BR-1',
  item: 'S-3',
  story: 'As a guest, I want to see my bookings, so I know where I stay.',
  criteria: [{ given: 'a guest with two bookings', when: 'they open My bookings', then: 'both show' }],
  approvedBy: 'Momen',
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-auto-demo-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Runs the sample squad until the ticket reaches the state. `never` must not happen on the way. */
async function until(id: string, done: (t: Ticket) => boolean, never?: (t: Ticket) => boolean): Promise<Ticket> {
  for (let i = 0; i < 600; i += 1) {
    tick(bp);
    const t = readTicket(bp, id)!;
    if (never?.(t)) throw new Error(`${id} stopped on the way: ${t.status}`);
    if (done(t)) return t;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`${id} never reached the expected state`);
}

describe('the sample squad on the Builds by itself track', () => {
  it('takes a story from the breakdown to merged with no person, and says what it decided', async () => {
    const t0 = actions.createTicket(bp, { title: 'Show my bookings', fromBreakdown: STORY });
    const t = await until(t0.id, (x) => Boolean(x.mergedAt), (x) => Boolean(x.waiting));
    const lines = t.activity.map((a) => a.text);
    expect(t.stage).toBe('release');
    expect(t.status).toBe(`Merged into main · goes out in ${t.release}`);
    expect(draftRelease(bp)?.tickets).toContain(t0.id);
    expect(t.gates).toMatchObject({ checks: 'pass', review: 'pass', proof: 'pass' });
    expect(lines).toContain('Builds by itself: no questions, the story was approved with the breakdown');
    expect(lines.some((l) => l.startsWith('Builds by itself: approved the plan on its own'))).toBe(true);
    expect(lines).toContain('Checks and review passed: accepted by itself');
    expect(lines).toContain('Merged into main');
    expect(lines).not.toContain('Checked the proof. Looks right');
    expect(t.decided!.map((d) => `${d.id} ${d.by}`)).toEqual(['d1 architect', 'd2 builder']);
    expect(t.decided![0]).toMatchObject({ item: 'S-3', ticket: t0.id, text: 'It goes on the screens people already use, not on a new page.' });
  });

  it('stops a refund story at the plan with a clash, and carries on once it is answered', async () => {
    const t0 = actions.createTicket(bp, { title: 'Refund on cancel', fromBreakdown: { ...STORY, item: 'S-14' } });
    const asked = await until(t0.id, (x) => x.waiting?.kind === 'ask');
    const q = asked.agentQuestion!;
    expect(q).toMatchObject({ from: 'architect', kind: 'clash' });
    // The court portal's own words: its BRD (and the person's answer to question 1) against how it refunds today.
    expect(q.text).toBe("Cancelling a hearing today keeps the court fee as credit for the lawyer's next booking. That was built in an earlier ticket. The BRD says the fee goes back in full to the card that paid. Which one is right from now on?");
    expect(JSON.stringify(q)).not.toMatch(/guest|stay|24 hours/i);
    expect(q.options).toHaveLength(3);
    expect(q.options[0]).toBe('Refund to the card that paid, as the BRD says. Change how the portal refunds today (suggested)');
    expect(q.sources).toEqual([{ text: 'BRD 4.4 Refunds, page 3', section: '4.4', page: 3 }, { text: 'Your answer to question 1' }]);
    expect(asked.waiting).toEqual({ kind: 'ask', summary: 'Two parts clash' });
    expect(asked.status).toBe('Needs you: two parts clash');
    expect(stopOf(asked)).toBe('clash');
    expect(asked.stage).toBe('specs');
    expect(asked.steps).toBeUndefined();

    actions.answerAgent(bp, t0.id, q.options[0]!);
    const t = await until(t0.id, (x) => Boolean(x.mergedAt), (x) => Boolean(x.waiting));
    expect(t.activity.map((a) => a.text)).toContain(`Carried on with your answer: ${q.options[0]}`);
    expect(t.decided!.map((d) => d.text)).toEqual(['The refund goes back to the card that paid.', 'The lawyer gets an email and an SMS when the fee is refunded.']);
  });
});

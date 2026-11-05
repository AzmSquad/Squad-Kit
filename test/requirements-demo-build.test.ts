import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readTicket, type BoardPaths } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { tick } from '../src/board/engine.js';
import * as actions from '../src/board/actions.js';
import { allStories, readBreakdown, readBreakdownState, storyProgress } from '../src/board/requirements.js';
import { approveBreakdown } from '../src/board/requirements-actions.js';
import { setBuild } from '../src/board/requirements-build.js';
import { requestSend } from '../src/board/requirements-send.js';
import { demoSendTracker } from '../src/board/requirements-tracker.js';
import { setParallelLimit } from '../src/core/settings.js';

/**
 * The sample squad builds the court portal's breakdown by itself, end to end: two stories at a time in the order of
 * their needs, the refund story stops for a clash and only the story that needs it waits, the rest merge, and once
 * the clash is answered every story merges and Build continuously turns off. The send runs beside it.
 */

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-brd-demo-build-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 1000 });
  setParallelLimit(2);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const states = () => {
  const b = readBreakdown(bp, 'BR-1')!;
  return new Map(storyProgress(bp, b, readBreakdownState(bp, 'BR-1')).map((p) => [p.key, p]));
};

/** Plays the sample squad (and its sends) until `done` holds. Never more than two of BR-1's stories build at once. */
async function play(done: () => boolean): Promise<number> {
  let most = 0;
  for (let i = 0; i < 6000 && !done(); i += 1) {
    tick(bp, { sends: true });
    most = Math.max(most, [...states().values()].filter((p) => p.state === 'building').length);
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(done()).toBe(true);
  return most;
}

describe('the sample squad builds a breakdown by itself', () => {
  it('builds BR-1 story by story; the refund clash stops only itself and the story that needs it', async () => {
    approveBreakdown(bp, 'BR-1');
    const stories = allStories(readBreakdown(bp, 'BR-1')!).map(({ story }) => story);
    const refund = stories.find((s) => /refund/i.test(s.title))!;
    const needsRefund = stories.filter((s) => s.dependsOn.includes(refund.key)).map((s) => s.key);
    expect(refund.key).toBe('S-12');
    expect(needsRefund).toEqual(['S-18']);
    setBuild(bp, 'BR-1', true);
    requestSend(bp, 'BR-1');

    const others = stories.filter((s) => s.key !== refund.key && !needsRefund.includes(s.key)).map((s) => s.key);
    const most = await play(() => others.every((k) => states().get(k)?.state === 'merged') && states().get(refund.key)?.state === 'needs-you');
    expect(most).toBeLessThanOrEqual(2);
    const s = states();
    expect(s.get(refund.key)).toMatchObject({ state: 'needs-you', stop: 'clash', line: 'Needs you: two parts clash' });
    expect(s.get('S-18')).toMatchObject({ state: 'waits', waitsOn: ['S-12'] });
    expect(readBreakdownState(bp, 'BR-1').build).toMatchObject({ on: true, held: 'The next stories wait for S-12 to merge. S-12 needs you.', heldFor: 'waits' });
    // The send ran beside it, and the stories' tickets moved to their items.
    expect(readBreakdownState(bp, 'BR-1').sync).toMatchObject({ status: 'done' });
    expect(demoSendTracker(bp)!.items.size).toBe(3 + 7 + 20);
    const t = readTicket(bp, s.get('S-1')!.ticket!)!;
    expect(t).toMatchObject({ track: 'auto', breakdown: { id: 'BR-1', item: 'S-1' }, source: { type: 'azure', ref: expect.stringMatching(/^AB#\d+$/) } });

    // The person answers the clash: the refund story carries on, then the one that needed it.
    const stop = readTicket(bp, s.get(refund.key)!.ticket!)!;
    // The clash names the earlier ticket that built cancelling a hearing, and where it all comes from.
    const cancel = s.get('S-5')!.ticket!;
    expect(stop.agentQuestion!.text).toContain(`That was built in ${cancel} (Cancel or move a hearing).`);
    expect(stop.agentQuestion!.sources).toEqual([
      { text: 'BRD 4.4 Refunds, page 3', section: '4.4', page: 3 },
      { text: 'Your answer to question 1' },
      { text: `${cancel} Cancel or move a hearing`, ticket: cancel },
    ]);
    actions.answerAgent(bp, stop.id, stop.agentQuestion!.options[0]!);
    await play(() => !readBreakdownState(bp, 'BR-1').build?.on);
    expect([...states().values()].every((p) => p.state === 'merged')).toBe(true);
    expect(readBreakdownState(bp, 'BR-1').activity[0]).toMatchObject({ who: 'squad', text: 'All 20 stories are merged. Send the release out from Releases.' });
  }, 120_000);
});

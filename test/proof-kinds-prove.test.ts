import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

/**
 * The person changes how a "done when" is proved, with the chip's menu on the spec, one REST call or `squad prove`.
 * Only before the spec is approved; never away from Screen on a line squad-kit locked; Not on a screen only with a
 * reason. Ask for changes after the approval carries the kinds, and a change cannot unlock a line.
 */

const { boardPaths, readTicket, updateTicket } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { proveLine, kindNamed, kindsOpen } = await import('../src/board/prove.js');
const { mountProveApi } = await import('../src/console/api/prove.js');
const { buildPaths } = await import('../src/core/paths.js');
const { LOCK_NOTE, SEES_WHY } = await import('../src/board/proof-lock.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-prove-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A spec waiting for the person, with the Analyst's kinds. */
function specWaiting(withKinds = true): string {
  const t = actions.createTicket(bp, { title: 'Pay by card when booking', ask: 'Customers pay by card when they confirm a booking.' });
  updateTicket(bp, t.id, (x) => {
    x.stage = 'specs';
    x.live = false;
    x.story = 'As a customer, I want to pay by card, so my booking is kept.';
    x.criteria = [
      { given: 'I confirm a booking', when: 'I pay by card', then: 'I see Paid and my receipt number', ...(withKinds ? { proof: { kind: 'screen' as const, why: SEES_WHY, locked: true } } : {}) },
      { given: 'a payment', when: 'it goes through', then: 'the booking is saved as paid, with its amount', ...(withKinds ? { proof: { kind: 'api' as const } } : {}) },
      { given: 'a card', when: 'it is used', then: 'card numbers are never saved', ...(withKinds ? { proof: { kind: 'screen' as const } } : {}) },
    ];
    x.waiting = { kind: 'spec', summary: 'The spec is ready: is this what you want?' };
  });
  return t.id;
}

describe('squad prove: the person picks the kind before approving', () => {
  it('changes a kind, keeps it in the spec file, and says so on the story', () => {
    const id = specWaiting();
    const t = proveLine(bp, id, 2, 'data');
    expect(t.criteria![1]!.proof).toEqual({ kind: 'data' });
    expect(readTicket(bp, id)!.criteria![1]!.proof).toEqual({ kind: 'data' });
    expect(fs.readFileSync(path.join(bp.ticketsDir, id, 'spec.md'), 'utf8')).toContain('   Proof: data');
    expect(t.activity.map((a) => a.text)).toContain('"Done when" 2 is proved by Data now');
    expect(kindNamed('API call')).toBe('api');
    expect(kindNamed('Not on a screen')).toBe('none');
    expect(kindNamed('nope')).toBeNull();
  });

  it('never moves a locked line away from Screen', () => {
    const id = specWaiting();
    expect(() => proveLine(bp, id, 1, 'data')).toThrow(LOCK_NOTE);
    expect(proveLine(bp, id, 1, 'screen').criteria![0]!.proof).toEqual({ kind: 'screen', why: SEES_WHY, locked: true });
  });

  it('takes Not on a screen only with a reason', () => {
    const id = specWaiting();
    expect(() => proveLine(bp, id, 3, 'none')).toThrow('Say why it cannot be shown');
    expect(proveLine(bp, id, 3, 'none', 'Nothing to show. The Reviewer checks the code.').criteria![2]!.proof).toEqual({ kind: 'none', why: 'Nothing to show. The Reviewer checks the code.' });
    // Picked again with no new words, the reason stays.
    expect(proveLine(bp, id, 3, 'none').criteria![2]!.proof?.why).toBe('Nothing to show. The Reviewer checks the code.');
  });

  it('is read only once the spec is approved, and checks the line and the kind', () => {
    const id = specWaiting();
    expect(() => proveLine(bp, id, 9, 'data')).toThrow('has "done when" 1 to 3');
    expect(() => proveLine(bp, id, 2, 'pictures')).toThrow('Choose one of');
    updateTicket(bp, id, (x) => (x.live = true));
    expect(() => proveLine(bp, id, 2, 'data')).toThrow('writing the spec');
    updateTicket(bp, id, (x) => {
      x.live = false;
      x.specApproved = { by: 'Momen', at: '2026-11-13T10:00:00Z' };
      x.waiting = { kind: 'plan', summary: 'The design is ready' };
    });
    expect(kindsOpen(readTicket(bp, id)!)).toBe(false);
    expect(() => proveLine(bp, id, 2, 'data')).toThrow('Ask for changes to change it');
  });

  it('an old spec with no kinds gets them on the first pick: the others stay pictures, as before', () => {
    const id = specWaiting(false);
    const t = proveLine(bp, id, 2, 'test');
    expect(t.criteria!.map((c) => c.proof?.kind)).toEqual(['screen', 'test', 'screen']);
  });

  it('is one REST call, the same as the terminal', async () => {
    const id = specWaiting();
    const app = new Hono();
    mountProveApi(app, { paths: buildPaths(tmp) });
    const post = (body: object) => app.request(`/api/v1/tickets/${id}/prove`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const ok = await post({ line: 2, kind: 'test' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { criteria: { proof: unknown }[] }).criteria[1]!.proof).toEqual({ kind: 'test' });
    const locked = await post({ line: 1, kind: 'none', why: 'x' });
    expect(locked.status).toBe(400);
    expect(((await locked.json()) as { error: string }).error).toBe(LOCK_NOTE);
  });

  it('in the terminal: squad prove lists the lines, and changes one', async () => {
    const id = specWaiting();
    let said = '';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((said += String(s)), true));
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const { runProve } = await import('../src/commands/prove.js');
      await runProve(id, undefined, undefined, {});
      await runProve(id, '3', 'none', { why: 'Nothing to show.' });
    } finally {
      process.chdir(cwd);
      out.mockRestore();
    }
    expect(said).toContain('1. I see Paid and my receipt number  Screen, kept by squad-kit');
    expect(said).toContain('squad prove');
    expect(readTicket(bp, id)!.criteria![2]!.proof).toEqual({ kind: 'none', why: 'Nothing to show.' });
  });
});

describe('Ask for changes after the approval', () => {
  it('carries the kinds, takes a new one the Analyst gives, and keeps a locked line on Screen', () => {
    const id = specWaiting();
    const t = readTicket(bp, id)!;
    const parts = actions.changeParts(t, {
      summary: 'Prove line 2 with a test',
      size: 'small',
      why: 'Only the proof changes.',
      story: '',
      criteria: [
        { number: 2, action: 'change', given: 'a payment', when: 'it goes through', then: 'the booking is saved as paid, with its amount', proof: { kind: 'test', why: 'A rule.' } },
        { number: 1, action: 'change', given: 'I confirm a booking', when: 'I pay by card', then: 'I see Paid and my receipt number', proof: { kind: 'none', why: 'no' } },
        { number: 0, action: 'add', given: 'a refund', when: 'staff approve it', then: 'the money goes back' },
      ],
    });
    expect(parts).toHaveLength(2);
    expect(parts[0]!.criterion!.proof).toEqual({ kind: 'test', why: 'A rule.' });
    expect(parts[0]!.after).toContain('Proved by: Test.');
    // A new line on a spec with kinds is a picture unless the Analyst says otherwise.
    expect(parts[1]!.criterion!.proof).toEqual({ kind: 'screen' });
  });
});

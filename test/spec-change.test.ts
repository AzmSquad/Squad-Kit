import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * Asking never stops the work, and a change goes through the spec. The AI tool is a fake that answers by the shape it
 * is asked for; a Builder run can be held open, so a test can talk, propose and approve while the Builder works.
 */

const calls: RunOptions[] = [];
const queue: Record<string, unknown[]> = {};
const held: { opts: RunOptions; done(structured?: unknown): void }[] = [];
let hold = false;

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    const kind = kindOf(opts);
    const session = opts.resume ?? opts.sessionId ?? '';
    if (kind === 'build' && hold) {
      return new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'stopped', text: '', sessionId: session } as RunResult));
        held.push({ opts, done: (structured = { summary: 'built' }) => resolve({ ok: true, structured, text: '', sessionId: session } as RunResult) });
      });
    }
    return { ok: true, structured: queue[kind]?.shift() ?? { summary: 'done' }, text: '', sessionId: session } as RunResult;
  },
}));

const store = await import('../src/board/store.js');
const { boardPaths, readMeta, readTicket, updateTicket, writeMeta, listTickets, removeTicket, ticketDir } = store;
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths } = await import('../src/core/paths.js');

function kindOf(o: RunOptions): string {
  if (o.schema === P.CHAT_SCHEMA) return 'chat';
  if (o.schema === P.CHANGE_SCHEMA) return 'change';
  if (o.schema === P.CHANGE_DESIGN_SCHEMA) return 'design';
  if (o.schema === P.BUILD_SCHEMA) return 'build';
  return 'other';
}

type Ticket = import('../src/board/types.js').Ticket;
type Squad = {
  tick(): void;
  step(id: string, phase: string): Promise<void>;
  chatReply(id: string): Promise<void>;
  phaseFor(t: Ticket): string;
  pickUpChange(t: Ticket): void;
};

let tmp: string;
let wt: string;
let bp: ReturnType<typeof boardPaths>;
let squads: { start(): () => void }[] = [];

beforeEach(() => {
  calls.length = 0;
  held.length = 0;
  hold = false;
  for (const k of Object.keys(queue)) delete queue[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-change-'));
  wt = path.join(tmp, 'copy');
  fs.mkdirSync(wt);
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  // Only this test's tickets, so the squad's limit and order are this test's own.
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', parallel: 3 });
});

afterEach(() => {
  for (const h of held) h.done();
  squads = [];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function until(ok: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const squadOf = () => new LiveSquad(bp) as unknown as Squad;
const due = () => new Date(Date.now() - 1000).toISOString();
const get = (id: string) => readTicket(bp, id)!;

/** A ticket the Builder works on: spec and design approved, its copy made, two "done when" and three steps. */
function building(title = 'Limit bookings'): Ticket {
  const t0 = actions.createTicket(bp, { title, ask: 'One person blocks the whole day.' });
  return updateTicket(bp, t0.id, (x) => {
    x.stage = 'implement';
    x.live = true;
    x.waiting = null;
    x.squad = { phase: 'build', nextAt: due() };
    x.worktree = wt;
    x.sessions = { intake: 'i-1', build: 'b-1' };
    x.specApproved = { by: 'Momen', at: new Date().toISOString() };
    x.story = 'As a clerk, I want at most 3 bookings a day per person, so the day stays fair.';
    x.criteria = [
      { given: 'a person with 3 bookings today', when: 'they book again', then: 'it is refused' },
      { given: 'a refused booking', when: 'the clerk looks', then: 'the clerk sees why' },
    ];
    x.steps = [
      { title: 'Count the bookings per person', status: 'todo' },
      { title: 'Refuse the fourth booking', status: 'todo' },
      { title: 'Write the tests', status: 'todo' },
    ];
  });
}

/** Moves a proposal straight to "proposed", as the Analyst would write it. */
function proposed(id: string, size: 'small' | 'big', extra = 'The manager can raise the limit for one person'): Ticket {
  actions.proposeChange(bp, id, extra);
  return updateTicket(bp, id, (x) => {
    const c = actions.openChange(x)!;
    Object.assign(c, {
      status: 'proposed',
      size,
      summary: extra,
      why: size === 'big' ? 'It needs a new screen.' : 'The design still holds.',
      parts: actions.changeParts(x, { summary: extra, size, why: '', story: '', criteria: [{ number: 0, action: 'add', given: 'a manager', when: 'they raise the limit', then: extra.toLowerCase() }] }),
    });
  });
}

describe('asking never stops the work', () => {
  it('the Analyst answers while the Builder builds; the build goes on and moves the ticket on', async () => {
    const t0 = building();
    hold = true;
    const squad = squadOf();
    squad.tick();
    await until(() => held.length === 1, 'the Builder starts');

    let t = actions.startChat(bp, t0.id, 'analyst');
    expect(t.chat).toMatchObject({ with: 'analyst', beside: true, thinking: true });
    expect(t.stopRequested).toBeUndefined();
    queue.chat = [{ reply: 'The Builder is on the first step. The limit is 3 a day.', ready: true }];
    squad.tick();
    await until(() => get(t0.id).chat?.thinking === false, 'the Analyst answers');

    const chat = calls.find((c) => kindOf(c) === 'chat')!;
    expect(chat.sessionId).toBeTruthy();
    expect([chat.sessionId, chat.resume]).not.toContain('i-1');
    expect([chat.sessionId, chat.resume]).not.toContain('b-1');
    expect(chat.allowedTools).not.toContain('Edit');
    expect(chat.addDirs).toContain(wt);
    // The Builder was neither stopped nor paused, and the ticket stays with the squad.
    expect(held[0]!.opts.signal?.aborted).toBe(false);
    t = get(t0.id);
    expect(t.live).toBe(true);
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('build');
    expect(t.chat!.messages.at(-1)!.text).toContain('first step');

    actions.sendChat(bp, t0.id, 'Does a cancelled booking count?');
    queue.chat = [{ reply: 'No.', ready: false }];
    squad.tick();
    await until(() => get(t0.id).chat?.thinking === false, 'the second answer');
    expect(calls.filter((c) => kindOf(c) === 'chat').at(-1)!.resume).toBe(get(t0.id).chat!.side);

    // The build ends while the chat is open: the ticket moves on to the checks as if nobody talked.
    held[0]!.done();
    await until(() => get(t0.id).squad?.phase === 'test', 'the checks come next');
    t = get(t0.id);
    expect(t.stage).toBe('test');
    expect(t.chat!.open).toBe(true);
    t = actions.chatDone(bp, t0.id);
    expect(t.squad?.phase).toBe('test');
    expect(t.waiting).toBeNull();
  });

  it('a chat reply starts even when the squad is at its limit', async () => {
    // A limit of two: both Builders take it up, and the third ticket's chat still gets its answer.
    writeMeta(bp, { ...readMeta(bp), parallel: 2 });
    const a = building('First');
    const b = building('Second');
    const c = actions.createTicket(bp, { title: 'Third' });
    updateTicket(bp, c.id, (x) => {
      x.squad = null;
      x.live = false;
      x.story = 'As a clerk…';
      x.waiting = { kind: 'spec', summary: 'The spec is ready' };
    });
    hold = true;
    const squad = squadOf();
    squad.tick();
    await until(() => held.length === 2, 'two Builders work');
    expect(held.map((h) => h.opts.cwd)).toEqual([wt, wt]);
    actions.startChat(bp, c.id, 'analyst');
    queue.chat = [{ reply: 'Hello', ready: false }];
    squad.tick();
    await until(() => get(c.id).chat?.thinking === false, 'the Analyst answers on the third ticket');
    expect(get(a.id).live).toBe(true);
    expect(get(b.id).live).toBe(true);
  });
});

describe('a change goes through the spec', () => {
  it('needs an approved spec, takes one change at a time, and the spec keeps its record', () => {
    const t0 = actions.createTicket(bp, { title: 'Limit bookings' });
    expect(() => actions.proposeChange(bp, t0.id, 'Allow 5')).toThrow(/not written yet/);
    updateTicket(bp, t0.id, (x) => {
      x.story = 'As a clerk…';
      x.waiting = { kind: 'spec', summary: '' };
    });
    expect(() => actions.proposeChange(bp, t0.id, 'Allow 5')).toThrow(/still waits for your approval/);
    const t1 = building();
    expect(() => actions.proposeChange(bp, t1.id, '  ')).toThrow(/what should change/);
    const t = actions.proposeChange(bp, t1.id, 'Allow 5 a day');
    expect(actions.openChange(t)).toMatchObject({ id: 'c1', status: 'writing', ask: 'Allow 5 a day', by: 'Momen' });
    expect(t.activity[0]!.text).toBe('Proposed change c1: Allow 5 a day');
    expect(() => actions.proposeChange(bp, t1.id, 'And 6')).toThrow(/one change at a time/);
    expect(fs.readFileSync(path.join(ticketDir(bp, t1.id), 'spec.md'), 'utf8')).toContain('### c1: writing');
    expect(actions.changeNeedsYou(t)).toBe(false);
  });

  it('the Analyst writes the old and new words beside the work, then a small one reaches the Builder at the end of its step', async () => {
    const t0 = building();
    hold = true;
    const squad = squadOf();
    squad.tick();
    await until(() => held.length === 1, 'the Builder starts');

    actions.proposeChange(bp, t0.id, 'Allow 5 bookings, not 3');
    queue.change = [
      {
        summary: 'The limit goes from 3 to 5 bookings a day',
        size: 'small',
        why: 'Only the number changes; the design still holds.',
        story: 'As a clerk, I want at most 5 bookings a day per person, so the day stays fair.',
        criteria: [{ number: 1, action: 'change', given: 'a person with 5 bookings today', when: 'they book again', then: 'it is refused' }],
      },
    ];
    squad.tick();
    await until(() => actions.openChange(get(t0.id))?.status === 'proposed', 'the Analyst writes it');
    const write = calls.find((c) => kindOf(c) === 'change')!;
    expect(write.allowedTools).not.toContain('Edit');
    expect(write.sessionId).not.toBe('i-1');
    expect(write.prompt).toContain('"Allow 5 bookings, not 3"');
    expect(write.prompt).toContain('1. Given a person with 3 bookings today, when they book again, then it is refused.');
    let t = get(t0.id);
    let c = actions.openChange(t)!;
    expect(c).toMatchObject({ size: 'small', summary: 'The limit goes from 3 to 5 bookings a day' });
    // The old words come from the ticket itself.
    expect(c.parts).toEqual([
      { part: 'story', before: 'As a clerk, I want at most 3 bookings a day per person, so the day stays fair.', after: 'As a clerk, I want at most 5 bookings a day per person, so the day stays fair.' },
      {
        part: 'criterion',
        index: 0,
        before: 'Given a person with 3 bookings today, when they book again, then it is refused.',
        after: 'Given a person with 5 bookings today, when they book again, then it is refused.',
        criterion: { given: 'a person with 5 bookings today', when: 'they book again', then: 'it is refused' },
      },
    ]);
    expect(actions.changeNeedsYou(t)).toBe(true);
    expect(actions.inbox(bp).map((x) => x.id)).toContain(t0.id);
    expect(t.live).toBe(true);
    expect(held[0]!.opts.signal?.aborted).toBe(false);

    t = actions.approveChange(bp, t0.id);
    c = actions.openChange(t)!;
    expect(c.status).toBe('approved');
    expect(c.decided).toMatchObject({ by: 'Momen', approved: true });
    expect(t.story).toContain('at most 5 bookings');
    expect(t.criteria![0]!.given).toBe('a person with 5 bookings today');
    expect(t.activity[0]!.text).toContain('it reaches the Builder at the end of its current step');
    const spec = fs.readFileSync(path.join(ticketDir(bp, t0.id), 'spec.md'), 'utf8');
    expect(spec).toContain('### c1: small, approved');
    expect(spec).toContain('- Done when 1 was: Given a person with 3 bookings today');
    expect(spec).toContain('- Approved by: Momen');
    // The step that runs keeps going with what it had.
    expect(held[0]!.opts.prompt).not.toContain('Allow 5');

    held[0]!.done();
    await until(() => held.length === 2, 'the Builder gets the change next');
    const next = held[1]!.opts;
    expect(next.resume).toBe('b-1');
    expect(next.prompt).toContain('The person approved a small change to the spec while you worked (change c1)');
    expect(next.prompt).toContain('"Done when" 1 said "Given a person with 3 bookings today, when they book again, then it is refused." and now says');
    expect(actions.openChange(get(t0.id))!.status).toBe('building');
    held[1]!.done();
    await until(() => get(t0.id).squad?.phase === 'test', 'the checks come next');
    t = get(t0.id);
    expect(t.changes![0]!.status).toBe('done');
    expect(actions.openChange(t)).toBeUndefined();
    expect(t.activity.some((a) => a.who === 'builder' && a.text.startsWith('Made change c1'))).toBe(true);
  });

  it('a small change approved while others work goes to the Builder before the next step, and the proof waits for it', async () => {
    const t0 = building();
    proposed(t0.id, 'small');
    actions.approveChange(bp, t0.id);
    const squad = squadOf();
    // A Builder step takes it in its own prompt; any other step waits for a Builder step of its own first.
    expect(squad.phaseFor({ ...get(t0.id), squad: { phase: 'fix', nextAt: due() } })).toBe('fix');
    expect(squad.phaseFor({ ...get(t0.id), squad: { phase: 'proof', nextAt: due() } })).toBe('change-build');
    expect(squad.phaseFor({ ...get(t0.id), squad: { phase: 'review', nextAt: due() } })).toBe('change-build');

    // The proof waits for you, but it does not show the change: it is taken back and the change goes in now.
    updateTicket(bp, t0.id, (x) => {
      x.squad = null;
      x.live = false;
      x.stage = 'review';
      x.waiting = { kind: 'proof', summary: 'The proof is ready' };
    });
    expect(() => actions.approve(bp, t0.id)).toThrow(/Change c1 is still open/);
    squad.pickUpChange(get(t0.id));
    let t = get(t0.id);
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('change-build');
    await squad.step(t0.id, 'change-build');
    const run = calls.filter((c) => kindOf(c) === 'build').at(-1)!;
    expect(run.resume).toBe('b-1');
    expect(run.prompt).toContain('approved a small change');
    t = get(t0.id);
    expect(t.changes![0]!.status).toBe('done');
    expect(t.squad?.phase).toBe('test');
    expect(t.gates).toEqual({ checks: 'pending', review: 'pending', proof: 'pending' });
  });

  it('a big change pauses the Builder after its step; the Architect updates the design; the Builder redoes only what changed', async () => {
    const t0 = building();
    hold = true;
    const squad = squadOf();
    squad.tick();
    await until(() => held.length === 1, 'the Builder starts');
    proposed(t0.id, 'big');
    let t = actions.approveChange(bp, t0.id);
    expect(actions.openChange(t)!.status).toBe('approved');
    // Not in the spec yet: it goes in with the new design.
    expect(t.criteria).toHaveLength(2);
    expect(t.activity[0]!.text).toContain('The Builder pauses after its current step');

    // The current step finishes as it was.
    held[0]!.done();
    await until(() => get(t0.id).squad?.phase === 'test', 'the build step ends');
    queue.design = [
      {
        summary: 'A manager screen to raise the limit, and the refusal reads the person’s own limit.',
        steps: [
          { title: 'Count the bookings per person', change: 'same' },
          { title: 'Refuse a booking over the person’s own limit', change: 'changed' },
          { title: 'Add a manager screen to raise the limit', change: 'new' },
          { title: 'Write the tests', change: 'changed' },
        ],
      },
    ];
    updateTicket(bp, t0.id, (x) => (x.squad!.nextAt = due()));
    squad.tick();
    await until(() => get(t0.id).waiting?.kind === 'change', 'the design update waits for you');
    const design = calls.find((c) => kindOf(c) === 'design')!;
    expect(design.resume).toBe('i-1');
    expect(design.allowedTools).not.toContain('Edit');
    expect(design.addDirs).toContain(wt);
    expect(design.prompt).toContain('The Builder has built part of the approved design');
    expect(design.prompt).toContain('1. Count the bookings per person (built)');
    t = get(t0.id);
    let c = actions.openChange(t)!;
    expect(c.status).toBe('design-ready');
    expect(c.paused).toEqual({ phase: 'test' });
    expect(c.design!.before).toEqual(['Count the bookings per person', 'Refuse the fourth booking', 'Write the tests']);
    expect(t.live).toBe(false);
    expect(t.squad).toBeNull();
    // Nothing else ran while it waited: no checks, no review.
    expect(calls.filter((x) => kindOf(x) === 'other')).toHaveLength(0);
    expect(fs.readFileSync(path.join(ticketDir(bp, t0.id), 'spec.md'), 'utf8')).toContain('- Step 3, new: Add a manager screen to raise the limit');

    t = actions.approve(bp, t0.id);
    c = actions.openChange(t)!;
    expect(c.status).toBe('building');
    expect(t.criteria).toHaveLength(3);
    expect(t.steps!.map((s) => s.status)).toEqual(['done', 'todo', 'todo', 'todo']);
    expect(t.activity[0]!.text).toContain('The Builder redoes only steps 2, 3, 4');
    expect(t.squad?.phase).toBe('change-build');
    expect(fs.readFileSync(path.join(ticketDir(bp, t0.id), 'design.md'), 'utf8')).toContain('3. Add a manager screen to raise the limit');

    updateTicket(bp, t0.id, (x) => (x.squad!.nextAt = due()));
    squad.tick();
    await until(() => held.length === 2, 'the Builder redoes the steps');
    const redo = held[1]!.opts;
    expect(redo.resume).toBe('b-1');
    expect(redo.prompt).toContain('Redo only steps 2, 3, 4.');
    expect(redo.prompt).toContain('1. Count the bookings per person (done, keep it)');
    held[1]!.done();
    await until(() => get(t0.id).squad?.phase === 'test', 'the checks run on the redo');
    t = get(t0.id);
    expect(t.changes![0]!.status).toBe('done');
    expect(t.steps!.every((s) => s.status === 'done')).toBe(true);
    expect(t.gates).toEqual({ checks: 'pending', review: 'pending', proof: 'pending' });
  });

  it('declining a design update keeps the spec as it was and carries on where the work paused', () => {
    const t0 = building();
    proposed(t0.id, 'big');
    actions.approveChange(bp, t0.id);
    updateTicket(bp, t0.id, (x) => {
      const c = actions.openChange(x)!;
      c.status = 'design-ready';
      c.paused = { phase: 'review' };
      c.design = { summary: 'A new screen', before: x.steps!.map((s) => s.title), steps: [{ title: 'Add a screen', change: 'new' }] };
      x.squad = null;
      x.live = false;
      x.waiting = { kind: 'change', summary: 'The design update is ready' };
    });
    const t = actions.declineChange(bp, t0.id, 'Not now');
    expect(t.changes![0]).toMatchObject({ status: 'declined', decided: { approved: false, reason: 'Not now' } });
    expect(t.criteria).toHaveLength(2);
    expect(t.steps).toHaveLength(3);
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('review');
    expect(() => actions.declineChange(bp, t0.id)).toThrow(/no change waiting/);
    // A new change can be proposed now.
    expect(actions.openChange(actions.proposeChange(bp, t0.id, 'Something else'))!.id).toBe('c2');
  });

  it('a declined proposal changes nothing', () => {
    const t0 = building();
    proposed(t0.id, 'small');
    const t = actions.declineChange(bp, t0.id);
    expect(t.changes![0]!.status).toBe('declined');
    expect(t.criteria).toHaveLength(2);
    expect(t.activity[0]!.text).toBe('Declined change c1');
    expect(t.squad?.phase).toBe('build');
  });

  it('before the build a change goes straight into the spec, and a big one back to the design for your approval', () => {
    const t0 = building();
    updateTicket(bp, t0.id, (x) => {
      x.sessions = { intake: 'i-1' };
      x.stage = 'specs';
      x.live = false;
      x.squad = null;
      x.waiting = { kind: 'plan', summary: 'The design is ready' };
    });
    proposed(t0.id, 'small');
    let t = actions.approveChange(bp, t0.id);
    expect(t.changes![0]!.status).toBe('done');
    expect(t.criteria).toHaveLength(3);
    expect(t.waiting?.kind).toBe('plan');

    proposed(t0.id, 'big', 'Clerks can book for a whole family');
    t = actions.approveChange(bp, t0.id);
    expect(t.changes![1]!.status).toBe('done');
    expect(t.criteria).toHaveLength(4);
    expect(t.squad?.phase).toBe('plan-rewrite');
    expect(t.changeRequest).toMatch(/^The spec changed \(change c2\)/);
    expect(t.planReview?.before?.criteria).toHaveLength(3);
    expect(actions.changeSummary(t.changeRequest)).toBe('for the change to the spec');
  });

  it('cannot be approved while the Architect writes the design', () => {
    const t0 = building();
    proposed(t0.id, 'small');
    updateTicket(bp, t0.id, (x) => {
      x.sessions = { intake: 'i-1' };
      x.stage = 'specs';
      x.live = true;
    });
    expect(() => actions.approveChange(bp, t0.id)).toThrow(/Architect is writing the design right now/);
  });

  it('keeps every change in spec.md and reads it back the same', () => {
    const t0 = building();
    const changes: Ticket['changes'] = [
      {
        id: 'c1',
        ask: 'Allow 5,\nnot 3',
        by: 'Momen',
        at: '2026-11-01T10:00:00.000Z',
        from: 'analyst',
        status: 'done',
        size: 'big',
        summary: 'The limit goes to 5',
        why: 'A new screen: "the manager page".',
        parts: [
          { part: 'story', before: 'Old story', after: 'New story' },
          { part: 'criterion', index: 0, before: 'Given a, when b, then c.', after: 'Given a, when b, then d.', criterion: { given: 'a', when: 'b', then: 'd' } },
          { part: 'criterion', index: 1, before: 'Given x, when y, then z.', after: '' },
          { part: 'criterion', before: '', after: 'Given a manager, when they raise it, then it holds.', criterion: { given: 'a manager', when: 'they raise it', then: 'it holds' } },
        ],
        design: { summary: 'One more screen', before: ['One', 'Two'], steps: [{ title: 'One', change: 'same' }, { title: 'Two, again', change: 'changed' }, { title: 'Three', change: 'new' }] },
        decided: { by: 'Momen', at: '2026-11-01T10:05:00.000Z', approved: true },
      },
      { id: 'c2', ask: 'Nope', by: 'Sara', at: '2026-11-01T11:00:00.000Z', status: 'declined', decided: { by: 'Sara', at: '2026-11-01T11:01:00.000Z', approved: false, reason: 'Later' } },
      { id: 'c3', ask: 'Try', by: 'Sara', at: '2026-11-01T12:00:00.000Z', status: 'design-ready', size: 'big', paused: { phase: 'test' }, error: 'once failed' },
    ];
    updateTicket(bp, t0.id, (x) => (x.changes = changes));
    const back = get(t0.id);
    expect(back.changes).toEqual(changes);
    expect(back.story).toBe(t0.story);
    expect(back.criteria).toEqual(t0.criteria);
  });
});

describe('released work is for questions only', () => {
  function released(): Ticket {
    const t0 = building('Show the price');
    return updateTicket(bp, t0.id, (x) => {
      x.stage = 'done';
      x.live = false;
      x.squad = null;
      x.release = 'v0.3.0';
      x.status = 'Released in v0.3.0';
    });
  }

  it('the chat answers questions but makes no changes', async () => {
    const t0 = released();
    let t = actions.startChat(bp, t0.id, 'analyst');
    expect(t.chat!.beside).toBe(true);
    expect(t.activity[0]!.text).toContain('Questions only');
    queue.chat = [{ reply: 'It shows the price in bold.', ready: true }];
    await squadOf().chatReply(t0.id);
    const call = calls.find((c) => kindOf(c) === 'chat')!;
    expect(call.prompt).toContain('This ticket is released (v0.3.0)');
    expect(call.prompt).toContain('this talk is for questions only');
    expect(call.allowedTools).not.toContain('Edit');
    expect(() => actions.chatWrite(bp, t0.id)).toThrow(/answers questions only/);
    t = actions.chatDone(bp, t0.id);
    expect(t.stage).toBe('done');
    expect(t.squad).toBeNull();

    // Talking again keeps the messages, in a fresh side conversation that reads them.
    const side = t.chat!.side;
    t = actions.startChat(bp, t0.id, 'analyst');
    expect(t.chat!.messages).toHaveLength(1);
    expect(t.chat!.side).toBeUndefined();
    queue.chat = [{ reply: 'Yes, in bold.', ready: false }];
    await squadOf().chatReply(t0.id);
    const again = calls.filter((c) => kindOf(c) === 'chat').at(-1)!;
    expect(again.resume).toBeUndefined();
    expect(again.sessionId).not.toBe(side);
    expect(again.prompt).toContain('Earlier in this chat');
    expect(again.prompt).toContain('- You: It shows the price in bold.');
  });

  it('refuses a change and offers a new linked ticket or a bug report', () => {
    const t0 = released();
    expect(() => actions.proposeChange(bp, t0.id, 'Show it in red')).toThrow(actions.ReleasedError);
    expect(() => actions.proposeChange(bp, t0.id, 'Show it in red')).toThrow(/released in v0.3.0, so it only answers questions/);
    expect(() => actions.changeAfterRelease(bp, building().id, 'x', 'ticket')).toThrow(/not accepted yet/);

    const made = actions.changeAfterRelease(bp, t0.id, 'Show the price in red', 'ticket');
    expect(made).toMatchObject({ title: 'Show the price in red', kind: 'feature', changeOf: t0.id });
    expect(made.ask).toContain(`A change to ${t0.id} "Show the price", released in v0.3.0.`);
    const bug = actions.changeAfterRelease(bp, t0.id, 'The price is cut off on phones', 'bug');
    expect(bug).toMatchObject({ kind: 'bug', changeOf: t0.id, foundIn: 'v0.3.0' });
    expect(bug.ask).toContain('The price is cut off on phones');
    expect(get(t0.id).activity[0]!.text).toContain(`It became bug ${bug.id}`);
    expect(get(t0.id).changes).toBeUndefined();
    expect(fs.readFileSync(path.join(ticketDir(bp, made.id), 'ticket.md'), 'utf8')).toContain(`changeOf: ${t0.id}`);
  });
});

describe('the board API', () => {
  function app() {
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(tmp) });
    return a;
  }
  const post = (a: Hono, url: string, body: unknown = {}) => a.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('proposes, approves and declines a change, and says no with 409 on released work', async () => {
    const a = app();
    const t0 = building();
    let res = await post(a, `/api/v1/tickets/${t0.id}/spec-change`, { text: 'Allow 5', from: 'analyst' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Ticket).changes![0]).toMatchObject({ status: 'writing', from: 'analyst' });
    res = await post(a, `/api/v1/tickets/${t0.id}/spec-change`, { text: 'Again' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/one change at a time/);
    res = await post(a, `/api/v1/tickets/${t0.id}/spec-change/approve`);
    expect(res.status).toBe(400);
    updateTicket(bp, t0.id, (x) => {
      const c = actions.openChange(x)!;
      Object.assign(c, { status: 'failed', error: 'no answer' });
    });
    res = await post(a, `/api/v1/tickets/${t0.id}/spec-change/retry`);
    expect(actions.openChange(((await res.json()) as Ticket))!.status).toBe('writing');
    updateTicket(bp, t0.id, (x) => {
      const c = actions.openChange(x)!;
      Object.assign(c, { status: 'proposed', size: 'small', summary: 'Five', parts: [{ part: 'story', before: x.story!, after: 'As a clerk, five.' }] });
    });
    res = await post(a, `/api/v1/tickets/${t0.id}/spec-change/approve`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Ticket).story).toBe('As a clerk, five.');

    updateTicket(bp, t0.id, (x) => {
      x.stage = 'done';
      x.release = 'v0.3.0';
    });
    res = await post(a, `/api/v1/tickets/${t0.id}/spec-change`, { text: 'Red' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ released: true, choices: ['ticket', 'bug'] });
    res = await post(a, `/api/v1/tickets/${t0.id}/spec-change/new-ticket`, { text: 'Red', as: 'bug' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'bug', changeOf: t0.id });
    res = await post(a, `/api/v1/tickets/${t0.id}/chat/start`, { with: 'analyst' });
    expect(res.status).toBe(200);
    res = await post(a, `/api/v1/tickets/${t0.id}/chat/write`);
    expect(res.status).toBe(400);
  });
});

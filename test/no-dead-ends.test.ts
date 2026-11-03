import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { Tracker } from '../src/modules/tracker/types.js';

/**
 * No dead ends: Stop keeps the step, tracker updates wait until they are sent, tries start again after a pass, a
 * "Continue anyway" is remembered, a resumed Builder gets a new plan, and an approved change can be withdrawn. The AI
 * tool is a fake that answers at once.
 */

const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, ticketDir, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { flushTracker, trackerRetryDelay } = await import('../src/engine/sync.js');
const P = await import('../src/engine/prompts.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths } = await import('../src/core/paths.js');
const { holdRelease, releaseGoingOut } = await import('../src/board/lock.js');

type Ticket = import('../src/board/types.js').Ticket;
type Squad = {
  tick(): void;
  checks(id: string): Promise<void>;
  build(id: string): Promise<void>;
  phaseFor(t: Ticket): string;
  pickUpChange(t: Ticket): void;
};

let tmp: string;
let wt: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ends-'));
  wt = path.join(tmp, 'copy');
  fs.mkdirSync(wt);
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, blueprint: undefined, impactChecks: [], techDrafts: [] });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const squadOf = () => new LiveSquad(bp) as unknown as Squad;
const get = (id: string) => readTicket(bp, id)!;
const later = () => new Date(Date.now() + 60_000).toISOString();
const due = () => new Date(Date.now() - 1000).toISOString();
const builds = () => calls.filter((c) => c.schema === P.BUILD_SCHEMA);

/** A ticket the Builder works on: spec and design approved, its copy made, two "done when" and three steps. */
function building(title = 'Limit bookings'): Ticket {
  const t0 = actions.createTicket(bp, { title, ask: 'One person blocks the whole day.' });
  return updateTicket(bp, t0.id, (x) => {
    x.stage = 'implement';
    x.live = true;
    x.waiting = null;
    x.squad = null;
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
    x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
  });
}

describe('Stop keeps the step the ticket is on', () => {
  it('between steps, or while it waits for a free place: Carry on runs that step, not the Analyst', () => {
    const between = building('Between steps');
    updateTicket(bp, between.id, (x) => {
      x.stage = 'review';
      x.squad = { phase: 'review', nextAt: later() };
    });
    const queued = building('Waits for a place');
    updateTicket(bp, queued.id, (x) => {
      x.stage = 'test';
      x.squad = { phase: 'test', nextAt: due() };
    });
    actions.stopTicket(bp, between.id);
    actions.stopTicket(bp, queued.id);
    squadOf().tick();

    for (const [id, phase] of [
      [between.id, 'review'],
      [queued.id, 'test'],
    ] as const) {
      let t = get(id);
      expect(t.waiting?.kind).toBe('stuck');
      expect(t.retryPhase).toBe(phase);
      expect(t.stopRequested).toBeUndefined();
      expect(t.stuck?.options[0]?.name).toBe('Carry on');
      t = actions.decideStuck(bp, id, 0);
      expect(t.squad?.phase).toBe(phase);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('a release and a pull request share one lock', () => {
  it('the pull request of a ticket accepted while a release goes out waits to merge until it is out', async () => {
    const t0 = building();
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'release';
      x.squad = { phase: 'publish', nextAt: due() };
    });
    const free = holdRelease(bp, 'v1.5.0');
    try {
      expect(() => holdRelease(bp, 'v1.6.0')).toThrow('v1.5.0 is going out right now');
      // Accepted meanwhile: the ticket goes into another release, whose notes can still be edited.
      const next = actions.ensureDraftRelease(bp, 'minor');
      expect(next.version).not.toBe('v1.5.0');
      expect(actions.saveReleaseNotes(bp, next.version, 'Next one').notes).toBe('Next one');
      await (squadOf() as unknown as { step(id: string, phase: string): Promise<void> }).step(t0.id, 'publish');
      const t = get(t0.id);
      expect(t.status).toBe('Merges once v1.5.0 is out');
      expect(t.squad?.phase).toBe('publish');
      expect(Date.parse(t.squad!.nextAt)).toBeGreaterThan(Date.now());
    } finally {
      free();
    }
    expect(releaseGoingOut(bp)).toBeNull();
  });
});

describe('tracker updates are kept until they are sent', () => {
  let down: boolean;
  let tries: number;
  let sent: string[];
  const tracker = {
    name: 'fake',
    label: 'Fake Boards',
    abilities: { tags: false, bugs: false, wiki: false },
    refOf: (id: string) => `FB#${id}`,
    parseRef: (ref: string) => ref,
    moveTo: async (_id: string, state: string) => {
      tries += 1;
      if (down) throw new Error('503 Service Unavailable');
      sent.push(`move ${state}`);
      return 'Active';
    },
    comment: async (_id: string, text: string) => {
      tries += 1;
      if (down) throw new Error('503 Service Unavailable');
      sent.push(`comment ${text.split('\n')[0]}`);
    },
  } as unknown as Tracker;

  beforeEach(() => {
    down = true;
    tries = 0;
    sent = [];
  });

  it('a failed update stays first in the queue, waits longer after each failure, and goes out once the tracker answers', async () => {
    const t0 = actions.createTicket(bp, { title: 'Sign up' });
    updateTicket(bp, t0.id, (x) => {
      x.source = { type: 'fake', id: '7', ref: 'FB#7' };
      x.trackerQueue = [{ kind: 'started' }, { kind: 'note', text: 'Use the new logo', noteKind: 'rule' }];
    });
    const queue = get(t0.id).trackerQueue;

    await flushTracker(bp, t0.id, tracker);
    let t = get(t0.id);
    expect(t.trackerQueue).toEqual(queue);
    expect(t.trackerRetry?.tries).toBe(1);
    expect(Date.parse(t.trackerRetry!.nextAt) - Date.now()).toBeGreaterThan(25_000);
    expect(t.activity[0]!.text).toBe('Could not update FB#7 on Fake Boards: 503 Service Unavailable. The update is kept and sent again later');

    // Not time yet: the tracker is not asked again.
    const asked = tries;
    await flushTracker(bp, t0.id, tracker);
    expect(tries).toBe(asked);

    // The next try fails too: a longer wait, and no second note.
    updateTicket(bp, t0.id, (x) => (x.trackerRetry = { ...x.trackerRetry!, nextAt: due() }));
    await flushTracker(bp, t0.id, tracker);
    t = get(t0.id);
    expect(t.trackerRetry?.tries).toBe(2);
    expect(Date.parse(t.trackerRetry!.nextAt) - Date.now()).toBeGreaterThan(55_000);
    expect(t.activity.filter((a) => a.text.startsWith('Could not update')).length).toBe(1);
    expect(t.trackerQueue).toEqual(queue);

    // The tracker answers again: both go out, oldest first, and the queue is empty.
    down = false;
    updateTicket(bp, t0.id, (x) => (x.trackerRetry = { ...x.trackerRetry!, nextAt: due() }));
    await flushTracker(bp, t0.id, tracker);
    t = get(t0.id);
    expect(sent).toEqual(['move in-progress', 'comment squad-kit started work on this as ticket **' + t0.id + '**.', 'comment **Business rule added** by Momen']);
    expect(t.trackerQueue).toBeUndefined();
    expect(t.trackerRetry).toBeUndefined();
  });

  it('waits 30 seconds, then twice as long each time, at most 30 minutes', () => {
    expect([1, 2, 3, 4].map(trackerRetryDelay)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(trackerRetryDelay(20)).toBe(30 * 60_000);
  });
});

describe('the checks after "Continue anyway"', () => {
  const commands = (c: Record<string, string>) => writeMeta(bp, { ...readMeta(bp), commands: c });

  it('tries start again once the checks pass', async () => {
    commands({ test: 'true' });
    const t0 = building();
    updateTicket(bp, t0.id, (x) => (x.tries = 2));
    await squadOf().checks(t0.id);
    const t = get(t0.id);
    expect(t.gates?.checks).toBe('pass');
    expect(t.tries).toBe(0);
    expect(t.squad?.phase).toBe('review');
  });

  it('a later round where the same checks still fail goes on as you decided; a new failure is fixed as usual', async () => {
    commands({ test: 'exit 1' });
    const t0 = building();
    updateTicket(bp, t0.id, (x) => (x.tries = 2));
    const squad = squadOf();
    await squad.checks(t0.id);
    let t = get(t0.id);
    expect(t.stuck).toMatchObject({ gate: 'checks', checks: ['test'] });
    t = actions.decideStuck(bp, t0.id, 2, { reason: 'The test is broken on main too' });
    expect(t.checksContinued).toEqual(['test']);
    expect(t.tries).toBe(0);
    expect(t.squad?.phase).toBe('review');

    // The Reviewer asked for a fix, the Builder made it, and the checks run again: the same test still fails.
    await squad.checks(t0.id);
    t = get(t0.id);
    expect(builds()).toHaveLength(0);
    expect(t.waiting).toBeNull();
    expect(t.gates?.checks).toBe('skipped');
    expect(t.squad?.phase).toBe('review');
    expect(t.activity[0]!.text).toBe('Checks still fail: test. You continued anyway past them, so the work goes on');

    // A check that fails only now is new: the Builder fixes it, with its own tries.
    commands({ test: 'exit 1', lint: 'exit 1' });
    await squad.checks(t0.id);
    t = get(t0.id);
    expect(builds()).toHaveLength(1);
    expect(t.tries).toBe(1);
    expect(t.squad?.phase).toBe('test');

    // Once they pass, nothing is continued past any more.
    commands({ test: 'true', lint: 'true' });
    await squad.checks(t0.id);
    expect(get(t0.id).checksContinued).toBeUndefined();
  });
});

describe('a resumed Builder after a plan change', () => {
  it('gets the new plan; without a change it just carries on', async () => {
    const t0 = building();
    const squad = squadOf();
    await squad.build(t0.id);
    expect(builds()[0]!.prompt).toContain('Refuse the fourth booking');

    // Stopped, sent back to the plan, and the new design has other steps.
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'implement';
      x.steps = [
        { title: 'Count the bookings per person and per day', status: 'todo' },
        { title: 'Let the manager raise the limit', status: 'todo' },
      ];
    });
    await squad.build(t0.id);
    let run = builds().at(-1)!;
    expect(run.resume).toBe('b-1');
    expect(run.prompt).toMatch(/^The plan changed since you last worked on this ticket/);
    expect(run.prompt).toContain('Let the manager raise the limit');
    expect(get(t0.id).activity.map((a) => a.text)).toContain('Got the new plan');

    // Stopped again, the plan as it was: the same conversation simply goes on.
    await squad.build(t0.id);
    run = builds().at(-1)!;
    expect(run.resume).toBe('b-1');
    expect(run.prompt).toBe('Continue the steps that are not done yet, then run the tests.');
  });
});

describe('withdrawing an approved change', () => {
  /** A small change the Analyst wrote: the limit goes from 3 to 5. */
  function proposedSmall(id: string): Ticket {
    actions.proposeChange(bp, id, 'Allow 5 bookings, not 3');
    return updateTicket(bp, id, (x) => {
      const c = actions.openChange(x)!;
      Object.assign(c, {
        status: 'proposed',
        size: 'small',
        summary: 'The limit goes from 3 to 5',
        parts: actions.changeParts(x, {
          summary: '',
          size: 'small',
          why: '',
          story: 'As a clerk, I want at most 5 bookings a day per person, so the day stays fair.',
          criteria: [{ number: 1, action: 'change', given: 'a person with 5 bookings today', when: 'they book again', then: 'it is refused' }],
        }),
      });
    });
  }

  it('before the Builder takes it, the spec goes back to how it was and the work goes on without it', () => {
    const t0 = building();
    const before = { story: t0.story, criteria: t0.criteria };
    proposedSmall(t0.id);
    let t = actions.approveChange(bp, t0.id);
    expect(t.story).toContain('at most 5 bookings');
    // Read back from spec.md, as after a restart.
    expect(actions.openChange(get(t0.id))).toMatchObject({ status: 'approved', specBefore: before });

    t = actions.withdrawChange(bp, t0.id, 'We keep 3 for now');
    expect({ story: t.story, criteria: t.criteria }).toEqual(before);
    expect(actions.openChange(t)).toBeUndefined();
    expect(t.changes![0]).toMatchObject({ status: 'declined', decided: { by: 'Momen', approved: false, withdrawn: true, reason: 'We keep 3 for now' } });
    expect(t.activity[0]!.text).toBe('Withdrew change c1; the spec is back to how it was: We keep 3 for now');
    const spec = fs.readFileSync(path.join(ticketDir(bp, t0.id), 'spec.md'), 'utf8');
    expect(spec).toContain('- Withdrawn by: Momen');
    expect(get(t0.id).changes![0]!.decided?.withdrawn).toBe(true);
    // The next Builder step is just that step: no change goes into it.
    expect(squadOf().phaseFor({ ...get(t0.id), squad: { phase: 'review', nextAt: due() } })).toBe('review');
  });

  it('once the Builder is making it, or with nothing approved, it says what to do instead', () => {
    const t0 = building();
    expect(() => actions.withdrawChange(bp, t0.id)).toThrow(`${t0.id} has no approved change to withdraw.`);
    proposedSmall(t0.id);
    expect(() => actions.withdrawChange(bp, t0.id)).toThrow(/no approved change/);
    actions.approveChange(bp, t0.id);
    updateTicket(bp, t0.id, (x) => (actions.openChange(x)!.status = 'building'));
    expect(() => actions.withdrawChange(bp, t0.id)).toThrow('The Builder is making change c1 already. Once it is done, propose a new change to undo it.');
  });

  it('a withdrawn change gives back the proof that waited for you', async () => {
    const t0 = building();
    proposedSmall(t0.id);
    updateTicket(bp, t0.id, (x) => (actions.openChange(x)!.size = 'big'));
    actions.approveChange(bp, t0.id);
    updateTicket(bp, t0.id, (x) => {
      x.squad = null;
      x.live = false;
      x.stage = 'review';
      x.waiting = { kind: 'proof', summary: 'The proof is ready' };
    });
    squadOf().pickUpChange(get(t0.id));
    expect(get(t0.id)).toMatchObject({ waiting: null, squad: { phase: 'change-design' } });

    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(tmp) });
    const res = await a.request(`/api/v1/tickets/${t0.id}/spec-change/withdraw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    const t = get(t0.id);
    expect(t.waiting).toEqual({ kind: 'proof', summary: 'The proof is ready' });
    expect(t.squad).toBeNull();
    expect(t.live).toBe(false);
    expect(actions.openChange(t)).toBeUndefined();
  });
});

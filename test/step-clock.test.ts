import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { tinyApp } from './support/tiny-app.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, savedFiles } from './support/window.js';
import { checkAnswer, isProofCheck } from './support/proof-check.js';

/**
 * The "Taking long" timer counts only the time a step really runs. RO-13 said "The Tester has been on this step for 81
 * minutes" after 44 seconds of work, an hour waiting for the person and 17 minutes waiting for a free place.
 */

/** What the fake Tester does when it runs. */
let tester: (opts: RunOptions) => Promise<unknown> = async () => ({ shots: [], offScreen: [] });
const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    const structured = isProofCheck(opts) ? checkAnswer(opts) : await tester(opts);
    return { ok: true, structured, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' } as RunResult;
  },
}));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

const { boardPaths, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { pauseClock, slowStep, startStep, stepSeconds, endStep } = await import('../src/board/clock.js');
const { LiveSquad, queuedText } = await import('../src/engine/live.js');
const { addWorktree } = await import('./support/copy.js');
const { readUsual } = await import('../src/board/usual.js');

type Squad = { proof(id: string): Promise<void>; hold(t: unknown, text: string): void };

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
const AT = (clock: string) => Date.parse(`2026-11-04T${clock}Z`);
const ticket = (id: string) => readTicket(bp, id)!;

beforeEach(async () => {
  tester = async () => ({ shots: [], offScreen: [] });
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-clock-')));
  const project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  execSync('git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m start', { cwd: project });
  bp = boardPaths(path.join(project, '.squad'));
  const app = await tinyApp();
  writeMeta(bp, {
    project: 'App',
    key: 'RO',
    nextNumber: 13,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: { start: app.start, url: app.url },
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
  h.browser = fakeBrowser({ '/': { has: [] } }).module;
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A story whose checks and review passed: the proof is next. */
function story(): string {
  const t0 = actions.createTicket(bp, { title: 'Close a room' });
  const wt = addWorktree(bp.root, t0.id, 'main');
  updateTicket(bp, t0.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'review';
    x.live = true;
    x.squad = null;
    x.sessions = { tester: 't-1' };
    x.criteria = [{ given: 'a closed room', when: 'I open the day view', then: 'the room shows as closed' }];
    x.work = { steps: 1, tests: 1, screens: 1 };
    x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
  });
  return t0.id;
}

describe('the clock counts only the time a step runs', () => {
  it("RO-13: 44 seconds of work, an hour's wait for the person and 17 minutes in the queue are not 81 minutes", async () => {
    const id = story();
    vi.useFakeTimers({ toFake: ['Date'], now: AT('19:34:31.912') });
    // The first run: the Tester does not get through, and the proof stops for the person.
    tester = async () => {
      vi.setSystemTime(AT('19:35:15.260'));
      throw new Error('the tools were used the wrong way');
    };
    const squad = new LiveSquad(bp) as unknown as Squad;
    await squad.proof(id);
    expect(ticket(id).waiting?.kind).toBe('stuck');
    expect(ticket(id).clock).toBeUndefined();

    // An hour on, the person presses Take the screenshots again, and every place is taken.
    vi.setSystemTime(AT('20:38:01.672'));
    actions.decideStuck(bp, id, 0);
    squad.hold(ticket(id), queuedText(['RO-8', 'RO-12'], 2));
    expect(ticket(id).status).toContain('Next in line');
    vi.setSystemTime(AT('20:55:56.604'));
    expect(slowStep(ticket(id), readUsual(bp))).toBeNull();

    // Its place comes: the clock starts with the step.
    let seen = -1;
    tester = async (opts) => {
      vi.setSystemTime(AT('20:56:07.698'));
      const t = ticket(id);
      seen = stepSeconds(t.clock!);
      expect(slowStep(t, readUsual(bp))).toBeNull();
      const [file] = savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: [{ page: '/' }] }));
      return { shots: [{ criterion: 1, file: file!, shows: 'met', note: 'The room shows as closed.' }], offScreen: [] };
    };
    await squad.proof(id);
    expect(seen).toBeLessThan(12);
    expect(ticket(id).gates?.proof).toBe('pass');
    // The activity never says it took long, and the step's time in the history is its own.
    expect(ticket(id).activity.some((a) => a.text.startsWith('Taking long'))).toBe(false);
    const run = ticket(id).history!.find((r) => r.who === 'tester' && r.step === 'proof')!;
    expect(Date.parse(run.to) - Date.parse(run.from)).toBeLessThan(12_000);
  });

  it('a clock from before this fix, on a stopped ticket, starts again with the next run', () => {
    const id = story();
    vi.useFakeTimers({ toFake: ['Date'], now: AT('20:38:01') });
    updateTicket(bp, id, (x) => {
      x.clock = { who: 'tester', step: 'proof', since: new Date(AT('19:34:31')).toISOString() };
      x.live = false;
      x.retryPhase = 'proof';
      x.stuck = { gate: 'proof', question: 'No screenshots yet.', options: actions.wayOptions({ gate: 'proof' }) };
      x.waiting = { kind: 'stuck', summary: 'No screenshots yet: needs one decision' };
    });
    expect(actions.decideStuck(bp, id, 0).clock).toBeUndefined();
  });

  it('waiting for the person, in the middle of a step: that time does not count', () => {
    const id = story();
    vi.useFakeTimers({ toFake: ['Date'], now: AT('10:00:00') });
    updateTicket(bp, id, (x) => startStep(x, { who: 'reviewer', step: 'review' }));
    vi.setSystemTime(AT('10:02:00'));
    // A question for the person: the clock stands still as soon as the ticket waits.
    let t = updateTicket(bp, id, (x) => (x.waiting = { kind: 'ask', summary: 'A question for you' }));
    expect(t.clock!.paused).toBe(new Date(AT('10:02:00')).toISOString());
    vi.setSystemTime(AT('13:00:00'));
    expect(stepSeconds(t.clock!)).toBe(120);
    // The answer comes, and the same step goes on with its own two minutes.
    t = updateTicket(bp, id, (x) => (x.waiting = null));
    expect(stepSeconds(t.clock!)).toBe(120);
    t = updateTicket(bp, id, (x) => startStep(x, { who: 'reviewer', step: 'review' }));
    expect(t.clock!.paused).toBeUndefined();
    vi.setSystemTime(AT('13:01:00'));
    expect(stepSeconds(t.clock!)).toBe(180);
    expect(slowStep(t, readUsual(bp))).toBeNull();
    // Its time in the usual times and the history is its own too.
    t = updateTicket(bp, id, (x) => endStep(bp, x));
    const run = t.history!.at(-1)!;
    expect(Date.parse(run.to) - Date.parse(run.from)).toBe(180_000);
  });

  it('waiting for another story: that time does not count', () => {
    const id = story();
    vi.useFakeTimers({ toFake: ['Date'], now: AT('10:00:00') });
    updateTicket(bp, id, (x) => startStep(x, { who: 'builder', step: 'build' }));
    vi.setSystemTime(AT('10:01:00'));
    const t = updateTicket(bp, id, (x) => {
      x.live = false;
      x.squad = null;
      x.waiting = { kind: 'depends', summary: 'RO-13 needs RO-12, which is not merged yet' };
    });
    vi.setSystemTime(AT('18:00:00'));
    expect(stepSeconds(t.clock!)).toBe(60);
  });

  it('waiting for a free place, or for the usage limit: that time does not count', () => {
    const id = story();
    vi.useFakeTimers({ toFake: ['Date'], now: AT('10:00:00') });
    updateTicket(bp, id, (x) => {
      startStep(x, { who: 'tester', step: 'proof' });
      x.squad = { phase: 'proof', nextAt: new Date(AT('10:00:00')).toISOString() };
    });
    vi.setSystemTime(AT('10:00:30'));
    const squad = new LiveSquad(bp) as unknown as Squad;
    squad.hold(ticket(id), queuedText(['RO-8', 'RO-12'], 2));
    vi.setSystemTime(AT('11:30:00'));
    const held = ticket(id);
    expect(stepSeconds(held.clock!)).toBe(30);
    expect(slowStep(held, readUsual(bp))).toBeNull();
    const t = updateTicket(bp, id, (x) => startStep(x, { who: 'tester', step: 'proof' }));
    vi.setSystemTime(AT('11:30:10'));
    expect(stepSeconds(t.clock!)).toBe(40);
  });

  it('a step that really runs long still says so', () => {
    const id = story();
    vi.useFakeTimers({ toFake: ['Date'], now: AT('10:00:00') });
    updateTicket(bp, id, (x) => startStep(x, { who: 'tester', step: 'proof' }));
    vi.setSystemTime(AT('11:00:00'));
    expect(slowStep(ticket(id), readUsual(bp))?.detail).toContain('The Tester has been on this step for 60 minutes');
  });

  it('a clock that stands still can be paused only once, and another step starts its own', () => {
    const t = { waiting: null, clock: { who: 'tester', step: 'proof', since: new Date(AT('10:00:00')).toISOString() } } as unknown as Parameters<typeof pauseClock>[0];
    pauseClock(t, AT('10:01:00'));
    pauseClock(t, AT('10:05:00'));
    expect(t.clock!.paused).toBe(new Date(AT('10:01:00')).toISOString());
    startStep(t, { who: 'reviewer', step: 'review' }, AT('10:06:00'));
    expect(t.clock).toMatchObject({ who: 'reviewer', step: 'review', since: new Date(AT('10:06:00')).toISOString() });
    expect(t.clock!.paused).toBeUndefined();
  });
});


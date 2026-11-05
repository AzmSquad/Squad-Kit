import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { stepSeconds } from '../src/board/clock.js';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { freePort } from './support/tiny-app.js';

/**
 * An interruption is not a failure, and nothing is left behind (the Mawid MA-5 incident). A board restart in the middle
 * of the Builder's step is no failed try and no stronger model: the same step carries on with its clock, and the
 * server the run left running in the ticket's copy is gone. Before the checks, squad-kit frees a port its own copies
 * hold. A Builder question about a busy port is settled by squad-kit when the holder is its own leftover. When it is
 * not, the Builder is told to go around it with a free port, and only asking again reaches the person, as one plain
 * choice. Real processes, ports and git repos; every agent run is a fake.
 */

type Run = { opts: RunOptions; end(r?: Partial<RunResult>): void };
const runs: Run[] = [];
let answer: ((opts: RunOptions) => Partial<RunResult> | null) | null = null;

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> =>
    new Promise((resolve) => {
      let over = false;
      const run: Run = {
        opts,
        end: (r = {}) => {
          if (over) return;
          over = true;
          resolve({ ok: false, sessionId: opts.sessionId ?? opts.resume ?? '', text: '', error: 'Ended by the test.', ...r });
        },
      };
      runs.push(run);
      opts.signal?.addEventListener('abort', () => run.end({ error: 'You stopped the squad.' }));
      const now = answer?.(opts);
      if (now) run.end({ sessionId: opts.resume ?? opts.sessionId ?? '', ...now });
    }),
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { answerAgent, createTicket } = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { setParallelLimit } = await import('../src/core/settings.js');
const { addWorktree } = await import('../src/engine/git.js');
const { liveNow } = await import('../src/board/now.js');
const { readUsual, usualKey } = await import('../src/board/usual.js');
const { allEnded } = await import('../src/engine/process-group.js');
const { portTaken } = await import('../src/engine/run-app.js');
const { inTheWay } = await import('../src/engine/port-ask.js');
const { stoppedLines } = await import('../src/engine/leftovers.js');
const { markInterrupted, sleptSince } = await import('../src/engine/interrupt.js');
type Ticket = import('../src/board/types.js').Ticket;

let tmp: string;
const stops: (() => void)[] = [];
/** Every process this test started, so it can stop whatever is still there afterwards, by its own number. */
const started: number[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const SERVE = (p: number) => `require('http').createServer((q, s) => s.end('ok')).listen(${p}, '127.0.0.1')`;
const WATCH = 'setInterval(() => {}, 1000)';

/**
 * A program left running the way an agent's background command leaves one (`npm exec next start &`): the shell that
 * started it is gone, so it hangs off the system, outside any process group squad-kit started.
 */
async function orphan(cwd: string, code: string, port?: number): Promise<number> {
  const out = execFileSync('/bin/sh', ['-c', `"${process.execPath}" -e "${code}" >/dev/null 2>&1 & echo $!`], { cwd, encoding: 'utf8' });
  const pid = Number(out.trim());
  started.push(pid);
  if (port) await until(`port ${port}`, () => portTaken(port));
  return pid;
}

/** A live project with one commit, its Architect done, and a ticket with its own copy of the code. */
function liveTicket(name: string, over: (t: Ticket) => void = () => {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'page.txt'), 'old');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'start'], { cwd: dir });
  setupProject(dir);
  const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), name);
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct', commands: {} });
  const t = createTicket(bp, { title: 'Book an appointment' });
  const wt = addWorktree(bp.root, t.id, 'main');
  updateTicket(bp, t.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.squad = null;
    over(x);
  });
  return { bp, id: t.id, wt };
}

const texts = (t: Ticket) => t.activity.map((a) => a.text);
const builderRuns = (dir: string) => runs.filter((r) => r.opts.cwd === dir);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-restart-carry-')));
  fs.rmSync(path.join(process.env.SQUAD_KIT_HOME!, 'settings.yaml'), { force: true });
  runs.length = 0;
  answer = null;
  setParallelLimit(2);
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const r of runs) r.end();
  await allEnded(15_000);
  for (const pid of started.splice(0)) {
    try {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    } catch {
      // Gone meanwhile.
    }
  }
  await sleep(50);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('a board restart in the middle of a Builder step', () => {
  it('is no failed try: the same step carries on with its clock and its effort, and the server it left is gone', async () => {
    const port = await freePort();
    // MA-5: the plan was redone to follow ADR-009 after the Builder had started.
    const { bp, id, wt } = liveTicket('mawid', (x) => {
      x.stage = 'implement';
      x.live = true;
      x.steps = [{ title: 'Read the booking page', status: 'todo' }, { title: 'Use the shared parts', status: 'todo' }, { title: 'Tests', status: 'todo' }] as Ticket['steps'];
      x.work = { steps: 3, tests: 1, screens: 0 };
      x.replanFor = 'ADR-009';
      x.builtPlan = 'the old plan';
      x.squad = { phase: 'build', nextAt: new Date().toISOString() };
    });
    let server = 0;
    let during: { clock?: Ticket['clock']; line?: string; detail?: string; seconds?: number } = {};
    answer = (opts) => {
      if (opts.cwd !== wt.dir) return null;
      if (builderRuns(wt.dir).length === 1) {
        opts.onText?.('>> step 1');
        opts.onText?.('>> step 2');
        return null;
      }
      const t = readTicket(bp, id)!;
      const now = liveNow(t, readUsual(bp));
      during = { clock: { ...t.clock! }, line: now.line, detail: now.detail, ...(now.seconds !== undefined ? { seconds: now.seconds } : {}) };
      // The part that ran across the restart took long: its time must not teach the usual times.
      updateTicket(bp, id, (x) => (x.clock!.since = new Date(Date.now() - 130_000).toISOString()));
      opts.onText?.('>> step 3');
      return { ok: true, structured: { summary: 'Done' } };
    };

    stops.push(new LiveSquad(bp).start(25));
    await until('the Builder on step 2', () => builderRuns(wt.dir).length === 1 && readTicket(bp, id)!.clock?.part === 2);
    // The run starts a server in the background, the way `npm exec next start -p 3100 &` does.
    server = await orphan(wt.dir, SERVE(port), port);
    const before = readTicket(bp, id)!.clock!;
    const first = builderRuns(wt.dir)[0]!.opts;

    // "Restart now": the board closes, then a new one opens on the same project.
    stops.shift()!();
    expect(await allEnded(15_000)).toBe(true);
    expect(alive(server)).toBe(false);
    expect(await portTaken(port)).toBe(false);
    const cut = readTicket(bp, id)!;
    expect(cut.fails ?? 0).toBe(0);
    expect(cut.interrupted).toMatchObject({ by: 'restart', phase: 'build' });
    expect(texts(cut)).toContain("Stopped a leftover test server from this ticket's copy");

    stops.push(new LiveSquad(bp).start(25));
    await until('the Builder again', () => builderRuns(wt.dir).length === 2);
    await until('the build to finish', () => readTicket(bp, id)!.stage === 'test');
    const again = builderRuns(wt.dir)[1]!.opts;
    const t = readTicket(bp, id)!;

    // The same conversation goes on with the step it was on, at the same effort: no failed try, no redo, no new merge.
    expect(again.resume).toBe(first.sessionId);
    expect(again.prompt).toContain('You were on step 2 of 3');
    expect(again.prompt).toContain('do not start again from step 1');
    expect(again.prompt).not.toContain('Redo the work');
    expect(again.effort).toBe(first.effort);
    expect(t.fails ?? 0).toBe(0);
    expect(texts(t).filter((x) => x.startsWith('Runs on ')).every((x) => !x.includes('failed'))).toBe(true);
    expect(texts(t).filter((x) => x === 'Started redoing the work to follow ADR-009')).toHaveLength(1);
    expect(texts(t).filter((x) => x.startsWith('Brought the latest main'))).toHaveLength(1);
    expect(texts(t)).toContain('Carried on with step 2 of 3 after a restart');
    expect(t.interrupted).toBeUndefined();
    expect(t.replanFor).toBeUndefined();

    // The step clock kept its time and its part, without the time the board was closed, and said once that it resumed.
    expect(during.clock).toMatchObject({ who: 'builder', step: 'build', part: 2 });
    expect(Date.parse(during.clock!.since)).toBeGreaterThanOrEqual(Date.parse(before.since));
    expect(during.clock!.paused).toBeUndefined();
    expect(during.seconds!).toBeLessThan(stepSeconds(cut.clock!) + 5);
    expect(during.clock!.resumed).toBeTruthy();
    expect(during.line).toBe('Builder · step 2 of 3 · resumed after a restart');
    expect(during.detail).toMatch(/^Step 2 of 3 · \d+ s so far · resumed after a restart · this step usually takes/);
    expect((readUsual(bp)[usualKey('builder', 'build', 'full')] ?? []).every((s) => s < 100)).toBe(true);
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')('before the checks', () => {
  it("stops a leftover server of the ticket's copy that holds the port, and says so in one plain line", async () => {
    const port = await freePort();
    const { bp, id, wt } = liveTicket('checks', (x) => {
      x.stage = 'test';
      x.live = true;
      x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    });
    // The e2e tests need the port for their own server.
    const bind = `require('net').createServer().once('error', () => process.exit(1)).listen(${port}, '127.0.0.1', function () { console.log('Tests  1 passed'); this.close(); })`;
    writeMeta(bp, { ...readMeta(bp), commands: { test: `"${process.execPath}" -e "${bind}"` } });
    const other = createTicket(bp, { title: 'Staff page' });
    const otherCopy = addWorktree(bp.root, other.id, 'main');
    answer = () => ({ ok: true, structured: { summary: 'Fixed' } });

    const server = await orphan(wt.dir, SERVE(port), port);
    // Left alone: a program of another ticket's copy that holds no port, and a program outside squad-kit's copies.
    const quiet = await orphan(otherCopy.dir, WATCH);
    const outside = await orphan(tmp, SERVE(await freePort()));
    await (new LiveSquad(bp) as unknown as { checks(id: string): Promise<void> }).checks(id);

    const t = readTicket(bp, id)!;
    expect(t.gates?.checks).toBe('pass');
    expect(t.fails ?? 0).toBe(0);
    expect(texts(t)).toContain("Stopped a leftover test server from this ticket's copy");
    expect(runs).toHaveLength(0);
    expect(alive(server)).toBe(false);
    expect(alive(quiet)).toBe(true);
    expect(alive(outside)).toBe(true);
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')('a Builder question about a busy port', () => {
  function asking(name: string) {
    return liveTicket(name, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.steps = [{ title: 'Booking form', status: 'todo' }] as Ticket['steps'];
      x.work = { steps: 1, tests: 1, screens: 0 };
      x.squad = { phase: 'build', nextAt: new Date().toISOString() };
    });
  }
  const question = (port: number, pid: number) => ({ text: `Can you stop the leftover server on port ${port} so the e2e tests can run?`, options: [`I ran \`kill ${pid}\``], why: 'The e2e tests start their own server there.', kind: 'gap' });
  type Squad = { build(id: string): Promise<void>; builderAnswered(id: string): Promise<void> };

  it("is answered by squad-kit when a squad-kit leftover holds the port: the person never sees it", async () => {
    const port = await freePort();
    const { bp, id, wt } = asking('ours');
    const server = await orphan(wt.dir, SERVE(port), port);
    answer = (opts) => (builderRuns(wt.dir).length === 1 ? { ok: true, structured: { summary: 'Blocked on the port', question: question(port, server) } } : { ok: true, structured: { summary: 'Done' } });

    await (new LiveSquad(bp) as unknown as Squad).build(id);

    const t = readTicket(bp, id)!;
    expect(t.agentQuestion).toBeUndefined();
    expect(t.waiting ?? null).toBeNull();
    expect(t.stage).toBe('test');
    expect(alive(server)).toBe(false);
    const [first, second] = builderRuns(wt.dir).map((r) => r.opts);
    expect(second!.resume).toBe(first!.sessionId);
    expect(second!.prompt).toContain(`squad-kit stopped the leftover server on port ${port}; carry on`);
    expect(texts(t)).toContain("Stopped a leftover test server from this ticket's copy");
    expect(texts(t).some((x) => x.startsWith('Asked you'))).toBe(false);
  }, 30_000);

  it('another program holds it: the Builder goes around it with a free port, and the person never sees it', async () => {
    const port = await freePort();
    const { bp, id, wt } = asking('around');
    const theirs = await orphan(tmp, SERVE(port), port);
    answer = (opts) => (builderRuns(wt.dir).length === 1 ? { ok: true, structured: { summary: 'Blocked on the port', question: question(port, theirs) } } : { ok: true, structured: { summary: 'Done' } });

    await (new LiveSquad(bp) as unknown as Squad).build(id);

    const t = readTicket(bp, id)!;
    expect(t.agentQuestion).toBeUndefined();
    expect(t.waiting ?? null).toBeNull();
    expect(t.stage).toBe('test');
    // Never stopped without the person's press.
    expect(alive(theirs)).toBe(true);
    const told = builderRuns(wt.dir)[1]!.opts.prompt;
    expect(told).toContain(`holds port ${port}. Leave it alone: do not stop it.`);
    expect(told).toMatch(/Port \d+ is free right now: run your server there, with PORT=\d+/);
    // The story's line has no port and no process in it.
    expect(texts(t)).toContain('Another program on this computer was in the way, so squad-kit showed how to go around it. The work carries on');
    expect(texts(t).join(' ')).not.toMatch(new RegExp(`\\b(${port}|${theirs})\\b`));
  }, 30_000);

  it('reaches the person as one plain choice when the Builder asks again, and Stop it stops that program', async () => {
    const port = await freePort();
    const { bp, id, wt } = asking('theirs');
    // The person's own program: it runs outside squad-kit's copies.
    const theirs = await orphan(tmp, SERVE(port), port);
    answer = (opts) => (builderRuns(wt.dir).length <= 2 ? { ok: true, structured: { summary: 'Blocked on the port', question: question(port, theirs) } } : { ok: true, structured: { summary: 'Done' } });
    const squad = new LiveSquad(bp) as unknown as Squad;

    await squad.build(id).catch(() => undefined);
    const t = readTicket(bp, id)!;
    expect(builderRuns(wt.dir)).toHaveLength(2);
    expect(t.waiting?.kind).toBe('ask');
    expect(t.agentQuestion).toMatchObject({ from: 'builder', text: 'Another program on this computer is using what the browser tests need.', options: ['Stop it', 'Skip the browser tests'] });
    expect(t.agentQuestion!.port).toMatchObject({ port, pid: theirs, asked: question(port, theirs).text });
    // No port and no process number in what the person reads; engineers find them in the details.
    const reads = `${t.agentQuestion!.text} ${t.agentQuestion!.why} ${t.agentQuestion!.options.join(' ')} ${t.status} ${t.waiting?.summary} ${texts(t).join(' ')}`;
    expect(reads).not.toMatch(new RegExp(`\\b(${port}|${theirs})\\b`));
    expect(alive(theirs)).toBe(true);

    answerAgent(bp, id, 'Stop it');
    await squad.builderAnswered(id);
    const done = readTicket(bp, id)!;
    expect(alive(theirs)).toBe(false);
    expect(texts(done)).toContain('Stopped the other program, as you asked');
    expect(builderRuns(wt.dir)[2]!.opts.prompt).toContain(`squad-kit stopped the program that held port ${port}; carry on`);
    expect(done.stage).toBe('test');
  }, 30_000);

  it('Skip the browser tests leaves that program alone', async () => {
    const port = await freePort();
    const { bp, id, wt } = asking('skip');
    const theirs = await orphan(tmp, SERVE(port), port);
    answer = (opts) => (builderRuns(wt.dir).length <= 2 ? { ok: true, structured: { summary: 'Blocked on the port', question: question(port, theirs) } } : { ok: true, structured: { summary: 'Done' } });
    const squad = new LiveSquad(bp) as unknown as Squad;

    await squad.build(id).catch(() => undefined);
    answerAgent(bp, id, 'Skip the browser tests');
    await squad.builderAnswered(id);
    expect(alive(theirs)).toBe(true);
    expect(builderRuns(wt.dir)[2]!.opts.prompt).toContain('Skip the browser tests for now');
  }, 30_000);

  it("the Builder's own words about a port never reach the person, however often it asks", async () => {
    const port = await freePort();
    const { bp, id, wt } = asking('keeps');
    // Nothing holds the port, and the Builder keeps asking about it: squad-kit answers twice, then stops the step.
    answer = () => ({ ok: true, structured: { summary: 'Blocked on the port', question: question(port, 4242) } });
    await expect((new LiveSquad(bp) as unknown as Squad).build(id)).rejects.toThrow('kept asking a technical question');
    expect(builderRuns(wt.dir)).toHaveLength(3);
    const t = readTicket(bp, id)!;
    expect(t.agentQuestion).toBeUndefined();
    expect(texts(t).some((x) => x.startsWith('Asked you'))).toBe(false);
  }, 30_000);
});

describe('reading a question for a busy port', () => {
  it('finds the ports and process numbers a question about one names, and nothing in other questions', () => {
    expect(inTheWay('Can you stop the leftover server on port 3100 so the e2e tests can run?')).toEqual({ ports: [3100], pids: [] });
    expect(inTheWay('next start -p 3100 failed: EADDRINUSE 127.0.0.1:3100. I ran `kill 17514`?')).toEqual({ ports: [3100], pids: [17514] });
    expect(inTheWay('Process 4123 is stuck; may I kill it?')).toEqual({ ports: [], pids: [4123] });
    expect(inTheWay('Should cancelled bookings count towards the limit of 3100 seats?')).toBeNull();
    expect(inTheWay('Which port should the API use, 3000 or 8080?')).toBeNull();
  });

  it('says one line per server, with its helpers folded in', () => {
    const p = (pid: number, cwd: string, ports: number[] = []) => ({ pid, ppid: 1, pgid: pid, tty: '', command: 'node', cwd, ports });
    const words = (cwd: string) => (cwd.startsWith('/a') ? "this ticket's copy" : "MA-4's copy");
    expect(stoppedLines([p(1, '/a'), p(2, '/a', [3100]), p(3, '/b')], words)).toEqual([
      "Stopped a leftover test server from this ticket's copy",
      "Stopped a program left running in MA-4's copy",
    ]);
  });
});

describe('an interruption is recorded as what it was', () => {
  const ticket = (over: Partial<Ticket>) => ({ id: 'MA-5', activity: [], ...over }) as unknown as Ticket;

  it('a review cut off runs its round again; a fix cut off inside the checks is counted once', () => {
    const review = ticket({ reviewRound: 1, clock: { who: 'reviewer', step: 'review', since: '' } });
    expect(markInterrupted(review, 'review', 'restart', 'now')).toBe('review');
    expect(review).toMatchObject({ reviewRound: 0, interrupted: { by: 'restart', phase: 'review', at: 'now' } });
    const fixing = ticket({ tries: 1, fails: 1, clock: { who: 'builder', step: 'fix', since: '' } });
    expect(markInterrupted(fixing, 'test', 'stop')).toBe('test');
    expect(fixing).toMatchObject({ tries: 0, fails: 0 });
    const checking = ticket({ tries: 1, fails: 2, clock: { who: 'squad', step: 'checks', since: '' } });
    markInterrupted(checking, 'test', 'restart');
    expect(checking).toMatchObject({ tries: 1, fails: 2 });
  });

  it('tells a sleep from a slow run by the clock that stops while the computer sleeps', () => {
    const mark = { wall: 0, awake: 0 };
    expect(sleptSince(mark, 90_000, 89_000)).toBe(false);
    expect(sleptSince(mark, 30 * 60_000, 60_000)).toBe(true);
    expect(sleptSince(undefined)).toBe(false);
  });
});

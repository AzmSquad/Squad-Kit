import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * A story's commands push only into a temp folder (noPushEnv in engine/sandbox.ts). A test that pushes anywhere else
 * fails with squad-kit's refusal, which says nothing about the story's code: the checks stop with one plain card, no
 * try is counted and the Builder is not sent to "fix" a test that is not broken. The AI tool is a fake.
 */

const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { GUARD_BLOCKED_PUSH } = await import('../src/engine/push-refused.js');
const { problemOf } = await import('../src/board/problem.js');
const P = await import('../src/engine/prompts.js');

type Ticket = import('../src/board/types.js').Ticket;
type Squad = { checks(id: string): Promise<void> };

let tmp: string;
let wt: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-push-')));
  wt = path.join(tmp, 'copy');
  fs.mkdirSync(wt);
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: {}, blueprint: undefined, impactChecks: [], techDrafts: [] });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const squad = () => new LiveSquad(bp) as unknown as Squad;
const get = (id: string) => readTicket(bp, id)!;
const commands = (c: Record<string, string>) => writeMeta(bp, { ...readMeta(bp), commands: c });
const builds = () => calls.filter((c) => c.schema === P.BUILD_SCHEMA);

/** What git prints when squad-kit refused a push, as a test that pushes to a real remote would show it. */
const REFUSED = `echo "Error: Command failed: git push -q origin main" >&2; echo "git: 'remote-squad-kit-no-push' is not a git command. See 'git --help'." >&2; echo "fatal: remote helper 'squad-kit-no-push' aborted session" >&2; exit 1`;

function built(): Ticket {
  const t0 = actions.createTicket(bp, { title: 'Close the issue on merge', ask: 'The issue stays open after the merge.' });
  return updateTicket(bp, t0.id, (x) => {
    x.stage = 'test';
    x.live = true;
    x.waiting = null;
    x.squad = null;
    x.worktree = wt;
    x.sessions = { intake: 'i-1', build: 'b-1' };
    x.story = 'As a maintainer, I want the issue closed when its pull request merges.';
    x.steps = [{ title: 'Close it on merge', status: 'done' }];
    x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
  });
}

describe('a test that squad-kit refused a push for', () => {
  it('stops with one plain card: no failed try, and no Builder', async () => {
    commands({ test: REFUSED, lint: 'true' });
    const t0 = built();
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(builds()).toHaveLength(0);
    expect(t.tries ?? 0).toBe(0);
    expect(t.fails ?? 0).toBe(0);
    expect(t.status).toBe('Stopped: a push was blocked');
    expect(t.stuck).toMatchObject({ gate: 'checks', kind: 'push', checks: ['test'], question: GUARD_BLOCKED_PUSH });
    expect(t.stuck!.options.map((o) => o.do)).toEqual(['continue', 'yourself', 'plan']);
    // For engineers: the command and what it printed.
    expect(t.stuck!.detail).toContain('remote-squad-kit-no-push');
    expect(problemOf(t)?.title).toBe('A push was blocked');
    expect(t.activity.map((a) => a.text)).toContain('A test tried to push code outside a temp folder, and squad-kit blocked it (test). Not a failed try');
  });

  it('plain words for the person: no git, no paths, no guard jargon', () => {
    expect(GUARD_BLOCKED_PUSH).not.toMatch(/sandbox|seatbelt|no-push|pushInsteadOf|\/Users|~\//i);
  });

  it('after Continue anyway, the same check failing the same way lets the work go on', async () => {
    commands({ test: REFUSED });
    const t0 = built();
    await squad().checks(t0.id);
    actions.decideStuck(bp, t0.id, 0, { reason: 'An engineer ran the tests outside squad-kit: they pass.' });
    expect(get(t0.id).checksContinued).toEqual(['test']);
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'test';
      x.live = true;
      x.squad = null;
      x.waiting = null;
    });
    await squad().checks(t0.id);
    const t = get(t0.id);
    expect(t.stuck?.kind).not.toBe('push');
    expect(builds()).toHaveLength(0);
    expect(t.squad?.phase).toBe('review');
  });

  it('a test that failed for another reason goes through the fixes as before', async () => {
    commands({ test: 'echo "the booking test failed"; exit 1' });
    const t0 = built();
    await squad().checks(t0.id);
    expect(get(t0.id).stuck?.kind).toBeUndefined();
    expect(get(t0.id).tries).toBe(1);
  });
});

describe('the agents are told', () => {
  it('that a refused push is squad-kit, not a bug to work around', () => {
    expect(P.PROCESS_RULE).toMatch(/push from your shell goes only into a temp folder/);
    expect(P.PROCESS_RULE).toMatch(/never change code or tests to get around it/);
  });
});

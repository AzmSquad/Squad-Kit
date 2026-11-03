import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * The Reviewer's second round (E5) sees the whole ticket, the whole change since the base, the check results and its
 * own notes from round one, not only the fix. Its conversation may be a new one, so the prompt carries everything.
 */

const calls: RunOptions[] = [];
let reviews: { approved: boolean; summary: string; comments: string[] }[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    const P = await import('../src/engine/prompts.js');
    const structured = opts.schema === P.REVIEW_SCHEMA ? reviews.shift() : { summary: 'Fixed' };
    return { ok: true, structured, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');

type Ticket = import('../src/board/types.js').Ticket;

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  reviews = [];
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-review-two-')));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  for (const t of listTickets(bp)) removeTicket(bp, t.id);
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done' }, commands: { test: 'npm test', lint: 'npm run lint' }, blueprint: undefined, impactChecks: [], techDrafts: [] });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const gates: Ticket['gates'] = {
  checks: 'pass',
  checksText: '12 tests pass, test, lint OK',
  ran: [
    { name: 'test', command: 'npm test', ok: true, tests: 12 },
    { name: 'lint', command: 'npm run lint', ok: true },
  ],
  review: 'pending',
  proof: 'pending',
};

function ticket(over: Partial<Ticket> = {}): Ticket {
  const t0 = actions.createTicket(bp, { title: 'Limit bookings', ask: 'One person blocks the whole day.' });
  return updateTicket(bp, t0.id, (x) => {
    Object.assign(x, {
      stage: 'review',
      live: true,
      squad: null,
      baseCommit: 'abc123',
      story: 'As a clerk, I want at most 3 bookings a day per person, so the day stays fair.',
      criteria: [{ given: 'a person with 3 bookings today', when: 'they book again', then: 'it is refused' }],
      gates,
      ...over,
    });
  });
}

describe('the review prompt in round 2', () => {
  it('has the whole ticket, the whole change, each check result and the notes from round 1', () => {
    const t = ticket({ reviewAsked: ['Count per day, not per week.', 'Add a test for the fourth booking.'] });
    const p = P.reviewPrompt(readMeta(bp), [], t, 2, undefined, ['src/booking.ts', 'test/booking.test.ts']);
    expect(p).toContain('This is review round 2: the Builder changed the code after your last review.');
    // The whole ticket, as in round 1.
    expect(p).toContain(`Ticket ${t.id}: a feature request.`);
    expect(p).toContain('Story: As a clerk, I want at most 3 bookings a day per person');
    expect(p).toContain('1. Given a person with 3 bookings today, when they book again, then it is refused.');
    expect(p).toContain('Saved decisions every ticket must follow');
    // The whole change, not only the fix.
    expect(p).toContain('Review the whole change again, not only the fix: run "git status" and "git diff abc123"');
    expect(p).toContain('Files changed since abc123 (2): src/booking.ts, test/booking.test.ts');
    // Its own notes, to check in the code.
    expect(p).toContain('In your last round you asked for:\n- Count per day, not per week.\n- Add a test for the fourth booking.');
    // The check results, each one.
    expect(p).toContain('they pass: 12 tests pass, test, lint OK');
    expect(p).toContain('Each check squad-kit ran:\n- test (npm test): passed, 12 tests\n- lint (npm run lint): passed');
    expect(p).toContain('Were tests deleted, switched off or made weaker?');
    expect(p).toContain('Approve when your notes are handled and nothing else is wrong.');
  });

  it('round 1 is unchanged in what it asks, and also lists the files and the checks', () => {
    const t = ticket();
    const p = P.reviewPrompt(readMeta(bp), [], t, 1, undefined, ['src/booking.ts']);
    expect(p).toContain("a second pair of eyes on the Builder's work");
    expect(p).toContain('Look at everything that changed since commit abc123');
    expect(p).toContain('Files changed since abc123 (1): src/booking.ts');
    expect(p).not.toContain('In your last round');
    expect(p).toContain('Approve unless there is a real problem.');
  });
});

describe('the live review loop', () => {
  it('hands round 2 the notes from round 1 and every file changed since the base, in the same conversation', async () => {
    const dir = path.join(tmp, 'copy');
    fs.mkdirSync(dir);
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(dir, 'booking.ts'), 'export const limit = 3;\n');
    sh('init', '-q', '-b', 'main');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'start');
    const base = sh('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'booking.ts'), 'export const limit = 3; // per week\n');
    fs.writeFileSync(path.join(dir, 'booking.test.ts'), "it('refuses', () => {});\n");
    const t0 = ticket({ worktree: dir, baseCommit: base, sessions: { build: 'b-1' } });
    const squad = new LiveSquad(bp) as unknown as { review(id: string): Promise<void> };

    reviews = [{ approved: false, summary: 'Almost', comments: ['Count per day, not per week.'] }];
    await squad.review(t0.id);
    let t = readTicket(bp, t0.id)!;
    expect(t.reviewAsked).toEqual(['Count per day, not per week.']);
    expect(t.squad?.phase).toBe('test');

    // The Builder fixed it and the checks passed again; round 2 starts.
    reviews = [{ approved: true, summary: 'Good now', comments: [] }];
    updateTicket(bp, t0.id, (x) => (x.squad = null));
    await squad.review(t0.id);
    const runs = calls.filter((c) => c.schema === P.REVIEW_SCHEMA);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.resume).toBe(runs[0]!.sessionId);
    expect(runs[1]!.prompt).toContain('This is review round 2');
    expect(runs[1]!.prompt).toContain('- Count per day, not per week.');
    expect(runs[1]!.prompt).toContain(`Files changed since ${base} (2): booking.ts, booking.test.ts`);
    expect(runs[1]!.prompt).toContain('Story: As a clerk');
    t = readTicket(bp, t0.id)!;
    expect(t.gates?.review).toBe('pass');
    expect(t.reviewAsked).toBeUndefined();
  });
});

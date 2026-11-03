import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * Every error the person sees says what happened in plain words, what is safe, and the ways out (phase 10). The exact
 * error stays for engineers: in the ticket's Developer tab and in the app log.
 */

const answers: ((opts: RunOptions) => Promise<RunResult>)[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> =>
    answers.shift()?.(opts) ?? new Promise((resolve) => opts.signal?.addEventListener('abort', () => resolve({ ok: false, sessionId: '', text: '', error: 'You stopped the squad.' }))),
}));

const { boardPaths, readMeta, readTicket, writeMeta } = await import('../src/board/store.js');
const { createTicket, wayOptions } = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { StepError, explainError, problemOf, withProblem } = await import('../src/board/problem.js');
const { recentLines } = await import('../src/core/app-log.js');
const { wayButtons, stuckTitle } = await import('../console-ui/src/lib/problem.js');
import type { Ticket } from '../src/board/types.js';

const base = (over: Partial<Ticket>): Ticket => ({
  id: 'RO-7',
  title: 'Show room capacity',
  ask: '',
  kind: 'feature',
  source: { type: 'manual' },
  priority: 'normal',
  stage: 'implement',
  status: 'Stopped, needs you',
  waiting: { kind: 'stuck', summary: 'The squad stopped and needs you' },
  createdAt: '2026-11-03T10:00:00Z',
  createdBy: 'Momen',
  activity: [],
  ...over,
});

describe('the shape of a stop', () => {
  it('a failed agent step: who stopped, the plain words, what is kept, and that nothing was merged', () => {
    const t = base({
      retryPhase: 'build',
      steps: [
        { title: 'a', status: 'done' },
        { title: 'b', status: 'done' },
        { title: 'c', status: 'done' },
        { title: 'd', status: 'todo' },
      ],
      stuck: { question: "Claude Code's sign-in expired. Run `claude` in a terminal, log in, then press Try again.", detail: '401 OAuth token has expired', options: wayOptions({ copy: true }) },
    });
    expect(problemOf(t)).toEqual({
      title: 'The Builder stopped',
      what: "Claude Code's sign-in expired. Run `claude` in a terminal, log in, then press Try again.",
      safe: ['Your work is saved: steps 1 to 3 are done and kept.', 'Nothing was merged or pushed.'],
      detail: '401 OAuth token has expired',
    });
    expect(withProblem(t).stuck?.title).toBe('The Builder stopped');
  });

  it('names the role of each step, and the gates by what failed', () => {
    const title = (over: Partial<Ticket>) => problemOf(base({ stuck: { question: 'x', options: [] }, ...over }))!.title;
    expect(title({ retryPhase: 'analyst-read' })).toBe('The Analyst stopped');
    expect(title({ retryPhase: 'plan-write' })).toBe('The Analyst stopped');
    expect(title({ retryPhase: 'plan-write', specApproved: { by: 'M', at: '' } })).toBe('The Architect stopped');
    expect(title({ retryPhase: 'review' })).toBe('The Reviewer stopped');
    expect(title({ retryPhase: 'proof' })).toBe('The Tester stopped');
    expect(title({ retryPhase: 'publish' })).toBe('The pull request did not open');
    expect(title({ retryPhase: 'test' })).toBe('The checks could not run');
    expect(title({ retryPhase: 'something-new' })).toBe('The squad stopped');
    expect(title({ stuck: { question: 'x', options: [], gate: 'checks' } })).toBe('The checks still fail');
    expect(title({ stuck: { question: 'x', options: [], gate: 'merge' } })).toBe('The change clashes with newer code');
    expect(title({ stuck: { question: 'You stopped the squad. Nothing was lost; the work so far is kept.', options: [] } })).toBe('You stopped the squad');
  });

  it('says what is safe from the ticket as it is: the copy for a gate, the pull request once opened, nothing when merged', () => {
    const safe = (over: Partial<Ticket>) => problemOf(base({ stuck: { question: 'x', options: [] }, ...over }))!.safe;
    expect(safe({ stuck: { question: 'x', options: [], gate: 'checks' } })).toEqual(["The changes are kept in the ticket's own copy of the code.", 'Nothing was merged or pushed.']);
    expect(safe({ retryPhase: 'publish' })).toEqual(['Nothing was lost: the work so far is kept.', 'Nothing was merged yet.']);
    expect(safe({ steps: [{ title: 'a', status: 'todo' }, { title: 'b', status: 'done' }] })[0]).toBe('Your work is saved: 1 of 2 steps are done and kept.');
    expect(safe({ mergedAt: '2026-11-03T11:00:00Z' })).toEqual(['Nothing was lost: the work so far is kept.']);
    expect(safe({ stuck: { question: 'You stopped the squad. Nothing was lost; the work so far is kept.', options: [] } })).toEqual([]);
    expect(problemOf(base({ waiting: null }))).toBeNull();
  });

  it('keeps the exact error beside the plain words, and gives plain words to errors squad-kit did not expect', () => {
    expect(explainError(new StepError('Claude is busy right now.', 'API Error: 529 overloaded'))).toEqual({ what: 'Claude is busy right now.', detail: 'API Error: 529 overloaded' });
    expect(explainError(new Error('git push failed: rejected'))).toEqual({ what: 'git push failed: rejected' });
    const typo = explainError(new TypeError("Cannot read properties of undefined (reading 'phase')"));
    expect(typo.what).toBe('squad-kit ran into a problem it did not expect.');
    expect(typo.detail).toMatch(/^TypeError: Cannot read properties/);
    const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/x/plan.md'"), { code: 'ENOENT' });
    expect(explainError(missing).what).toBe('squad-kit ran into a problem it did not expect.');
  });

  it('turns the ways out into the card’s buttons: Continue anyway asks why first, Fix it yourself opens the copy first', () => {
    const buttons = wayButtons({ question: 'x', gate: 'checks', options: wayOptions({ gate: 'checks', copy: true }) });
    expect(buttons.map((b) => [b.label, b.needs, b.primary])).toEqual([
      ['Let the Builder try 3 more times', null, true],
      ['Fix it yourself', 'fix', false],
      ['Continue anyway', 'reason', false],
      ['Send it back to the plan', null, false],
    ]);
    // A card from before ways had names: its first choice tries again.
    expect(wayButtons({ question: 'x', options: [{ name: 'Retry', note: '' }, { name: 'Plan', note: '' }] })[0]!.way).toBe('retry');
    expect(stuckTitle({ question: 'x', options: [] })).toBe('The squad stopped and needs you');
  });
});

describe('a step that fails on the live board', () => {
  let tmp: string;
  let stop: (() => void) | null = null;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-error-shapes-')));
  });
  afterEach(() => {
    stop?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stops with the plain words on the card, the exact error kept for the Developer tab, and a line in the app log', async () => {
    const dir = path.join(tmp, 'roomflow');
    fs.mkdirSync(dir);
    setupProject(dir);
    const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'roomflow');
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct', speed: 100 });
    const t = createTicket(bp, { title: 'Show room capacity' });
    answers.push(async (opts) => ({ ok: false, sessionId: opts.sessionId ?? '', text: '', error: 'Claude is busy right now. Wait a few minutes, then press Try again.', detail: 'API Error: 529 {"type":"overloaded_error"}' }));
    stop = new LiveSquad(bp).start(25);
    for (let i = 0; i < 400 && readTicket(bp, t.id)?.waiting?.kind !== 'stuck'; i += 1) await new Promise((r) => setTimeout(r, 20));
    const stuck = readTicket(bp, t.id)!;
    expect(stuck.stuck?.question).toBe('Claude is busy right now. Wait a few minutes, then press Try again.');
    expect(stuck.stuck?.detail).toBe('API Error: 529 {"type":"overloaded_error"}');
    expect(stuck.stuck?.options[0]?.name).toBe('Try again');
    expect(problemOf(stuck)?.title).toBe('The Analyst stopped');
    const log = recentLines(3_600_000).join('\n');
    expect(log).toContain(`[roomflow] ${t.id}  Stopped at analyst-read: Claude is busy right now.`);
    expect(log).toContain('API Error: 529');
  }, 20_000);
});

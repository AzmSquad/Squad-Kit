import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import { tinyApp } from './support/tiny-app.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, rpc, savedFiles, textOf } from './support/window.js';
import { checkAnswer, checkedNumbers, isProofCheck, type FakeCheck } from './support/proof-check.js';

/**
 * The proof shows each "done when" is met (RO-6 and RO-7): the Tester says per picture whether it shows its "done when"
 * met, broken or not clearly; squad-kit's own check (a Reviewer run, one for all pictures) looks at each picture too,
 * and the proof passes only when every "done when" on a screen is met. Not shown goes back to the Tester, told what to
 * show, then a plain stop: the Builder never gets a picture problem (RO-8, RO-12). Broken goes back to the Builder
 * once; still broken is a plain stop with its ways out, and Builds by itself never merges it. A stop it went past is
 * cleared once a step passes. Fake agents throughout: the Tester presses squad-kit's own screenshot tool over the
 * run's window.
 */

type Shows = 'met' | 'broken' | 'not-shown';
/** What the fake Tester says each round, by "done when" number: its verdict and note, or nothing for no picture. */
let say: (round: number) => Record<number, [Shows, string] | 'off'> = () => ({ 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['met', 'Omar is told the slot is taken.'] });
/** What squad-kit's check says each run, by "done when" number. */
let checks: (run: number) => Record<number, FakeCheck> = () => ({});
/** What the fake Tester presses before its pictures, like the fast model on RO-8 did. */
let first: ((opts: RunOptions) => Promise<void>) | null = null;
/** A Tester of the test's own, in place of the usual one. */
let testerRun: ((opts: RunOptions) => Promise<unknown>) | null = null;
const calls: RunOptions[] = [];
const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    const answer = isProofCheck(opts) ? checkAnswer(opts, checks(calls.filter(isProofCheck).length)) : opts.schema === P.PROOF_SCHEMA ? await shoot(opts) : { summary: 'Fixed it' };
    return { ok: true, structured: answer, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' } as RunResult;
  },
}));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

/** The fake Tester: one picture per "done when" it says shows on a screen, each of its own page. */
async function shoot(opts: RunOptions): Promise<unknown> {
  if (testerRun) return testerRun(opts);
  const round = calls.filter((c) => c.schema === P.PROOF_SCHEMA).length;
  const plan = say(round);
  await first?.(opts);
  const shots = [];
  const offScreen = [];
  for (const [n, v] of Object.entries(plan)) {
    if (v === 'off') {
      offScreen.push({ criterion: Number(n), why: 'It happens after a restart, which a screenshot cannot show.' });
      continue;
    }
    const [file] = savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: [{ page: `/p${n}` }] }));
    shots.push({ criterion: Number(n), file: file!, shows: v[0], note: v[1] });
  }
  return { shots, offScreen };
}

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const auto = await import('../src/board/auto.js');
const { withProblem } = await import('../src/board/problem.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('../src/engine/git.js');
const { MAX_PROOF_ROUNDS, MAX_RETAKES, brokenStop, checkVerdicts, drawnFromPicture, notShownStop, together } = await import('../src/engine/proof-verdict.js');
const P = await import('../src/engine/prompts.js');

type Squad = { proof(id: string): Promise<void>; step(id: string, phase: string): Promise<void> };
const squad = () => new LiveSquad(bp) as unknown as Squad;

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const CRITERIA = [
  { given: 'Sara is signed in', when: 'she books Room A for Monday 10:00', then: 'the booking shows as Confirmed' },
  { given: 'a booked slot', when: 'Omar books the same slot', then: 'he is told it is taken' },
];

/** A story whose work is built and whose checks and review passed: the proof is next. Builds by itself unless `full`. */
function story(full = false): string {
  const t0 = full
    ? actions.createTicket(bp, { title: 'Book a room' })
    : actions.createTicket(bp, { title: 'Book a room', fromBreakdown: { id: 'BR-1', item: 'S-4', story: 'As a clerk, I want to book a room.', criteria: CRITERIA, approvedBy: 'Momen' } });
  const wt = addWorktree(project, t0.id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'rooms.txt'), 'Room A\n');
  updateTicket(bp, t0.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'review';
    x.live = true;
    x.squad = null;
    x.sessions = { intake: 'i-1', build: 'b-1', review: 'r-1', tester: 't-1' };
    x.criteria = CRITERIA;
    x.steps = [{ title: 'Book a room', status: 'done' }];
    x.work = { steps: 1, tests: 1, screens: 2 };
    x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
  });
  return t0.id;
}

/** After the Builder's fix the checks and a fresh review pass again, as the live squad runs them; the proof is next. */
function checksAndReviewPassAgain(id: string): void {
  updateTicket(bp, id, (x) => {
    x.stage = 'review';
    x.squad = null;
    x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
  });
}

const ticket = (id: string) => readTicket(bp, id)!;
const lines = (id: string) => ticket(id).activity.map((a) => a.text);
const testerRuns = () => calls.filter((c) => c.schema === P.PROOF_SCHEMA);
const checkRuns = () => calls.filter(isProofCheck);
const builderRuns = () => calls.filter((c) => c.prompt.includes('they show these "done when" do not work yet'));

beforeEach(async () => {
  calls.length = 0;
  say = () => ({ 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['met', 'Omar is told the slot is taken.'] });
  checks = () => ({});
  first = null;
  testerRun = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-verdict-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'rooms.txt'), 'none\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', project);
  bp = boardPaths(path.join(project, '.squad'));
  const app = await tinyApp();
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 1,
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
  h.browser = fakeBrowser({ '/p1': { has: ['combobox:Booking as', 'button:Book'] }, '/p2': { has: [] } }).module;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the proof shows each "done when" is met', () => {
  it('both say met: each row is marked Met, and Builds by itself accepts and merges it', async () => {
    const id = story();
    await squad().proof(id);
    let t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(t.proof?.map((p) => [p.criterion, p.shows])).toEqual([
      ['The booking shows as Confirmed', 'met'],
      ['He is told it is taken', 'met'],
    ]);
    // One short check for all the pictures, not one per picture.
    expect(checkRuns()).toHaveLength(1);
    expect(checkedNumbers(checkRuns()[0]!)).toEqual([1, 2]);
    expect(t.squad?.phase).toBe('accept');
    await squad().step(id, 'accept');
    t = ticket(id);
    expect(t.mergedAt).toBeTruthy();
    expect(sh('git show main:rooms.txt', project)).toBe('Room A');
  });

  it('the check runs as the Reviewer, at the level the Quality setting gives a review, and may read the pictures', async () => {
    const id = story();
    await squad().proof(id);
    const run = checkRuns()[0]!;
    expect(run.schema).toBe(P.PROOF_CHECK_SCHEMA);
    expect(run.addDirs).toContain(bp.proofDir);
    // Each picture by its full path in the proof folder, next to its "done when" in full.
    const files = ticket(id).proof!.map((p) => path.join(bp.proofDir, p.after));
    for (const f of files) expect(run.prompt).toContain(f);
    expect(run.prompt).toContain('1. Done when: Given Sara is signed in, when she books Room A for Monday 10:00, then the booking shows as Confirmed.');
    expect(run.prompt).toContain('the picture shows the result of the "done when" as written');
    // Best: the Reviewer at high effort; Thrifty: medium, as a review would be.
    expect(run.effort).toBe('high');
    expect(ticket(id).activity.some((a) => a.who === 'reviewer' && a.text.startsWith('Runs on') && a.text.includes('strongest'))).toBe(true);
    calls.length = 0;
    writeMeta(bp, { ...readMeta(bp), quality: 'thrifty' });
    const id2 = story(true);
    await squad().proof(id2);
    expect(checkRuns()[0]!.effort).toBe('medium');
    // It only reads.
    expect(checkRuns()[0]!.allowedTools).not.toContain('Edit');
  });

  it('the Tester says broken: back to the Builder with the plain note, then fixed, then merged', async () => {
    const id = story();
    say = (round) =>
      round === 1
        ? { 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['broken', 'At phone width the page runs off the right edge, so it scrolls sideways.'] }
        : { 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['met', 'Omar is told the slot is taken.'] };
    await squad().proof(id);
    let t = ticket(id);
    expect(t.gates?.proof).toBe('fail');
    expect(t.proof?.find((p) => p.criterion === 'He is told it is taken')).toMatchObject({ shows: 'broken', why: 'At phone width the page runs off the right edge, so it scrolls sideways.' });
    // The Builder got the notes like review notes; its fix starts the checks, a fresh review and the proof again.
    expect(builderRuns()).toHaveLength(1);
    expect(builderRuns()[0]!.prompt).toContain('- "Done when" 2 (He is told it is taken): At phone width the page runs off the right edge, so it scrolls sideways.');
    expect(t.squad?.phase).toBe('test');
    expect(t.reviewRound).toBe(0);
    expect(t.proofRound).toBe(1);
    expect(t.mergedAt).toBeUndefined();
    expect(lines(id)).toContain('Fixed what the screenshots showed');
    // The check looked at every picture, the one the Tester called broken too.
    expect(checkedNumbers(checkRuns()[0]!)).toEqual([1, 2]);
    expect(checkRuns()[0]!.prompt).toContain('The Tester says it is broken: At phone width');

    checksAndReviewPassAgain(id);
    await squad().proof(id);
    t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(t.proof?.every((p) => p.shows === 'met')).toBe(true);
    expect(t.proofRound).toBeUndefined();
    await squad().step(id, 'accept');
    expect(ticket(id).mergedAt).toBeTruthy();
  });

  it("squad-kit's check says broken while the Tester says met: back to the Builder", async () => {
    const id = story();
    checks = () => ({ 2: ['broken', 'The picture shows the booking form with no message at all.'] });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.proof?.find((p) => p.criterion === 'He is told it is taken')).toMatchObject({ shows: 'broken', why: 'The picture shows the booking form with no message at all.' });
    expect(t.proof?.find((p) => p.criterion === 'The booking shows as Confirmed')?.shows).toBe('met');
    expect(builderRuns()[0]!.prompt).toContain('"Done when" 2 (He is told it is taken): The picture shows the booking form with no message at all.');
    expect(t.squad?.phase).toBe('test');
    expect(lines(id)).toContain('Checked the screenshots: 1 met, 1 not working yet');
  });

  it('not shown: the Tester takes it again in its own conversation, told what to show; then met passes, and the Builder is never called', async () => {
    const id = story();
    // The check says not shown while the Tester says met: the Tester gets the advice, never the Builder.
    say = (round): Record<number, [Shows, string]> => (round === 1 ? { 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['met', 'Omar is told the slot is taken.'] } : { 2: ['met', 'Omar is told the slot is taken.'] });
    checks = (run) => (run === 1 ? { 2: ['not-shown', "Omar's message is below the part of the page in the picture.", { advice: 'Show the message under the Book button after pressing Book, on a phone.' }] } : ({} as Record<number, FakeCheck>));
    await squad().proof(id);
    const t = ticket(id);
    expect(testerRuns()).toHaveLength(2);
    expect(testerRuns()[1]!.prompt).toContain(`The after screenshot for "done when" 2 ("He is told it is taken") does not show it clearly yet: Omar's message is below the part of the page in the picture. Show it like this: Show the message under the Book button after pressing Book, on a phone.`);
    // The same conversation, so it knows what it took and why.
    expect(testerRuns()[1]!.sessionId).toBe(testerRuns()[0]!.sessionId);
    // The second check looked only at the new picture.
    expect(checkRuns()).toHaveLength(2);
    expect(checkedNumbers(checkRuns()[1]!)).toEqual([2]);
    expect(t.gates?.proof).toBe('pass');
    expect(t.proof?.every((p) => p.shows === 'met')).toBe(true);
    expect(t.proof?.find((p) => p.criterion === 'He is told it is taken')?.why).toBeUndefined();
    expect(builderRuns()).toHaveLength(0);
    expect(calls.filter((c) => c.schema === P.BUILD_SCHEMA)).toHaveLength(0);
    expect(t.fails ?? 0).toBe(0);
    expect(lines(id)).toContain('The screenshots do not show "done when" 2 clearly yet, so the Tester takes it again (try 1 of 2)');
  });

  it(`not shown after ${MAX_RETAKES} retakes: a plain stop with its ways out, the Builder never called, the note reaches the Tester`, async () => {
    const id = story();
    checks = () => ({ 2: ['not-shown', 'The day view is not in the picture.', { advice: 'Open the day view on Monday.' }] });
    await squad().proof(id);
    let t = ticket(id);
    expect(testerRuns()).toHaveLength(1 + MAX_RETAKES);
    expect(checkRuns()).toHaveLength(1 + MAX_RETAKES);
    expect(builderRuns()).toHaveLength(0);
    expect(calls.filter((c) => c.schema === P.BUILD_SCHEMA)).toHaveLength(0);
    expect(t.proofRound).toBeUndefined();
    expect(t.fails ?? 0).toBe(0);
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.status).toBe('The screenshots do not show it yet');
    expect(t.stuck).toMatchObject({
      gate: 'proof',
      kind: 'not-shown',
      question: 'The squad could not show "done when" 2 on a screen. Try it yourself, or ask a question.',
      points: ['"Done when" 2, He is told it is taken: The day view is not in the picture.'],
    });
    expect(t.stuck!.options.map((o) => [o.do, o.name])).toEqual([
      ['retry', 'Take the screenshots again'],
      ['continue', 'Continue anyway'],
      ['plan', 'Send it back to the plan'],
    ]);
    expect(withProblem(t).stuck!.title).toBe('A "done when" is not shown yet');
    expect(t.proof?.find((p) => p.criterion === 'He is told it is taken')).toMatchObject({ shows: 'not-shown', why: 'The day view is not in the picture.' });
    expect(t.retryPhase).toBe('proof');
    expect(t.clock).toBeUndefined();
    expect(lines(id)).toContain('Checked the screenshots: 1 met, 1 not shown yet');
    // Builds by itself never accepts it.
    await squad().step(id, 'accept');
    t = ticket(id);
    expect(t.mergedAt).toBeUndefined();

    // Take the screenshots again, with a note: only the proof runs again, and the Tester reads the note.
    updateTicket(bp, id, (x) => {
      x.waiting = { kind: 'stuck', summary: 'The screenshots do not show it yet: needs one decision' };
      x.squad = null;
    });
    const tried = actions.decideStuck(bp, id, 0, { note: 'The message shows after you press Book twice.' });
    expect(tried.squad?.phase).toBe('proof');
    const before = testerRuns().length;
    await squad().step(id, 'proof');
    expect(testerRuns()[before]!.prompt).toContain('The message shows after you press Book twice.');
    expect(builderRuns()).toHaveLength(0);
  });

  it('Continue anyway past what is not shown: your check, with the rows marked, on the record', async () => {
    const id = story(true);
    checks = () => ({ 2: ['not-shown', 'The day view is not in the picture.'] });
    await squad().proof(id);
    const went = actions.decideStuck(bp, id, 1, { reason: 'I looked myself' });
    expect(went.waiting).toEqual({ kind: 'proof', summary: 'Ready for you to check: a "done when" is not shown yet' });
    expect(went.gates?.proof).toBe('skipped');
    expect(went.proof?.map((p) => p.shows)).toEqual(['met', 'not-shown']);
    expect(builderRuns()).toHaveLength(0);
  });

  it('a "broken" whose reason is about the picture is not shown: RO-12 and RO-8 never reach the Builder', async () => {
    const id = story();
    say = (round) => (round === 1 ? { 1: ['broken', 'The booking form is below the visible part of the page.'], 2: ['met', 'Omar is told the slot is taken.'] } : { 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['met', 'Omar is told the slot is taken.'] });
    checks = (run) => (run === 1 ? { 2: ['broken', 'The picture is not at the required 360 px.'] } : ({} as Record<number, FakeCheck>));
    await squad().proof(id);
    const t = ticket(id);
    // The check said picture 1 is met, and the Tester's reason was about its picture: met. Picture 2 went back.
    expect(t.gates?.proof).toBe('pass');
    expect(testerRuns()).toHaveLength(2);
    expect(builderRuns()).toHaveLength(0);
  });

  it('the Tester says not shown and the check sees it met: met', async () => {
    const id = story();
    say = () => ({ 1: ['not-shown', 'I could not get it all in.'], 2: ['met', 'Omar is told the slot is taken.'] });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(t.proof?.every((p) => p.shows === 'met')).toBe(true);
    expect(testerRuns()).toHaveLength(1);
  });

  it('the Tester says broken and the check says the picture does not show it: taken again, not sent to the Builder', async () => {
    const id = story();
    say = (round) => (round === 1 ? { 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['broken', 'No message shows.'] } : { 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['met', 'Omar is told the slot is taken.'] });
    checks = (run) => (run === 1 ? { 2: ['not-shown', 'The page is still loading in the picture.'] } : ({} as Record<number, FakeCheck>));
    await squad().proof(id);
    expect(ticket(id).gates?.proof).toBe('pass');
    expect(builderRuns()).toHaveLength(0);
  });

  it('every fix of the Builder tells it to fix only what is broken, never the product for a picture', () => {
    const rule = 'Fix only what is broken in the product. Never change the product just to make a picture clearer.';
    expect(P.proofFixPrompt(['"Done when" 1 (x): no message.'])).toContain(rule);
    expect(P.fixChecksPrompt([{ name: 'test', command: 'npm test', output: 'failed' }])).toContain(rule);
    expect(P.reviewFixPrompt(['Fix the title.'])).toContain(rule);
  });

  it('the old words count: unclear is not shown, not-met broken; a check that says nothing cannot tell', () => {
    const v = checkVerdicts({ checks: [{ criterion: 1, shows: 'unclear', why: 'Still loading.' }, { criterion: 2, shows: 'not-met', why: 'An error shows.' }] }, [1, 2, 3]);
    expect(v.get(1)).toMatchObject({ shows: 'not-shown', why: 'Still loading.' });
    expect(v.get(2)).toMatchObject({ shows: 'broken', why: 'An error shows.' });
    expect(v.get(3)).toMatchObject({ shows: 'not-shown', why: '' });
  });

  it('the rules for two verdicts together', () => {
    const c = (shows: Shows, why = 'x shows.', more = {}) => ({ shows, why, advice: '', noChange: false, ...more });
    const met = { shows: 'met' as const, note: 'It shows.' };
    expect(together(met, c('met')).shows).toBe('met');
    expect(together(met, undefined).shows).toBe('not-shown');
    expect(together(met, c('not-shown')).shows).toBe('not-shown');
    expect(together(met, c('broken', 'An error shows.'))).toMatchObject({ shows: 'broken', why: 'An error shows.' });
    expect(together(met, c('broken', '')).shows).toBe('not-shown');
    expect(together({ shows: 'broken', note: 'An error shows.' }, c('met'))).toMatchObject({ shows: 'broken', why: 'An error shows.' });
    expect(together({ shows: 'broken', note: 'An error shows.' }, c('not-shown')).shows).toBe('not-shown');
    expect(together({ shows: 'broken' }, c('met')).shows).toBe('met');
    expect(together({ shows: 'not-shown', note: 'Cut off.' }, c('met')).shows).toBe('met');
    // The same picture as before: shows nothing, unless the check says the screen is meant to stay as it was.
    expect(together(met, c('met'), true)).toMatchObject({ shows: 'not-shown' });
    expect(together(met, c('met', 'Fine.', { noChange: true }), true).shows).toBe('met');
    expect(together(met, c('not-shown', 'Cut off.', { noChange: true }), true).shows).toBe('not-shown');
    expect(together(met, c('broken', 'An error shows.'), true).shows).toBe('broken');
  });

  it('tells a reason about the picture from one about the product, in the words of the real runs', () => {
    for (const why of [
      'The booking form is below the visible part of the page, so the Borealis line in the form cannot be seen in this picture.',
      'The screenshot does not show clearly that it works.',
      'The picture is not at the required 360 px.',
      'The room management page is not in this picture.',
      "The refused 16 Nov booking and its message are not in view.",
      'The past half of this "done when" cannot be judged from the picture.',
      'The rest of the second card is out of view.',
      'The page is still loading.',
      '',
    ]) {
      expect(drawnFromPicture(why), why).toBe(false);
    }
    for (const why of [
      'At phone width the page runs off the right edge, so it scrolls sideways.',
      'The picture shows the booking form with no message at all.',
      'An error shows: something went wrong.',
      'The title is cut off with no way to read the rest.',
    ]) {
      expect(drawnFromPicture(why), why).toBe(true);
    }
  });

  it(`${MAX_PROOF_ROUNDS} rounds still broken: a plain stop with the ways out, never merged by itself`, async () => {
    const id = story();
    say = () => ({ 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['broken', 'At phone width the page runs off the right edge, so the page scrolls sideways.'] });
    await squad().proof(id);
    checksAndReviewPassAgain(id);
    await squad().proof(id);
    let t = ticket(id);
    expect(builderRuns()).toHaveLength(1);
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck).toMatchObject({
      gate: 'proof',
      kind: 'broken',
      question: 'The screenshots show "done when" 2 is not working yet: at phone width the page runs off the right edge, so the page scrolls sideways.',
      points: ['"Done when" 2: He is told it is taken'],
    });
    expect(t.stuck!.options.map((o) => [o.do, o.name])).toEqual([
      ['retry', 'Let the Builder try again'],
      ['continue', 'Continue anyway'],
      ['plan', 'Send it back to the plan'],
    ]);
    expect(withProblem(t).stuck!.title).toBe('A "done when" is not working yet');
    expect(t.retryPhase).toBe('proof-fix');
    // Builds by itself never accepts it, even if an accept came: it waits for the person with the proof.
    await squad().step(id, 'accept');
    t = ticket(id);
    expect(t.mergedAt).toBeUndefined();
    expect(sh('git show main:rooms.txt', project)).toBe('none');

    // Let the Builder try again: it gets what the screenshots show, with two more rounds.
    updateTicket(bp, id, (x) => {
      x.waiting = { kind: 'stuck', summary: 'The screenshots show it is not working yet: needs one decision' };
      x.squad = null;
    });
    const tried = actions.decideStuck(bp, id, 0);
    expect(tried.squad?.phase).toBe('proof-fix');
    expect(tried.proofRound).toBeUndefined();
    await squad().step(id, 'proof-fix');
    expect(builderRuns()).toHaveLength(2);
    expect(builderRuns()[1]!.prompt).toContain('"Done when" 2 (He is told it is taken)');
    expect(ticket(id).squad?.phase).toBe('test');
  });

  it('a stop from before the three verdicts, with only picture problems: Let the Builder try again goes to the Tester', async () => {
    const id = story();
    updateTicket(bp, id, (x) => {
      x.live = false;
      x.retryPhase = 'proof-fix';
      x.gates = { checks: 'pass', review: 'pass', proof: 'fail' };
      x.stuck = { gate: 'proof', kind: 'not-met' as never, question: 'The screenshots show "done when" 2 is not met yet.', options: actions.wayOptions({ gate: 'proof', kind: 'broken' }) };
      x.waiting = { kind: 'stuck', summary: 'The screenshots show it is not done yet: needs one decision' };
      x.proof = [{ criterion: 'He is told it is taken', before: 'a.png', after: 'b.png', beforeLabel: 'New screen', afterLabel: 'After', shows: 'not-shown', why: 'The day view is not in the picture.' }];
    });
    // Read back, the old kind is the new one.
    expect(ticket(id).stuck?.kind).toBe('broken');
    actions.decideStuck(bp, id, 0);
    await squad().step(id, 'proof-fix');
    expect(builderRuns()).toHaveLength(0);
    expect(testerRuns()).toHaveLength(1);
  });

  it('a stray accept of a story with a "done when" broken or not shown waits for the person', () => {
    const id = story();
    updateTicket(bp, id, (x) => {
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.proof = [{ criterion: 'He is told it is taken', before: 'a.png', after: 'b.png', beforeLabel: 'New screen', afterLabel: 'After', shows: 'broken', why: 'No message shows.' }];
    });
    const t = auto.acceptByItself(bp, id);
    expect(t.mergedAt).toBeUndefined();
    expect(t.waiting).toEqual({ kind: 'proof', summary: 'Ready for you to check: a "done when" is not working yet' });
    expect(t.activity[0]!.text).toBe('Not accepted by itself: the screenshots show a "done when" is not working yet');

    const id2 = story();
    updateTicket(bp, id2, (x) => {
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.proof = [{ criterion: 'He is told it is taken', before: 'a.png', after: 'b.png', beforeLabel: 'New screen', afterLabel: 'After', shows: 'not-shown', why: 'The day view is not in the picture.' }];
    });
    const t2 = auto.acceptByItself(bp, id2);
    expect(t2.mergedAt).toBeUndefined();
    expect(t2.waiting).toEqual({ kind: 'proof', summary: 'Ready for you to check: a "done when" is not shown yet' });
  });

  it('on Full, Continue anyway goes on to your check with the rows marked, on the record', async () => {
    const id = story(true);
    say = () => ({ 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: ['broken', 'No message shows when Omar books the same slot.'] });
    await squad().proof(id);
    checksAndReviewPassAgain(id);
    await squad().proof(id);
    const t0 = ticket(id);
    expect(t0.stuck?.kind).toBe('broken');
    const went = actions.decideStuck(bp, id, 1, { reason: 'The message comes in the next story' });
    expect(went.waiting).toEqual({ kind: 'proof', summary: 'Ready for you to check: a "done when" is not working yet' });
    expect(went.gates?.proof).toBe('skipped');
    expect(went.proof?.map((p) => p.shows)).toEqual(['met', 'broken']);
  });

  it('a "done when" the Tester says shows on no screen does not fail the gate', async () => {
    const id = story();
    say = () => ({ 1: ['met', 'Sara’s booking shows as Confirmed.'], 2: 'off' });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(t.offScreen).toEqual([{ criterion: 'He is told it is taken', why: 'It happens after a restart, which a screenshot cannot show.' }]);
    expect(t.proof?.map((p) => p.criterion)).toEqual(['The booking shows as Confirmed']);
    expect(lines(id)).toContain('Saved 1 screenshots. Not on a screen: "done when" 2');
  });

  it('a "done when" with no picture, and not said to show on no screen, is asked for, then is a plain stop with no Builder', async () => {
    const id = story();
    say = () => ({ 1: ['met', 'Sara’s booking shows as Confirmed.'] });
    await squad().proof(id);
    // The answer named only "done when" 1: squad-kit asked for a complete one, then took a retake for 2.
    expect(lines(id).some((l) => l.startsWith('The answer was not complete (every "done when" must be in shots or in offScreen, and "done when" 2 is in neither)'))).toBe(true);
    expect(testerRuns().at(-1)!.prompt).toContain('"Done when" 2 ("He is told it is taken") has no screenshot, and you did not say it shows on no screen.');
    expect(builderRuns()).toHaveLength(0);
    expect(ticket(id).stuck).toMatchObject({ kind: 'not-shown', question: 'The squad could not show "done when" 2 on a screen. Try it yourself, or ask a question.', points: ['"Done when" 2, He is told it is taken: No screenshot shows it.'] });
  });

  it('the Tester gets the exact list of the pictures it took, and a name from outside it is asked for once more with the list', async () => {
    const id = story();
    let answers = 0;
    let told = '';
    testerRun = async (opts) => {
      answers += 1;
      if (answers === 1) {
        // RO-13: a file from an earlier round of the same conversation.
        const list = await callTool(opts.window!, 'take_screenshots', { shots: [{ page: '/p1' }, { page: '/p2', size: 'phone' }] });
        const [a] = savedFiles(list);
        told = textOf(list);
        return { shots: [{ criterion: 1, file: a!, shows: 'met', note: 'Confirmed.' }, { criterion: 2, file: 'ap-1-after-41.png', shows: 'met', note: 'Taken.' }], offScreen: [] };
      }
      return { shots: [{ criterion: 1, file: `${id.toLowerCase()}-after-1.png`, shows: 'met', note: 'Confirmed.' }, { criterion: 2, file: `${id.toLowerCase()}-after-2.png`, shows: 'met', note: 'Taken.' }], offScreen: [] };
    };
    await squad().proof(id);
    // Every answer of take_screenshots ends with the list: name, page and size.
    expect(told).toContain(`The pictures you took in this step. In your final answer, name only these files:\n- ${id.toLowerCase()}-after-1.png: /p1, desktop\n- ${id.toLowerCase()}-after-2.png: /p2, phone`);
    // Named wrong: asked again, in the same conversation, with the same list.
    expect(answers).toBe(2);
    expect(testerRuns()[1]!.prompt).toContain('it names ap-1-after-41.png, which squad-kit did not take in this step');
    expect(testerRuns()[1]!.prompt).toContain(`- ${id.toLowerCase()}-after-2.png: /p2, phone`);
    expect(ticket(id).gates?.proof).toBe('pass');
    expect(lines(id).some((l) => l.includes('left out'))).toBe(false);
  });

  it('the limit on pictures is plain in the tool and in its answer', async () => {
    const id = story();
    let over = '';
    let many = '';
    testerRun = async (opts) => {
      const shots = (n: number) => ({ shots: Array.from({ length: n }, (_, i) => ({ page: `/p${(i % 2) + 1}` })) });
      many = textOf(await callTool(opts.window!, 'take_screenshots', shots(11)));
      const tools = (await rpc(opts.window!, 'tools/list')).body.result.tools as { name: string; description: string }[];
      over = tools.find((t) => t.name === 'take_screenshots')!.description;
      const [a] = savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: [{ page: '/p1' }] }));
      return { shots: [{ criterion: 1, file: a!, shows: 'met', note: 'Confirmed.' }], offScreen: [{ criterion: 2, why: 'It needs a second person at the same time.' }] };
    };
    await squad().proof(id);
    expect(over).toContain('at most 10 shots in one call, and at most 40 pictures in all in this step, counting each one you take again');
    expect(many).toContain('11 shots in one call, and one call takes at most 10. Split them over calls: this step may take 40 pictures in all, and 40 are left');
  });

  it("RO-8's own calls in the wrong shape never stop the story: the proof goes on and passes", async () => {
    const id = story();
    first = async (opts) => {
      // The exact shapes from that day's log, a few times over.
      for (let i = 0; i < 3; i += 1) {
        await callTool(opts.window!, 'look_at_page', { path: '/p1' });
        await callTool(opts.window!, 'take_screenshots', { shots: [{ page: '/p1', steps: [{ action: 'select', role: 'combobox', name: 'Booking as', value: 'Lina Park' }, { action: 'wait', ms: 500 }], size: 'desktop' }] });
        await callTool(opts.window!, 'take_screenshots', { shots: [{ page: '/p1', steps: [{ fill: { role: 'textbox', name: 'Title' }, value: 'Sprint review' }] }] });
      }
    };
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(t.stuck).toBeUndefined();
    expect(lines(id).some((l) => l.includes('may not do') || l.includes('refused'))).toBe(false);
  });

  it('a check that does not get through is a plain stop with Try again, never a pass', async () => {
    const id = story();
    checks = () => {
      throw new Error('the reviewer run broke');
    };
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('fail');
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck?.options[0]).toMatchObject({ do: 'retry', name: 'Take the screenshots again' });
    expect(t.squad ?? null).toBeNull();
  });
});

describe('the plain stop', () => {
  it('names one "done when" in a sentence, or counts several', () => {
    expect(brokenStop([{ criterion: 5, text: 'The page fits a phone', why: 'The page scrolls sideways on a phone.' }])).toEqual({
      question: 'The screenshots show "done when" 5 is not working yet: the page scrolls sideways on a phone.',
      points: ['"Done when" 5: The page fits a phone'],
    });
    expect(
      brokenStop([
        { criterion: 2, text: 'A', why: 'No message.' },
        { criterion: 3, text: 'B', why: 'The list is empty.' },
      ]),
    ).toEqual({ question: 'The screenshots show 2 "done when" are not working yet.', points: ['"Done when" 2, A: No message.', '"Done when" 3, B: The list is empty.'] });
  });

  it('says plainly what the squad could not show', () => {
    expect(notShownStop([{ criterion: 3, text: 'A', why: 'It is out of view.' }])).toEqual({
      question: 'The squad could not show "done when" 3 on a screen. Try it yourself, or ask a question.',
      points: ['"Done when" 3, A: It is out of view.'],
    });
    expect(notShownStop([{ criterion: 3, text: 'A', why: 'x' }, { criterion: 5, text: 'B', why: 'y' }, { criterion: 6, text: 'C', why: 'z' }]).question).toBe('The squad could not show "done when" 3, 5 and 6 on a screen. Try it yourself, or ask a question.');
  });
});

describe('a stop it went past is cleared (RO-6)', () => {
  it('stuck on the proof, Take the screenshots again, the proof passes, accepted by itself: no stop is left', async () => {
    const id = story();
    // RO-6 as it really stopped: the Tester could not take the screenshots.
    updateTicket(bp, id, (x) => {
      x.live = false;
      x.retryPhase = 'proof';
      x.gates = { checks: 'pass', review: 'pass', proof: 'fail' };
      x.stuck = {
        gate: 'proof',
        question: 'The Tester could not take the screenshots. Saved 0 screenshots.',
        options: actions.wayOptions({ gate: 'proof' }),
      };
      x.waiting = { kind: 'stuck', summary: 'No screenshots yet: needs one decision' };
    });
    const tried = actions.decideStuck(bp, id, 0);
    expect(tried.squad?.phase).toBe('proof');
    await squad().step(id, 'proof');
    let t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(t.stuck).toBeUndefined();
    expect(t.waiting).toBeNull();
    await squad().step(id, 'accept');
    t = ticket(id);
    expect(t.mergedAt).toBeTruthy();
    expect(t.stuck).toBeUndefined();
    expect(t.activity.find((a) => a.text.includes('accepted by itself'))!.text).toBe('Checks, review and screenshots passed: accepted by itself');
  });

  it('a later pass of the checks or the review clears an old stop too', async () => {
    const { clearStaleStop } = await import('../src/board/stale-stop.js');
    const t = { stuck: { gate: 'review' as const, question: 'The Reviewer still asks for a change after 2 rounds.', options: [] }, waiting: { kind: 'stuck' as const, summary: 'x' } };
    clearStaleStop(t as never);
    expect(t).toEqual({ stuck: undefined, waiting: null });
  });
});

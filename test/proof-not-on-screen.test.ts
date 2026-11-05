import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import type { ProofShot, Ticket } from '../src/board/types.js';
import { tinyApp } from './support/tiny-app.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, savedFiles } from './support/window.js';
import { checkAnswer, checkedNumbers, isProofCheck, type FakeCheck } from './support/proof-check.js';
import { notOnScreen, verdictClass, verdictNote, verdictWord } from '../console-ui/src/lib/verdict.js';
import { proofWords } from '../console-ui/src/lib/gates.js';

/**
 * A "done when" that truly cannot be shown (RO-12: no past bookings in the app; RO-8: no old booking in the data). The
 * Tester's reason goes to squad-kit's check, which says whether it can be shown at all. Two voices agree: it is Not on a
 * screen, with its pictures kept and which part could not be shown, and it does not stop the story. A lazy reason goes
 * back to the Tester, then a plain stop. Fake agents; the Tester presses squad-kit's own screenshot tool.
 */

type Shows = 'met' | 'broken' | 'not-shown';
/** What the fake Tester does for a "done when" in a round: a picture with its verdict and note, a reason it cannot be shown, or both. */
type Plan = { pic?: [Shows, string]; off?: string };
let say: (round: number) => Record<number, Plan> = () => ({});
let checks: (run: number) => Record<number, FakeCheck> = () => ({});
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

async function shoot(opts: RunOptions): Promise<unknown> {
  const round = calls.filter((c) => c.schema === P.PROOF_SCHEMA).length;
  const shots = [];
  const offScreen = [];
  for (const [n, v] of Object.entries(say(round))) {
    if (v.off) offScreen.push({ criterion: Number(n), why: v.off });
    if (!v.pic) continue;
    const [file] = savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: [{ page: `/p${n}` }] }));
    shots.push({ criterion: Number(n), file: file!, shows: v.pic[0], note: v.pic[1] });
  }
  return { shots, offScreen };
}

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const auto = await import('../src/board/auto.js');
const { withProblem } = await import('../src/board/problem.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('../src/engine/git.js');
const { MAX_RETAKES, SAME_PICTURE, afterLastRetake, cannotShowLine, checkVerdicts, fromReason, reasonRefusedLine, together } = await import('../src/engine/proof-verdict.js');
const { readTicketDocs, ticketDocs } = await import('../src/board/docs.js');
const P = await import('../src/engine/prompts.js');

type Squad = { proof(id: string): Promise<void>; step(id: string, phase: string): Promise<void> };
const squad = () => new LiveSquad(bp) as unknown as Squad;

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const ROOM = 'The room shows on the day view';
const NAME = 'They show the new name';
const CRITERIA = [
  { given: 'a room', when: 'anyone opens the day view', then: 'the room shows on the day view' },
  { given: 'a room renamed Dune', when: 'anyone looks at past and upcoming bookings for that room', then: 'they show the new name' },
];
const PART = 'Shown for upcoming bookings. Past bookings could not be shown: the app has none yet.';
const REASON = 'The app has no past bookings, and none can be made through its screens.';
const MET: Plan = { pic: ['met', 'The room is on the day view.'] };
const UPCOMING: Plan = { pic: ['met', 'Upcoming bookings show Dune.'] };

/** A story whose work is built and whose checks and review passed: the proof is next. Builds by itself unless `full`. */
function story(full = false): string {
  const t0 = full
    ? actions.createTicket(bp, { title: 'Rename a room' })
    : actions.createTicket(bp, { title: 'Rename a room', fromBreakdown: { id: 'BR-1', item: 'S-4', story: 'As a clerk, I want to rename a room.', criteria: CRITERIA, approvedBy: 'Momen' } });
  const wt = addWorktree(project, t0.id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'rooms.txt'), 'Dune\n');
  updateTicket(bp, t0.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'review';
    x.live = true;
    x.squad = null;
    x.sessions = { intake: 'i-1', build: 'b-1', review: 'r-1', tester: 't-1' };
    x.criteria = CRITERIA;
    x.steps = [{ title: 'Rename a room', status: 'done' }];
    x.work = { steps: 1, tests: 1, screens: 2 };
    x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
  });
  return t0.id;
}

const ticket = (id: string) => readTicket(bp, id)!;
const lines = (id: string) => ticket(id).activity.map((a) => a.text);
const row = (id: string, criterion: string) => ticket(id).proof?.find((p) => p.criterion === criterion);
const testerRuns = () => calls.filter((c) => c.schema === P.PROOF_SCHEMA);
const checkRuns = () => calls.filter(isProofCheck);

beforeEach(async () => {
  calls.length = 0;
  say = () => ({});
  checks = () => ({});
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-off-screen-')));
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
  h.browser = fakeBrowser({ '/p1': { has: [] }, '/p2': { has: [] } }).module;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the Tester and the check agree it cannot be shown', () => {
  it('RO-12: a picture of a part, the Tester says why not the rest, the check agrees: Not on a screen, pictures kept, and it merges', async () => {
    const id = story();
    say = () => ({ 1: MET, 2: { ...UPCOMING, off: REASON } });
    checks = () => ({ 2: ['not-shown', 'Neither picture shows a past booking.', { canShow: false, canShowWhy: PART }] });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(t.stuck).toBeUndefined();
    expect(row(id, NAME)).toMatchObject({ shows: 'off-screen', why: PART, note: 'Upcoming bookings show Dune.' });
    expect(row(id, NAME)!.after).toBeTruthy();
    expect(row(id, ROOM)?.shows).toBe('met');
    // The row says it itself, so it is not on the list of those with no picture too.
    expect(t.offScreen).toBeUndefined();
    // The check saw the Tester's reason beside the picture, and no retake was needed.
    expect(checkRuns()[0]!.prompt).toContain(`The Tester says this cannot be shown on a screen: ${REASON}`);
    expect(testerRuns()).toHaveLength(1);
    expect(checkRuns()).toHaveLength(1);
    expect(lines(id)).toContain('Checked the screenshots: 1 met, 1 not on a screen');
    expect(lines(id)).toContain(`"Done when" 2 is not on a screen: ${PART}`);
    // Builds by itself accepts it and merges it.
    expect(t.squad?.phase).toBe('accept');
    await squad().step(id, 'accept');
    expect(ticket(id).mergedAt).toBeTruthy();
    expect(sh('git show main:rooms.txt', project)).toBe('Dune');
  });

  it('RO-12 as it went: the Tester says so only on a retake, with no new picture, and the check looks again', async () => {
    const id = story();
    say = (round): Record<number, Plan> => (round === 1 ? { 1: MET, 2: UPCOMING } : { 2: { off: REASON } });
    checks = (run): Record<number, FakeCheck> => (run === 1 ? { 2: ['not-shown', 'Neither picture shows a past booking.', { advice: 'Open a past booking.' }] } : { 2: ['not-shown', 'Neither picture shows a past booking.', { canShow: false, canShowWhy: PART }] });
    await squad().proof(id);
    const t = ticket(id);
    expect(testerRuns()).toHaveLength(2);
    expect(checkedNumbers(checkRuns()[1]!)).toEqual([2]);
    expect(t.gates?.proof).toBe('pass');
    expect(row(id, NAME)).toMatchObject({ shows: 'off-screen', why: PART, note: 'Upcoming bookings show Dune.' });
  });

  it("RO-8's dw4: no picture, on the list from the start, and the check agrees: it still passes, on the check's own words", async () => {
    const id = story();
    say = () => ({ 1: MET, 2: { off: 'There is no old booking in the data.' } });
    checks = () => ({ 2: ['not-shown', 'No picture.', { canShow: false, canShowWhy: 'Old bookings could not be shown: the data has none.' }] });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(testerRuns()).toHaveLength(1);
    expect(checkRuns()[0]!.prompt).toMatch(/^2\. Done when: .*\n {3}No picture\.\n {3}The Tester says this cannot be shown on a screen: There is no old booking in the data\.$/m);
    expect(t.offScreen).toEqual([{ criterion: NAME, why: 'Old bookings could not be shown: the data has none.' }]);
    expect(t.proof?.map((p) => p.criterion)).toEqual([ROOM]);
    expect(t.squad?.phase).toBe('accept');
    expect(lines(id)).toContain('"Done when" 2 is not on a screen: Old bookings could not be shown: the data has none.');
  });

  it("with no words of its own from the check, the Tester's reason stands", async () => {
    const id = story();
    say = () => ({ 1: MET, 2: { off: REASON } });
    await squad().proof(id);
    expect(ticket(id).offScreen).toEqual([{ criterion: NAME, why: REASON }]);
  });

  it('technical words stay out of the row', async () => {
    const id = story();
    say = () => ({ 1: MET, 2: { ...UPCOMING, off: REASON } });
    checks = () => ({ 2: ['not-shown', 'x', { canShow: false, canShowWhy: 'The sandbox blocks port 3000.' }] });
    await squad().proof(id);
    expect(row(id, NAME)).toMatchObject({ shows: 'off-screen', why: 'The screenshots show a part of it. The rest cannot be shown on a screen.' });
  });

  it('Full: it goes to your check with the row marked, and Looks right is yours as always', async () => {
    const id = story(true);
    say = () => ({ 1: MET, 2: { ...UPCOMING, off: REASON } });
    checks = () => ({ 2: ['not-shown', 'x', { canShow: false, canShowWhy: PART }] });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.waiting).toEqual({ kind: 'proof', summary: 'The proof is ready for you to check' });
    expect(t.proof?.map((p) => p.shows)).toEqual(['met', 'off-screen']);
  });
});

describe('the check says it can be shown', () => {
  it('a lazy reason with no picture goes back to the Tester, told so; the picture then passes, and the reason is gone', async () => {
    const id = story();
    say = (round): Record<number, Plan> => (round === 1 ? { 1: MET, 2: { off: 'I did not try, it takes too long.' } } : { 2: UPCOMING });
    checks = (run): Record<number, FakeCheck> => (run === 1 ? { 2: ['not-shown', 'The bookings page shows this', { canShow: true, advice: 'Open the bookings page.' }] } : {});
    await squad().proof(id);
    const t = ticket(id);
    expect(testerRuns()).toHaveLength(2);
    expect(testerRuns()[1]!.prompt).toContain(reasonRefusedLine(2, NAME, 'I did not try, it takes too long.', 'The bookings page shows this', 'Open the bookings page.'));
    expect(t.gates?.proof).toBe('pass');
    expect(row(id, NAME)?.shows).toBe('met');
    expect(t.offScreen).toBeUndefined();
  });

  it(`a lazy reason it keeps giving: ${MAX_RETAKES} retakes, then the plain stop, and it is not called Not on a screen`, async () => {
    const id = story();
    say = (round): Record<number, Plan> => (round === 1 ? { 1: MET, 2: { off: 'Too long.' } } : {});
    checks = () => ({ 2: ['not-shown', 'The bookings page shows this.', { canShow: true, advice: 'Open the bookings page.' }] });
    await squad().proof(id);
    const t = ticket(id);
    expect(testerRuns()).toHaveLength(1 + MAX_RETAKES);
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck).toMatchObject({ gate: 'proof', kind: 'not-shown', question: 'The squad could not show "done when" 2 on a screen. Try it yourself, or ask a question.', points: [`"Done when" 2, ${NAME}: The bookings page shows this.`] });
    expect(t.offScreen).toBeUndefined();
    expect(t.gates?.proof).toBe('fail');
  });

  it('a picture and a lazy reason: retake, then the plain stop, with the row not shown', async () => {
    const id = story();
    say = (round): Record<number, Plan> => (round === 1 ? { 1: MET, 2: { ...UPCOMING, off: 'I did not try the past ones.' } } : {});
    checks = () => ({ 2: ['not-shown', 'Past bookings are not in the picture.', { canShow: true, advice: 'Open a past booking.' }] });
    await squad().proof(id);
    const t = ticket(id);
    expect(testerRuns()).toHaveLength(1 + MAX_RETAKES);
    expect(testerRuns()[1]!.prompt).toContain('You said "done when" 2');
    expect(row(id, NAME)).toMatchObject({ shows: 'not-shown', why: 'Past bookings are not in the picture.' });
    expect(t.offScreen).toBeUndefined();
    expect(t.stuck?.kind).toBe('not-shown');
  });

  it('a check that leaves out canShow means it can be shown: never a pass on silence', async () => {
    const id = story();
    say = () => ({ 1: MET, 2: { off: REASON } });
    checks = () => ({ 2: ['not-shown', 'No picture.'] });
    await squad().proof(id);
    expect(ticket(id).stuck?.kind).toBe('not-shown');
    expect(ticket(id).offScreen).toBeUndefined();
  });

  it('a picture that does show it in the end is met, whatever the Tester said first', async () => {
    const id = story();
    say = () => ({ 1: MET, 2: { ...UPCOMING, off: 'I doubt it can be shown.' } });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(row(id, NAME)?.shows).toBe('met');
    expect(t.offScreen).toBeUndefined();
  });
});

describe('RO-18: pictures of most of it, and the rest needs time or data the app refuses', () => {
  // The real sentences from the release-gate run.
  const CRITERION = 'Sara sees Change next to Cancel; Omar does not, and the server refuses a change from him; In progress, ended and cancelled bookings have no Change button';
  const TESTER = "The In progress and ended rows only exist after the clock passes a booking's start and end time, and waiting for the clock is not allowed. The server refusing Omar cannot be pictured either, because the page never sends that request. The cancelled case was already pictured.";
  const CHECK = 'The pictures show Sara with Change next to Cancel on her Confirmed bookings, Omar with no Change on hers, and a cancelled booking with no buttons, but none shows an In progress booking; the code does cover the other two parts, since it refuses Omar on the server and drops ended bookings from the list.';

  it('after the last retake it is Not on a screen with its pictures and the plain reason, though the check said it could be shown, and the story goes on', async () => {
    const id = story(true);
    updateTicket(bp, id, (x) => {
      x.criteria = [
        { given: 'a room', when: 'anyone opens the day view', then: 'the room shows on the day view' },
        { given: 'bookings on the page', when: 'Sara and Omar look', then: CRITERION },
      ];
    });
    const text = `${CRITERION.charAt(0).toUpperCase()}${CRITERION.slice(1)}`;
    say = (round): Record<number, Plan> => (round === 1 ? { 1: MET, 2: { pic: ['met', 'Sara has Change next to Cancel.'], off: TESTER } } : { 2: { off: TESTER } });
    checks = () => ({ 2: ['not-shown', CHECK, { canShow: true, advice: 'Make a booking whose time has started.' }] });
    await squad().proof(id);
    const t = ticket(id);
    // It tried first: the check gets its say on every retake.
    expect(testerRuns()).toHaveLength(1 + MAX_RETAKES);
    expect(row(id, text)).toMatchObject({ shows: 'off-screen', why: TESTER });
    expect(row(id, text)!.after).toBeTruthy();
    // The story did not stop; the reason stays for the person's check.
    expect(t.stuck).toBeUndefined();
    expect(t.gates?.proof).toBe('pass');
    expect(t.waiting?.kind).toBe('proof');
    expect(notOnScreen(t).map((o) => o.why)).toContain(TESTER);
    expect(lines(id)).toContain(`"Done when" 2 is not on a screen: ${TESTER}`);
  });

  it('with no picture at all it still needs both voices', async () => {
    const id = story();
    say = (round): Record<number, Plan> => (round === 1 ? { 1: MET, 2: { off: TESTER } } : { 2: { off: TESTER } });
    checks = () => ({ 2: ['not-shown', CHECK, { canShow: true, advice: 'Make a booking whose time has started.' }] });
    await squad().proof(id);
    expect(ticket(id).stuck?.kind).toBe('not-shown');
    expect(ticket(id).gates?.proof).toBe('fail');
  });

  it('the rule by itself: only not shown, only with a real reason, and never for a picture the same as before', () => {
    const notShown = { shows: 'not-shown' as const, why: CHECK, advice: 'Make one.' };
    expect(afterLastRetake(notShown, TESTER)).toEqual({ shows: 'off-screen', why: TESTER, advice: '' });
    expect(afterLastRetake(notShown, undefined)).toEqual(notShown);
    expect(afterLastRetake(notShown, '  ')).toEqual(notShown);
    expect(afterLastRetake(notShown, 'I did not try the past ones.')).toEqual(notShown);
    expect(afterLastRetake(notShown, 'It takes too long.')).toEqual(notShown);
    expect(afterLastRetake({ ...notShown, why: SAME_PICTURE }, TESTER).shows).toBe('not-shown');
    const met = { shows: 'met' as const, why: '', advice: '' };
    expect(afterLastRetake(met, TESTER)).toEqual(met);
    const broken = { shows: 'broken' as const, why: 'The button is missing.', advice: '' };
    expect(afterLastRetake(broken, TESTER)).toEqual(broken);
  });
});

describe('only the check says it cannot be shown', () => {
  it('the Tester gets a retake first, told so, and may agree', async () => {
    const id = story();
    say = (round): Record<number, Plan> => (round === 1 ? { 1: MET, 2: UPCOMING } : { 2: { off: REASON } });
    checks = () => ({ 2: ['not-shown', 'Past bookings are not in the picture.', { canShow: false, canShowWhy: PART }] });
    await squad().proof(id);
    expect(testerRuns()).toHaveLength(2);
    expect(testerRuns()[1]!.prompt).toContain(cannotShowLine(2, NAME, PART));
    expect(ticket(id).gates?.proof).toBe('pass');
    expect(row(id, NAME)?.shows).toBe('off-screen');
  });

  it('a Tester that could not show it in its last retake counts as the second voice', async () => {
    const id = story();
    say = () => ({ 1: MET, 2: UPCOMING });
    checks = () => ({ 2: ['not-shown', 'Past bookings are not in the picture.', { canShow: false, canShowWhy: PART }] });
    await squad().proof(id);
    expect(testerRuns()).toHaveLength(1 + MAX_RETAKES);
    expect(ticket(id).gates?.proof).toBe('pass');
    expect(row(id, NAME)).toMatchObject({ shows: 'off-screen', why: PART });
  });
});

describe('the gate still needs something on a screen', () => {
  it('every "done when" off-screen with no picture: the stop from before, and no check runs', async () => {
    const id = story();
    say = () => ({ 1: { off: REASON }, 2: { off: REASON } });
    await squad().proof(id);
    const t = ticket(id);
    expect(checkRuns()).toHaveLength(0);
    expect(t.gates?.proof).toBe('fail');
    expect(t.stuck?.question).toContain('The Tester took no screenshots, so the proof is not ready yet.');
  });

  it('every "done when" ending Not on a screen, even with pictures: a plain stop, never accepted by itself', async () => {
    const id = story();
    say = () => ({ 1: { pic: ['met', 'A part.'], off: REASON }, 2: { off: REASON } });
    checks = () => ({ 1: ['not-shown', 'x', { canShow: false, canShowWhy: PART }], 2: ['not-shown', 'x', { canShow: false }] });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('fail');
    expect(t.squad ?? null).toBeNull();
    expect(t.stuck).toMatchObject({ gate: 'proof', kind: 'not-shown', question: 'The squad could not show "done when" 1 and 2 on a screen. Try it yourself, or ask a question.' });
    expect(t.stuck!.points).toEqual([`"Done when" 1, ${ROOM}: ${PART}`, `"Done when" 2, ${NAME}: ${REASON}`]);
    expect(lines(id)).toContain('Every "done when" ended as not on a screen, so the screenshots do not show the work');
    expect(withProblem(t).stuck!.title).toBe('A "done when" is not shown yet');
    expect(t.mergedAt).toBeUndefined();
  });

  it('with broken as well, the Builder comes first', async () => {
    const id = story();
    say = () => ({ 1: { pic: ['broken', 'The room is missing from the day view.'] }, 2: { ...UPCOMING, off: REASON } });
    checks = () => ({ 1: ['broken', 'The room is missing from the day view.'], 2: ['not-shown', 'x', { canShow: false, canShowWhy: PART }] });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.proofRound).toBe(1);
    expect(t.squad?.phase).toBe('test');
    expect(row(id, NAME)?.shows).toBe('off-screen');
  });
});

describe('the rules, one by one', () => {
  const base = { why: 'Past bookings are not in the picture.', advice: '', noChange: false };

  it('reads canShow from the check: true unless it says false, and one answer that says it can is enough', () => {
    expect(checkVerdicts({ checks: [{ criterion: 2, shows: 'not-shown', why: 'x' }] }, [2]).get(2)!.canShow).toBeUndefined();
    expect(checkVerdicts({ checks: [{ criterion: 2, shows: 'not-shown', why: 'x', canShow: true }] }, [2]).get(2)!.canShow).toBeUndefined();
    expect(checkVerdicts({ checks: [{ criterion: 2, shows: 'not-shown', why: 'x', canShow: false, canShowWhy: ' Part  one. ' }] }, [2]).get(2)).toMatchObject({ canShow: false, canShowWhy: 'Part one.' });
    expect(checkVerdicts({ checks: [{ criterion: 2, shows: 'not-shown', why: 'x', canShow: false }, { criterion: 2, shows: 'not-shown', why: 'y', canShow: true }] }, [2]).get(2)!.canShow).toBeUndefined();
  });

  it('together: cannot be shown only for what the pictures do not show', () => {
    const off = { shows: 'not-shown' as const, ...base, canShow: false as const, canShowWhy: PART };
    expect(together({ shows: 'met' }, off)).toEqual({ shows: 'off-screen', why: PART, advice: '' });
    // No words of its own: what it saw.
    expect(together({ shows: 'met' }, { ...off, canShowWhy: '' }).why).toBe(base.why);
    expect(together({ shows: 'met' }, { ...off, shows: 'met' }).shows).toBe('met');
    expect(together({ shows: 'met' }, { ...off, shows: 'broken', why: 'The name is wrong in the list.' }).shows).toBe('broken');
    expect(together({ shows: 'met' }, { shows: 'not-shown', ...base }).shows).toBe('not-shown');
  });

  it('fromReason: Not on a screen only when the check says so, whatever else it said', () => {
    expect(fromReason(REASON, undefined)).toMatchObject({ shows: 'not-shown' });
    expect(fromReason(REASON, { shows: 'met', ...base })).toMatchObject({ shows: 'not-shown' });
    expect(fromReason(REASON, { shows: 'not-shown', ...base, canShow: false })).toEqual({ shows: 'off-screen', why: REASON, advice: '' });
    expect(fromReason(REASON, { shows: 'not-shown', ...base, canShow: false, canShowWhy: PART }).why).toBe(PART);
  });

  it('Builds by itself accepts past a row that is Not on a screen, never past one not shown', () => {
    const shot = { criterion: NAME, before: 'a.png', after: 'b.png', beforeLabel: 'New screen', afterLabel: 'After' };
    const id = story();
    updateTicket(bp, id, (x) => {
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.proof = [{ ...shot, shows: 'off-screen', why: PART }];
    });
    expect(auto.acceptByItself(bp, id).mergedAt).toBeTruthy();
    const open = story();
    updateTicket(bp, open, (x) => {
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.proof = [{ ...shot, shows: 'not-shown', why: 'x' }];
    });
    expect(auto.acceptByItself(bp, open).mergedAt).toBeUndefined();
  });
});

describe('what each agent is told', () => {
  const t = (more: Partial<Ticket> = {}) => ({ ...ticket(story()), ...more }) as Ticket;

  it('the check judges the reason, and says canShow and which part', () => {
    const prompt = P.proofCheckPrompt(t(), [{ criterion: 1, offScreen: 'Too long.' }]);
    expect(prompt).toContain('1. Done when:');
    expect(prompt).toContain('No picture.');
    expect(prompt).toContain('The Tester says this cannot be shown on a screen: Too long.');
    expect(prompt).toContain('canShow: for not-shown only.');
    expect(prompt).toContain('"I did not try", "it takes too long" or "too many\n  steps" is always true');
    expect(prompt).toContain('Shown for upcoming bookings. Past bookings could not be shown:\n  the app has none yet.');
    const props = P.PROOF_CHECK_SCHEMA.properties.checks.items.properties as Record<string, unknown>;
    expect(props.canShow).toEqual({ type: 'boolean' });
    expect(props.canShowWhy).toBeTruthy();
    expect(P.PROOF_CHECK_SCHEMA.properties.checks.items.required).not.toContain('canShow');
  });

  it('the Tester may hand in a part and say why not the rest, and hears a lazy reason is no reason', () => {
    const prompt = P.proofPrompt(readMeta(bp), t(), 'after');
    expect(prompt).toContain('hand in the pictures of the parts that can be shown, and also put it in offScreen');
    expect(prompt).toContain('"I did not try" or "it takes');
    expect(P.proofAgainPrompt(['x'])).toContain('put that "done when" in offScreen with which part and why');
  });

  it('the Tester hears never to wait for the clock', () => {
    expect(P.proofPrompt(readMeta(bp), t(), 'after')).toContain('Never wait for the clock');
  });

  it('the Reviewer checks in the code and tests what no picture proves, and hears which ones the last screenshots could not show', () => {
    const none = P.reviewPrompt(readMeta(bp), [], t(), 1);
    expect(none).toContain('A "done when" can end as "Not on a screen"');
    expect(none).toContain('find the code that does it and a test that covers it');
    expect(none).not.toContain('The last screenshots could not show these');
    const named = P.reviewPrompt(readMeta(bp), [], t({ offScreen: [{ criterion: 'It survives a restart', why: 'A screenshot cannot show a restart.' }], proof: [{ criterion: NAME, before: 'a.png', after: 'b.png', beforeLabel: 'Before', afterLabel: 'After', shows: 'off-screen', why: PART }] }), 2);
    expect(named).toContain(`The last screenshots could not show these:\n- ${NAME}: ${PART}\n- It survives a restart: A screenshot cannot show a restart.`);
  });
});

describe('on the board', () => {
  const part: ProofShot = { criterion: NAME, before: 'a.png', after: 'b.png', beforeLabel: 'New screen', afterLabel: 'After', note: 'Upcoming bookings show Dune.', shows: 'off-screen', why: PART };
  const none = { criterion: 'It survives a restart', why: 'A screenshot cannot show a restart.' };
  const read = (f: string) => fs.readFileSync(new URL(`../console-ui/src/${f}`, import.meta.url), 'utf8');

  it('the row says Not on a screen, and which part could not be shown', () => {
    expect(verdictWord('off-screen')).toBe('Not on a screen');
    expect(verdictClass('off-screen')).toBe('notonscreen');
    expect(verdictNote(part)).toBe(PART);
    for (const c of ['.verdict.notonscreen', '.critrow.notonscreen', '.verdictline.notonscreen', 'svg.vo']) expect(read('styles/verdict.css')).toContain(c);
  });

  it('your check lists them all, each once, with why', () => {
    expect(notOnScreen({ proof: [part, { ...part, criterion: 'Met', shows: 'met' }], offScreen: [none, { criterion: NAME, why: 'again' }] })).toEqual([{ criterion: NAME, why: PART }, none]);
    expect(notOnScreen({})).toEqual([]);
    expect(read('components/YourCheck.tsx')).toContain('<LookYourself t={t} />');
  });

  it('the gate is passed with it, and says so when you went past it', () => {
    const gates = (proof: 'fail' | 'skipped' | 'pass') => ({ gates: { checks: 'pass', review: 'pass', proof } as const });
    expect(proofWords({ ...gates('pass'), proof: [part] })).toBe('Proof made');
    expect(proofWords({ ...gates('fail'), proof: [part] })).toBe('Nothing shows on a screen yet');
    expect(proofWords({ ...gates('skipped'), proof: [part] })).toBe('Not on a screen, you continued');
  });

  it("keeps the row in the ticket's files", () => {
    const docs = ticketDocs({ id: 'RO-12', title: 'Rename a room', proof: [part], offScreen: [none] });
    expect(docs['proof.md']).toContain(`- Shows: not on a screen\n- Why: ${PART}`);
    const back = readTicketDocs(docs);
    expect(back.proof).toEqual([part]);
    expect(back.offScreen).toEqual([none]);
  });

  it('draws the partial row: its tag, its icon, and the list at your check', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'tok' });
    vi.stubGlobal('window', { location: { pathname: '/' } });
    // React lives with the board's own packages, and the root type check does not read its JSX.
    const board = (file: string) => import(/* @vite-ignore */ new URL(`../console-ui/${file}`, import.meta.url).pathname);
    const { renderToStaticMarkup } = await board('node_modules/react-dom/server.node.js');
    const { createElement } = await board('node_modules/react/index.js');
    const { LookYourself, OffScreenList, VerdictIcon, VerdictTag } = await board('src/components/Verdict.tsx');
    expect(renderToStaticMarkup(createElement(VerdictTag, { shows: 'off-screen' }))).toBe('<span class="verdict notonscreen">Not on a screen</span>');
    expect(renderToStaticMarkup(createElement(VerdictIcon, { shows: 'off-screen' }))).toContain('vo');
    const html = renderToStaticMarkup(createElement(LookYourself, { t: { proof: [part], offScreen: [none] } }));
    expect(html).toContain('Not on a screen, so look at these yourself');
    expect(html).toContain(NAME);
    expect(html).toContain('Past bookings could not be shown: the app has none yet.');
    expect(html).toContain('It survives a restart');
    expect(renderToStaticMarkup(createElement(LookYourself, { t: { proof: [{ ...part, shows: 'met' }] } }))).toBe('');
    // The list of those with no picture leaves the row with pictures to the row itself, and your check has them once.
    expect(renderToStaticMarkup(createElement(OffScreenList, { t: { offScreen: [none] } }))).toContain('It survives a restart');
    expect(renderToStaticMarkup(createElement(OffScreenList, { t: { offScreen: [none], waiting: { kind: 'proof', summary: 'x' } } }))).toBe('');
    // The panel and the page both draw the row by its verdict.
    expect(read('pages/TicketDrawer.tsx')).toContain('<VerdictTag shows={p.shows} />');
    expect(read('pages/Proof.tsx')).toContain('<VerdictTag shows={shot.shows} />');
    vi.unstubAllGlobals();
  });
});

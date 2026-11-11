import { afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SAVING, limitWords, liveNow, queuedLine, shortDoing, slowActivity, slowWhy } from '../src/board/now.js';
import { endStep, nextPart, ownCheckEnded, pauseClock, ranFor, runsFor, slowStep, startStep, stepDoing, trackStage, waitsNow } from '../src/board/clock.js';
import { boardPaths } from '../src/board/store.js';
import { usualKey } from '../src/board/usual.js';
import type { Step, Ticket } from '../src/board/types.js';

/**
 * Live status everywhere (phase 4): the card's line says who works, which step, what it does, how long and the usual
 * time; the Now tab says it in a sentence with what comes next; the tracker says how long each stage took.
 */

const AT = Date.parse('2026-11-03T10:45:00Z');
const ago = (s: number) => new Date(AT - s * 1000).toISOString();

function ticket(over: Partial<Ticket> = {}): Ticket {
  return { id: 'RO-7', title: 'Show room capacity', ask: '', kind: 'feature', source: { type: 'manual' }, priority: 'normal', stage: 'implement', status: '', waiting: null, createdAt: ago(540), createdBy: 'Sara', activity: [], ...over };
}

const six = (doing: number): Step[] =>
  ['Read the booking page', 'Get each room size', 'Show how many fit', 'Warn when full', 'Same in the API', 'Tests for every "done when"'].map((title, i) => ({
    title,
    status: i < doing ? 'done' : i === doing ? 'doing' : 'todo',
  }));

function building(over: Partial<Ticket> = {}): Ticket {
  return ticket({
    live: true,
    squad: { phase: 'build', nextAt: ago(-3600) },
    status: 'Editing src/pages/booking.tsx',
    steps: six(2),
    work: { steps: 6, tests: 4, screens: 2 },
    specApproved: { by: 'Sara', at: ago(400) },
    clock: { who: 'builder', step: 'build', part: 3, since: ago(130), doing: 'Editing src/pages/booking.tsx', doingAt: ago(4), limit: 60 },
    stageTimes: { stage: 'implement', since: ago(150), spent: { tickets: 30, specs: 240 } },
    ...over,
  });
}

describe('the card line', () => {
  it("says who, which step, what it does, how long and the step's usual time, with a step bar", () => {
    const n = liveNow(building(), {}, AT);
    expect(n.state).toBe('working');
    expect(n.line).toBe('Builder · step 3 of 6 · editing booking.tsx');
    expect(n.time).toBe('2 min · usually 2 to 4 min');
    expect(n.bar).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo']);
  });

  it('uses the usual time learned from the project once it has history', () => {
    const book = { [usualKey('builder', 'build', 'full')]: [60, 60, 90, 120] };
    expect(liveNow(building(), book, AT).time).toBe('2 min · usually 1 to 2 min');
  });

  it('follows the ticket through its steps: Analyst, Architect, checks, Reviewer, Tester', () => {
    const analyst = liveNow(ticket({ stage: 'specs', live: true, squad: { phase: 'plan-write', nextAt: ago(-60) }, status: 'Analyst is writing the spec', clock: { who: 'analyst', step: 'spec', since: ago(40) } }), {}, AT);
    expect(analyst.line).toBe('Analyst · writing the spec');
    expect(analyst.time).toBe('40 s · usually 1 to 3 min');
    expect(analyst.bar).toEqual(['done', 'now', 'todo']);
    expect(analyst.next).toContain('You read the spec and approve it.');

    const architect = liveNow(ticket({ stage: 'specs', live: true, squad: { phase: 'plan-write', nextAt: ago(-60) }, status: 'Reading src/rooms.py', specApproved: { by: 'Sara', at: ago(100) }, clock: { who: 'architect', step: 'design', since: ago(70), doing: 'Reading src/rooms.py' } }), {}, AT);
    expect(architect.line).toBe('Architect · reading rooms.py');

    const checks = liveNow(ticket({ stage: 'test', live: true, squad: { phase: 'test', nextAt: ago(-60) }, status: 'Running test: npm test', clock: { who: 'squad', step: 'checks', since: ago(65), doing: 'Running test: npm test' } }), {}, AT);
    expect(checks.line).toBe('squad-kit · running test: npm test');
    expect(checks.time).toBe('1 min · usually 1 to 3 min');

    const reviewer = liveNow(ticket({ stage: 'review', live: true, squad: { phase: 'review', nextAt: ago(-60) }, status: 'Reviewer is reading the changes', clock: { who: 'reviewer', step: 'review', since: ago(10) } }), {}, AT);
    expect(reviewer.line).toBe('Reviewer · reading the changes');
    expect(reviewer.sentence).toBe('The Reviewer is reading the changes.');

    const tester = liveNow(ticket({ stage: 'review', live: true, work: { steps: 2, tests: 1, screens: 2 }, squad: { phase: 'proof', nextAt: ago(-60) }, status: 'Tester is taking after screenshots', clock: { who: 'tester', step: 'proof', since: ago(30) } }), {}, AT);
    expect(tester.line).toBe('Tester · taking after screenshots');
    expect(tester.bar).toEqual(['done', 'done', 'now']);
  });

  it('never says the role twice when the latest line is a sentence about it', () => {
    const t = ticket({ stage: 'review', live: true, squad: { phase: 'ambient', nextAt: ago(-5) }, status: 'Reviewer is checking the session handling', clock: { who: 'reviewer', step: 'review', since: ago(90), doing: 'Reviewer is checking the session handling' } });
    expect(liveNow(t, {}, AT).line).toBe('Reviewer · checking the session handling');
  });

  it('works out who works from the stage when no clock is on the ticket yet', () => {
    const n = liveNow(ticket({ stage: 'tickets', live: true, squad: { phase: 'ambient', nextAt: ago(-5) }, status: 'Analyst is reading the ticket' }), {}, AT);
    expect(n.line).toBe('Analyst · reading the ticket');
    expect(n.time).toBe('usually 1 to 3 min');
  });

  it('says a queued ticket is next in line, with how many places are busy', () => {
    expect(queuedLine(2, 2)).toBe('Next in line: starts when a slot is free (2 of 2 busy)');
    const n = liveNow(ticket({ live: true, squad: { phase: 'build', nextAt: ago(5) }, status: queuedLine(2, 2) }), {}, AT);
    expect(n.state).toBe('queued');
    expect(n.line).toBe('Next in line: starts when a slot is free (2 of 2 busy)');
    expect(n.sentence).toBe('It is next in line. It starts when a slot is free (2 of 2 busy).');
  });

  it('shortens tool lines for a card', () => {
    expect(shortDoing('Editing web/src/app/upload/upload.component.ts')).toBe('editing upload.component.ts');
    expect(shortDoing('Running npm test -- --run')).toBe('running npm test -- --run');
    expect(shortDoing(`Searching for "${'x'.repeat(80)}"`).length).toBeLessThanOrEqual(56);
  });
});

describe('the Now tab', () => {
  it('says what happens in one sentence, the step and its time, and what comes next with when it needs you', () => {
    const n = liveNow(building(), {}, AT);
    expect(n.sentence).toBe('The Builder is on step 3 of 6: show how many fit.');
    expect(n.detail).toBe('Step 3 of 6 · 2 min so far · this step usually takes 2 to 4 min');
    expect(n.next).toBe(
      'The Builder goes on with step 4 of 6. Then the checks run on their own, a fresh Reviewer reads the work, then the Tester takes a screenshot for each "done when". You will be asked to check the proof in about 17 minutes. Nothing is needed from you now.',
    );
    // The rest of this step (50 s), 3 more steps (9 min), checks (2), review (3) and proof (2), at their usual times.
    expect(n.readyIn).toEqual({ seconds: 1010, what: 'check the proof' });
    expect(n.lastAt).toBe(ago(4));
  });

  it('says how long each finished stage took, the one now, and the usual time of the ones to come', () => {
    const notes = Object.fromEntries(liveNow(building(), {}, AT).stages.map((s) => [s.stage, s.note]));
    expect(notes).toEqual({ tickets: '30 s', specs: '4 min, you approved', implement: 'now · 2 min', test: 'about 2 min', review: 'you check proof', release: 'on Looks right' });
  });

  it('says when a note is read: at the next step while an agent runs, or after your part when none does', () => {
    expect(liveNow(building(), {}, AT).noteWhen).toBe('The Builder reads it when its next step starts, in about a minute.');
    const waiting = liveNow(ticket({ stage: 'specs', waiting: { kind: 'spec', summary: 'The spec is ready: is this what you want?' } }), {}, AT);
    expect(waiting.state).toBe('you');
    expect(waiting.noteWhen).toBe('No agent is running now, so nobody reads it yet. The squad reads it when it carries on, after you approve the spec.');
  });
});

describe('on its way in, after Looks right', () => {
  const proof = () => ticket({ stage: 'review', status: 'Proof ready to check', waiting: { kind: 'proof', summary: 'The proof is ready for you to check' } });

  it('says it is being saved and merged while the save runs, never Your turn', () => {
    const n = liveNow(proof(), {}, AT, true);
    expect(n.merging).toBe(true);
    expect(n.line).toBe(SAVING);
    expect(n.sentence).toBe('You said Looks right. squad-kit is saving the change and merging it now. Nothing is needed from you.');
    expect(n.stages.find((s) => s.stage === 'review')?.note).toBe('saving now');
    // Before Looks right, or once the save is over: the proof waits for the person, as before.
    expect(liveNow(proof(), {}, AT).merging).toBeUndefined();
    expect(liveNow(proof(), {}, AT).state).toBe('you');
  });

  it('says it is merging while its pull request opens and merges, and accepted once it is in', () => {
    const merging = liveNow(ticket({ stage: 'release', release: 'v0.3.0', live: true, squad: { phase: 'publish', nextAt: ago(1) }, status: 'Merging pull request 15' }), {}, AT);
    expect(merging.merging).toBe(true);
    expect(merging.line).toBe('Merging pull request 15');
    expect(merging.sentence).toBe('It is accepted, and squad-kit is merging it now. Nothing is needed from you.');
    const merged = liveNow(ticket({ stage: 'release', release: 'v0.3.0', mergedAt: ago(5), status: 'Merged into main · goes out in v0.3.0' }), {}, AT);
    expect(merged.merging).toBeUndefined();
    expect(merged.sentence).toBe('It is accepted and goes out with v0.3.0. Nothing is needed from you until then.');
  });
});

describe('slow and stuck steps', () => {
  it('is slow past twice the usual time, never before 5 minutes', () => {
    expect(slowStep(building({ clock: { who: 'builder', step: 'build', part: 3, since: ago(7 * 60) } }), {}, AT)).toBeNull();
    const slow = slowStep(building({ clock: { who: 'builder', step: 'build', part: 3, since: ago(14 * 60) } }), {}, AT);
    expect(slow).toMatchObject({ kind: 'long', detail: 'The Builder has been on this step for 14 minutes. It usually takes 2 to 4 minutes.' });
    // Until the Builder says which step it is on, the whole build is judged: its steps would all pile up on the first.
    const unsaid = (secs: number) => building({ steps: six(-1), clock: { who: 'builder', step: 'build', part: 1, since: ago(secs), began: ago(secs) } });
    expect(slowStep(unsaid(14 * 60), {}, AT)).toBeNull();
    expect(slowStep(unsaid(50 * 60), {}, AT)).toMatchObject({ kind: 'long', detail: 'The Builder has been building for 50 minutes. 6 steps usually take 12 to 24 minutes.' });
    // A step that usually takes seconds is still not slow after one minute.
    const quick = { [usualKey('squad', 'checks', 'full')]: [5, 6, 7] };
    const checks = ticket({ stage: 'test', live: true, squad: { phase: 'test', nextAt: ago(-60) }, clock: { who: 'squad', step: 'checks', since: ago(60) } });
    expect(slowStep(checks, quick, AT)).toBeNull();
    expect(slowStep({ ...checks, clock: { who: 'squad', step: 'checks', since: ago(301) } }, quick, AT)?.detail).toBe('The checks have been running for 5 minutes. They usually take under a minute.');
    expect(slowStep({ ...checks, waiting: { kind: 'stuck', summary: 'x' } }, quick, AT)).toBeNull();
  });

  it('shows the Taking longer card with what it does, its last progress and what happens at the limit', () => {
    const t = building({ clock: { who: 'builder', step: 'build', part: 4, since: ago(14 * 60), doing: 'Running npm test', doingAt: ago(40), limit: 60 }, steps: six(3) });
    t.quiet = slowStep(t, {}, AT)!;
    const s = liveNow(t, {}, AT).slow!;
    expect(s.title).toBe('Taking longer than usual');
    expect(s.where).toBe('RO-7 · step 4 of 6');
    // Nothing failed on the way, and the computer is not busy: the plain reason.
    expect(s.text).toBe('Nothing failed on the way, so it is most likely a bigger step than usual.');
    expect(s.facts).toEqual([
      { label: 'How long', value: 'The Builder has been on this step for 14 minutes. It usually takes 2 to 4 minutes.' },
      { label: 'Doing now', value: 'Running npm test' },
      { label: 'Last progress', value: '40 seconds ago, so it is still working' },
      { label: 'Time limit', value: "squad-kit gives the Builder up to 60 min for all its steps together (14 min used so far). If it isn't done by then, squad-kit stops it and asks you what to do." },
      { label: 'Your part', value: "You don't need to do anything. If it gets stuck, it will show in Waiting for you." },
    ]);
    expect(s).toMatchObject({ calm: true, line: 'Longer than usual · 14 min · still working' });
    expect(s.note).toBeUndefined();
  });

  it('shows the Looks stuck card with what squad-kit checked, and whether the stuck command can be ended', () => {
    const t = building({
      quiet: { since: ago(200), kind: 'stuck', detail: 'A command has run for 6 minutes and has done nothing for 3 minutes. It may be waiting on the network or on a question.', command: 'npm test', pid: 4242 },
    });
    const s = liveNow(t, {}, AT).slow!;
    expect(s.title).toBe('Looks stuck');
    expect(s.text).toBe('No progress for 3 minutes. The Builder was editing src/pages/booking.tsx.');
    expect(s.facts[0]).toEqual({ label: 'What we checked', value: t.quiet!.detail });
    expect(s.facts[1]).toEqual({ label: 'Your work', value: 'Safe. Everything done so far is kept.' });
    expect(s.canEnd).toBe(true);
    // The command and its process are for engineers: in the details, not the facts.
    expect(JSON.stringify(s.facts)).not.toMatch(/npm test|4242/);
    expect(s.detail).toBe('Waiting on: npm test (process 4242)');
  });
});

describe('why a step takes longer than usual', () => {
  /** The Builder 14 minutes on plan step 4, past twice its usual time, with its last action 40 seconds ago. */
  const slowBuilder = (clock: Partial<NonNullable<Ticket['clock']>> = {}, over: Partial<Ticket> = {}) => {
    const t = building({ steps: six(3), clock: { who: 'builder', step: 'build', part: 4, since: ago(14 * 60), began: ago(30 * 60), doing: 'Writing the code', doingAt: ago(40), limit: 60, ...clock }, ...over });
    t.quiet = slowStep(t, {}, AT)!;
    return t;
  };
  const failed = { check: 'test' as const, times: 1, at: ago(300) };

  it('picks the reason from what really happened on the step, most specific first', () => {
    // Everything at once: its own failed run of the tests wins.
    const all = slowBuilder({ failed }, { tries: 1, reviewRound: 2 });
    all.quiet!.busy = true;
    expect(slowWhy(all)).toEqual({ kind: 'own-fail', short: 'fixing a failed test', sentence: 'The tests failed once, so the Builder is fixing them.' });
    expect(slowWhy(slowBuilder({ failed: { ...failed, times: 2 } }))?.sentence).toBe('The tests failed 2 times, so the Builder is fixing them.');
    expect(slowWhy(slowBuilder({ failed: { check: 'lint', times: 1, at: ago(300) } }))).toMatchObject({ short: 'fixing the code check', sentence: 'The code check failed once, so the Builder is fixing it.' });
    expect(slowWhy(slowBuilder({ failed: { check: 'build', times: 1, at: ago(300) } }))).toMatchObject({ short: 'fixing the build', sentence: 'The build failed once, so the Builder is fixing it.' });
    expect(slowWhy(slowBuilder({ failed: { ...failed, fixed: ago(60) } }))).toEqual({ kind: 'own-fixed', short: 'fixed a failed test', sentence: 'The tests failed once on the way. The Builder fixed them, and they pass now.' });
    // Then the checks squad-kit ran failed, and the Builder fixes them.
    const fix = slowBuilder({ step: 'fix', part: undefined }, { tries: 1, reviewRound: 2 });
    fix.quiet!.busy = true;
    expect(slowWhy(fix)).toEqual({ kind: 'checks', short: 'fixing the checks (try 2 of 3)', sentence: 'The checks failed once, so the Builder is fixing them (try 2 of 3).' });
    // The Reviewer's second round.
    const review = ticket({ stage: 'review', live: true, squad: { phase: 'review', nextAt: ago(-60) }, reviewRound: 2, clock: { who: 'reviewer', step: 'review', since: ago(20 * 60), limit: 15 } });
    expect(slowWhy(review)).toMatchObject({ kind: 'review', short: 'review round 2 of 2', sentence: 'The Reviewer asked for changes, so this is its second look (round 2 of 2).' });
    // The copy being set up: squad-kit's setup again, or the Builder installing packages.
    const setup = slowBuilder({ running: 'setup', doing: "Setting up this story's copy" });
    setup.quiet!.busy = true;
    expect(slowWhy(setup)).toMatchObject({ kind: 'setup', sentence: "This story's copy is being set up (packages and the like), which can take a few minutes." });
    // The computer is busy, as the engine measured it.
    const busy = slowBuilder();
    busy.quiet!.busy = true;
    expect(slowWhy(busy)).toEqual({ kind: 'busy', short: 'your computer is busy', sentence: 'Your computer is busy, so steps run slower.' });
    // Else the plain reason.
    expect(slowWhy(slowBuilder())).toMatchObject({ kind: 'bigger', short: 'a bigger step than usual', sentence: 'Nothing failed on the way, so it is most likely a bigger step than usual.' });
  });

  it('reads calm while it still works, with the reason under the line when the line does not say it', () => {
    const busy = slowBuilder();
    busy.quiet!.busy = true;
    const n = liveNow(busy, {}, AT);
    expect(n.line).toBe('Builder · step 4 of 6 · writing the code');
    expect(n.slow).toMatchObject({ kind: 'long', calm: true, line: 'Longer than usual · 14 min · still working', note: 'Your computer is busy', text: 'Your computer is busy, so steps run slower.' });
    // Fixing a failed test: the first line says it already.
    const fixing = liveNow(slowBuilder({ failed, doing: 'Fixing a failed test' }), {}, AT);
    expect(fixing.line).toBe('Builder · step 4 of 6 · fixing a failed test');
    expect(fixing.slow).toMatchObject({ calm: true, line: 'Longer than usual · 14 min · still working' });
    expect(fixing.slow?.note).toBeUndefined();
    // Running the tests again while fixing: the reason shows under it.
    expect(liveNow(slowBuilder({ failed, doing: 'Running the tests' }), {}, AT).slow?.note).toBe('Fixing a failed test');
  });

  it('turns amber only with no progress for a few minutes, unless squad-kit itself runs something for it', () => {
    const quiet = liveNow(slowBuilder({ doingAt: ago(4 * 60) }), {}, AT).slow!;
    expect(quiet).toMatchObject({ calm: false, line: 'Longer than usual · 14 min · no update for 4 min' });
    expect(quiet.facts.find((f) => f.label === 'Last progress')?.value).toBe('4 minutes ago');
    // A long run of the tests for the Builder is the step working.
    const tests = liveNow(slowBuilder({ doing: 'Running the tests', doingAt: ago(4 * 60), running: 'test' }), {}, AT).slow!;
    expect(tests).toMatchObject({ calm: true, line: 'Longer than usual · 14 min · still working' });
    expect(tests.facts.find((f) => f.label === 'Last progress')?.value).toBe('4 minutes ago, and squad-kit is still running the tests for it');
    // Looks stuck stays what it was.
    const stuck = building({ quiet: { since: ago(200), kind: 'stuck', detail: 'A command has run for 6 minutes and has done nothing for 3 minutes.' } });
    expect(liveNow(stuck, {}, AT).slow).toMatchObject({ kind: 'stuck', title: 'Looks stuck' });
    expect(liveNow(stuck, {}, AT).slow?.calm).toBeUndefined();
  });

  it("says the step's real limit and what really happens there", () => {
    const at = (c: Parameters<typeof limitWords>[0], part?: { n: number; of: number }) => limitWords(c, part, AT);
    expect(at({ who: 'reviewer', step: 'review', limit: 15, since: ago(60) })).toBe("squad-kit gives this step up to 15 min. If it isn't done by then, squad-kit stops it and asks you what to do.");
    expect(at({ who: 'tester', step: 'proof', limit: 30, since: ago(60) })).toBe("squad-kit gives this step up to 30 min. If it isn't done by then, squad-kit stops it and asks you what to do.");
    // The Builder's limit is for its whole run, all its plan steps together.
    expect(at({ who: 'builder', step: 'build', limit: 60, since: ago(19 * 60), began: ago(41 * 60) }, { n: 7, of: 7 })).toBe("squad-kit gives the Builder up to 60 min for all its steps together (41 min used so far). If it isn't done by then, squad-kit stops it and asks you what to do.");
    expect(at({ who: 'builder', step: 'fix', limit: 60, since: ago(30) })).toBe("squad-kit gives this step up to 60 min. If it isn't done by then, squad-kit stops it and asks you what to do.");
    // squad-kit's checks have it per check: one that runs longer does not pass.
    expect(at({ who: 'squad', step: 'checks', limit: 15, since: ago(60) })).toBe('squad-kit gives each check up to 15 min. One that runs longer is stopped and counts as not passed.');
    expect(at({ who: 'analyst', step: 'questions', since: ago(60) })).toBeUndefined();
    // On the drawer card, with nothing for the person to do.
    const s = liveNow(slowBuilder({ failed, doing: 'Fixing a failed test' }), {}, AT).slow!;
    expect(s.facts).toEqual([
      { label: 'How long', value: 'The Builder has been on this step for 14 minutes. It usually takes 2 to 4 minutes.' },
      { label: 'Doing now', value: 'Fixing a failed test' },
      { label: 'Last progress', value: '40 seconds ago, so it is still working' },
      { label: 'Time limit', value: "squad-kit gives the Builder up to 60 min for all its steps together (30 min used so far). If it isn't done by then, squad-kit stops it and asks you what to do." },
      { label: 'Your part', value: "You don't need to do anything. If it gets stuck, it will show in Waiting for you." },
    ]);
  });

  it('says the same reason in the activity, and that it is still working', () => {
    const t = slowBuilder({ failed, doing: 'Fixing a failed test' });
    expect(slowActivity(t, t.quiet!, AT)).toBe('Taking longer than usual: the tests failed once, so the Builder is fixing them. Still working.');
    const quiet = slowBuilder({ doingAt: ago(6 * 60) });
    expect(slowActivity(quiet, quiet.quiet!, AT)).toBe('Taking longer than usual: nothing failed on the way, so it is most likely a bigger step than usual. The Builder has been on this step for 14 minutes. It usually takes 2 to 4 minutes.');
  });

  it("keeps the Builder's own runs of the checks on its clock, per plan step", () => {
    const t = building({ steps: six(3), clock: { who: 'builder', step: 'build', part: 4, since: ago(60) } });
    runsFor(t, 'test', 'Running the tests', AT - 30_000);
    expect(t.clock).toMatchObject({ doing: 'Running the tests', running: 'test' });
    ownCheckEnded(t, 'test', false, false, AT);
    expect(t.clock).toMatchObject({ doing: 'Fixing a failed test', failed: { check: 'test', times: 1 } });
    expect(t.clock?.running).toBeUndefined();
    // The code check passing says nothing new while the tests still fail.
    ownCheckEnded(t, 'lint', true, false, AT);
    expect(t.clock?.doing).toBe('Fixing a failed test');
    ownCheckEnded(t, 'test', false, false, AT);
    expect(t.clock?.failed?.times).toBe(2);
    // One test file passing alone does not fix it; the whole tests passing does.
    ownCheckEnded(t, 'test', true, true, AT);
    expect(t.clock?.failed?.fixed).toBeUndefined();
    ownCheckEnded(t, 'test', true, false, AT);
    expect(t.clock).toMatchObject({ doing: 'The tests passed', failed: { check: 'test', times: 2, fixed: new Date(AT).toISOString() } });
    // A new action ends what squad-kit ran; the next plan step starts with nothing failed.
    runsFor(t, 'build', 'Checking that the app builds');
    stepDoing(t, 'Writing tests');
    expect(t.clock?.running).toBeUndefined();
    // (Carried on after a restart, so this part teaches no usual time and nothing is written.)
    const next = { ...t, clock: { ...t.clock!, resumed: ago(30) } };
    nextPart(boardPaths(path.join(os.tmpdir(), 'squad-no-board', '.squad')), next, 5, AT);
    expect(next.clock).toMatchObject({ part: 5 });
    expect(next.clock.failed).toBeUndefined();
    // squad-kit's setup again, ended: progress, and nothing runs for it any more.
    runsFor(t, 'setup', "Setting up this story's copy", AT - 60_000);
    ranFor(t, 'setup', AT);
    expect(t.clock).toMatchObject({ doing: "Setting up this story's copy", doingAt: new Date(AT).toISOString() });
    expect(t.clock?.running).toBeUndefined();
  });
});

describe('the tracker counts the squad\'s own work', () => {
  const T0 = Date.parse('2026-11-08T09:00:00Z');
  const min = (m: number) => T0 + m * 60_000;
  const iso = (at: number) => new Date(at).toISOString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-stage-work-'));
  const bp = boardPaths(path.join(dir, '.squad'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** What saving a ticket does (store.ts updateTicket): the stage times move, and the clock stands still while it waits. */
  const move = (t: Ticket, at: number, change: (x: Ticket) => void) => {
    const before = t.stage;
    change(t);
    trackStage(t, before, at);
    if (waitsNow(t)) pauseClock(t, at);
  };
  const working = { live: true, squad: { phase: 'build', nextAt: iso(min(500)) } } as const;

  it('leaves out the waits for you, for another story and a chat, and says a long wait on a small line', () => {
    const t = ticket({ stage: 'tickets', createdAt: iso(min(0)), ...working });
    // The Analyst reads it for a minute, and its questions wait 20 minutes for you.
    move(t, min(0), (x) => startStep(x, { who: 'analyst', step: 'questions' }, min(0)));
    move(t, min(1), (x) => {
      endStep(bp, x, min(1));
      x.stage = 'specs';
      x.waiting = { kind: 'questions', summary: 'Two questions' };
    });
    // The spec takes 2 minutes, then waits for you: a 10 minute talk with the Analyst in between, then your approval.
    move(t, min(21), (x) => {
      x.waiting = null;
      startStep(x, { who: 'analyst', step: 'spec' }, min(21));
    });
    move(t, min(23), (x) => {
      endStep(bp, x, min(23));
      x.waiting = { kind: 'spec', summary: 'The spec is ready' };
    });
    move(t, min(25), (x) => (x.waiting = { kind: 'chat', summary: 'Talking it through' }));
    move(t, min(35), (x) => (x.waiting = { kind: 'spec', summary: 'The spec is ready' }));
    move(t, min(40), (x) => {
      x.waiting = null;
      x.specApproved = { by: 'Sara', at: iso(min(40)) };
      startStep(x, { who: 'architect', step: 'design' }, min(40));
    });
    move(t, min(41), (x) => {
      endStep(bp, x, min(41));
      x.waiting = { kind: 'plan', summary: 'The design is ready' };
    });
    // The Builder works 3 minutes, waits 20 for another story to merge, then works 4 more.
    move(t, min(45), (x) => {
      x.waiting = null;
      x.stage = 'implement';
      startStep(x, { who: 'builder', step: 'build' }, min(45));
    });
    move(t, min(48), (x) => {
      x.live = false;
      x.squad = null;
    });
    move(t, min(68), (x) => {
      Object.assign(x, working);
      startStep(x, { who: 'builder', step: 'build' }, min(68));
    });
    // The checks use the Builder's own run: 3 seconds.
    move(t, min(72), (x) => {
      endStep(bp, x, min(72));
      x.stage = 'test';
      startStep(x, { who: 'squad', step: 'checks' }, min(72));
    });
    move(t, min(72) + 3000, (x) => {
      endStep(bp, x, min(72) + 3000, { builderRun: { checks: ['test', 'lint'], all: true } });
      x.stage = 'review';
      startStep(x, { who: 'reviewer', step: 'review' }, min(72) + 3000);
    });
    expect(t.history?.map((h) => [h.step, h.stage])).toEqual([
      ['questions', 'tickets'],
      ['spec', 'specs'],
      ['design', 'specs'],
      ['build', 'implement'],
      ['checks', 'test'],
    ]);
    const n = liveNow(t, {}, min(74));
    const notes = Object.fromEntries(n.stages.map((s) => [s.stage, s.note]));
    expect(notes).toEqual({ tickets: '1 min', specs: '3 min, you approved', implement: '7 min', test: '3 s · passed earlier on the same code', review: 'now · 1 min', release: 'on Looks right' });
    // Specs waited 41 minutes, all of it for you (the talk too); Implement waited 20 for another story.
    expect(n.stages.filter((s) => s.wait).map((s) => [s.stage, s.wait])).toEqual([
      ['specs', 'waited 41 min for you'],
      ['implement', 'waited 20 min'],
    ]);
  });

  it('says which checks came from the Builder\'s run when only some did, and the clock time for a ticket with no steps kept', () => {
    const t = ticket({
      stage: 'review',
      ...working,
      history: [{ who: 'squad', step: 'checks', from: ago(100), to: ago(60), stage: 'test', builderRun: { checks: ['test'] } }],
      stageTimes: { stage: 'review', since: ago(50), spent: { test: 50 } },
    });
    expect(liveNow(t, {}, AT).stages.find((s) => s.stage === 'test')).toEqual({ stage: 'test', note: '40 s · tests passed earlier on the same code' });
    // A stage no step ran in says nothing, not the time it waited.
    const none = ticket({ stage: 'implement', ...working, history: [{ who: 'architect', step: 'design', from: ago(200), to: ago(140), stage: 'specs' }], stageTimes: { stage: 'implement', since: ago(10), spent: { tickets: 900, specs: 70 } } });
    expect(liveNow(none, {}, AT).stages.slice(0, 2)).toEqual([
      { stage: 'tickets', note: '' },
      { stage: 'specs', note: '1 min' },
    ]);
  });

  it("keeps the person's turn with the stage it was in, also when the stage moves on during it", () => {
    const t = ticket({ stage: 'specs', createdAt: iso(min(0)) });
    move(t, min(0), (x) => (x.waiting = { kind: 'spec', summary: 'The spec is ready' }));
    move(t, min(12), (x) => {
      x.stage = 'implement';
      x.waiting = { kind: 'depends', summary: 'Choose how to build it' };
    });
    move(t, min(15), (x) => (x.waiting = null));
    expect(t.stageTimes?.yours).toEqual({ specs: 720, implement: 180 });
    expect(t.stageTimes?.yoursSince).toBeUndefined();
  });
});

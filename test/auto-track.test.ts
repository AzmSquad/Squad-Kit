import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * Builds by itself (the 'auto' track) in the live squad, with fake agents: no questions step, the plan approves
 * itself, small choices are kept as "Decided for you", it stops only for a gap or a clash, and the squad accepts and
 * merges it itself.
 */

const calls: RunOptions[] = [];
const answers: unknown[] = [];
/** What the fake Builder does to the files before it answers. */
let builderWork: ((cwd: string) => void) | null = null;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    if (opts.permissionMode === 'acceptEdits' && builderWork && opts.cwd) builderWork(opts.cwd);
    return { ok: true, structured: answers.shift() ?? { summary: 'done' }, sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, draftRelease, listDecisions, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const auto = await import('../src/board/auto.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('./support/copy.js');
const P = await import('../src/engine/prompts.js');
const { breakdownFile, breakdownTextDir } = await import('../src/board/requirements-paths.js');
const { wakeIfReady } = await import('../src/board/depends.js');
const { liveNow } = await import('../src/board/now.js');
const { answerAsk } = await import('../src/board/ask.js');
const { expressTip } = await import('../src/board/cost.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths } = await import('../src/core/paths.js');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;

type Squad = {
  step(id: string, phase: string): Promise<void>;
  runBuilder(id: string, prompt: string, resume: boolean, step?: string): Promise<void>;
  review(id: string): Promise<void>;
  proof(id: string): Promise<void>;
  updateBase(id: string): Promise<void>;
};
const squad = () => new LiveSquad(bp) as unknown as Squad;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, cwd);
const texts = (id: string) => readTicket(bp, id)!.activity.map((a) => a.text);
/** Runs a step that may stop to ask: the question shows on the ticket, and the step ends there. */
const stepAsking = (id: string, phase: string) => squad().step(id, phase).catch(() => undefined);

const STORY = {
  id: 'BR-1',
  item: 'S-14',
  story: 'As a guest, I want my money back when I cancel, so I do not pay for a stay I do not take.',
  criteria: [{ given: 'a paid booking', when: 'the guest cancels it', then: 'the refund is sent' }],
  approvedBy: 'Momen',
};
const story = (title = 'Refund on cancel') => actions.createTicket(bp, { title, fromBreakdown: STORY });

/** A design answer, as the Architect gives it. */
const design = (more: Record<string, unknown> = {}) => ({ steps: ['Send the refund', 'Add the tests'], tests: 2, screens: 0, ...more });

/** The ticket's own copy of the code, with the work done in it, ready for its accept. */
function built(id: string, work = 'limit = 3\n'): string {
  const wt = addWorktree(project, id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'limit.txt'), work);
  updateTicket(bp, id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'review';
    x.squad = null;
    x.live = false;
    x.sessions = { intake: 'i-1', build: 'b-1', review: 'r-1' };
    x.steps = [{ title: 'Send the refund', status: 'done' }];
    x.work = { steps: 1, tests: 1, screens: 0 };
    x.gates = { checks: 'pass', review: 'pass', proof: 'pending' };
  });
  return wt.dir;
}

function writeBreakdown(): void {
  const file = breakdownFile(bp, 'BR-1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const s = (key: string, title: string, more: Record<string, unknown> = {}) => ({ key, title, story: '', criteria: [], size: 'M', dependsOn: [], ...more });
  fs.writeFileSync(
    file,
    yaml.dump({
      id: 'BR-1',
      title: 'RoomFlow BRD v2',
      status: 'approved',
      source: { file: 'source/RoomFlow BRD v2.docx', name: 'RoomFlow BRD v2.docx', kind: 'docx', bytes: 1200, addedBy: 'Momen', addedAt: '2026-11-04T10:00:00Z' },
      summary: 'Guests book rooms, pay and get refunds.',
      questions: [],
      epics: [
        {
          key: 'E-2',
          title: 'Payments',
          goal: 'Guests pay for a stay and get their money back.',
          stories: [],
          features: [
            {
              key: 'F-3',
              title: 'Invoices and refunds',
              stories: [
                s('S-13', 'Send the invoice', { size: 'S', ticket: 'AP-9' }),
                s('S-14', 'Refund on cancel', { dependsOn: ['S-13'], ref: { section: '4.2', title: 'Refunds', page: 18 } }),
                s('S-16', 'Partial refunds', { dependsOn: ['S-14'] }),
              ],
            },
          ],
        },
      ],
      decided: [],
      leftOut: [{ text: 'Loyalty points', why: 'A later phase' }],
      createdAt: '2026-11-04T10:00:00Z',
      createdBy: 'Momen',
      owner: 'Momen',
      next: { epic: 3, feature: 4, story: 17 },
    }),
  );
  fs.mkdirSync(breakdownTextDir(bp, 'BR-1'), { recursive: true });
  fs.writeFileSync(path.join(breakdownTextDir(bp, 'BR-1'), 'part-01.md'), '# 4.2 Refunds\nNo refund within 24 hours.\n');
}

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  builderWork = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-auto-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  commit(project, 'start');
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

describe('a story that builds by itself', () => {
  it('gives the Architect the whole text folder only when no heading says where the story is, and never a forged id', async () => {
    writeBreakdown();
    const { breakdownFor } = await import('../src/engine/auto-prompts.js');
    // S-16 has no place of its own, and its feature none either: the folder, as before.
    const t = actions.createTicket(bp, { title: 'Partial refunds', fromBreakdown: { ...STORY, item: 'S-16' } });
    const r = breakdownFor(bp, t);
    expect(r.text).toContain(`The document's text is in ${breakdownTextDir(bp, 'BR-1')}`);
    expect(r.dirs).toContain(breakdownTextDir(bp, 'BR-1'));
    // A ticket file edited to name a path instead of a breakdown reads nothing.
    expect(breakdownFor(bp, { ...t, breakdown: { id: '../../..', item: 'S-16' } })).toEqual({ text: '', dirs: [] });
  });

  it('starts with the story and done-when approved, and skips the questions', async () => {
    const t0 = story();
    expect(t0).toMatchObject({ track: 'auto', breakdown: { id: 'BR-1', item: 'S-14' }, specApproved: { by: 'Momen' } });
    expect(actions.needsSpec(t0)).toBe(false);
    await squad().step(t0.id, 'analyst-read');
    expect(calls).toHaveLength(0);
    const t = readTicket(bp, t0.id)!;
    expect(t.squad?.phase).toBe('plan-write');
    expect(t.status).toBe('Architect is choosing the design');
    expect(t.questions ?? []).toEqual([]);
    expect(texts(t0.id)[0]).toBe('Builds by itself: no questions, the story was approved with the breakdown');
  });

  it('plans with the breakdown in view, keeps what the Architect decided, and approves the plan on its own', async () => {
    writeBreakdown();
    // A second part of the BRD, about something else: only the outline names it.
    fs.writeFileSync(path.join(breakdownTextDir(bp, 'BR-1'), 'part-02.md'), '# 5 Front desk\nGuests check in at the desk.\n');
    const t0 = story();
    answers.push(
      design({
        decision: { title: 'Refund through the payment service', options: [{ name: 'Its refund call', note: 'Simple', chosen: true }, { name: 'By hand', note: 'Slow', chosen: false }], why: 'It is already used', area: 'Data' },
        decided: ['The refund goes back to the card that paid.', '  ', 'The refund goes back to the card that paid'],
      }),
    );
    await squad().step(t0.id, 'plan-write');
    const ask = calls[0]!;
    // The breakdown goes in fenced as data, with the story's place, the stories around it and what was left out.
    expect(ask.prompt).toContain('<data>\nBreakdown BR-1 "RoomFlow BRD v2", from the document "RoomFlow BRD v2.docx".');
    expect(ask.prompt).toContain('Epic E-2 Payments: Guests pay for a stay and get their money back.');
    expect(ask.prompt).toContain('Feature F-3 Invoices and refunds');
    expect(ask.prompt).toContain('This story: S-14 Refund on cancel (size M), from section 4.2 "Refunds" page 18 of the document. It needs S-13 first.');
    expect(ask.prompt).toContain('- S-13 Send the invoice: ticket AP-9');
    expect(ask.prompt).toContain('- S-16 Partial refunds: not started; needs S-14');
    expect(ask.prompt).toContain('- Loyalty points (A later phase)');
    // Its own part of the BRD and the outline of the rest, not the whole text folder.
    expect(ask.prompt).toContain('The part of the BRD this story comes from (text/part-01.md)');
    expect(ask.prompt).toContain('No refund within 24 hours.');
    expect(ask.prompt).toContain('# 4.2 Refunds (text/part-01.md)\n# 5 Front desk (text/part-02.md)');
    expect(ask.prompt).not.toContain('Guests check in at the desk.');
    expect(ask.prompt).not.toContain(`The document's text is in`);
    expect(ask.addDirs ?? []).not.toContain(breakdownTextDir(bp, 'BR-1'));
    expect(ask.prompt).toContain('question.kind');
    expect(ask.prompt).toContain('In "sources" say where');
    expect(ask.prompt).not.toContain('Your job now: ask the person');

    let t = readTicket(bp, t0.id)!;
    expect(t.decided).toEqual([{ id: 'd1', text: 'The refund goes back to the card that paid.', by: 'architect', at: expect.any(String), item: 'S-14', ticket: t0.id }]);
    expect(texts(t0.id)).toContain('Decided for you (d1): The refund goes back to the card that paid.');
    expect(t.status).toBe('Builds by itself: approving the plan');
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('express-approve');

    await squad().step(t0.id, 'express-approve');
    t = readTicket(bp, t0.id)!;
    expect(t.stage).toBe('implement');
    expect(t.squad?.phase).toBe('build');
    expect(texts(t0.id)).toContain(`Builds by itself: approved the plan on its own. Decision saved as ${t0.id}.1`);
    expect(listDecisions(bp)[0]!.approvedBy).toBe('Momen (Builds by itself)');
  });

  it('works without a breakdown file: the story and done-when are enough', async () => {
    const t0 = story();
    answers.push(design());
    await squad().step(t0.id, 'plan-write');
    expect(calls[0]!.prompt).toContain('The ticket below is a story from a breakdown');
    expect(calls[0]!.prompt).not.toContain('Breakdown BR-1');
    expect(readTicket(bp, t0.id)!.squad?.phase).toBe('express-approve');
  });

  it('stops only for a clash or a gap, says which, and carries on in the same conversation after the answer', async () => {
    const t0 = story();
    const sources = [
      { text: 'BRD 4.2 Refunds, page 18', section: '4.2', page: 18 },
      { text: 'Your answer to question 1' },
      { text: 'AP-9 Cancel and refund', ticket: 'ap-9' },
      { text: '  ', ticket: 'not a ticket' },
    ];
    const question = { text: 'The app refunds every cancel in full; the BRD says no refund within 24 hours. Which is right?', options: ['No refund within 24 hours (suggested)', 'Keep the full refund'], kind: 'clash', sources };
    answers.push(design({ question, decided: ['Not kept: it asked instead.'] }));
    await stepAsking(t0.id, 'plan-write');
    let t = readTicket(bp, t0.id)!;
    expect(t.waiting).toEqual({ kind: 'ask', summary: 'Two parts clash' });
    expect(t.status).toBe('Needs you: two parts clash');
    expect(t.agentQuestion).toMatchObject({ from: 'architect', kind: 'clash', options: question.options });
    // Where it comes from (the answer's shape allows 4), each cleaned: a ticket in capitals, nothing empty.
    expect(t.agentQuestion!.sources).toEqual([
      { text: 'BRD 4.2 Refunds, page 18', section: '4.2', page: 18 },
      { text: 'Your answer to question 1' },
      { text: 'AP-9 Cancel and refund', ticket: 'AP-9' },
    ]);
    expect(t.decided).toBeUndefined();
    expect(auto.stopOf(t)).toBe('clash');

    actions.answerAgent(bp, t0.id, 'Keep the full refund');
    answers.push(design());
    await squad().step(t0.id, 'answered-architect');
    expect(calls.at(-1)!.resume).toBe(readTicket(bp, t0.id)!.sessions!.intake);
    expect(calls.at(-1)!.prompt).toContain('The person answered: "Keep the full refund"');
    expect(readTicket(bp, t0.id)!.squad?.phase).toBe('express-approve');

    const gap = story('Refund rules for groups');
    answers.push(design({ question: { text: 'The BRD does not say who gets the refund for a group booking.', options: ['The person who paid'], kind: 'gap' } }));
    await stepAsking(gap.id, 'plan-write');
    t = readTicket(bp, gap.id)!;
    expect(t.waiting).toEqual({ kind: 'ask', summary: 'Missing in the BRD' });
    expect(t.agentQuestion!.sources).toBeUndefined();
    expect(t.status).toBe('Needs you: missing in the BRD');
    expect(auto.stopOf(t)).toBe('gap');
  });

  it('keeps at most 4 sources of a stop, and only what each one really says', () => {
    expect(auto.cleanSources('BRD 4.2')).toEqual([]);
    expect(
      auto.cleanSources([
        { text: ' BRD   4.2 ', section: 4.2, page: '18' },
        { text: 'x', page: -3, ticket: 'RO 12' },
        null,
        { text: '' },
        { text: 'c', page: 2.5 },
        { text: 'd' },
        { text: 'e' },
      ]),
    ).toEqual([{ text: 'BRD 4.2', section: '4.2', page: 18 }, { text: 'x' }, { text: 'c' }, { text: 'd' }]);
  });

  it('keeps what the Builder and the Reviewer decided, each with its own id', async () => {
    const t0 = story();
    built(t0.id);
    updateTicket(bp, t0.id, (x) => auto.addDecided(x, 'architect', ['The refund goes back to the card that paid.']));
    answers.push({ summary: 'Built it', decided: ['The guest gets an email when the refund is sent.'] });
    await squad().runBuilder(t0.id, 'Build it', true, 'build');
    answers.push({ approved: true, summary: 'Looks fine', comments: [], decided: ['Dates show as 4 Nov 2026.', 'The guest gets an email when the refund is sent.'] });
    await squad().review(t0.id);
    const t = readTicket(bp, t0.id)!;
    expect(t.decided!.map((d) => `${d.id} ${d.by}: ${d.text}`)).toEqual([
      'd1 architect: The refund goes back to the card that paid.',
      'd2 builder: The guest gets an email when the refund is sent.',
      'd3 reviewer: Dates show as 4 Nov 2026.',
    ]);
    expect(t.squad?.phase).toBe('proof');
  });

  it('accepts and merges by itself once the checks, the review and the proof pass, and keeps the proof', async () => {
    const t0 = story();
    built(t0.id);
    await squad().proof(t0.id);
    let t = readTicket(bp, t0.id)!;
    expect(t.waiting).toBeNull();
    expect(t.gates?.proof).toBe('pass');
    expect(t.status).toBe('Accepting it by itself');
    expect(t.squad?.phase).toBe('accept');

    await squad().step(t0.id, 'accept');
    t = readTicket(bp, t0.id)!;
    expect(t.mergedAt).toBeTruthy();
    expect(t.stage).toBe('release');
    expect(t.waiting).toBeNull();
    expect(sh('git log --format=%s -1 main', project)).toBe(`Merge Refund on cancel (${t0.id})`);
    expect(sh('git show main:limit.txt', project)).toBe('limit = 3');
    expect(draftRelease(bp)?.tickets).toContain(t0.id);
    const line = t.activity.find((a) => a.text.includes('accepted by itself'))!;
    expect(line).toMatchObject({ who: 'squad', text: 'Checks and review passed: accepted by itself' });
    expect(texts(t0.id)).not.toContain('Checked the proof. Looks right');
  });

  it('says so when the project goes on without tests, and what passed', () => {
    const t = story();
    expect(auto.acceptedLine({ ...t, gates: { checks: 'pass', review: 'pass', proof: 'pass' }, proof: [{ criterion: 'x', before: 'a.png', after: 'b.png', beforeLabel: 'Before', afterLabel: 'After' }] })).toBe(
      'Checks, review and screenshots passed: accepted by itself',
    );
    expect(auto.acceptedLine({ ...t, gates: { checks: 'unchecked', review: 'pass', proof: 'pass' } })).toBe(
      'Review passed: accepted by itself. No tests ran: you chose to go on without tests in this project',
    );
    expect(auto.acceptedLine({ ...t, gates: { checks: 'skipped', review: 'pass', proof: 'pass' } })).toBe(
      'Review passed: accepted by itself. The checks did not pass, and you chose to go on anyway',
    );
  });

  it('waits for an open change before it accepts itself, and goes on once the change is declined', () => {
    const t0 = story();
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'review';
      x.sessions = { build: 'b-1' };
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.changes = [{ id: 'c1', ask: 'Refund to a voucher', by: 'Momen', at: new Date().toISOString(), status: 'proposed' }];
    });
    let t = auto.acceptByItself(bp, t0.id);
    expect(t.stage).toBe('review');
    expect(t.selfAccept?.waitsFor).toBe('c1');
    expect(t.status).toBe('Waits for change c1, then it is accepted by itself');
    expect(auto.resumeAccept(bp, t)).toBe(false);
    actions.declineChange(bp, t0.id);
    expect(auto.resumeAccept(bp, readTicket(bp, t0.id)!)).toBe(true);
    t = readTicket(bp, t0.id)!;
    expect(t.squad?.phase).toBe('accept');
    expect(t.selfAccept?.waitsFor).toBeUndefined();
  });

  it('brings in the newest code on a merge clash, and again while main keeps moving (test/merge-clash-retry.test.ts has the rest)', async () => {
    const t0 = story();
    built(t0.id);
    // Someone changed the same line on main meanwhile.
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 4\n');
    commit(project, 'other change');
    updateTicket(bp, t0.id, (x) => (x.gates = { checks: 'pass', review: 'pass', proof: 'pass' }));

    let t = auto.acceptByItself(bp, t0.id);
    expect(t.waiting).toBeNull();
    expect(t.stuck).toBeUndefined();
    expect(t.squad?.phase).toBe('update-base');
    expect(t.selfAccept?.baseTried).toBeTruthy();
    expect(t.selfAccept?.baseTries).toBe(1);
    expect(texts(t0.id)[0]).toBe('It clashes with newer changes, so squad-kit brings in the newest code and runs the checks, the review and the proof again (try 1 of 3)');
    expect(sh('git log --format=%s -1 main', project)).toBe('other change');

    // The Builder settles the clash in the copy, then the checks, the review and the proof run again.
    builderWork = (cwd) => fs.writeFileSync(path.join(cwd, 'limit.txt'), 'limit = 5\n');
    await squad().updateBase(t0.id);
    expect(calls.at(-1)!.prompt).toContain('- limit.txt');
    expect(readTicket(bp, t0.id)!.squad?.phase).toBe('test');

    // Main moved on again, on the same line: the squad brings it in again by itself.
    fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 6\n');
    commit(project, 'third change');
    updateTicket(bp, t0.id, (x) => {
      x.squad = null;
      x.stage = 'review';
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
    });
    t = auto.acceptByItself(bp, t0.id);
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('update-base');
    expect(t.selfAccept?.baseTries).toBe(2);
    expect(texts(t0.id)[0]).toBe('It clashes with newer changes, so squad-kit brings in the newest code and runs the checks, the review and the proof again (try 2 of 3)');
    expect(sh('git log --format=%s -1 main', project)).toBe('third change');
  });

  it('waits plainly for a pull request approver, and a pull request clash brings in the base', () => {
    const t0 = story();
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'release';
      x.release = 'v0.1.0';
      x.squad = null;
      x.live = false;
      x.status = 'PR 7 is waiting in the code host · v0.1.0';
      x.pr = { id: 7, url: 'https://code.example.test/pr/7', repo: 'app', host: 'example' };
    });
    auto.afterPullRequest(bp, t0.id, false);
    let t = readTicket(bp, t0.id)!;
    expect(t.status).toBe('Waits for someone to approve the pull request');
    expect(texts(t0.id)[0]).toBe('Pull request 7 waits for someone to approve it. That is a normal wait, not a failure');

    actions.pullRequestClashed(bp, t0.id);
    auto.afterPullRequest(bp, t0.id, true);
    t = readTicket(bp, t0.id)!;
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('update-base');
    expect(t.pr).toBeUndefined();

    // A ticket on the Full track keeps its own words for a pull request that waits. A clash brings in the base too.
    const full = actions.createTicket(bp, { title: 'Plain ticket' });
    updateTicket(bp, full.id, (x) => {
      x.stage = 'release';
      x.squad = null;
      x.status = 'PR 8 is waiting in the code host · v0.1.0';
      x.pr = { id: 8, url: 'https://code.example.test/pr/8', repo: 'app', host: 'example' };
    });
    auto.afterPullRequest(bp, full.id, false);
    expect(readTicket(bp, full.id)!.status).toBe('PR 8 is waiting in the code host · v0.1.0');
    actions.pullRequestClashed(bp, full.id);
    auto.afterPullRequest(bp, full.id, true);
    expect(readTicket(bp, full.id)!.waiting).toBeNull();
    expect(readTicket(bp, full.id)!.squad?.phase).toBe('update-base');
  });

  it('never asks how to build around a ticket it needs: it waits, and starts once that one merges', async () => {
    const dep = actions.createTicket(bp, { title: 'Send the invoice' });
    const t0 = story();
    // The Architect finds the need while planning.
    answers.push(design({ dependsOn: [dep.id] }));
    await squad().step(t0.id, 'plan-write');
    expect(readTicket(bp, t0.id)!.dependsOn).toEqual([dep.id]);
    await squad().step(t0.id, 'express-approve');
    let t = readTicket(bp, t0.id)!;
    expect(t.waiting).toBeNull();
    expect(t.squad).toBeNull();
    expect(t.dependency).toMatchObject({ on: [dep.id], way: 'wait', by: 'the squad' });
    expect(t.status).toBe(`Waits for ${dep.id} to merge · starts by itself`);
    expect(texts(t0.id)[0]).toBe(`${t0.id} needs ${dep.id}, which is not merged yet. Builds by itself: it waits, and the build starts by itself once it merges`);
    expect(wakeIfReady(bp, t)).toBe(false);

    updateTicket(bp, dep.id, (x) => (x.mergedAt = new Date().toISOString()));
    expect(wakeIfReady(bp, readTicket(bp, t0.id)!)).toBe(true);
    t = readTicket(bp, t0.id)!;
    expect(t.squad?.phase).toBe('build');
  });
});

describe('changing what was decided for you', () => {
  it('becomes a small change on the ticket before it is accepted', () => {
    const t0 = story();
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'implement';
      x.squad = null;
      auto.addDecided(x, 'architect', ['The refund goes back to the card that paid.']);
    });
    expect(() => auto.changeDecided(bp, t0.id, 'd9', 'Something')).toThrow(`${t0.id} has nothing decided for you as d9. It has d1.`);
    expect(() => auto.changeDecided(bp, t0.id, 'd1', '  ')).toThrow('Say what it should be instead.');
    const t = auto.changeDecided(bp, t0.id, 'D1', 'Refund to a voucher instead');
    expect(t.changes?.at(-1)).toMatchObject({ id: 'c1', status: 'writing', ask: 'Instead of "The refund goes back to the card that paid." (decided for you): Refund to a voucher instead' });
    expect(t.decided![0]!.changed).toMatchObject({ text: 'Refund to a voucher instead', by: 'Momen', ticket: 'c1' });
    expect(texts(t0.id)[0]).toBe('Changed what was decided for you (d1): Refund to a voucher instead. It became change c1');
  });

  it('becomes a new linked ticket once it is merged, through one REST call', async () => {
    const t0 = story();
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'release';
      x.release = 'v0.1.0';
      x.mergedAt = new Date().toISOString();
      x.squad = null;
      auto.addDecided(x, 'builder', ['The guest gets an email when the refund is sent.']);
    });
    const app = new Hono();
    mountBoardApi(app, { paths: buildPaths(project) });
    const post = (did: string, text: string) =>
      app.request(`/api/v1/tickets/${t0.id}/decided/${did}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    expect((await post('d7', 'Also a text message')).status).toBe(400);
    const res = await post('d1', 'Also send a text message');
    expect(res.status).toBe(200);
    const t = (await res.json()) as { decided: { changed?: { ticket?: string } }[] };
    const made = t.decided[0]!.changed!.ticket!;
    expect(readTicket(bp, made)).toMatchObject({ title: 'Also send a text message', changeOf: t0.id, track: 'full' });
    expect(readTicket(bp, made)!.ask).toContain(`Instead of "The guest gets an email when the refund is sent.", which the squad decided on ${t0.id}.`);
  });
});

describe('the words for the track', () => {
  it('asks only for a gap or a clash on this track, and the other tracks keep their rule', () => {
    const meta = readMeta(bp);
    const full = actions.createTicket(bp, { title: 'Plain ticket' });
    const mine = { ...full, track: 'auto' as const };
    for (const prompt of [P.buildPrompt(meta, [], mine), P.reviewPrompt(meta, [], mine, 1), P.designPrompt(mine)]) {
      expect(prompt).toContain('question.kind');
      expect(prompt).toContain('"decided"');
      expect(prompt).not.toContain('Never ask about code style or small choices');
    }
    for (const prompt of [P.buildPrompt(meta, [], full), P.reviewPrompt(meta, [], full, 1), P.designPrompt(full)]) {
      expect(prompt).toContain('Never ask about code style or small choices');
      // Every track: each question says why it is asked, a gap or a clash, and technical trouble never goes to the person.
      expect(prompt).toContain('question.kind');
    }
    for (const prompt of [P.buildPrompt(meta, [], full), P.buildPrompt(meta, [], mine)]) expect(prompt).toContain('i_am_stuck');
    for (const schema of [P.DESIGN_SCHEMA, P.BUILD_SCHEMA, P.REVIEW_SCHEMA]) {
      const props = schema.properties as Record<string, { type?: string; properties?: Record<string, { enum?: string[] }> }>;
      expect(props.decided?.type).toBe('array');
      expect(props.question?.properties?.kind?.enum).toEqual(['gap', 'clash']);
      expect(schema.required).not.toContain('decided');
    }
  });

  it('says what happens next, in English and Arabic, with no Express tip', () => {
    const t0 = story();
    updateTicket(bp, t0.id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.squad = { phase: 'build', nextAt: new Date().toISOString() };
      x.steps = [{ title: 'Send the refund', status: 'doing' }];
      x.clock = { who: 'builder', step: 'build', since: new Date().toISOString(), part: 1 };
    });
    const t = readTicket(bp, t0.id)!;
    const now = liveNow(t, {});
    expect(now.next).toContain('It is accepted and merged by itself in about');
    expect(now.stages.find((s) => s.stage === 'release')?.note).toBe('merges by itself');
    expect(answerAsk(t, now, {}, 'when will it be ready?').lines[0]).toMatch(/Then it is accepted and merged by itself\.$/);
    expect(answerAsk(t, now, {}, 'متى يجهز؟').lines[0]).toContain('يقبل الفريق العمل ويدمجه تلقائيًا');
    expect(expressTip(t, [])).toBeNull();
    expect(expressTip(actions.createTicket(bp, { title: 'Plain ticket' }), [])).toContain('Express track');
  });
});

describe('Full and Express as before', () => {
  it('Express still approves its plan as Express, and a Full ticket still waits for Looks right', async () => {
    const x = actions.createTicket(bp, { title: 'Fix the typo', track: 'express' });
    answers.push({ story: 'As a clerk, I want the right word.', criteria: [{ given: 'a', when: 'b', then: 'c' }], steps: ['Fix it'], tests: 1, screens: 0, releaseNote: 'Typo.' });
    await squad().step(x.id, 'plan-write');
    expect(readTicket(bp, x.id)!.status).toBe('Express track: approving the plan');
    await squad().step(x.id, 'express-approve');
    expect(texts(x.id)).toContain('Express track: approved the plan on its own');

    const full = actions.createTicket(bp, { title: 'Raise the limit' });
    built(full.id);
    await squad().proof(full.id);
    const t = readTicket(bp, full.id)!;
    expect(t.waiting).toEqual({ kind: 'proof', summary: 'The proof is ready for you to check' });
    expect(t.squad).toBeNull();
    expect(() => auto.acceptByItself(bp, full.id)).toThrow('is not on the Builds by itself track');
    // A Full ticket that needs an unmerged one still asks how to build.
    const dep = actions.createTicket(bp, { title: 'Send the invoice' });
    const plan = actions.createTicket(bp, { title: 'Show the invoice' });
    updateTicket(bp, plan.id, (y) => {
      y.squad = null;
      y.dependsOn = [dep.id];
      y.steps = [{ title: 'Show it', status: 'todo' }];
      y.waiting = { kind: 'plan', summary: '' };
    });
    expect(actions.approve(bp, plan.id).waiting?.kind).toBe('depends');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { freePort } from './support/tiny-app.js';

/**
 * "Not checked" (E5): a project with no tests never gets a green pass. The person is asked once per project: use the
 * test command the Architect suggested, or go on without tests. "The app starts" is a check of its own. The AI tool is
 * a fake that answers at once.
 */

const calls: RunOptions[] = [];
let reply: (opts: RunOptions) => unknown = () => ({ summary: 'done' });
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: reply(opts), text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, removeTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { withProblem } = await import('../src/board/problem.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { runChecks } = await import('../src/engine/checks.js');
const { holdTestCommand, notCheckedText } = await import('../src/engine/not-checked.js');
const { prDescription } = await import('../src/engine/review-record/pr-description.js');
const P = await import('../src/engine/prompts.js');
const { checksWords, noShotsText, notCheckedWhy, proofLead } = await import('../console-ui/src/lib/gates.js');
const { needsYou, noticeText, reasonsOf, testChangeLine } = await import('../console-ui/src/lib/waiting.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths, chooseProject } = await import('../src/core/paths.js');
const { inboxLine, runTestCommand } = await import('../src/commands/board.js');

type Ticket = import('../src/board/types.js').Ticket;
type Squad = { checks(id: string): Promise<void>; step(id: string, phase: string): Promise<void> };

let tmp: string;
let wt: string;
let bp: ReturnType<typeof boardPaths>;

beforeEach(() => {
  calls.length = 0;
  reply = () => ({ summary: 'done' });
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-unchecked-')));
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

const squadOf = () => new LiveSquad(bp) as unknown as Squad;
const get = (id: string) => readTicket(bp, id)!;
const commands = (c: Record<string, string>) => writeMeta(bp, { ...readMeta(bp), commands: c });
const builds = () => calls.filter((c) => c.schema === P.BUILD_SCHEMA);

/** A ticket the Builder finished, ready for the checks. */
function built(title = 'Limit bookings', suggestion?: string): Ticket {
  const t0 = actions.createTicket(bp, { title, ask: 'One person blocks the whole day.' });
  return updateTicket(bp, t0.id, (x) => {
    x.stage = 'test';
    x.live = true;
    x.waiting = null;
    x.squad = null;
    x.worktree = wt;
    x.sessions = { intake: 'i-1', build: 'b-1' };
    x.story = 'As a clerk, I want at most 3 bookings a day per person.';
    x.criteria = [{ given: 'a person with 3 bookings', when: 'they book again', then: 'it is refused' }];
    x.steps = [{ title: 'Refuse the fourth booking', status: 'done' }];
    x.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    if (suggestion) x.testSuggestion = suggestion;
  });
}

describe('a project with no tests', () => {
  it('the first ticket stops once with the suggested command; "Go on without tests" counts for the whole project', async () => {
    const squad = squadOf();
    const first = built('Limit bookings', 'npm test');
    await squad.checks(first.id);
    let t = get(first.id);
    // Never a green pass: "Not checked", and one decision.
    expect(t.gates).toMatchObject({ checks: 'unchecked', checksText: 'No tests ran' });
    expect(t.waiting?.kind).toBe('stuck');
    expect(t.stuck).toMatchObject({ gate: 'checks', kind: 'no-tests' });
    // Plain words for the person: no command in the question or on a button. Engineers get it in the details.
    expect(t.stuck!.question).toBe('This project has no tests yet, so squad-kit cannot check that the work does what it should.');
    expect(t.stuck!.detail).toContain('The Architect suggests: npm test');
    expect(withProblem(t).stuck!.title).toBe('No tests to check the work');
    expect(t.stuck!.options.map((o) => [o.do, o.name])).toEqual([
      ['add-test', 'Have the Builder add tests'],
      ['no-tests', 'Go on without tests'],
      ['retry', 'Check again'],
    ]);

    t = actions.decideStuck(bp, first.id, 1);
    expect(readMeta(bp).noTests).toMatchObject({ ticket: first.id, by: readMeta(bp).user.name });
    expect(t.gates?.checks).toBe('unchecked');
    expect(t.squad?.phase).toBe('review');
    // The Reviewer knows nothing was tested, and so does the pull request.
    const review = P.reviewPrompt(readMeta(bp), [], t, 1);
    expect(review).toContain('but no tests ran (No tests ran), so nothing checked that the work does what it should');
    expect(review).toContain('say in a note if tests are missing');
    expect(prDescription(t, null, [])).toContain('- Tests, lint and build: not checked, no tests ran (No tests ran)');

    // The next ticket is not asked again: it is simply "Not checked".
    const second = built('Show the limit');
    await squad.checks(second.id);
    t = get(second.id);
    expect(t.waiting).toBeNull();
    expect(t.gates?.checks).toBe('unchecked');
    expect(t.squad?.phase).toBe('review');
    expect(t.activity[0]!.text).toBe('Not checked: No tests ran. You chose to go on without tests in this project');
  });

  it('"Use npm test": saved in the project settings, and the checks run again with it', async () => {
    const squad = squadOf();
    const t0 = built('Limit bookings', 'echo "Tests  4 passed"');
    await squad.checks(t0.id);
    let t = actions.decideStuck(bp, t0.id, 0);
    expect(readMeta(bp).commands?.test).toBe('echo "Tests  4 passed"');
    expect(readMeta(bp).noTests).toBeUndefined();
    expect(t.testSuggestion).toBeUndefined();
    // The exact command is for engineers: in the log, and in the Developer tab once the checks ran it.
    expect(t.activity[0]!.text).toBe('Found how to test this project');
    expect(t.squad?.phase).toBe('test');
    await squad.checks(t0.id);
    t = get(t0.id);
    expect(t.gates).toMatchObject({ checks: 'pass', checksText: '4 tests pass, test OK' });
  });

  it('without a suggestion: go on without tests, or add one in Settings and check again', async () => {
    const squad = squadOf();
    const t0 = built();
    await squad.checks(t0.id);
    let t = get(t0.id);
    expect(t.stuck!.question).not.toMatch(/command|Settings/);
    expect(t.stuck!.detail).toContain('Add one in Settings');
    expect(t.stuck!.options.map((o) => o.do)).toEqual(['no-tests', 'retry']);
    commands({ test: 'echo "Tests  2 passed"' });
    t = actions.decideStuck(bp, t0.id, 1);
    expect(t.squad?.phase).toBe('test');
    await squad.checks(t0.id);
    expect(get(t0.id).gates).toMatchObject({ checks: 'pass', checksText: '2 tests pass, test OK' });
  });

  it('a test command that finds no tests is not checked either; lint and build still run and must pass', async () => {
    writeMeta(bp, { ...readMeta(bp), noTests: { by: 'Momen', at: new Date().toISOString(), ticket: 'X-1' } });
    commands({ test: 'echo "Tests  0 passed"', build: 'true' });
    const squad = squadOf();
    const t0 = built();
    await squad.checks(t0.id);
    expect(get(t0.id).gates).toMatchObject({ checks: 'unchecked', checksText: 'No tests ran · build passes' });

    // A failing build is a failed check, not "Not checked": the Builder fixes it.
    commands({ build: 'exit 1' });
    const t1 = built('Another');
    await squad.checks(t1.id);
    const t = get(t1.id);
    expect(t.gates).toMatchObject({ checks: 'fail', checksText: 'build failed' });
    expect(builds()).toHaveLength(1);
  });
});

describe('the Architect suggests a test command', () => {
  const plan = (cmds: Record<string, string>) => ({
    story: 'As a clerk, I want the right word.',
    criteria: [{ given: 'the login page', when: 'it opens', then: 'it says Sign in' }],
    steps: ['Fix the word', 'Add a test'],
    tests: 1,
    screens: 0,
    releaseNote: '**Typo.** Fixed.',
    commands: cmds,
  });

  it('for a project with none, the design asks for it, and it waits for the person; the other commands apply at once', async () => {
    reply = () => plan({ test: 'npm test', start: 'npm start', url: 'http://localhost:3000' });
    const t0 = actions.createTicket(bp, { title: 'Fix the typo', track: 'express' });
    const squad = squadOf();
    await squad.step(t0.id, 'plan-write');
    expect(calls[0]!.prompt).toContain('commands.test: this project has no test command yet');
    expect(readMeta(bp).commands).toEqual({ start: 'npm start', url: 'http://localhost:3000' });
    expect(get(t0.id).testSuggestion).toBe('npm test');
    // A first test command is a suggestion for the no-tests card, not a change.
    expect(get(t0.id).testChange).toBeUndefined();
  });

  it('holds a new test command, and a different one as a change from → to; the other commands apply', () => {
    expect(holdTestCommand({}, { test: 'pytest', start: 'flask run' })).toEqual({ apply: { start: 'flask run' }, suggest: 'pytest' });
    expect(holdTestCommand({ test: 'pytest -q' }, { test: 'pytest', build: 'make' })).toEqual({ apply: { build: 'make' }, change: { from: 'pytest -q', to: 'pytest' } });
    expect(holdTestCommand({ test: 'pytest -q' }, { test: ' pytest -q ' })).toEqual({ apply: {} });
    expect(holdTestCommand({}, { build: 'make' })).toEqual({ apply: { build: 'make' } });
    // The design prompt on the Full track asks too.
    const t = { ...built(), specApproved: { by: 'Momen', at: '' } };
    expect(P.designPrompt(t, undefined, readMeta(bp))).toContain('The person approves it before squad-kit runs it.');
  });
});

describe('"the app starts" is a check of its own', () => {
  it('passes when the app answers at its address, then stops it; fails with the reason when it does not start', async () => {
    const port = await freePort();
    fs.writeFileSync(path.join(wt, 'server.js'), `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1');\n`);
    const url = `http://127.0.0.1:${port}`;
    const ok = await runChecks(wt, { start: 'node server.js', url }, undefined, {}, 20_000);
    expect(ok).toEqual([expect.objectContaining({ name: 'start', command: 'node server.js', ok: true, output: `The app answered at ${url}.` })]);
    // It was stopped again: nothing answers there any more.
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(url, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();

    const bad = await runChecks(wt, { build: 'true', start: 'node -e "console.error(\'no database\'); process.exit(3)"', url }, undefined, {}, 20_000);
    expect(bad.map((r) => [r.name, r.ok])).toEqual([
      ['build', true],
      ['start', false],
    ]);
    expect(bad[1]!.output).toMatch(/The app stopped while starting.*no database/s);
  });

  it('in the live checks: no tests but the app starts is "Not checked"; an app that does not start goes to the Builder', async () => {
    writeMeta(bp, { ...readMeta(bp), noTests: { by: 'Momen', at: new Date().toISOString(), ticket: 'X-1' } });
    const port = await freePort();
    fs.writeFileSync(path.join(wt, 'server.js'), `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1');\n`);
    commands({ build: 'true', start: 'node server.js', url: `http://127.0.0.1:${port}` });
    const squad = squadOf();
    const t0 = built();
    await squad.checks(t0.id);
    let t = get(t0.id);
    expect(t.gates).toMatchObject({ checks: 'unchecked', checksText: 'No tests ran · build passes, the app starts' });
    expect(t.gates?.ran?.map((r) => [r.name, r.ok])).toEqual([
      ['build', true],
      ['start', true],
    ]);

    commands({ start: 'exit 3', url: `http://127.0.0.1:${port}` });
    const t1 = built('Another');
    await squad.checks(t1.id);
    t = get(t1.id);
    expect(t.gates).toMatchObject({ checks: 'fail', checksText: 'start failed' });
    expect(builds().at(-1)!.prompt).toContain('"start" (exit 3) failed.');

    // With tests that ran, the tests are the check: the Tester starts the app for the proof anyway.
    commands({ test: 'echo "Tests  3 passed"', start: 'exit 3', url: `http://127.0.0.1:${port}` });
    const t2 = built('A third');
    await squad.checks(t2.id);
    expect(get(t2.id).gates).toMatchObject({ checks: 'pass', checksText: '3 tests pass, test OK' });
  });
});

describe('the board shows "Not checked" as its own state', () => {
  it('in words: never "pass", with why and what did pass', () => {
    const g = { checks: 'unchecked' as const, checksText: 'No tests ran · build passes, the app starts', review: 'pass' as const, proof: 'pass' as const };
    expect(checksWords(g)).toBe('Not checked: no tests ran');
    expect(notCheckedWhy(g)).toBe(
      'No tests ran, so squad-kit could not check that the work does what it should. Passed: build passes, the app starts. Check the proof with extra care. To turn tests on, have an engineer add tests to the project.',
    );
    expect(notCheckedWhy({ ...g, checks: 'pass' })).toBeNull();
    expect(checksWords({ ...g, checks: 'skipped', checksText: '4 tests pass, test OK; tests weakened, you continued' })).toBe('Tests weakened, you continued');
    expect(checksWords({ ...g, checks: 'skipped', checksText: 'test failed' })).toBe('Checks failed, you continued');
    expect(noShotsText({ gates: g, work: { screens: 0 } })).toBe('No screens change in this ticket and no tests ran, so read the changes in the Changes tab.');
    expect(notCheckedText([])).toBe('No tests ran');
    expect(proofLead(g)).toBe('Not checked: no tests ran, so look closely. Compare the screens before and after each "done when".');
    expect(proofLead({ ...g, checks: 'pass' })).toMatch(/^Every gate is green\./);
  });
});

describe('a change to the test command the project has', () => {
  const plan = (cmds: Record<string, string>, repo?: string) => ({
    story: 'As a clerk, I want the right word.',
    criteria: [{ given: 'the login page', when: 'it opens', then: 'it says Sign in' }],
    steps: ['Fix the word', 'Add a test'],
    tests: 1,
    screens: 0,
    releaseNote: '**Typo.** Fixed.',
    commands: cmds,
    ...(repo ? { repo } : {}),
  });

  it('is held, not applied, until squad-kit tries it: the person is not asked, and the words name no command', async () => {
    commands({ test: 'pnpm test' });
    reply = () => plan({ test: 'pnpm vitest run --passWithNoTests', build: 'pnpm build' });
    const t0 = actions.createTicket(bp, { title: 'Fix the typo', track: 'express' });
    const squad = squadOf();
    await squad.step(t0.id, 'plan-write');
    // The other commands apply as before; the test command does not.
    expect(readMeta(bp).commands).toEqual({ test: 'pnpm test', build: 'pnpm build' });
    let t = get(t0.id);
    expect(t.testChange).toMatchObject({ from: 'pnpm test', to: 'pnpm vitest run --passWithNoTests' });
    expect(t.testSuggestion).toBeUndefined();
    expect(t.activity.map((a) => a.text)).toContain('The design changes how the tests run. squad-kit tries the new way after the build');
    expect(t.activity.map((a) => a.text).join(' ')).not.toContain('pnpm');

    // Express approves its own plan and builds on, and nobody waits on the change.
    await squad.step(t0.id, 'express-approve');
    t = get(t0.id);
    expect(t.waiting).toBeNull();
    expect(t.squad?.phase).toBe('build');
    expect(actions.inbox(bp).map((x) => x.id)).not.toContain(t0.id);
    expect(needsYou(t as never)).toBe(false);
    expect(reasonsOf(t as never)).toEqual([]);
    expect(readMeta(bp).commands?.test).toBe('pnpm test');
  });

  it('when squad-kit cannot tell, it is one plain item in Waiting for you, and the terminal has the commands', () => {
    commands({ test: 'npm test' });
    const t = updateTicket(bp, built().id, (x) => (x.testChange = { from: 'npm test', to: 'npm run all', at: new Date().toISOString(), ask: true }));
    expect(actions.inbox(bp).map((x) => x.id)).toContain(t.id);
    expect(needsYou(t as never)).toBe(true);
    expect(reasonsOf(t as never)).toEqual(['test-command']);
    expect(testChangeLine(t as never)).toBe('squad-kit cannot tell which way of testing to keep');
    expect(noticeText({ key: 'k', project: { id: 'p', name: 'Case portal' }, ticket: t as never, reason: 'test-command' }).title).toBe(`${t.id}: a choice about the tests waits for you`);
    expect(inboxLine(t)).toBe('The Architect suggests changing the test command from "npm test" to "npm run all"');
  });

  it('with the design waiting, it is part of the design: one item, one notice', () => {
    const t = updateTicket(bp, built().id, (x) => {
      x.waiting = { kind: 'plan', summary: 'The design is ready' };
      x.testChange = { from: 'npm test', to: 'npm run test:all', at: new Date().toISOString(), ask: true };
    });
    expect(reasonsOf(t as never)).toEqual(['plan']);
    expect(actions.inbox(bp).filter((x) => x.id === t.id)).toHaveLength(1);
  });

  it('Use the new command: saved for the ticket\'s own repo; Keep: dropped, nothing changes', async () => {
    writeMeta(bp, {
      ...readMeta(bp),
      commands: undefined,
      repos: [
        { path: 'web', base: 'main', remote: '', commands: { test: 'npm test' } },
        { path: 'api', base: 'main', remote: '', commands: { test: 'dotnet test' } },
      ],
    });
    reply = () => plan({ test: 'dotnet test --filter Booking' }, 'api');
    const t0 = actions.createTicket(bp, { title: 'Fix the typo', track: 'express' });
    await squadOf().step(t0.id, 'plan-write');
    expect(get(t0.id).testChange).toMatchObject({ from: 'dotnet test', to: 'dotnet test --filter Booking', repo: 'api' });
    expect(readMeta(bp).repos!.map((r) => r.commands.test)).toEqual(['npm test', 'dotnet test']);

    const t = actions.decideTestCommand(bp, t0.id, true);
    expect(t.testChange).toBeUndefined();
    expect(t.activity[0]!.text).toBe('Chose the new way of testing this project');
    expect(t.testDecided).toMatchObject({ from: 'dotnet test', to: 'dotnet test --filter Booking', kept: 'new', by: 'you' });
    expect(readMeta(bp).repos!.map((r) => r.commands.test)).toEqual(['npm test', 'dotnet test --filter Booking']);
    expect(actions.inbox(bp).map((x) => x.id)).not.toContain(t0.id);
    expect(() => actions.decideTestCommand(bp, t0.id, true)).toThrow('has no change to the test command waiting');

    // Keep: the Architect's command is dropped and the settings stay as they are.
    updateTicket(bp, t0.id, (x) => (x.testChange = { from: 'dotnet test --filter Booking', to: 'dotnet test --no-build', repo: 'api', at: new Date().toISOString() }));
    const kept = actions.decideTestCommand(bp, t0.id, false);
    expect(kept.testChange).toBeUndefined();
    expect(kept.activity[0]!.text).toBe('Kept the current way of testing this project');
    expect(kept.testDecided).toMatchObject({ from: 'dotnet test --filter Booking', to: 'dotnet test --no-build', kept: 'current', by: 'you' });
    expect(readMeta(bp).repos!.map((r) => r.commands.test)).toEqual(['npm test', 'dotnet test --filter Booking']);
  });

  it('a later design that keeps the command clears the change', async () => {
    commands({ test: 'pnpm test' });
    reply = () => plan({ test: 'pnpm vitest run' });
    const t0 = actions.createTicket(bp, { title: 'Fix the typo', track: 'express' });
    const squad = squadOf();
    await squad.step(t0.id, 'plan-write');
    expect(get(t0.id).testChange).toBeDefined();
    reply = () => plan({});
    await squad.step(t0.id, 'plan-rewrite');
    expect(get(t0.id).testChange).toBeUndefined();
  });

  it('one REST call and one terminal command each for Use and Keep', async () => {
    commands({ test: 'npm test' });
    const change = () => updateTicket(bp, built().id, (x) => (x.testChange = { from: 'npm test', to: 'npm run test:ci', at: new Date().toISOString() }));
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(tmp) });
    const post = (id: string, body: unknown) => a.request(`/api/v1/tickets/${id}/test-command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const one = change();
    expect((await post(one.id, {})).status).toBe(400);
    expect((await post(one.id, { use: false })).status).toBe(200);
    expect(readMeta(bp).commands?.test).toBe('npm test');
    const two = change();
    expect((await post(two.id, { use: true })).status).toBe(200);
    expect(readMeta(bp).commands?.test).toBe('npm run test:ci');

    chooseProject(tmp);
    const quiet = [vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)];
    try {
      const three = updateTicket(bp, built().id, (x) => (x.testChange = { from: 'npm run test:ci', to: 'npm test -- --bail', at: new Date().toISOString() }));
      await runTestCommand(three.id, {});
      expect(get(three.id).testChange).toBeDefined();
      await runTestCommand(three.id, { use: true });
      expect(readMeta(bp).commands?.test).toBe('npm test -- --bail');
      const four = updateTicket(bp, built().id, (x) => (x.testChange = { from: 'npm test -- --bail', to: 'jest', at: new Date().toISOString() }));
      await runTestCommand(four.id, { keep: true });
      expect(get(four.id).testChange).toBeUndefined();
      expect(readMeta(bp).commands?.test).toBe('npm test -- --bail');
      await expect(runTestCommand(four.id, { use: true, keep: true })).rejects.toThrow('Pick one');
    } finally {
      chooseProject(null);
      for (const q of quiet) q.mockRestore();
    }
  });
});

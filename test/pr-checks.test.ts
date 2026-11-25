import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, requireTicket, updateTicket, writeMeta } from '../src/board/store.js';
import { approve, createTicket, decideStuck } from '../src/board/actions.js';
import { afterPullRequest, mergeWait, mergeWatch, PR_HOST_WAITS } from '../src/board/auto.js';
import { problemOf } from '../src/board/problem.js';
import { recheckMerge, repoTarget, targetHost } from '../src/engine/sync.js';
import { publishTicket } from '../src/engine/publish.js';
import { CHECK_ROUNDS, JOB_START_MS, UNRUN_MS, heldBack, jobNamed, nothingChanged, roundStarts } from '../src/engine/pr-checks.js';
import { failedTest, logWords } from '../src/modules/github/failed-checks.js';
import { labelJobsIn } from '../src/modules/github/pull-jobs.js';
import { checkGh } from '../src/modules/github/sign-in.js';
import { addWorktree } from './support/copy.js';
import { fakeGh, fakeGitHub, pullJson, repoJson, type Call, type FakeGitHub } from './support/fake-github.js';

/**
 * A check GitHub failed on a story's own pull request is squad-kit's to handle, never a technical step for the person
 * (like a Flutter app whose golden pictures are only ever made on Linux). squad-kit reads why it failed; the Builder fixes
 * it, or names the project's own job a label starts (update goldens); squad-kit merges once the checks pass. Only after
 * its rounds does a plain card ask for an engineer, and squad-kit still merges by itself once the check passes.
 */

/** GitHub's own output of a Flutter test that failed (--reporter github), as a real check printed it. */
const FLUTTER_LOG = [
  '2026-11-25T07:34:20.1Z ##[group]Run flutter test',
  '2026-11-25T07:34:26.6Z ✅ test/app/router_test.dart: opens the home screen',
  '2026-11-25T07:34:26.6Z ##[group]❌ /home/runner/work/app/app/test/app/placeholder_golden_test.dart: placeholder screen in Arabic matches its picture (failed)',
  '2026-11-25T07:34:26.6Z ══╡ EXCEPTION CAUGHT BY FLUTTER TEST FRAMEWORK ╞══',
  '2026-11-25T07:34:26.6Z Expected: one widget whose rasterized image matches golden image "goldens/placeholder_ar.png"',
  '2026-11-25T07:34:26.6Z    Which: Could not be compared against non-existent file: "goldens/placeholder_ar.png"',
  '2026-11-25T07:34:26.7Z ##[endgroup]',
  '2026-11-25T07:34:28.4Z ##[error]66 tests passed, 1 failed.',
  '2026-11-25T07:34:28.4Z ##[error]Process completed with exit code 1.',
].join('\n');

const GOLDENS = `# Makes fresh golden pictures on Linux and commits them to a branch.
# Golden pictures are only ever made here, never on a Mac.
name: Update goldens
on:
  workflow_dispatch:
  pull_request:
    types: [labeled]
jobs:
  update-goldens:
    if: github.event.label.name == 'update goldens'
    runs-on: ubuntu-latest
    steps:
      - run: flutter test --update-goldens
`;

const CHECKS = `name: checks
on:
  pull_request:
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - run: flutter test
`;

describe('reading why a check failed', () => {
  it('names the failed tests of the usual test tools', () => {
    expect(failedTest('##[group]❌ /home/runner/work/app/app/test/a_test.dart: shows the name (failed)')).toBe('test/a_test.dart: shows the name');
    expect(failedTest('00:05 +12 -1: test/a_test.dart: shows the name [E]')).toBe('test/a_test.dart: shows the name');
    expect(failedTest('  ✕ adds the fee (12 ms)')).toBe('adds the fee');
    expect(failedTest('FAILED tests/test_fee.py::test_adds - AssertionError')).toBe('tests/test_fee.py::test_adds - AssertionError');
    expect(failedTest('--- FAIL: TestAddsFee (0.00s)')).toBe('TestAddsFee');
    expect(failedTest('FeeTest > adds the fee FAILED')).toBe('FeeTest > adds the fee');
    expect(failedTest('✅ test/a_test.dart: shows the name')).toBeNull();
  });

  it('keeps the lines that say why, without the runner folder, the times or GitHub marks', () => {
    const w = logWords(FLUTTER_LOG);
    expect(w.tests).toEqual(['test/app/placeholder_golden_test.dart: placeholder screen in Arabic matches its picture']);
    expect(w.lines).toContain('   Which: Could not be compared against non-existent file: "goldens/placeholder_ar.png"');
    expect(w.lines).toContain('66 tests passed, 1 failed.');
    expect(w.lines.join('\n')).not.toMatch(/##\[|\/home\/runner|2026-11-25T/);
  });

  it("finds the project's jobs a label starts, with the team's own words about them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-jobs-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'update_goldens.yml'), GOLDENS);
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'checks.yml'), CHECKS);
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'broken.yml'), 'on: [');
    expect(labelJobsIn(dir)).toEqual([
      { name: 'Update goldens', label: 'update goldens', file: '.github/workflows/update_goldens.yml', about: 'Makes fresh golden pictures on Linux and commits them to a branch. Golden pictures are only ever made here, never on a Mac.' },
    ]);
    expect(labelJobsIn(path.join(dir, 'nothing'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

let tmp: string;
let project: string;
let remote: string;
let bp: ReturnType<typeof boardPaths>;
let gh: FakeGitHub | undefined;
let undo: (() => void)[] = [];
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const route = (c: Call, method: string, p: string) => c.method === method && c.path.split('?')[0] === p;

/** GitHub now: the pull request's newest commit, its checks, and whether it is a draft. */
const now = { sha: 'sha1', checks: 'failed' as 'failed' | 'passed' | 'job running' | 'none', draft: false, merged: false, moved: false };

function setUp(): void {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-pr-checks-')));
  remote = path.join(tmp, 'remote.git');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  project = path.join(tmp, 'app');
  fs.mkdirSync(path.join(project, '.github', 'workflows'), { recursive: true });
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'book.ts'), 'export const fee = 500;\n');
  fs.writeFileSync(path.join(project, '.github', 'workflows', 'update_goldens.yml'), GOLDENS);
  fs.writeFileSync(path.join(project, '.gitignore'), '.squad/\n');
  sh('git add -A && git commit -qm start', project);
  const url = 'https://github.com/me/app.git';
  sh(`git remote add origin ${url} && git config url.${remote}.insteadOf ${url} && git config url.${remote}.pushInsteadOf ${url} && git push -q origin main`, project);
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
  Object.assign(now, { sha: 'sha1', checks: 'failed', draft: false, merged: false, moved: false });
  setUpGitHubAgain();
}

/** GitHub for these tests, answering from `now`. */
function setUpGitHubAgain(): void {
  gh = fakeGitHub((c) => {
    if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
    if (route(c, 'GET', '/repos/me/app/pulls')) return { body: [] };
    if (route(c, 'POST', '/repos/me/app/pulls')) return { status: 201, body: pullJson('me/app', 7) };
    if (route(c, 'GET', '/repos/me/app/pulls/7')) {
      const p = pullJson('me/app', 7, { sha: now.sha, merged: now.merged, mergeableState: now.checks === 'passed' || now.checks === 'none' ? 'clean' : 'unstable' });
      return { body: { ...p, draft: now.draft } };
    }
    if (route(c, 'PUT', '/repos/me/app/pulls/7/merge')) {
      // Another story merged into main a moment before: GitHub's own 405.
      if (now.moved) {
        now.moved = false;
        return { status: 405, body: { message: 'Base branch was modified. Review and try the merge again.' } };
      }
      now.merged = true;
      return { body: { merged: true, sha: 'abc123' } };
    }
    if (c.path.startsWith(`/repos/me/app/commits/${now.sha}/check-runs`) && now.checks === 'none') return { body: { check_runs: [] } };
    if (c.path.startsWith(`/repos/me/app/commits/${now.sha}/check-runs`)) {
      const checks = now.checks === 'passed' ? { status: 'completed', conclusion: 'success' } : { status: 'completed', conclusion: 'failure' };
      const job = now.checks === 'job running' ? [{ id: 56, name: 'update goldens', status: 'in_progress', conclusion: null }] : [];
      return { body: { check_runs: [{ id: 55, name: 'checks', ...checks, details_url: 'https://github.com/me/app/actions/runs/1/job/55', app: { slug: 'github-actions' } }, ...job] } };
    }
    if (c.path.includes('/check-runs')) return { body: { check_runs: [] } };
    if (c.path.endsWith('/status')) return { body: { statuses: [] } };
    if (route(c, 'GET', '/repos/me/app/actions/jobs/55/logs')) return { text: FLUTTER_LOG };
    if (route(c, 'GET', '/repos/me/app/issues/7/labels')) return { body: [] };
    if (route(c, 'POST', '/repos/me/app/issues/7/labels')) return { body: [{ name: 'update goldens' }] };
    if (c.method === 'DELETE') return { status: 204 };
    if (c.method === 'GET' && c.path.includes('/comments')) return { body: [] };
    if (c.method === 'POST' && c.path.includes('/comments')) return { status: 201, body: { id: 900 } };
    return undefined;
  });
}

/** Looks right on a story whose work is in its own copy: the publish step comes next. */
function accepted(): string {
  const t = createTicket(bp, { title: 'Set up checks and CI' });
  const wt = addWorktree(project, t.id, 'main');
  fs.writeFileSync(path.join(wt.dir, 'book.ts'), 'export const fee = 450;\n');
  sh('git add -A && git commit -qm "lower the fee"', wt.dir);
  updateTicket(bp, t.id, (x) => {
    x.worktree = wt.dir;
    x.branch = wt.branch;
    x.baseCommit = wt.baseCommit;
    x.stage = 'review';
    x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
    x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
    x.squad = null;
  });
  approve(bp, t.id);
  return t.id;
}

/** The fix round got through and sent its fix to the same pull request (the publish step does this for real). */
function fixSent(id: string, sha: string): void {
  now.sha = sha;
  updateTicket(bp, id, (x) => {
    Object.assign(x, { stage: 'release', live: false, squad: null, status: PR_HOST_WAITS, changeRequest: undefined });
    x.prCheck!.fixing = false;
  });
}

beforeEach(async () => {
  undo.push(fakeGh('ready'));
  await checkGh();
  setUp();
});

afterEach(() => {
  gh?.done();
  gh = undefined;
  for (const u of undo.reverse()) u();
  undo = [];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a check GitHub failed on the story's pull request", () => {
  it("goes to the Builder at once, with the failed test, what the check printed and the project's jobs", async () => {
    const id = accepted();
    await publishTicket(bp, id);
    const t = requireTicket(bp, id);
    expect(t).toMatchObject({ stage: 'implement', live: true, waiting: null, status: "Builder is fixing what GitHub's check found", squad: { phase: 'fix' } });
    expect(t.prCheck).toMatchObject({ pr: 7, sha: 'sha1', failed: ['checks'], url: 'https://github.com/me/app/actions/runs/1/job/55', rounds: 1, fixing: true });
    expect(t.prCheck!.offered).toEqual([expect.objectContaining({ label: 'update goldens', file: '.github/workflows/update_goldens.yml' })]);
    const ask = t.changeRequest!;
    expect(ask.split('\n')[0]).toBe("Fix what GitHub's check found");
    expect(ask).toContain('- test/app/placeholder_golden_test.dart: placeholder screen in Arabic matches its picture');
    expect(ask).toContain('Could not be compared against non-existent file');
    expect(ask).toContain('- "update goldens": Update goldens (.github/workflows/update_goldens.yml). Makes fresh golden pictures on Linux');
    expect(ask).toContain('Do not weaken, skip or delete a test');
    expect(t.activity.map((a) => a.text)).toContain('GitHub\'s check "checks" failed on pull request 7 (1 test: placeholder screen in Arabic matches its picture), so it is not merged yet');
    // Nothing is a stop: no card, no technical step for the person.
    expect(t.stuck).toBeUndefined();
  });

  it("the Builder names the project's job and changes nothing: squad-kit starts it, waits for it, and merges once green", async () => {
    const id = accepted();
    await publishTicket(bp, id);
    await roundStarts(bp, id);
    // Its answer names the job by its label, in any case. A job it was not offered is never taken.
    updateTicket(bp, id, (x) => jobNamed(x, 'Deploy to production'));
    expect(requireTicket(bp, id).prCheck!.job).toBeUndefined();
    updateTicket(bp, id, (x) => jobNamed(x, 'Update Goldens'));
    expect(await nothingChanged(bp, id)).toBe(true);
    let t = requireTicket(bp, id);
    expect(t).toMatchObject({ stage: 'release', live: false, squad: null, status: PR_HOST_WAITS, prCheck: { started: { label: 'update goldens' }, fixing: false } });
    expect(gh!.sent('POST', '/repos/me/app/issues/7/labels').map((c) => c.body)).toEqual([{ labels: ['update goldens'] }]);
    expect(t.activity[0]!.text).toBe('Started the project\'s own job "Update goldens" on pull request 7, as the Builder said. squad-kit merges once the checks pass');
    // The job runs: the old check's failure on the same commit is no new try.
    now.checks = 'job running';
    expect(await recheckMerge(bp, id)).toBe('waiting');
    expect(requireTicket(bp, id)).toMatchObject({ stage: 'release', prCheck: { rounds: 1 } });
    // It committed the pictures, and the checks pass on the new commit.
    now.sha = 'sha2';
    now.checks = 'passed';
    expect(await recheckMerge(bp, id)).toBe('merged');
    t = requireTicket(bp, id);
    expect(t.mergedAt).toBeTruthy();
    expect(t.prCheck).toBeUndefined();
    expect(t.activity.map((a) => a.text)).toContain('Merged pull request 7 on GitHub once it was ready');
  });

  it('still failing after the rounds: one plain card for an engineer, and it still merges by itself once the check passes', async () => {
    const id = accepted();
    await publishTicket(bp, id);
    fixSent(id, 'sha2');
    expect(await recheckMerge(bp, id)).toBe('waiting');
    let t = requireTicket(bp, id);
    expect(t).toMatchObject({ stage: 'implement', prCheck: { rounds: 2, sha: 'sha2' } });
    expect(t.changeRequest).toContain('Tried already: the Builder fixed it once, and the check still failed on the new commit.');
    fixSent(id, 'sha3');
    await recheckMerge(bp, id);
    t = requireTicket(bp, id);
    expect(CHECK_ROUNDS).toBe(2);
    expect(t).toMatchObject({ stage: 'release', live: false, squad: null, waiting: { kind: 'stuck' }, status: "GitHub's check fails on pull request 7" });
    expect(t.stuck).toMatchObject({
      kind: 'pr-check',
      question: 'GitHub\'s check "checks" failed on pull request 7 again after the Builder\'s fixes, so it is not merged. This needs an engineer on your team. squad-kit still merges it by itself once the check passes.',
      points: ['Failed: test/app/placeholder_golden_test.dart: placeholder screen in Arabic matches its picture'],
      link: { label: 'See the check on GitHub', url: 'https://github.com/me/app/actions/runs/1/job/55' },
    });
    expect(t.stuck!.detail).toContain('Could not be compared against non-existent file');
    expect(t.stuck!.options.map((o) => o.name)).toEqual(['Let the Builder try again', 'Let an engineer look']);
    expect(problemOf(t)?.title).toBe("The pull request's check still fails");
    // The squad keeps looking while the card waits.
    expect(mergeWait(t)).toBeNull();
    expect(mergeWatch(t)).toBe('pr');
    expect(await recheckMerge(bp, id)).toBe('waiting');
    t = decideStuck(bp, id, 1);
    expect(t).toMatchObject({ status: 'Waiting for an engineer', waiting: { kind: 'stuck' }, stuck: { kind: 'pr-check' } });
    expect(mergeWatch(t)).toBe('pr');
    // An engineer fixed it on GitHub.
    now.sha = 'sha4';
    now.checks = 'passed';
    expect(await recheckMerge(bp, id)).toBe('merged');
    t = requireTicket(bp, id);
    expect(t.waiting).toBeNull();
    expect(t.stuck).toBeUndefined();
    expect(t.prCheck).toBeUndefined();
    expect(t.mergedAt).toBeTruthy();
  });

  it('Let the Builder try again on the card: one more round, and the card comes back if that one fails too', async () => {
    const id = accepted();
    await publishTicket(bp, id);
    fixSent(id, 'sha2');
    await recheckMerge(bp, id);
    fixSent(id, 'sha3');
    await recheckMerge(bp, id);
    const t = decideStuck(bp, id, 0);
    expect(t).toMatchObject({ stage: 'implement', live: true, waiting: null, stuck: undefined, squad: { phase: 'fix' }, prCheck: { rounds: CHECK_ROUNDS, fixing: true } });
    expect(t.activity[0]!.text).toBe("Let the Builder try GitHub's check again");
  });

  it("a job that ran without a fix: the Builder tries once more, told what was tried", async () => {
    const id = accepted();
    await publishTicket(bp, id);
    await roundStarts(bp, id);
    updateTicket(bp, id, (x) => jobNamed(x, 'update goldens'));
    await nothingChanged(bp, id);
    // Still the same commit, nothing runs, and the job had its time to show.
    updateTicket(bp, id, (x) => (x.prCheck!.started!.at = new Date(Date.now() - JOB_START_MS - 1000).toISOString()));
    await recheckMerge(bp, id);
    const t = requireTicket(bp, id);
    expect(t).toMatchObject({ stage: 'implement', prCheck: { rounds: 2, fixing: true } });
    expect(t.prCheck!.started).toBeUndefined();
    expect(t.changeRequest).toContain('Tried already: squad-kit started the project\'s job "update goldens" on the pull request, as the Builder said, and the check still failed after it.');
  });

  it('nothing to fix in the code and no job named: the card says so at once', async () => {
    const id = accepted();
    await publishTicket(bp, id);
    await roundStarts(bp, id);
    expect(await nothingChanged(bp, id)).toBe(true);
    const t = requireTicket(bp, id);
    expect(t.stuck?.question).toBe('GitHub\'s check "checks" failed on pull request 7, and the Builder found nothing to fix in the code, so it is not merged. This needs an engineer on your team. squad-kit still merges it by itself once the check passes.');
    expect(t.activity[0]!.text).toBe("Found nothing to fix in the code for GitHub's check");
    expect(mergeWatch(t)).toBe('pr');
  });

  it('a change the Builder made goes on to the checks as usual', async () => {
    const id = accepted();
    await publishTicket(bp, id);
    await roundStarts(bp, id);
    fs.writeFileSync(path.join(requireTicket(bp, id).worktree!, 'book.ts'), 'export const fee = 400;\n');
    expect(await nothingChanged(bp, id)).toBe(false);
  });

  it('held back before squad-kit handled it (an older version): the next look hands it to the Builder', async () => {
    const id = accepted();
    now.checks = 'passed';
    now.draft = true;
    await publishTicket(bp, id);
    // An older version left only this status and a line.
    updateTicket(bp, id, (x) => Object.assign(x, { status: 'PR 7 is waiting in GitHub · v0.1.0', waiting: null, stuck: undefined }));
    now.draft = false;
    now.checks = 'failed';
    expect(mergeWatch(requireTicket(bp, id))).toBe('pr');
    await recheckMerge(bp, id);
    expect(requireTicket(bp, id)).toMatchObject({ stage: 'implement', status: "Builder is fixing what GitHub's check found", prCheck: { rounds: 1 } });
  });

  it('a draft: a plain card, and it merges by itself once it is ready on GitHub', async () => {
    const id = accepted();
    now.checks = 'passed';
    now.draft = true;
    await publishTicket(bp, id);
    let t = requireTicket(bp, id);
    expect(t.stuck).toMatchObject({ kind: 'pr-check', question: 'Pull request 7 is a draft on GitHub, so squad-kit does not merge it. squad-kit merges it by itself once GitHub lets it. If it stays like this, an engineer on your team can look.' });
    expect(t.stuck!.options.map((o) => o.name)).toEqual(['Let an engineer look', 'Check again']);
    expect(problemOf(t)?.title).toBe('The pull request is held back');
    now.draft = false;
    expect(await recheckMerge(bp, id)).toBe('merged');
    t = requireTicket(bp, id);
    expect(t.waiting).toBeNull();
    expect(t.stuck).toBeUndefined();
    expect(t.mergedAt).toBeTruthy();
  });

  it("a commit with the check never run again (a job's own push starts none): no merge, then a plain card; it merges once the check passes there", async () => {
    const id = accepted();
    await publishTicket(bp, id);
    fixSent(id, 'sha2');
    now.checks = 'none';
    // GitHub calls it clean, but "checks" never ran on this commit.
    expect(await recheckMerge(bp, id)).toBe('waiting');
    expect(now.merged).toBe(false);
    let t = requireTicket(bp, id);
    expect(t.prCheck?.unrun?.sha).toBe('sha2');
    expect(t.stuck).toBeUndefined();
    updateTicket(bp, id, (x) => (x.prCheck!.unrun!.at = new Date(Date.now() - UNRUN_MS - 1000).toISOString()));
    expect(await recheckMerge(bp, id)).toBe('waiting');
    t = requireTicket(bp, id);
    expect(t.stuck).toMatchObject({ kind: 'pr-check', question: 'GitHub\'s check "checks" has not run again on pull request 7\'s newest commit, so squad-kit does not merge it yet. squad-kit merges it by itself once GitHub lets it. If it stays like this, an engineer on your team can look.' });
    expect(t.stuck!.options.map((o) => o.name)).toEqual(['Let an engineer look', 'Check again']);
    expect(problemOf(t)?.title).toBe('The pull request is held back');
    // Check again is a look, never a Builder round, even though the check failed once.
    t = decideStuck(bp, id, 1);
    expect(t).toMatchObject({ stage: 'release', status: PR_HOST_WAITS, waiting: null });
    expect(now.merged).toBe(false);
    // Someone ran the check again there, and it passed.
    now.checks = 'passed';
    expect(await recheckMerge(bp, id)).toBe('merged');
  });

  it('two looks at the same time (the squad, and Check again): one Builder round, said once', async () => {
    const id = accepted();
    now.checks = 'passed';
    now.draft = true;
    await publishTicket(bp, id);
    updateTicket(bp, id, (x) => Object.assign(x, { status: 'PR 7 is waiting in GitHub · v0.1.0', waiting: null, stuck: undefined }));
    now.draft = false;
    now.checks = 'failed';
    const t0 = requireTicket(bp, id);
    const target = repoTarget(bp, t0)!;
    const host = targetHost(bp, target)!;
    await Promise.all([heldBack(bp, id, host, 7, 'refused'), heldBack(bp, id, host, 7, 'refused'), recheckMerge(bp, id)]);
    const t = requireTicket(bp, id);
    expect(t.prCheck?.rounds).toBe(1);
    expect(t.activity.filter((a) => a.text.startsWith('GitHub\'s check "checks" failed on pull request 7'))).toHaveLength(1);
  });

  it('Builds by itself: checks still running at Looks right stay a wait on the host, and a failure then goes to the Builder', async () => {
    const id = accepted();
    updateTicket(bp, id, (x) => (x.track = 'auto'));
    now.checks = 'job running';
    now.sha = 'sha0';
    // Nothing has run on the new commit's checks yet: "checks" only runs, so it is a wait.
    gh!.done();
    const running = fakeGitHub((c) => {
      if (route(c, 'GET', '/repos/me/app')) return { body: repoJson('me/app') };
      if (route(c, 'GET', '/repos/me/app/pulls')) return { body: [] };
      if (route(c, 'POST', '/repos/me/app/pulls')) return { status: 201, body: pullJson('me/app', 7) };
      if (route(c, 'GET', '/repos/me/app/pulls/7')) return { body: pullJson('me/app', 7, { sha: 'sha0', mergeableState: 'unstable' }) };
      if (c.path.includes('/check-runs')) return { body: { check_runs: [{ id: 55, name: 'checks', status: 'in_progress', conclusion: null }] } };
      if (c.path.endsWith('/status')) return { body: { statuses: [] } };
      return undefined;
    });
    await publishTicket(bp, id);
    afterPullRequest(bp, id, false);
    expect(requireTicket(bp, id).status).toBe(PR_HOST_WAITS);
    running.done();
    setUpGitHubAgain();
    now.sha = 'sha1';
    now.checks = 'failed';
    await recheckMerge(bp, id);
    expect(requireTicket(bp, id)).toMatchObject({ stage: 'implement', status: "Builder is fixing what GitHub's check found" });
  });

  it("another story's merge a moment before is a wait, never a card", async () => {
    const id = accepted();
    now.checks = 'passed';
    now.moved = true;
    await publishTicket(bp, id);
    const t = requireTicket(bp, id);
    expect(t.status).toBe(PR_HOST_WAITS);
    expect(t.stuck).toBeUndefined();
    expect(await recheckMerge(bp, id)).toBe('merged');
  });
});

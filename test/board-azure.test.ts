import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { boardPaths, readTicket, ticketFilesDir, updateTicket, writeMeta, type BoardPaths } from '../src/board/store.js';
import * as actions from '../src/board/actions.js';
import { addWorktree } from '../src/engine/git.js';
import { trackerFor } from '../src/modules/registry.js';
import { flushTracker, publishTicket, syncWiki } from '../src/engine/sync.js';
import { AzureError } from '../src/modules/azure/client.js';
import { LiveSquad } from '../src/engine/live.js';
import { listReleases } from '../src/board/store.js';

const AZURE_URL = 'https://dev.azure.com/momenysr/Mawid/_git/Mawid';

let tmp: string;
let project: string;
let remote: string;
let bp: BoardPaths;
let calls: { method: string; url: string; body: unknown }[];
/** Azure's answer when newer changes in main clash with the pull request. */
let prConflicts = false;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Azure DevOps as far as squad-kit uses it. Completing a PR really merges it in the local "remote". */
function fakeAzure() {
  const states = new Map<number, string>([[35, 'New']]);
  let prStatus = 'active';
  const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  return async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, body });
    if (method === 'GET' && /workitems\/35\?\$expand=relations/.test(url)) {
      return reply({
        id: 35,
        fields: {
          'System.WorkItemType': 'User Story',
          'System.Title': 'Owner signs up for a Mawid account',
          'System.State': states.get(35),
          'System.Description': '<p>As a business owner, I want to sign up.</p>',
          'Microsoft.VSTS.Common.AcceptanceCriteria': '<ol><li>Given the sign-up page, then an account is made.</li></ol>',
          'Microsoft.VSTS.Common.Priority': 1,
        },
        relations: [],
      });
    }
    if (method === 'GET' && /workitems\/35\?fields=System.WorkItemType/.test(url)) {
      return reply({ id: 35, fields: { 'System.WorkItemType': 'User Story', 'System.State': states.get(35) } });
    }
    if (method === 'GET' && /workitems\/35\?fields=System.Tags/.test(url)) return reply({ id: 35, fields: { 'System.Tags': 'owner; mvp' } });
    if (method === 'GET' && /workitemtypes\/User%20Story\/states/.test(url)) {
      return reply({ value: [{ name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }, { name: 'Resolved', category: 'Resolved' }, { name: 'Closed', category: 'Completed' }] });
    }
    if (method === 'PATCH' && /workitems\/35/.test(url)) {
      const op = (body as { path: string; value: string }[]).find((o) => o.path === '/fields/System.State');
      if (op) states.set(35, op.value);
      return reply({ id: 35 });
    }
    if (method === 'POST' && /workItems\/35\/comments/.test(url)) return reply({ id: 1 });
    if (method === 'GET' && /pullrequests\?searchCriteria/.test(url)) return reply({ value: [] });
    if (method === 'POST' && /repositories\/Mawid\/pullrequests$|repositories\/Mawid\/pullrequests\?/.test(url)) return reply({ pullRequestId: 7, status: 'active' });
    if (method === 'POST' && /pullRequests\/7\/attachments/.test(url)) return reply({ url: 'https://dev.azure.com/att/after-1.png' });
    if (method === 'PATCH' && /pullrequests\/7/.test(url)) {
      if ((body as { status?: string }).status === 'completed' && prConflicts) return reply({ pullRequestId: 7, status: 'active', mergeStatus: 'conflicts' });
      if ((body as { status?: string }).status === 'completed') {
        // What Azure does when a PR completes: a merge commit on main, and the branch is deleted.
        const work = path.join(tmp, 'azure-side');
        sh(`git clone -q ${remote} ${work}`, tmp);
        sh('git -c user.name=Azure -c user.email=a@a merge -q --no-ff -m "Merged PR 7" origin/squad/ab-35', work);
        sh('git push -q origin main && git push -q origin --delete squad/ab-35', work);
        prStatus = 'completed';
      }
      return reply({ pullRequestId: 7, status: prStatus });
    }
    if (method === 'GET' && /pullrequests\/7/.test(url)) {
      return reply({ pullRequestId: 7, status: prStatus, mergeStatus: prConflicts ? 'conflicts' : 'succeeded', lastMergeSourceCommit: { commitId: 'x' }, lastMergeCommit: { commitId: 'm' } });
    }
    return new Response(JSON.stringify({ message: `unexpected ${method} ${url}` }), { status: 404 });
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-azure-'));
  project = path.join(tmp, 'app');
  remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(project);
  sh(`git init -q --bare -b main ${remote}`, tmp);
  sh(`git init -q -b main && git remote add origin ${AZURE_URL}`, project);
  // The repo says Azure; git really talks to the local bare repo.
  sh(`git config url.${remote}.insteadOf ${AZURE_URL}`, project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'mawid', version: '0.0.0' }, null, 2));
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', project);
  fs.mkdirSync(path.join(project, '.squad'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.squad', 'config.yaml'),
    'version: 1\nproject:\n  name: Mawid\n  projectRoots:\n    - .\ntracker:\n  type: azure\n  workspace: momenysr\n  project: Mawid\nnaming:\n  includeTrackerId: false\n  globalSequence: true\nagents: []\n',
  );
  vi.stubEnv('AZURE_DEVOPS_PAT', 'secret');
  calls = [];
  prConflicts = false;
  vi.stubGlobal('fetch', fakeAzure());
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'Mawid',
    key: 'AP',
    nextNumber: 1,
    engine: 'live',
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const statesSet = () =>
  calls
    .filter((c) => c.method === 'PATCH' && /workitems\/35/.test(c.url))
    .flatMap((c) => (c.body as { path: string; value: string }[]).filter((o) => o.path === '/fields/System.State').map((o) => o.value));

describe('Azure Boards and Repos', () => {
  it('takes a story from Azure to a merged PR, a pushed release and a closed work item', async () => {
    const az = trackerFor(bp);
    expect(az).not.toBeNull();

    // 1. Start from the work item.
    const t = await actions.startFromTracker(bp, az!, '35');
    expect(t.source).toMatchObject({ type: 'azure', id: '35', ref: 'AB#35', itemType: 'User Story' });
    expect(t.priority).toBe('high');
    expect(t.ask).toContain('Acceptance criteria:\n- Given the sign-up page');
    await flushTracker(bp, t.id);
    expect(statesSet()).toEqual(['Active']);
    await expect(actions.startFromTracker(bp, az!, '35')).rejects.toThrow(/already on the board as AB-35/);

    // 2. The squad's work, as the live engine leaves it at the proof.
    const wt = addWorktree(project, t.id, 'main');
    fs.writeFileSync(path.join(wt.dir, 'signup.ts'), 'export const signup = true;\n');
    fs.mkdirSync(bp.proofDir, { recursive: true });
    fs.writeFileSync(path.join(bp.proofDir, 'AP-1-after-1.png'), 'png');
    updateTicket(bp, t.id, (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = wt.baseCommit;
      x.stage = 'review';
      x.story = 'As an owner I want to sign up.';
      x.criteria = [{ given: 'the sign-up page', when: 'I sign up', then: 'an account is made' }];
      x.gates = { checks: 'pass', checksText: '12 tests pass', review: 'pass', proof: 'pass' };
      x.proof = [{ criterion: 'An account is made', before: '', after: 'AP-1-after-1.png', beforeLabel: '', afterLabel: '' }];
      x.releaseNote = '**Sign up.** Owners can make an account.';
      x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
      x.squad = null;
      x.trackerQueue = undefined;
    });

    // 3. "Looks right" commits and hands the PR to the live squad.
    actions.approve(bp, t.id);
    expect(readTicket(bp, t.id)!.squad?.phase).toBe('publish');
    await publishTicket(bp, t.id);
    const published = readTicket(bp, t.id)!;
    expect(published.pr).toMatchObject({ id: 7, repo: 'Mawid', url: `${AZURE_URL}/pullrequest/7` });
    expect(published.squad).toBeNull();
    expect(sh('git branch -r --list', project) || sh('git ls-remote --heads origin', project)).toContain('squad/ab-35');
    const created = calls.find((c) => c.method === 'POST' && /pullrequests$|pullrequests\?/.test(c.url))!.body as Record<string, unknown>;
    expect(created).toMatchObject({ sourceRefName: 'refs/heads/squad/ab-35', targetRefName: 'refs/heads/main', workItemRefs: [{ id: '35' }] });
    const described = calls.filter((c) => c.method === 'PATCH' && /pullrequests\/7/.test(c.url) && (c.body as { description?: string }).description).at(-1)!.body as { description: string };
    expect(described.description).toContain('![An account is made](https://dev.azure.com/att/after-1.png)');
    expect(described.description).not.toMatch(/claude|\bai\b/i);
    expect(statesSet()).toEqual(['Active', 'Resolved']);
    // Merge on accept: the PR is merged right away, and the local main has it too, so the next ticket builds on it.
    expect(published.mergedAt).toBeTruthy();
    expect(published.status).toBe('Merged into main · goes out in v0.1.0');
    expect(sh('git log --format=%s -1 main', remote)).toBe('Merged PR 7');
    expect(sh('git rev-parse main', project)).toBe(sh('git rev-parse main', remote));

    // 4. Release adds the changelog, version and tag on top, and pushes.
    const release = await actions.releaseVersion(bp);
    expect(release.version).toBe('v0.1.0');
    expect(release.log?.filter((l) => !l.ok)).toEqual([]);
    expect(release.log?.[0]?.text).toBe('Already in main: AB-35 Owner signs up for a Mawid account');
    expect(calls.filter((c) => c.method === 'PATCH' && (c.body as { status?: string }).status === 'completed').length).toBe(1);
    const log = sh('git log --format=%s main', remote).split('\n');
    expect(log.slice(0, 2)).toEqual(['release v0.1.0', 'Merged PR 7']);
    expect(sh('git tag', remote)).toBe('v0.1.0');
    await flushTracker(bp, t.id);
    expect(statesSet()).toEqual(['Active', 'Resolved', 'Closed']);
    expect(calls.filter((c) => /comments/.test(c.url)).length).toBe(3);
  }, 30_000);

  it('files a reported bug on Azure', async () => {
    const bug = actions.reportBug(bp, { what: 'Booking page is blank on Safari', severity: 'stops-work' });
    expect(bug.trackerQueue).toEqual([{ kind: 'file-bug' }]);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
      return new Response(JSON.stringify({ id: 90, fields: { 'System.WorkItemType': 'Bug', 'System.Title': 'Booking page is blank on Safari' } }), { status: 200 });
    });
    await flushTracker(bp, bug.id);
    const after = readTicket(bp, bug.id)!;
    expect(after.source).toMatchObject({ type: 'azure', id: '90', itemType: 'Bug' });
    const ops = calls.at(-1)!.body as { path: string; value: string }[];
    expect(calls.at(-1)!.url).toContain('_apis/wit/workitems/$Bug');
    expect(ops).toContainEqual({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: '1 - Critical' });
    expect(after.trackerQueue).toBeUndefined();
  });
});

describe('a tracker that says no for good', () => {
  /** A tracker whose every call goes through `answer`. */
  function tracker(answer: (what: string) => void) {
    const az = trackerFor(bp)!;
    const said: string[] = [];
    const fake = Object.create(az) as typeof az & { said: string[] };
    fake.moveTo = async (id: string, stage: string) => {
      answer(`move ${id} ${stage}`);
      said.push(`move ${id} ${stage}`);
      return null;
    };
    fake.comment = async (id: string, text: string) => {
      answer(`comment ${id}`);
      said.push(text);
    };
    fake.said = said;
    return fake;
  }
  const queued = () => {
    const t = actions.createTicket(bp, { title: 'Owner signs up' });
    return updateTicket(bp, t.id, (x) => {
      x.source = { type: 'azure', ref: 'AB#35', id: '35' };
      x.trackerQueue = [{ kind: 'started' }, { kind: 'note', noteKind: 'note', text: 'A later note' }];
    }).id;
  };

  it.each([
    ['a deleted item', new AzureError('Azure DevOps said HTTP 404. TF401232', 404)],
    ['a rule of the tracker', new AzureError('Azure DevOps said HTTP 400. TF401320: Rule Error', 400)],
  ])('%s: that update goes, one plain line says so, and the later updates still go', async (_what, refusal) => {
    const id = queued();
    const az = tracker((what) => {
      if (what.startsWith('move')) throw refusal;
    });
    await flushTracker(bp, id, az);
    const t = readTicket(bp, id)!;
    expect(t.trackerQueue).toBeUndefined();
    expect(t.trackerRetry).toBeUndefined();
    expect(az.said.join('\n')).toContain('A later note');
    const said = t.activity.map((a) => a.text).join('\n');
    expect(said).toContain('Azure DevOps refused this update on AB#35, so squad-kit went on without it.');
    expect(said).not.toMatch(/HTTP|TF40/);
  });

  it.each([
    ['a sign-in', new AzureError('Azure DevOps refused the token (HTTP 401).', 401)],
    ['a busy service', new AzureError('Azure DevOps said HTTP 503.', 503)],
    ['too many calls', new AzureError('Azure DevOps said HTTP 429.', 429)],
    ['a lost connection', new AzureError('Could not reach Azure DevOps: socket hang up', undefined, 'offline')],
  ])('%s can pass, so the update is kept and sent again', async (_what, trouble) => {
    const id = queued();
    let fails = true;
    const az = tracker(() => {
      if (fails) throw trouble;
    });
    await flushTracker(bp, id, az);
    let t = readTicket(bp, id)!;
    expect(t.trackerQueue).toHaveLength(2);
    expect(t.trackerRetry?.tries).toBe(1);
    fails = false;
    updateTicket(bp, id, (x) => (x.trackerRetry!.nextAt = new Date(Date.now() - 1000).toISOString()));
    await flushTracker(bp, id, az);
    t = readTicket(bp, id)!;
    expect(t.trackerQueue).toBeUndefined();
    expect(az.said.join('\n')).toContain('A later note');
  });

  it('a bug it refuses for good stays on the board and blocks nothing', async () => {
    const bug = actions.reportBug(bp, { what: 'Booking page is blank', severity: 'annoying' });
    const az = trackerFor(bp)!;
    const fake = Object.create(az) as typeof az;
    fake.fileBug = async () => {
      throw new AzureError('Azure DevOps said HTTP 400. No Bug type', 400);
    };
    await flushTracker(bp, bug.id, fake);
    const t = readTicket(bp, bug.id)!;
    expect(t.trackerQueue).toBeUndefined();
    expect(t.activity[0]!.text).toBe('Azure DevOps refused this bug, so squad-kit went on without it. It stays on this board');
  });
});

describe('names in Arabic, pulled from the tracker', () => {
  it('keeps every wiki page, with a safe name of its own', async () => {
    const pages = [
      { path: '/', content: 'Home page' },
      { path: '/الرئيسية', content: 'Main rules' },
      { path: '/قواعد العمل', content: 'Work rules' },
      { path: '/قواعد/الرسوم', content: 'Fee rules' },
      { path: '/قواعد-الرسوم', content: 'Same name once it is safe' },
      { path: '/Team rules', content: 'Team rules' },
      { path: '/team-rules?', content: 'Nearly the same' },
      { path: '/???', content: 'No word at all' },
    ];
    const az = trackerFor(bp)!;
    const fake = Object.create(az) as typeof az;
    fake.wikiPages = async () => pages;
    expect(await syncWiki(bp, fake, true)).toBe(pages.length);
    const files = fs.readdirSync(bp.wikiDir).filter((f) => f.endsWith('.md')).sort();
    expect(files).toHaveLength(pages.length);
    expect(files).toEqual(expect.arrayContaining(['الرئيسية.md', 'قواعد العمل.md', 'قواعد-الرسوم.md', 'قواعد-الرسوم-2.md', 'Team rules.md', 'Home.md', 'Home-2.md']));
    const all = files.map((f) => fs.readFileSync(path.join(bp.wikiDir, f), 'utf8')).join('\n');
    for (const p of pages) expect(all).toContain(p.content);
    for (const f of files) expect(f, f).not.toMatch(/[/\\:*?"<>|]/);
  });

  it('keeps every attachment, with its name in any language, and two of one name both stay', async () => {
    const az = trackerFor(bp)!;
    const fake = Object.create(az) as typeof az;
    const item = await az.get('35');
    fake.get = async () => ({
      ...item,
      attachments: [
        { name: 'صورة.png', url: 'u1', size: 4 },
        { name: 'مستند.png', url: 'u2', size: 4 },
        { name: 'صورة.png', url: 'u3', size: 4 },
        { name: 'Screen Shot!.png', url: 'u4', size: 4 },
        { name: '../../secret.txt', url: 'u5', size: 4 },
        { name: '..', url: 'u6', size: 4 },
      ],
    });
    fake.download = async (url: string, file: string) => {
      fs.writeFileSync(file, url);
      return file;
    };
    const t = await actions.startFromTracker(bp, fake, '35');
    const dir = ticketFilesDir(bp, t.id);
    const names = fs.readdirSync(dir).sort();
    expect(names).toHaveLength(6);
    expect(names).toEqual(expect.arrayContaining(['صورة.png', 'صورة-2.png', 'مستند.png', 'Screen Shot_.png']));
    expect(names.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
    expect(readTicket(bp, t.id)!.attachments).toHaveLength(6);
    // Nothing lands outside the ticket's own folder.
    expect(fs.existsSync(path.join(dir, '..', '..', 'secret.txt'))).toBe(false);
  });
});

describe('a branch with someone else\'s work on it', () => {
  it('is never written over when a pull request goes out: taken back or not, nothing is forced', async () => {
    const t = actions.createTicket(bp, { title: 'Owner signs up' });
    const wt = addWorktree(project, t.id, 'main');
    fs.writeFileSync(path.join(wt.dir, 'mine.txt'), 'mine\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm mine', wt.dir);
    updateTicket(bp, t.id, (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = wt.baseCommit;
    });
    // Whoever had it pushed their own work to that branch, and this computer knows of it from its last look.
    const theirs = path.join(tmp, 'theirs');
    sh(`git clone -q "${remote}" "${theirs}"`, tmp);
    sh(`git checkout -q -b ${wt.branch}`, theirs);
    fs.writeFileSync(path.join(theirs, 'theirs.txt'), 'theirs\n');
    sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm theirs && git push -q origin ${wt.branch}`, theirs);
    const tip = sh(`git rev-parse ${wt.branch}`, theirs);
    sh('git fetch -q origin', project);
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    await expect(publishTicket(bp, t.id)).rejects.toThrow(/has newer work on this ticket from someone else, and squad-kit does not write over it/);
    expect(sh(`git rev-parse ${wt.branch}`, remote)).toBe(tip);
  });
});

describe('a pull request that clashes with newer changes in main', () => {
  async function accepted() {
    const t = await actions.startFromTracker(bp, trackerFor(bp)!, '35');
    await flushTracker(bp, t.id);
    const wt = addWorktree(project, t.id, 'main');
    fs.writeFileSync(path.join(wt.dir, 'signup.ts'), 'export const signup = true;\n');
    updateTicket(bp, t.id, (x) => {
      x.worktree = wt.dir;
      x.branch = wt.branch;
      x.baseCommit = wt.baseCommit;
      x.stage = 'review';
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
      x.squad = null;
      x.trackerQueue = undefined;
    });
    actions.approve(bp, t.id);
    return t.id;
  }
  const completions = () => calls.filter((c) => c.method === 'PATCH' && (c.body as { status?: string }).status === 'completed').length;

  it('gives the clash card on accept and leaves the release, instead of waiting in Azure', async () => {
    const id = await accepted();
    prConflicts = true;
    await (new LiveSquad(bp) as unknown as { step(id: string, phase: string): Promise<void> }).step(id, 'publish');
    const t = readTicket(bp, id)!;
    expect(t.waiting).toEqual({ kind: 'stuck', summary: 'Clashes with main and needs one decision' });
    expect(t.stuck?.gate).toBe('merge');
    expect(t.retryPhase).toBe('update-base');
    expect(t.pr).toBeUndefined();
    expect(t.release).toBeUndefined();
    expect(t.activity[0]!.text).toBe('Pull request 7 clashes with newer changes in main, so it left v0.1.0');
    expect(listReleases(bp).find((r) => r.version === 'v0.1.0')?.tickets ?? []).not.toContain(id);
    // The story is not done yet, so it stays Active.
    expect(statesSet()).toEqual(['Active']);
  }, 30_000);

  it('stops the release before anything changes, and gives the ticket a way out', async () => {
    const id = await accepted();
    // Like MA-5: accepted, its pull request open in Azure, then main moved on and it clashes.
    updateTicket(bp, id, (x) => {
      x.pr = { id: 7, url: `${AZURE_URL}/pullrequest/7`, repo: 'Mawid', host: 'azure' };
      x.squad = null;
    });
    prConflicts = true;
    await expect(actions.releaseVersion(bp)).rejects.toThrow(
      'The release did not go out: the pull request of AB-35 clashes with newer changes in main. It left v0.1.0 and waits for you with ways out.',
    );
    expect(completions()).toBe(0);
    expect(sh('git tag', project)).toBe('');
    expect(readTicket(bp, id)!.stuck?.gate).toBe('merge');
    expect(listReleases(bp).find((r) => r.version === 'v0.1.0')).toMatchObject({ status: 'draft', tickets: [] });
  }, 30_000);
});

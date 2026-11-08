import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import type { MergeState, PullRequest, RepoHost } from '../src/modules/code-host/types.js';

/**
 * A pull request squad-kit opened, merged by a person on the code host, outside squad-kit (like AB-46: its pull request
 * clashed with main, the board marked it stuck, and the person settled the clash and merged it there). Check again asks
 * the code host now, and a quiet look by itself asks every few minutes. A merge found there is recorded the way squad-kit
 * records its own, and the story that waits for it goes on.
 */

/** What the code host says about each pull request, and every question asked of it. */
const states = new Map<number, MergeState>();
const byBranch = new Map<string, PullRequest>();
const asked: string[] = [];
const host: RepoHost = {
  host: 'example',
  label: 'Example Repos',
  repo: 'app',
  abilities: { attachImages: false },
  gitEnv: () => ({}),
  findPullRequest: async () => null,
  lastPullRequest: async (source) => {
    asked.push(`find ${source}`);
    return byBranch.get(source) ?? null;
  },
  openPullRequest: async () => ({ id: 14, url: 'https://code.example.test/pr/14' }),
  attachImage: async () => '',
  updateDescription: async () => undefined,
  mergeState: async (id) => {
    asked.push(`state ${id}`);
    return states.get(id) ?? 'waiting';
  },
  merge: async () => ({ commit: '' }),
  close: async () => undefined,
  refusedPush: () => false,
};
vi.mock('../src/modules/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/registry.js')>()),
  repoHostFor: () => host,
}));

const { boardPaths, listReleases, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
const { checkMerge, lookOutside, lookOutsideBeside, FIRST_LOOK_MS } = await import('../src/engine/merged-outside.js');
const { mountDependsApi } = await import('../src/console/api/depends.js');
const { buildPaths, chooseProject } = await import('../src/core/paths.js');
const { runCheckMerge } = await import('../src/commands/depends.js');

let tmp: string;
let project: string;
let bp: ReturnType<typeof boardPaths>;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, msg: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "${msg}"`, cwd);

beforeEach(() => {
  states.clear();
  byBranch.clear();
  asked.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-merged-outside-')));
  const remote = path.join(tmp, 'remote.git');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'fee.txt'), 'fee = 500\n');
  commit(project, 'start');
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

const PR = (id: number) => ({ id, url: `https://code.example.test/pr/${id}`, repo: 'app', host: 'example' });

/** Accepted on the Full track, its pull request open on the code host and not merged yet. */
function openPr(id = 14, title = 'Book a room'): string {
  const t = actions.createTicket(bp, { title });
  updateTicket(bp, t.id, (x) => {
    x.stage = 'release';
    x.release = 'v0.1.0';
    x.live = false;
    x.squad = null;
    x.branch = `squad/${t.id.toLowerCase()}`;
    x.pr = PR(id);
    x.status = `PR ${id} is waiting in Example Repos · v0.1.0`;
  });
  return t.id;
}

/** Like AB-46: its pull request clashed with main, so it waits at the clash card, out of the release. */
function clashed(id = 14): string {
  const t = openPr(id);
  actions.pullRequestClashed(bp, t);
  return t;
}

/** Like MA-6: it needs `on`, and waits for it to merge. */
function waitsFor(on: string): string {
  const t = actions.createTicket(bp, { title: 'Show the booked rooms' });
  updateTicket(bp, t.id, (x) => {
    x.stage = 'specs';
    x.dependsOn = [on];
    x.dependency = { on: [on], way: 'wait', by: 'Momen', at: new Date().toISOString() };
    x.status = `Waits for ${on} to merge · starts by itself`;
    x.live = false;
    x.squad = null;
  });
  return t.id;
}

describe('Check again', () => {
  it('on the waiting story: the pull request it waits for was merged outside, so both move on', async () => {
    const ab = clashed();
    const stuck = readTicket(bp, ab)!;
    expect(stuck.stuck?.gate).toBe('merge');
    expect(stuck.pr).toBeUndefined();
    expect(stuck.clashedPr).toEqual(PR(14));
    const ma = waitsFor(ab);
    // The person settled the clash on the code host and merged it there.
    states.set(14, 'merged');
    const r = await checkMerge(bp, ma);
    expect(r.found).toBe('merged');
    expect(r.merged).toEqual([ab]);
    expect(r.line).toBe(`Pull request 14 was merged on Example Repos. squad-kit saw it and marked ${ab} as merged. ${ma} starts now, on the newest code.`);
    const t = readTicket(bp, ab)!;
    expect(t.mergedAt).toBeTruthy();
    expect(t.stage).toBe('release');
    expect(t.waiting).toBeNull();
    expect(t.stuck).toBeUndefined();
    expect(t.pr).toEqual(PR(14));
    expect(t.clashedPr).toBeUndefined();
    expect(t.status).toBe(`Merged into main · goes out in ${t.release}`);
    expect(t.activity[0]!.text).toBe('Pull request 14 was merged on Example Repos. squad-kit saw it and marked the story as merged');
    // Back in the release the clash took it out of.
    expect(listReleases(bp).find((x) => x.version === t.release)?.tickets).toContain(ab);
    const m = readTicket(bp, ma)!;
    expect(m.stage).toBe('implement');
    expect(m.squad?.phase).toBe('build');
    expect(m.dependency?.started).toBeTruthy();
  });

  it('on the stuck story itself: merged there, merged here', async () => {
    const ab = clashed();
    states.set(14, 'merged');
    const r = await checkMerge(bp, ab);
    expect(r).toMatchObject({ found: 'merged', line: `Pull request 14 was merged on Example Repos. squad-kit saw it and marked ${ab} as merged.`, merged: [ab] });
    expect(r.ticket.mergedAt).toBeTruthy();
    // Asked again, nothing more happens.
    asked.length = 0;
    expect((await checkMerge(bp, ab)).line).toBe(`${ab} is merged already.`);
    expect(asked).toEqual([]);
  });

  it('still open: nothing changes, and it says so', async () => {
    const ab = clashed();
    const ma = waitsFor(ab);
    const before = readTicket(bp, ab)!;
    states.set(14, 'clash');
    expect((await checkMerge(bp, ab)).line).toBe('Pull request 14 still clashes with main on Example Repos. Settle the clash there and merge it, or pick a way out on the card.');
    const pr = openPr(15);
    states.set(15, 'waiting');
    const r = await checkMerge(bp, pr);
    expect(r).toMatchObject({ found: 'open', line: 'Pull request 15 is still open on Example Repos, not merged yet. Nothing changed.', merged: [] });
    expect(readTicket(bp, ab)).toEqual(before);
    expect(readTicket(bp, pr)!.mergedAt).toBeUndefined();
    expect((await checkMerge(bp, ma)).found).toBe('clash');
    expect(readTicket(bp, ma)!.squad).toBeNull();
  });

  it('closed without merging: one plain line, said once, and nothing else changes', async () => {
    const ab = clashed();
    states.set(14, 'closed');
    const r = await checkMerge(bp, ab);
    expect(r.found).toBe('closed');
    const line = 'Pull request 14 was closed on Example Repos without merging, so it is not in main. squad-kit changed nothing else: open the pull request again there to go on';
    expect(r.line).toBe(`${line}.`);
    const t = readTicket(bp, ab)!;
    expect(t.activity[0]!.text).toBe(line);
    expect(t.stuck?.gate).toBe('merge');
    expect(t.mergedAt).toBeUndefined();
    await checkMerge(bp, ab);
    expect(readTicket(bp, ab)!.activity.filter((a) => a.text === line)).toHaveLength(1);
  });

  it('on a story with nothing to ask about says so plainly', async () => {
    const t = actions.createTicket(bp, { title: 'Nothing yet' });
    await expect(checkMerge(bp, t.id)).rejects.toThrow(`${t.id} has no pull request waiting and waits for no other story, so there is nothing to check.`);
  });

  it('is one call on the board and one command in the terminal', async () => {
    const ab = clashed();
    const app = new Hono();
    mountDependsApi(app, { paths: buildPaths(project) });
    states.set(14, 'waiting');
    let res = await app.request(`/api/v1/tickets/${ab}/check-merge`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { found: string }).found).toBe('open');
    chooseProject(project);
    const said: string[] = [];
    const quiet = [
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => (said.push(String(s)), true)),
      vi.spyOn(process.stderr, 'write').mockImplementation((s) => (said.push(String(s)), true)),
    ];
    try {
      states.set(14, 'merged');
      await runCheckMerge(ab);
    } finally {
      quiet.forEach((q) => q.mockRestore());
    }
    expect(said.join('')).toContain('Pull request 14 was merged on Example Repos.');
    expect(readTicket(bp, ab)!.mergedAt).toBeTruthy();
    res = await app.request('/api/v1/tickets/NOPE-1/check-merge', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('the quiet look by itself', () => {
  it('finds a merge done outside squad-kit, and frees what waits for it on the squad’s turn', async () => {
    const pr = openPr(15);
    const ab = clashed(14);
    states.set(14, 'merged');
    states.set(15, 'merged');
    const r = await lookOutside(bp);
    expect(r).toEqual({ asked: 2, merged: [pr, ab] });
    expect(readTicket(bp, pr)!.activity[0]!.text).toBe('Pull request 15 was merged on Example Repos. squad-kit saw it and marked the story as merged');
    expect(readTicket(bp, ab)!.mergedAt).toBeTruthy();
    // Nothing open any more: nothing is asked.
    asked.length = 0;
    expect(await lookOutside(bp)).toEqual({ asked: 0, merged: [] });
    expect(asked).toEqual([]);
  });

  it('makes no call when squad-kit has no pull request open', async () => {
    actions.createTicket(bp, { title: 'Being built' });
    const merged = openPr(16);
    updateTicket(bp, merged, (x) => (x.mergedAt = new Date().toISOString()));
    expect(await lookOutside(bp)).toEqual({ asked: 0, merged: [] });
    expect(asked).toEqual([]);
  });

  it('adds no line when nothing changed, and says a closed one once', async () => {
    const pr = openPr(15);
    const ab = clashed(14);
    states.set(15, 'waiting');
    states.set(14, 'clash');
    const before = [readTicket(bp, pr)!, readTicket(bp, ab)!];
    expect((await lookOutside(bp)).asked).toBe(2);
    expect([readTicket(bp, pr), readTicket(bp, ab)]).toEqual(before);
    states.set(15, 'closed');
    await lookOutside(bp);
    expect(readTicket(bp, pr)!.activity[0]!.text).toMatch(/^Pull request 15 was closed on Example Repos without merging/);
    expect(readTicket(bp, pr)!.stage).toBe('release');
    // Closed: not asked about by itself again.
    asked.length = 0;
    await lookOutside(bp);
    expect(asked).toEqual(['state 14']);
  });

  it('finds the pull request of a clash card from before it was kept, by its branch, once', async () => {
    const ab = clashed(14);
    // A board from 1.3.2: the clash card has no pull request on it.
    updateTicket(bp, ab, (x) => delete x.clashedPr);
    byBranch.set(readTicket(bp, ab)!.branch!, { id: 14, url: 'https://code.example.test/pr/14' });
    states.set(14, 'waiting');
    await lookOutside(bp);
    expect(asked).toEqual([`find squad/${ab.toLowerCase()}`, 'state 14']);
    expect(readTicket(bp, ab)!.clashedPr?.id).toBe(14);
    asked.length = 0;
    states.set(14, 'merged');
    expect((await lookOutside(bp)).merged).toEqual([ab]);
    expect(asked).toEqual(['state 14']);
  });

  it('leaves a story of someone else to their own squad', async () => {
    const pr = openPr(15);
    updateTicket(bp, pr, (x) => (x.owner = 'Sara'));
    states.set(15, 'merged');
    expect(await lookOutside(bp)).toEqual({ asked: 0, merged: [] });
  });

  it('comes a few seconds after the board opens, then waits a few minutes', async () => {
    openPr(15);
    const start = Date.now();
    lookOutsideBeside(bp, start);
    lookOutsideBeside(bp, start + 1000);
    expect(asked).toEqual([]);
    lookOutsideBeside(bp, start + FIRST_LOOK_MS);
    for (let i = 0; i < 100 && !asked.length; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual(['state 15']);
    await new Promise((r) => setTimeout(r, 50));
    lookOutsideBeside(bp, Date.now() + 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual(['state 15']);
  });
});

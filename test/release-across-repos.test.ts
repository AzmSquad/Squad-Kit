import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, readMeta, readRelease, readTicket, writeMeta, writeTicket } from '../src/board/store.js';
import type { Ticket } from '../src/board/types.js';
import * as actions from '../src/board/actions.js';
import { copyViews, repoOrder, repoReliesOn, storyCopyDir } from '../src/engine/copies.js';
import { addWorktree, mergeWouldClash } from '../src/engine/git.js';

/**
 * One story, accepted and released across the parts of a product, with real git and real bare remotes: every merge is tried
 * before any moves, what others rely on goes out first, and a part that fails to go out holds back what relies on it.
 */

let root: string;
let bp: ReturnType<typeof boardPaths>;
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = 'git -c user.name=t -c user.email=t@t commit -q';
const dirOf = (r: string) => path.join(root, r);
const bareOf = (r: string) => path.join(root, `${r}.git`);
const onRemote = (r: string, what = 'main') => sh(`git rev-parse --verify -q ${what} || true`, bareOf(r));
const get = () => readTicket(bp, 'AP-1')!;

function repo(name: string): void {
  const dir = dirOf(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  sh(`git init -q -b main && git add -A && ${commit} -m start`, dir);
  sh(`git init -q --bare -b main "${bareOf(name)}"`);
  sh(`git remote add origin "${bareOf(name)}" && git -c core.hooksPath=/dev/null push -q origin main`, dir);
}

function refusePushes(name: string): void {
  const hook = path.join(bareOf(name), 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "refused for the test" >&2\nexit 1\n', { mode: 0o755 });
}
const takePushes = (name: string) => fs.rmSync(path.join(bareOf(name), 'hooks', 'pre-receive'), { force: true });

/** A story at Looks right, with work in both copies, in its folder. */
function story(more: Partial<Ticket> = {}): Ticket {
  const copies = ['api', 'web'].map((r) => addWorktree(dirOf(r), 'AP-1', 'main', undefined, storyCopyDir(root, 'AP-1', r)));
  fs.writeFileSync(path.join(copies[0]!.dir, 'route.js'), 'route\n');
  fs.writeFileSync(path.join(copies[1]!.dir, 'page.js'), 'page\n');
  const t = {
    id: 'AP-1',
    title: 'Sale price',
    ask: 'Show the sale price',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'review',
    status: '',
    waiting: { kind: 'proof', summary: 'The proof is ready' },
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    owner: 'Momen',
    activity: [],
    repo: 'web',
    parts: ['web', 'api'],
    storyDir: path.dirname(copies[0]!.dir),
    worktree: copies[1]!.dir,
    branch: copies[1]!.branch,
    baseCommit: copies[1]!.baseCommit,
    copies: [{ repo: 'api', dir: copies[0]!.dir, baseCommit: copies[0]!.baseCommit }],
    gates: { checks: 'pass', review: 'pass', proof: 'pass' },
    releaseNote: '**Sale.** Shown.',
    story: 'As a customer, I see the sale price.',
    criteria: [{ given: 'a', when: 'b', then: 'c' }],
    ...more,
  } as unknown as Ticket;
  writeTicket(bp, t);
  return t;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-across-')));
  for (const r of ['api', 'web', 'other']) repo(r);
  bp = boardPaths(path.join(root, '.squad'));
  writeMeta(bp, {
    project: 'Shop',
    key: 'AP',
    nextNumber: 2,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    repos: ['api', 'web', 'other'].map((r) => ({ path: r, base: 'main', remote: 'origin', commands: {} })),
    parts: [
      { id: 'api', name: 'API', repo: 'api', needs: [] },
      { id: 'web', name: 'Web app', repo: 'web', needs: ['api'] },
      { id: 'other', name: 'Other app', repo: 'other', needs: [] },
    ],
    scan: { status: 'done', empty: false },
  } as never);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the order', () => {
  it('what the others rely on goes first, whatever order the story named them in', () => {
    const t = story();
    expect(copyViews(readMeta(bp), t).map((v) => v.repo)).toEqual(['api', 'web']);
    expect(repoOrder(readMeta(bp)).indexOf('api')).toBeLessThan(repoOrder(readMeta(bp)).indexOf('web'));
    expect(repoReliesOn(readMeta(bp), 'web', 'api')).toBe(true);
    expect(repoReliesOn(readMeta(bp), 'api', 'web')).toBe(false);
    expect(repoReliesOn(readMeta(bp), 'other', 'api')).toBe(false);
  });

  it('a story with one copy is its own view', () => {
    const t = { id: 'AP-2', repo: 'api', worktree: '/x' } as Ticket;
    expect(copyViews(readMeta(bp), t)).toEqual([t]);
  });
});

describe('Looks right', () => {
  it('saves and merges every part, and only then is the story merged', () => {
    story();
    actions.approve(bp, 'AP-1');
    expect(sh('git ls-tree --name-only main', dirOf('api'))).toContain('route.js');
    expect(sh('git ls-tree --name-only main', dirOf('web'))).toContain('page.js');
    expect(get().mergedAt).toBeTruthy();
    expect(get().stage).toBe('release');
  });

  it('a clash in any part moves nothing in any of them, and says which, on one card', () => {
    const t = story();
    const web = dirOf('web');
    fs.writeFileSync(path.join(web, 'page.js'), 'theirs\n');
    sh(`git add -A && ${commit} -m theirs`, web);
    const before = { api: sh('git rev-parse main', dirOf('api')), web: sh('git rev-parse main', web) };
    expect(mergeWouldClash(dirOf('api'), 'main', t.branch!)).toBe(false);
    actions.approve(bp, 'AP-1');
    expect(sh('git rev-parse main', dirOf('api'))).toBe(before.api);
    expect(sh('git rev-parse main', web)).toBe(before.web);
    expect(get().mergedAt).toBeUndefined();
    expect(JSON.stringify(get().stuck)).toContain('Web app');
  });

  it('a merge already in is skipped, so Try again finishes what a race cut off', () => {
    const t = story();
    actions.approve(bp, 'AP-1');
    const api = sh('git rev-parse main', dirOf('api'));
    writeTicket(bp, { ...t, ...get(), mergedAt: undefined, stage: 'review', waiting: { kind: 'proof', summary: 'x' } } as never);
    actions.approve(bp, 'AP-1');
    expect(sh('git rev-parse main', dirOf('api'))).toBe(api);
    expect(get().mergedAt).toBeTruthy();
  });

  it("the project's own check refusing in one part stops all of it", async () => {
    story();
    const hooks = path.join(dirOf('web'), '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "no" >&2\nexit 1\n', { mode: 0o755 });
    const before = sh('git rev-parse main', dirOf('api'));
    await actions.approveBeside(bp, 'AP-1').catch(() => undefined);
    expect(sh('git rev-parse main', dirOf('api'))).toBe(before);
    expect(get().mergedAt).toBeUndefined();
  });
});

describe('the release', () => {
  const accepted = async () => {
    story();
    actions.approve(bp, 'AP-1');
    return readTicket(bp, 'AP-1')!.release!;
  };

  it('both go out, the story closes, and its copies and folder go', async () => {
    const version = await accepted();
    const folder = get().storyDir!;
    const rel = await actions.releaseVersion(bp, version);
    expect(rel.unpushed).toBeUndefined();
    expect(sh('git ls-tree --name-only main', bareOf('api'))).toContain('route.js');
    expect(sh('git ls-tree --name-only main', bareOf('web'))).toContain('page.js');
    expect(get().stage).toBe('done');
    expect(fs.existsSync(folder)).toBe(false);
    const said = (rel.log ?? []).map((l) => l.text);
    expect(said.findIndex((l) => l.startsWith('api:'))).toBeLessThan(said.findIndex((l) => l.startsWith('web:')));
  });

  it('the API refused: the web app is not pushed, says why, and Push again sends both, in order', async () => {
    const version = await accepted();
    refusePushes('api');
    const webBefore = onRemote('web');
    const rel = await actions.releaseVersion(bp, version);
    expect(rel.unpushed?.map((u) => u.repo)).toEqual(['api', 'web']);
    expect(rel.unpushed?.[1]?.plain).toBe('Web app did not go out yet: it goes after API.');
    expect(onRemote('web')).toBe(webBefore);
    expect(get().stage).not.toBe('done');
    // Still refused: the web app does not go.
    const again = await actions.pushReleaseAgain(bp, version);
    expect(again.unpushed?.map((u) => u.repo)).toEqual(['api', 'web']);
    expect(onRemote('web')).toBe(webBefore);
    takePushes('api');
    const last = await actions.pushReleaseAgain(bp, version);
    expect(last.unpushed ?? []).toEqual([]);
    expect(sh('git ls-tree --name-only main', bareOf('web'))).toContain('page.js');
    expect(get().stage).toBe('done');
  });

  it('the web app refused after the API went: the release stays open, and Push again finishes it', async () => {
    const version = await accepted();
    refusePushes('web');
    const rel = await actions.releaseVersion(bp, version);
    expect(rel.unpushed?.map((u) => u.repo)).toEqual(['web']);
    expect(sh('git ls-tree --name-only main', bareOf('api'))).toContain('route.js');
    expect(get().stage).not.toBe('done');
    takePushes('web');
    expect((await actions.pushReleaseAgain(bp, version)).unpushed ?? []).toEqual([]);
    expect(get().stage).toBe('done');
  });

  it('a part nothing relies on never holds back another product in the folder', async () => {
    const dir = addWorktree(dirOf('other'), 'AP-2', 'main');
    fs.writeFileSync(path.join(dir.dir, 'x.txt'), 'x\n');
    writeTicket(bp, { ...story(), id: 'AP-2', repo: 'other', parts: ['other'], storyDir: undefined, copies: undefined, worktree: dir.dir, branch: dir.branch, baseCommit: dir.baseCommit } as never);
    actions.approve(bp, 'AP-2');
    actions.approve(bp, 'AP-1');
    refusePushes('other');
    const rel = await actions.releaseVersion(bp, readTicket(bp, 'AP-1')!.release!);
    expect(rel.unpushed?.map((u) => u.repo)).toEqual(['other']);
    expect(sh('git ls-tree --name-only main', bareOf('web'))).toContain('page.js');
  });

  it('a merge that would clash is found before anything goes out, in any part', async () => {
    const t = story();
    const start = sh('git rev-parse main', dirOf('web'));
    actions.approve(bp, 'AP-1');
    const version = get().release!;
    // The web app's merge did not hold, and someone changed the same file since.
    const web = dirOf('web');
    sh(`git reset -q --hard ${start}`, web);
    fs.writeFileSync(path.join(web, 'page.js'), 'theirs\n');
    sh(`git add -A && ${commit} -m theirs`, web);
    writeTicket(bp, { ...t, ...get(), mergedAt: undefined } as never);
    const apiBefore = onRemote('api');
    const webBefore = onRemote('web');
    await actions.releaseVersion(bp, version).catch(() => undefined);
    expect(onRemote('api')).toBe(apiBefore);
    expect(onRemote('web')).toBe(webBefore);
    expect(readRelease(bp, version)?.status).not.toBe('released');
  });
});

describe('pushing to a branch', () => {
  beforeEach(() => {
    writeMeta(bp, { ...readMeta(bp), delivery: 'push' });
  });

  it('one plain commit with the story id first, and no squad branch on the remote', async () => {
    const t = story();
    fs.writeFileSync(path.join(t.worktree!, 'second.js'), 'more\n');
    sh(`git add -A && ${commit} -m "work so far"`, t.worktree!);
    actions.approve(bp, 'AP-1');
    const web = dirOf('web');
    expect(sh('git log -1 --format=%s main', web)).toBe('AP-1: Sale price');
    expect(sh('git log -1 --format=%P main', web).split(' ')).toHaveLength(1);
    expect(sh('git log --format=%s main', web)).not.toContain('work so far');
    await actions.releaseVersion(bp, get().release!);
    expect(sh('git log --format=%s main', bareOf('web'))).not.toContain('work so far');
    expect(sh('git branch --list "squad/*"', bareOf('web'))).toBe('');
  });

  it('a second try adds nothing', () => {
    const t = story();
    actions.approve(bp, 'AP-1');
    const count = sh('git rev-list --count main', dirOf('web'));
    writeTicket(bp, { ...t, ...get(), mergedAt: undefined, stage: 'review', waiting: { kind: 'proof', summary: 'x' } } as never);
    actions.approve(bp, 'AP-1');
    expect(sh('git rev-list --count main', dirOf('web'))).toBe(count);
  });
});

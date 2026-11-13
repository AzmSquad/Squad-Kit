import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { boardPaths, writeMeta } from '../src/board/store.js';
import { bringCopyUpToDate, contributeChecklist, ideaPage, makeMyCopy } from '../src/engine/contribution/checklist.js';
import { mountContributionApi } from '../src/console/api/contribution.js';
import { buildPaths } from '../src/core/paths.js';
import { fakeGh, fakeGitHub, repoJson, type Call, type FakeGitHub } from './support/fake-github.js';

/**
 * The contribution checklist of squad-kit's own code, for people with no git background (ADR-008): signed in, a copy
 * of their own, up to date with the main repo, the rules, and a big idea told to the maintainers first. squad-kit makes
 * the copy and brings it up to date itself, only ever forward. GitHub's REST is made up; git pushes to a folder.
 */

let tmp = '';
let project: string;
let remote: string;
let gh: FakeGitHub | undefined;
let undo: (() => void)[] = [];
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const route = (c: Call, method: string, p: string) => c.method === method && c.path.split('?')[0] === p;
const SELF = { name: 'squad-kit', bin: { squad: './dist/cli.js' }, repository: { type: 'git', url: 'https://github.com/AzmSquad/squad-kit' } };

/** squad-kit's own code, cloned from `origin` (which git reaches in a folder), with the rules' files. */
function clone(origin: string, pkg: object = SELF) {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-contribute-')));
  remote = path.join(tmp, 'remote.git');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  project = path.join(tmp, 'squad-kit');
  fs.mkdirSync(path.join(project, 'test/architecture'), { recursive: true });
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(project, 'test/architecture/file-size-caps.json'), JSON.stringify({ 'src/cli.ts': 900, 'src/board/types.ts': 1301 }));
  fs.writeFileSync(path.join(project, 'test/architecture/rest-commands.json'), JSON.stringify({ commands: { a: 'squad a', b: 'squad b', c: 'squad c' } }));
  sh('git add -A && git commit -qm start', project);
  sh(`git remote add origin ${origin} && git config url.${remote}.insteadOf ${origin} && git push -q origin main`, project);
  const bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'squad-kit',
    key: 'SK',
    nextNumber: 1,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Sara', role: 'Contributor' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
  return bp;
}

afterEach(() => {
  gh?.done();
  gh = undefined;
  for (const u of undo.reverse()) u();
  undo = [];
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the contribution checklist', () => {
  it('not signed in: the steps first, the rest waits for it, the rules and the idea are there anyway', async () => {
    undo.push(fakeGh('missing'));
    const bp = clone('https://github.com/AzmSquad/squad-kit.git');
    const c = await contributeChecklist(bp);
    expect(c).toMatchObject({ self: true, host: 'GitHub', main: 'AzmSquad/squad-kit', line: 'Sign in to GitHub, and squad-kit can do the rest of this list for you.' });
    expect(c.items.map((i) => [i.id, i.state])).toEqual([
      ['sign-in', 'todo'],
      ['copy', 'blocked'],
      ['up-to-date', 'blocked'],
      ['rules', 'info'],
      ['idea', 'info'],
    ]);
    expect(c.items[0]!.steps![0]).toMatch(/Install GitHub's tool/);
    expect(c.items[3]!.points).toEqual([
      'Small files: a source file stays under 600 lines; the 2 older big files may only shrink (test/architecture/file-size-caps.json).',
      'The layers: the board talks to the engine over REST only, and outside tools are modules (test/architecture/layers.test.ts, test/module-boundaries.test.ts).',
      'Every button has its terminal command: 3 board actions, each one REST call and one squad command (test/architecture/rest-commands.json).',
      'The npm package stays under 6 MB (pnpm size:guard).',
    ]);
    expect(c.items[3]!.file).toBe(path.join(project, 'CONTRIBUTING.md'));
  });

  it("cloned the main repo itself, with no right to push: Make my copy makes the fork, then origin is the copy and upstream the main repo", async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/AzmSquad/squad-kit.git');
    let made = false;
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/user')) return { body: { login: 'sara' } };
      if (route(c, 'GET', '/repos/AzmSquad/squad-kit')) return { body: repoJson('AzmSquad/squad-kit', { push: false }) };
      if (route(c, 'POST', '/repos/AzmSquad/squad-kit/forks')) {
        made = true;
        return { status: 202, body: repoJson('sara/squad-kit', { fork: 'AzmSquad/squad-kit' }) };
      }
      if (made && route(c, 'GET', '/repos/sara/squad-kit')) return { body: repoJson('sara/squad-kit', { fork: 'AzmSquad/squad-kit' }) };
      if (made && route(c, 'GET', '/repos/sara/squad-kit/branches/main')) return { body: { name: 'main' } };
      if (route(c, 'GET', '/repos/AzmSquad/squad-kit/compare/main...sara:main')) return { body: { ahead_by: 0, behind_by: 0 } };
      return undefined;
    });
    const before = await contributeChecklist(bp);
    expect(before.items.map((i) => [i.id, i.state, i.action?.command ?? null])).toEqual([
      ['sign-in', 'done', null],
      ['copy', 'todo', 'squad contribute --fork'],
      ['up-to-date', 'blocked', null],
      ['rules', 'info', null],
      ['idea', 'info', 'squad contribute --idea <title> --text <words>'],
    ]);
    expect(before.items[0]!.line).toBe('Signed in as sara.');
    const head = sh('git rev-parse HEAD', project);
    const r = await makeMyCopy(bp);
    expect(r.line).toBe('Made your own copy, sara/squad-kit. origin is your copy now, and upstream is AzmSquad/squad-kit.');
    expect(sh('git config --get remote.origin.url', project)).toBe('https://github.com/sara/squad-kit.git');
    expect(sh('git config --get remote.upstream.url', project)).toBe('https://github.com/AzmSquad/squad-kit.git');
    // Nothing of the history changed.
    expect(sh('git rev-parse HEAD', project)).toBe(head);
    expect(r.checklist.items.find((i) => i.id === 'copy')).toMatchObject({ state: 'done', line: 'sara/squad-kit, a copy of AzmSquad/squad-kit. Your stories go to AzmSquad/squad-kit as pull requests from it.' });
    expect(r.checklist.items.find((i) => i.id === 'up-to-date')).toMatchObject({ state: 'done' });
    await expect(makeMyCopy(bp)).rejects.toThrow('sara/squad-kit is your own copy already, of AzmSquad/squad-kit.');
  });

  it('a copy behind the main repo: Bring it up to date syncs it on GitHub, then main here moves forward', async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/sara/squad-kit.git');
    // The copy on GitHub took the main repo's newest (what GitHub's sync does): it is in the folder git pushes to.
    sh(`git clone -q ${remote} other && cd other && echo new > news.txt && git add -A && git commit -qm news && git push -q origin main`, tmp);
    let synced = false;
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/user')) return { body: { login: 'sara' } };
      if (route(c, 'GET', '/repos/sara/squad-kit')) return { body: repoJson('sara/squad-kit', { fork: 'AzmSquad/squad-kit' }) };
      if (route(c, 'GET', '/repos/AzmSquad/squad-kit/compare/main...sara:main')) return { body: { ahead_by: 0, behind_by: synced ? 0 : 1 } };
      if (route(c, 'POST', '/repos/sara/squad-kit/merge-upstream')) {
        synced = true;
        return { body: { merge_type: 'fast-forward' } };
      }
      return undefined;
    });
    const c = await contributeChecklist(bp);
    expect(c.items.find((i) => i.id === 'up-to-date')).toMatchObject({ state: 'todo', line: 'Your copy is one change behind AzmSquad/squad-kit. Bring it up to date before your next story, so it starts from the newest code.', action: { command: 'squad contribute --sync' } });
    const app = new Hono();
    mountContributionApi(app, { paths: buildPaths(project) });
    const res = await app.request('/api/v1/contribute/sync', { method: 'POST' });
    const r = (await res.json()) as { line: string };
    expect(res.status).toBe(200);
    expect(r.line).toBe('Your copy sara/squad-kit took one change from AzmSquad/squad-kit, and main on this computer moved forward to it.');
    expect(fs.readFileSync(path.join(project, 'news.txt'), 'utf8')).toBe('new\n');
  });

  it('main here with changes of its own: nothing is forced, and it says why', async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/sara/squad-kit.git');
    sh('echo mine > mine.txt && git add -A && git commit -qm mine', project);
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/repos/sara/squad-kit')) return { body: repoJson('sara/squad-kit', { fork: 'AzmSquad/squad-kit' }) };
      if (route(c, 'GET', '/repos/AzmSquad/squad-kit/compare/main...sara:main')) return { body: { ahead_by: 0, behind_by: 0 } };
      return undefined;
    });
    const remoteTip = sh('git rev-parse main', remote);
    sh(`git clone -q ${remote} other && cd other && echo theirs > t.txt && git add -A && git commit -qm theirs && git push -q origin main`, tmp);
    await expect(bringCopyUpToDate(bp)).rejects.toThrow('main on this computer has changes that your copy on the code host does not have, so squad-kit leaves it as it is. Nothing was changed.');
    expect(sh('git log -1 --format=%s', project)).toBe('mine');
    expect(remoteTip).not.toBe('');
  });

  it('a copy with changes of its own on GitHub: refused, never forced', async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/sara/squad-kit.git');
    gh = fakeGitHub((c) => {
      if (route(c, 'GET', '/user')) return { body: { login: 'sara' } };
      if (route(c, 'GET', '/repos/sara/squad-kit')) return { body: repoJson('sara/squad-kit', { fork: 'AzmSquad/squad-kit' }) };
      if (route(c, 'GET', '/repos/AzmSquad/squad-kit/compare/main...sara:main')) return { body: { ahead_by: 2, behind_by: 3 } };
      return undefined;
    });
    expect((await contributeChecklist(bp)).items.find((i) => i.id === 'up-to-date')).toMatchObject({ state: 'blocked' });
    await expect(bringCopyUpToDate(bp)).rejects.toThrow('main of your copy sara/squad-kit has 2 changes that AzmSquad/squad-kit does not have. squad-kit never forces it');
    expect(gh.sent('POST', '/repos/sara/squad-kit/merge-upstream')).toHaveLength(0);
  });

  it('a big idea: the new issue page on the main repo, filled in; squad-kit posts nothing', async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/sara/squad-kit.git');
    gh = fakeGitHub(() => undefined);
    expect(ideaPage(bp, 'A design studio', 'Draw the screens first.')).toEqual({ link: 'https://github.com/AzmSquad/squad-kit/issues/new?title=A+design+studio&body=Draw+the+screens+first.', cut: false });
    // A long idea: the page has its start, and the whole text comes back to paste in.
    const long = 'Every screen drawn first. '.repeat(400);
    const big = ideaPage(bp, 'A design studio', long);
    expect(big).toMatchObject({ cut: true, rest: long.trim() });
    expect(big.link.length).toBeLessThanOrEqual(6000);
    expect(() => ideaPage(bp, ' ', 'x')).toThrow('Give your idea a short title.');
    expect(gh.calls).toEqual([]);
    const app = new Hono();
    mountContributionApi(app, { paths: buildPaths(project) });
    const r = (await (await app.request('/api/v1/contribute/idea', { method: 'POST', body: JSON.stringify({ title: 'Jira', text: 'Pull stories from Jira' }), headers: { 'content-type': 'application/json' } })).json()) as { link: string };
    expect(r).toEqual({ link: 'https://github.com/AzmSquad/squad-kit/issues/new?title=Jira&body=Pull+stories+from+Jira', cut: false });
  });

  it('any other project has no checklist', async () => {
    undo.push(fakeGh('ready'));
    const bp = clone('https://github.com/sara/shop.git', { name: 'shop' });
    expect(await contributeChecklist(bp)).toEqual({ self: false, line: "This project is not squad-kit's own code, so it has no contribution checklist.", items: [], ready: false, left: 0 });
  });
});

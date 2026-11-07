import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readMeta, readTicket, updateTicket, writeMeta, writeTicket, type BoardPaths } from '../src/board/store.js';
import * as actions from '../src/board/actions.js';
import { setupView } from '../src/board/first-run.js';
import type { Ticket } from '../src/board/types.js';
import { firstLook } from '../src/engine/first-look.js';
import { addWorktree } from '../src/engine/git.js';
import { pushHandOver } from '../src/engine/handover.js';
import { commitTicketDocs, docsRepo, leaveProjectFiles, stageProjectFiles, stageTicketDocs } from '../src/engine/project-git.js';
import { findNestedRepos, workspaceRepos } from '../src/engine/repos.js';
import { prepareProject } from '../src/engine/setup.js';

/**
 * A workspace whose root is itself a git repo, holding code repos with their own git: tools and notes at the root,
 * the code one level down. Stories work in the code repos, and squad-kit's own files never enter their history. A
 * project with its own code at the root stays one project, whatever sits inside it.
 */

let tmp: string;
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (file: string, text = 'x\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const commit = (dir: string, branch = 'main') => sh(`git init -q -b ${branch} && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first`, dir);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-rootrepo-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The shape: a root repo with tools and notes that ignores two code repos, each on its own branch. */
function workspace(name = 'portal'): string {
  const root = path.join(tmp, name);
  put(path.join(root, 'api', 'Program.cs'));
  put(path.join(root, 'web', 'src', 'app.ts'));
  commit(path.join(root, 'api'), 'development');
  commit(path.join(root, 'web'), 'development');
  put(path.join(root, '.gitignore'), 'api/\nweb/\n');
  put(path.join(root, 'NOTES.md'));
  put(path.join(root, '.tools', 'gate.cjs'));
  put(path.join(root, '.tools', 'report.js'));
  put(path.join(root, 'notes', 'review.md'));
  commit(root);
  return root;
}

/** A normal project: its own code at the root, and a repo that merely sits inside it. */
function oneRepoWithSubRepo(gitignore: string): string {
  const root = path.join(tmp, 'shop');
  put(path.join(root, 'package.json'), '{"name":"shop"}\n');
  put(path.join(root, 'src', 'index.ts'));
  put(path.join(root, 'test', 'index.test.ts'));
  put(path.join(root, 'lib', 'sub', 'index.js'));
  if (gitignore) put(path.join(root, '.gitignore'), gitignore);
  sh('git init -q -b main && git add -A -- package.json src test .gitignore 2>/dev/null || git add -A -- package.json src test', root);
  sh('git -c user.name=t -c user.email=t@t commit -q -m first', root);
  commit(path.join(root, 'lib'));
  return root;
}

/** The board as the first read leaves it in such a workspace, and a story being built in one code repo. */
function storyIn(root: string, repo: string): { bp: BoardPaths; t: Ticket } {
  const { bp } = prepareProject(root);
  writeMeta(bp, { ...readMeta(bp), repos: findNestedRepos(root), scan: { status: 'done', summary: 'A workspace.' } });
  const wt = addWorktree(path.join(root, repo), 'TQ-1', 'development');
  const t: Ticket = {
    id: 'TQ-1',
    title: 'Evaluation tab',
    ask: 'Show the first evaluation',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: 'Building',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    owner: readMeta(bp).user.name,
    activity: [],
    story: 'As a judge, I see the first evaluation.',
    criteria: [{ given: 'a case', when: 'I open it', then: 'I see the tab' }],
    specApproved: { by: 'Momen', at: new Date().toISOString() },
    repo,
    worktree: wt.dir,
    branch: wt.branch,
    baseCommit: wt.baseCommit,
  };
  writeTicket(bp, t);
  return { bp, t };
}

const squadFilesIn = (repo: string, ref: string) => sh(`git log --format=%s ${ref} -- .squad`, repo);

describe("squad-kit's own files and the code repos of a workspace with a root repo", () => {
  it('a big moment commits nothing in the code repo, and leaves its copy clean', () => {
    const root = workspace();
    const { bp, t } = storyIn(root, 'api');
    expect(docsRepo(bp)).toBeNull();
    expect(commitTicketDocs(bp, t, 'spec and design approved')).toBeNull();
    expect(stageTicketDocs(bp, t)).toEqual([]);
    expect(stageProjectFiles(bp, t, 'development')).toEqual([]);
    expect(leaveProjectFiles(bp, t, 'development')).toEqual([]);
    expect(squadFilesIn(path.join(root, 'api'), t.branch!)).toBe('');
    expect(fs.existsSync(path.join(t.worktree!, '.squad'))).toBe(false);
    expect(sh('git status --porcelain --untracked-files=all', t.worktree!)).toBe('');
  });

  it('Looks right and the release bring the code to the code repo, and no squad-kit file', async () => {
    const root = workspace();
    const { bp, t } = storyIn(root, 'api');
    const api = path.join(root, 'api');
    put(path.join(t.worktree!, 'Tab.cs'));
    updateTicket(bp, t.id, (x) => {
      x.stage = 'review';
      x.waiting = { kind: 'proof', summary: 'The proof is ready' };
      x.gates = { checks: 'pass', review: 'pass', proof: 'pass' };
      x.releaseNote = '**Tab.** The first evaluation.';
    });
    actions.approve(bp, t.id);
    expect(readTicket(bp, t.id)!.mergedAt).toBeTruthy();
    expect(sh('git ls-tree -r --name-only development', api).split('\n').sort()).toEqual(['Program.cs', 'Tab.cs']);

    await actions.releaseVersion(bp);
    expect(squadFilesIn(api, 'development')).toBe('');
    expect(sh('git ls-tree -r --name-only development', api)).not.toContain('.squad');
    // The other code repo and the root repo's history saw nothing either.
    expect(sh('git log --format=%s development', path.join(root, 'web'))).toBe('first');
    expect(sh('git log --format=%s main', root)).toBe('first');
  });

  it('hand over says plainly that the documents cannot travel, and pushes nothing', async () => {
    const root = workspace();
    const { bp, t } = storyIn(root, 'api');
    await expect(pushHandOver(bp, t)).rejects.toThrow("This project's documents sit outside its code repos");
    expect(squadFilesIn(path.join(root, 'api'), t.branch!)).toBe('');
  });

  it("the root repo still does not show .squad in git status, and keeps the person's own files as they are", () => {
    const root = workspace();
    prepareProject(root);
    expect(sh('git status --porcelain --untracked-files=all', root)).toBe('');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('api/\nweb/\n');
    expect(sh('git log --format=%s main', root)).toBe('first');
  });
});

describe('Add project and the setup say the same about a folder that is a repo with repos inside', () => {
  it('a root repo with tools and notes, and code repos inside: a workspace, from the first moment', () => {
    const root = workspace();
    expect(workspaceRepos(root).map((r) => [r.path, r.base])).toEqual([
      ['api', 'development'],
      ['web', 'development'],
    ]);
    expect(firstLook(root)).toMatchObject({ kind: 'repos', title: 'Several code folders', repos: ['api', 'web'] });
    const { bp, did } = prepareProject(root);
    expect(setupView(bp)?.kind).toBe('repos');
    expect(did.join('\n')).toContain('Git: found 2 code repos inside');
    expect(readMeta(bp).repos?.map((r) => r.path)).toEqual(['api', 'web']);
    expect(docsRepo(bp)).toBeNull();
  });

  it('small helper scripts beside the repos do not make the root a project of its own', () => {
    const root = workspace();
    put(path.join(root, 'scripts', 'pull.py'));
    put(path.join(root, 'tools', 'seed.mjs'));
    put(path.join(root, 'docs', 'site', 'index.html'));
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -q -m tools', root);
    expect(firstLook(root)).toMatchObject({ kind: 'repos', repos: ['api', 'web'] });
  });

  it('a root repo with no first commit stays as it is: its repos are not swept into a commit', () => {
    const root = path.join(tmp, 'fresh');
    put(path.join(root, 'api', 'Program.cs'));
    commit(path.join(root, 'api'), 'development');
    sh('git init -q -b main', root);
    expect(firstLook(root)).toMatchObject({ kind: 'repos', repos: ['api'] });
    const { bp } = prepareProject(root);
    expect(setupView(bp)?.kind).toBe('repos');
    expect(sh('git rev-parse --verify -q HEAD || echo none', root)).toBe('none');
  });

  it('a one-repo project with a repo inside that it ignores stays one project', () => {
    const root = oneRepoWithSubRepo('lib/\n');
    expect(workspaceRepos(root)).toEqual([]);
    expect(firstLook(root)).toMatchObject({ kind: 'repo', repos: [], language: 'TypeScript', branch: 'main' });
    const { bp, did } = prepareProject(root);
    expect(setupView(bp)?.kind).toBe('repo');
    expect(did.join('\n')).toContain('Git: found the repo, on main');
    expect(readMeta(bp).repos).toBeUndefined();
    // Its documents still go with its code, as in every one-repo project.
    expect(docsRepo(bp)).toBe(root);
  });

  it('a one-repo project with a repo inside that git has not been told about stays one project too', () => {
    const root = oneRepoWithSubRepo('');
    expect(workspaceRepos(root)).toEqual([]);
    expect(firstLook(root)).toMatchObject({ kind: 'repo', repos: [] });
    expect(setupView(prepareProject(root).bp)?.kind).toBe('repo');
  });

  it('code at the root that is not saved in git yet still counts as its own', () => {
    const root = workspace();
    put(path.join(root, 'main.go'));
    expect(workspaceRepos(root)).toEqual([]);
    expect(firstLook(root)).toMatchObject({ kind: 'repo', repos: [] });
  });

  it("a submodule or a repo the root tracks belongs to the root: it is no part of a workspace", () => {
    const lib = path.join(tmp, 'lib-source');
    put(path.join(lib, 'index.js'));
    commit(lib);
    const root = path.join(tmp, 'docs-site');
    put(path.join(root, 'README.md'));
    commit(root);
    sh(`git -c protocol.file.allow=always submodule --quiet add "${lib}" theme`, root);
    sh('git -c user.name=t -c user.email=t@t commit -q -m theme', root);
    // Git's own check for the .git file a submodule has: findNestedRepos sees it, the workspace rule does not.
    expect(findNestedRepos(root).map((r) => r.path)).toEqual(['theme']);
    expect(workspaceRepos(root)).toEqual([]);
    expect(firstLook(root)).toMatchObject({ kind: 'repo', repos: [] });
    expect(setupView(prepareProject(root).bp)?.kind).toBe('repo');
  });

  it('a linked copy of the root sitting inside it is not a code repo either', () => {
    const root = path.join(tmp, 'notes');
    put(path.join(root, 'README.md'));
    commit(root);
    sh('git worktree add -q -b other copy', root);
    expect(workspaceRepos(root)).toEqual([]);
  });

  it('a plain folder holding repos is a workspace as before, with loose files beside them', () => {
    const root = path.join(tmp, 'plain');
    put(path.join(root, 'api', 'index.js'));
    commit(path.join(root, 'api'));
    put(path.join(root, 'run-all.sh'));
    put(path.join(root, 'loose.py'));
    expect(workspaceRepos(root).map((r) => r.path)).toEqual(['api']);
    expect(firstLook(root)).toMatchObject({ kind: 'repos', repos: ['api'] });
  });

  it('a plain repo with nothing inside sees nothing new', () => {
    const root = path.join(tmp, 'plain-repo');
    put(path.join(root, 'index.ts'));
    commit(root);
    expect(workspaceRepos(root)).toEqual([]);
    expect(firstLook(root)).toMatchObject({ kind: 'repo', repos: [] });
    expect(docsRepo(prepareProject(root).bp)).toBe(root);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommitStopped, HookRefused, commitAll, commitChecked, settleCopy, stageAll } from '../src/engine/git.js';
import { addWorktree } from './support/copy.js';
import { buildGuard, guardSupport } from '../src/engine/project-guard.js';
import { squadHome } from '../src/core/home.js';

import { inGuard } from './support/in-guard.js';
/**
 * A commit's hooks run on a throwaway git folder, so the real one is read only to them, all of it. Real git, real hooks,
 * and on a Mac the real guard: every try at harm below has to be refused, and the real folder has to come out the same to
 * the byte. The fixtures sit under the worktree and not under the system temp, which the guard lets commands write in:
 * only there can a refusal show. Bubblewrap opens the temp folder again, so only a Mac can show the guarded parts here.
 */

vi.setConfig({ testTimeout: 60_000 });

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const guarded = () => process.platform === 'darwin' && guardSupport().on;
// git itself with nothing of squad-kit's around it, as a tool could reach it: it finds the real folder from the copy.
const REAL = 'env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_EXEC_PATH "$(git --exec-path)/git"';

let base: string;
let scratch: string;
let homeWas: string | undefined;
let ceilingWas: string | undefined;
let project: string;
let copy: string;
let common: string;
let own: string;

const sh = (cmd: string, cwd = copy) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const guardOf = (dir: string) => buildGuard({ cwd: dir, root: project, home: path.join(base, 'home'), platform: process.platform });
const how = (dir = copy) => (guarded() ? { guard: guardOf(dir) } : {});
const out = (name = 'out') => path.join(scratch, name);
const said = (name = 'out') => (fs.existsSync(out(name)) ? fs.readFileSync(out(name), 'utf8') : '');
const leftovers = () => (fs.existsSync(path.join(squadHome(), 'hook-git')) ? fs.readdirSync(path.join(squadHome(), 'hook-git')) : []);
const isThere = (sha: string, dir = project) => spawnSync('git', ['cat-file', '-e', sha], { cwd: dir }).status === 0;

function hook(name: string, body: string, dir = path.join(common, 'hooks')) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function newRepo(dir: string, opts = '') {
  fs.mkdirSync(dir, { recursive: true });
  sh(`git init -q -b main ${opts} && git config user.name "Momen Y" && git config user.email m@example.com`, dir);
  fs.writeFileSync(path.join(dir, 'limit.txt'), 'limit = 2\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  sh('git add -A && git commit -qm start', dir);
}

function place(dir: string) {
  project = dir;
  common = path.resolve(project, sh('git rev-parse --git-common-dir', project));
  copy = addWorktree(project, 'AP-1', 'main').dir;
  own = sh('git rev-parse --absolute-git-dir');
}

/** Every file in the real git folder, to the byte. The index by what it holds: git may refresh its notes on the files. */
function realGitBytes(): Map<string, string> {
  const bytes = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      // The index and the words are squad-kit's own to write, before the hooks run: what they hold is looked at on their own.
      else if (e.name !== 'index' && e.name !== 'COMMIT_EDITMSG') bytes.set(path.relative(common, file), `${fs.lstatSync(file).mode}:${createHash('sha1').update(fs.readFileSync(file)).digest('hex')}`);
    }
  };
  walk(common);
  bytes.set('(what is staged)', sh('git ls-files -s'));
  bytes.set('(the words)', fs.existsSync(path.join(own, 'COMMIT_EDITMSG')) ? 'there' : 'not yet');
  return bytes;
}

/** The work is staged and its tree in the store: all that squad-kit's own git does before and after the hooks. */
function work(text = 'limit = 3\n') {
  fs.writeFileSync(path.join(copy, 'limit.txt'), text);
  stageAll(copy);
  sh('git write-tree');
  fs.writeFileSync(path.join(own, 'COMMIT_EDITMSG'), 'before the hooks\n');
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, '.hookgit-')));
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hookgit-')));
  // squad-kit's folder holds the copies, so it stays out of the temp folder too.
  homeWas = process.env.SQUAD_KIT_HOME;
  process.env.SQUAD_KIT_HOME = path.join(base, 'squad-home');
  // These fixtures sit inside squad-kit's own repo: git run in the wrong folder must find nothing, never that repo.
  ceilingWas = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = ROOT;
  newRepo(path.join(base, 'app'));
  place(path.join(base, 'app'));
});

afterEach(() => {
  process.env.SQUAD_KIT_HOME = homeWas;
  if (ceilingWas === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = ceilingWas;
  // One test leaves a folder that will not be removed as it is.
  sh('chmod -R u+w .', base);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('in the real guard, the real git folder is read only, to the byte', () => {
  /** Each line is one try that has to fail. The hook says no at the end, so no real commit follows and all of it can be compared. */
  async function refusesAll(lines: string[]) {
    if (!guarded()) return;
    const body = lines.flatMap((line, i) => [`if { ${line}; } 2>> "${out('why')}"; then echo "DONE ${i}: ${line.replace(/["$`\\]/g, '.')}" >> "${out()}"; else echo "REFUSED ${i}" >> "${out()}"; fi`]);
    hook('pre-commit', [...body, 'exit 1'].join('\n'));
    work();
    const before = realGitBytes();
    await expect(commitChecked(copy, 'Work', 'feat: work', 60_000, how())).rejects.toBeInstanceOf(HookRefused);
    expect(said()).not.toContain('DONE');
    for (let i = 0; i < lines.length; i += 1) expect(said()).toContain(`REFUSED ${i}\n`);
    expect(said('why')).toMatch(/not permitted/i);
    expect(realGitBytes()).toEqual(before);
    expect(spawnSync('git', ['fsck', '--strict', '--no-dangling'], { cwd: project, encoding: 'utf8' }).status).toBe(0);
    expect(sh('git rev-parse --abbrev-ref HEAD')).toBe('squad/ap-1');
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
  }

  it('a stored object, loose: not changed, removed, moved or replaced, even made writable first', async () => {
    const sha = sh('git rev-parse main:limit.txt', project);
    const obj = path.join(common, 'objects', sha.slice(0, 2), sha.slice(2));
    // Only the guard is left to stop it: git's own read-only mode is taken off.
    fs.chmodSync(obj, 0o644);
    fs.chmodSync(path.dirname(obj), 0o755);
    await refusesAll([`printf junk > "${obj}"`, `rm -f "${obj}"`, `mv "${obj}" "${obj}.x"`, `ln -sf /etc/hosts "${obj}"`, `chmod 666 "${obj}"`, `printf junk > "${path.dirname(obj)}/new"`, `mkdir "${common}/objects/zz"`]);
    expect(sh(`git cat-file blob ${sha}`, project)).toBe('limit = 2');
  });

  it('a stored object, in a pack, and where git believes objects are', async () => {
    sh('git repack -adq', project);
    const pack = fs.readdirSync(path.join(common, 'objects', 'pack')).find((f) => f.endsWith('.pack'))!;
    const file = path.join(common, 'objects', 'pack', pack);
    fs.chmodSync(file, 0o644);
    await refusesAll([`printf junk >> "${file}"`, `rm -f "${file}"`, `echo /elsewhere > "${common}/objects/info/alternates"`, `${REAL} hash-object -w --stdin < /etc/hosts`]);
  });

  it('a ref: a branch, packed or not, a tag, a replacement', async () => {
    const tip = sh('git rev-parse main', project);
    sh('git tag v1', project);
    await refusesAll([
      `echo ${tip} > "${common}/refs/heads/main"`,
      `rm -f "${common}/refs/heads/main"`,
      `echo "ref: refs/heads/main" > "${common}/refs/heads/squad/ap-1"`,
      `${REAL} update-ref refs/heads/stolen ${tip}`,
      `${REAL} update-ref -d refs/heads/main`,
      `${REAL} tag -f v1 ${tip}`,
      `${REAL} replace ${tip} ${tip}~0`,
      `echo x > "${common}/packed-refs"`,
      `echo x > "${common}/packed-refs.lock"`,
      `mkdir -p "${common}/refs/replace"`,
    ]);
  });

  it('the settings, all the places git reads them from', async () => {
    await refusesAll([`echo "[core]" >> "${common}/config"`, `${REAL} config core.sshCommand evil`, `${REAL} config --worktree core.sshCommand evil`, `echo x > "${common}/config.lock"`, `echo "[core]" > "${own}/config.worktree"`]);
  });

  it('HEAD, the link to the repo, and where the copy\'s folder is', async () => {
    const tip = sh('git rev-parse main', project);
    await refusesAll([
      `echo "ref: refs/heads/main" > "${own}/HEAD"`,
      `rm -f "${own}/HEAD"`,
      `${REAL} symbolic-ref HEAD refs/heads/main`,
      `${REAL} update-ref --no-deref HEAD ${tip}`,
      `echo "ref: refs/heads/stolen" > "${common}/HEAD"`,
      `echo "gitdir: /elsewhere" > "${copy}/.git"`,
      `rm -f "${copy}/.git"`,
      `echo /elsewhere > "${own}/commondir"`,
      `echo /elsewhere > "${own}/gitdir"`,
    ]);
  });

  it('the reflog, and what the next commit would write through or believe', async () => {
    if (!guarded()) return;
    const rc = path.join(scratch, 'shell-settings');
    fs.writeFileSync(rc, '# mine\n');
    fs.writeFileSync(path.join(own, 'COMMIT_EDITMSG'), 'old\n');
    await refusesAll([
      `echo x >> "${own}/logs/HEAD"`,
      `rm -f "${own}/logs/HEAD"`,
      `ln -sf "${rc}" "${own}/logs/HEAD"`,
      `echo x >> "${common}/logs/HEAD"`,
      `echo x >> "${common}/logs/refs/heads/main"`,
      `rm -rf "${common}/logs"`,
      `ln -sf "${rc}" "${own}/COMMIT_EDITMSG"`,
      `echo x > "${own}/COMMIT_EDITMSG"`,
      `echo x > "${own}/MERGE_HEAD"`,
      `echo x > "${own}/ORIG_HEAD"`,
      `echo x > "${own}/index"`,
      `echo x > "${own}/index.lock"`,
    ]);
    expect(fs.readFileSync(rc, 'utf8')).toBe('# mine\n');
    expect(fs.lstatSync(path.join(own, 'COMMIT_EDITMSG')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(own, 'COMMIT_EDITMSG'), 'utf8')).toMatch(/^(?:Work|feat: work)\n$/);
  });

  it('the stash', async () => {
    const tip = sh('git rev-parse main', project);
    await refusesAll([`${REAL} stash store -m backup ${tip}`, `${REAL} stash push -q`, `echo ${tip} > "${common}/refs/stash"`, `echo x > "${common}/logs/refs/stash"`]);
    expect(sh('git stash list', project)).toBe('');
  });

  it('the hooks and what says which files git ignores', async () => {
    await refusesAll([`echo evil > "${common}/hooks/post-merge"`, `echo evil >> "${common}/hooks/pre-commit"`, `chmod -x "${common}/hooks/pre-commit"`, `rm -f "${common}/hooks/pre-commit"`, `echo '*' > "${common}/info/exclude"`, `echo x > "${common}/shallow"`]);
  });

  it('another copy, and a store of objects a linked project shares', async () => {
    const other = addWorktree(project, 'AP-2', 'main').dir;
    const otherOwn = sh('git rev-parse --absolute-git-dir', other);
    await refusesAll([`echo x > "${otherOwn}/HEAD"`, `echo x > "${otherOwn}/index"`, `echo "gitdir: /elsewhere" > "${other}/.git"`, `echo x > "${common}/worktrees/ap-1/locked"`, `ls "$(dirname "$GIT_DIR")"`, `echo x > "$(dirname "$GIT_DIR")/planted"`]);
  });

  it('a project in a temp folder, where the guard lets commands write: its git folder is still closed', async () => {
    if (!guarded()) return;
    const inTemp = path.join(scratch, 'in temp');
    newRepo(inTemp);
    place(inTemp);
    const sha = sh('git rev-parse main:limit.txt', project);
    const obj = path.join(common, 'objects', sha.slice(0, 2), sha.slice(2));
    fs.chmodSync(obj, 0o644);
    await refusesAll([`printf junk > "${obj}"`, `echo x >> "${common}/config"`, `echo x > "${own}/HEAD"`, `${REAL} update-ref refs/heads/stolen HEAD`, `${REAL} stash store -m b ${sha}`]);
    expect(sh(`git cat-file blob ${sha}`, project)).toBe('limit = 2');
  });

  it('when the hooks pass, the real folder gets the one real commit and nothing a hook made', async () => {
    const before = sh('git rev-parse squad/ap-1', project);
    hook('pre-commit', [`git hash-object -w --stdin < /etc/hosts > "${out('blob')}"`, `S=$(git stash create x); [ -n "$S" ] && git stash store -m x "$S"; git rev-parse refs/stash > "${out('stash')}"`, 'git tag from-a-hook', 'git update-ref refs/heads/from-a-hook HEAD'].join('\n'));
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git rev-list --count HEAD ^' + before)).toBe('1');
    expect(sh('git log -1 --format=%s')).toBe('Work');
    expect(sh('git show HEAD:limit.txt')).toBe('limit = 3');
    for (const made of ['blob', 'stash']) {
      expect(said(made).trim()).toMatch(/^[0-9a-f]{40}$/);
      expect(isThere(said(made).trim())).toBe(false);
    }
    expect(sh('git for-each-ref refs/tags refs/heads/from-a-hook refs/stash', project)).toBe('');
    expect(sh('git stash list', project)).toBe('');
    expect(spawnSync('git', ['fsck', '--strict', '--no-dangling'], { cwd: project }).status).toBe(0);
    expect(sh('git for-each-ref refs/heads/squad/saving', project)).toBe('');
  });
});

describe('a hook sees a real repo', () => {
  it('its branch by its real name, where git and the top are, the other branches and tags, and its identity', async () => {
    fs.writeFileSync(path.join(project, 'more.txt'), 'x\n');
    sh('git add -A && git commit -qm more && git tag v1 && git update-ref refs/remotes/origin/main HEAD', project);
    copy = addWorktree(project, 'AP-2', 'main').dir;
    hook('pre-commit', [
      `git rev-parse --abbrev-ref HEAD > "${out('branch')}"`,
      `git symbolic-ref HEAD >> "${out('branch')}"`,
      `git rev-parse --git-dir --git-common-dir --show-toplevel > "${out('where')}"`,
      `git config user.name > "${out('name')}"`,
      `git rev-parse origin/main main v1 > "${out('refs')}"`,
      `git merge-base origin/main HEAD >> "${out('refs')}"`,
      `git describe --tags --always > "${out('describe')}"`,
      `git log --format=%s -2 > "${out('log')}"`,
      `git diff --cached --name-only > "${out('staged')}"`,
      `git status --porcelain > "${out('status')}"`,
      `git config --get remote.origin.url > "${out('remote')}" || true`,
    ].join('\n'));
    work();
    const tip = sh('git rev-parse main', project);
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('branch').trim().split('\n')).toEqual(['squad/ap-2', 'refs/heads/squad/ap-2']);
    const [gitDir, commonDir, top] = said('where').trim().split('\n');
    expect(gitDir).toBe(commonDir);
    expect(gitDir!.startsWith(`${fs.realpathSync(path.join(squadHome(), 'hook-git'))}/`)).toBe(true);
    expect(top).toBe(fs.realpathSync(copy));
    expect(said('name').trim()).toBe('Momen Y');
    expect(said('refs').trim().split('\n')).toEqual([tip, tip, tip, tip]);
    expect(said('describe').trim()).toBe('v1');
    expect(said('log').trim().split('\n')).toEqual(['more', 'start']);
    expect(said('staged').trim()).toBe('limit.txt');
    expect(said('status').trim()).toBe('M  limit.txt');
    // What it loses on purpose: the repo's own settings are not there, remotes among them.
    expect(said('remote')).toBe('');
  });

  it('a relative hooks folder, from the top of the copy, and from a folder inside it', async () => {
    hook('pre-commit', `echo "$0" > "${out('zero')}"\npwd > "${out('pwd')}"\ncd sub && git rev-parse --show-prefix > "${out('prefix')}" && git add ../limit.txt\nunset GIT_DIR\ngit rev-parse --show-cdup --show-toplevel > "${out('cleared')}"`, path.join(project, '.githooks'));
    fs.mkdirSync(path.join(project, 'sub'));
    fs.writeFileSync(path.join(project, 'sub', 'a.txt'), 'a\n');
    sh('git add -A && git commit -qm hooks && git config core.hooksPath .githooks', project);
    copy = addWorktree(project, 'AP-2', 'main').dir;
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('zero').trim()).toBe(path.join(fs.realpathSync(copy), '.githooks', 'pre-commit'));
    expect(said('pwd').trim()).toBe(fs.realpathSync(copy));
    expect(said('prefix').trim()).toBe('sub/');
    expect(said('cleared').trim().split('\n')).toEqual(['../', fs.realpathSync(copy)]);
    expect(sh('git log -1 --format=%s')).toBe('Work');
  });

  it('what says which files git ignores comes along: a hook that stages everything takes none of them', async () => {
    fs.appendFileSync(path.join(common, 'info', 'exclude'), 'local-only/\n');
    fs.mkdirSync(path.join(copy, 'local-only'));
    fs.writeFileSync(path.join(copy, 'local-only', 'big'), 'x');
    hook('pre-commit', `git status --porcelain > "${out('status')}"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('status').trim()).toBe('M  limit.txt');
  });

  it('only what a commit needs is in its settings: no remote, no program, no token', async () => {
    sh('git config remote.origin.url https://me:THE-TOKEN@example.com/x.git && git config core.sshCommand evil && git config credential.helper evil && git config custom.key value', project);
    hook('pre-commit', `cat "$GIT_DIR/config" > "${out('config')}"\ngit config custom.key > "${out('plain')}"\n${REAL} config custom.key > "${out('past')}"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    const settings = said('config');
    expect(settings).toContain('hooksPath');
    expect(settings).toContain('name = "Momen Y"');
    expect(settings).not.toMatch(/THE-TOKEN|remote|sshCommand|credential|custom/);
    // A tool that needs the repo's own settings does not get them by plain git. It can still read them past it.
    expect(said('plain')).toBe('');
    expect(said('past').trim()).toBe('value');
  });

  it('a name with quotes in it, and a folder with an apostrophe, are written right', async () => {
    const odd = path.join(base, `it's مشروع`);
    newRepo(odd);
    sh(`git config user.name 'Mo "the" Man\\'`, odd);
    place(odd);
    hook('pre-commit', `git config user.name > "${out('name')}"\nunset GIT_DIR GIT_WORK_TREE\ngit rev-parse --absolute-git-dir > "${out('dir')}"`);
    work();
    await commitChecked(copy, `It's "quoted"`, 'feat: w', 60_000, how());
    expect(said('name').trim()).toBe('Mo "the" Man\\');
    expect(said('dir').trim().startsWith(fs.realpathSync(path.join(squadHome(), 'hook-git')))).toBe(true);
    expect(sh('git log -1 --format=%s')).toBe(`It's "quoted"`);
  });

  it('a file whose name a Mac keeps decomposed shows no false change to a hook', async () => {
    if (process.platform !== 'darwin') return;
    // Arabic: alef with hamza above, written as two letters. git keeps it as one in the index with this setting on.
    const name = 'أ.txt';
    sh('git config core.precomposeunicode true', project);
    fs.writeFileSync(path.join(copy, name), 'x\n');
    stageAll(copy);
    hook('pre-commit', `git status --porcelain > "${out('status')}"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('status')).not.toContain('??');
  });
});

describe('a tool that clears GIT_DIR, as lint-staged does before anything else', () => {
  const clears = 'unset GIT_DIR GIT_WORK_TREE';

  it('its backup lands in the throwaway folder, and a formatter\'s fix goes in', async () => {
    hook('pre-commit', [
      'set -e',
      clears,
      `git rev-parse --absolute-git-dir > "${out('dir')}"`,
      'S=$(git stash create "backup")',
      'git stash store -m "automatic backup" "$S"',
      `git stash list > "${out('list')}"`,
      'echo formatted >> limit.txt',
      'git add limit.txt',
      'git stash drop -q',
    ].join('\n'));
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('dir').trim().startsWith(fs.realpathSync(path.join(squadHome(), 'hook-git')))).toBe(true);
    expect(said('list')).toContain('automatic backup');
    expect(sh('git show HEAD:limit.txt')).toBe('limit = 3\nformatted');
    expect(sh('git stash list', project)).toBe('');
    expect(fs.existsSync(path.join(common, 'refs', 'stash'))).toBe(false);
  });

  it('a lint that says no: its reset and its backup stay in the throwaway folder, and the files come back', async () => {
    hook('pre-commit', ['set -e', clears, 'S=$(git stash create "backup")', 'git stash store -m "automatic backup" "$S"', 'git reset --hard HEAD', 'git stash apply --quiet --index "$S"', 'git stash drop -q', 'echo "lint says no"', 'exit 1'].join('\n'));
    work();
    const before = realGitBytes();
    const err = (await commitChecked(copy, 'Work', 'feat: work', 60_000, how()).catch((e: unknown) => e)) as HookRefused;
    expect(err).toBeInstanceOf(HookRefused);
    expect(err.said).toContain('lint says no');
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
    expect(realGitBytes()).toEqual(before);
    expect(sh('git stash list', project)).toBe('');
  });

  it('a tool that really reaches the real folder: its write is refused, and the person gets the usual card', async () => {
    if (!guarded()) return;
    hook('pre-commit', `${REAL} update-ref refs/heads/stolen HEAD 2>&1 || { echo "cannot write"; exit 1; }`);
    work();
    const before = realGitBytes();
    const err = (await commitChecked(copy, 'Work', 'feat: work', 60_000, how()).catch((e: unknown) => e)) as HookRefused;
    expect(err).toBeInstanceOf(HookRefused);
    expect(err.said).toContain('cannot write');
    expect(err.said).toContain("squad-kit's guard blocked");
    expect(realGitBytes()).toEqual(before);
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
  });

  it('git -C with GIT_DIR cleared finds the real folder, read only, and it can read there', async () => {
    if (!guarded()) return;
    hook('pre-commit', [`env -u GIT_DIR -u GIT_WORK_TREE git -C . rev-parse --abbrev-ref HEAD > "${out('read')}"`, `env -u GIT_DIR -u GIT_WORK_TREE git -C . rev-parse --absolute-git-dir > "${out('dir')}"`, 'env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C . update-ref refs/heads/stolen HEAD 2>&1 || { echo "cannot write"; exit 1; }'].join('\n'));
    work();
    const before = realGitBytes();
    await expect(commitChecked(copy, 'Work', 'feat: work', 60_000, how())).rejects.toBeInstanceOf(HookRefused);
    expect(said('read').trim()).toBe('squad/ap-1');
    expect(fs.realpathSync(said('dir').trim())).toBe(fs.realpathSync(own));
    expect(realGitBytes()).toEqual(before);
  });

  it('git -C with GIT_DIR left alone stays on the throwaway folder', async () => {
    hook('pre-commit', `git -C . rev-parse --absolute-git-dir > "${out('dir')}"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('dir').trim().startsWith(fs.realpathSync(path.join(squadHome(), 'hook-git')))).toBe(true);
  });

  it('a tool that works in another repo is not put on the throwaway folder', async () => {
    const other = path.join(scratch, 'other');
    newRepo(other);
    // Its own history: the same files in the same second would give it the same commit as the project's.
    fs.writeFileSync(path.join(other, 'other.txt'), 'other\n');
    sh('git add -A && git commit -qm other', other);
    const was = sh('git rev-parse HEAD', other);
    hook('pre-commit', `${clears}\ncd "${other}" && git rev-parse HEAD > "${out('head')}"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('head').trim()).toBe(was);
  });
});

describe('only the files and the words come back', () => {
  it('a commit-msg hook that edits the words: the real commit has them', async () => {
    hook('commit-msg', 'printf "edited by the hook\\n\\nwith a body\\n" > "$1"');
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git log -1 --format=%B')).toBe('edited by the hook\n\nwith a body');
  });

  it('a prepare-commit-msg hook that adds a line, with commitlint-like words on the second try', async () => {
    hook('prepare-commit-msg', 'printf "\\nReviewed: yes\\n" >> "$1"');
    hook('commit-msg', 'head -1 "$1" | grep -q "^feat: " || { echo "not in the form"; exit 1; }');
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git log -1 --format=%B')).toBe('feat: work\n\nReviewed: yes');
  });

  it('a link at the words to a file the hook cannot read: its contents never reach the commit', async () => {
    const secret = path.join(squadHome(), 'app.json');
    fs.writeFileSync(secret, 'THE BOARD TOKEN');
    hook('post-commit', `rm -f "$GIT_DIR/COMMIT_EDITMSG"\nln -s "${secret}" "$GIT_DIR/COMMIT_EDITMSG"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git log -1 --format=%B')).toBe('Work');
    expect(fs.readFileSync(secret, 'utf8')).toBe('THE BOARD TOKEN');
    fs.rmSync(secret);
  });

  it('a hard link at the words is no way round', async () => {
    const secret = path.join(scratch, 'secret');
    fs.writeFileSync(secret, 'THE SECRET');
    hook('post-commit', `rm -f "$GIT_DIR/COMMIT_EDITMSG"\nln "${secret}" "$GIT_DIR/COMMIT_EDITMSG"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git log -1 --format=%B')).toBe('Work');
  });

  it.each([
    ['a pipe, which would hang a plain read', 'mkfifo "$GIT_DIR/COMMIT_EDITMSG"'],
    ['a folder', 'mkdir "$GIT_DIR/COMMIT_EDITMSG"'],
    ['nothing at all', 'true'],
    ['words too long to pass on', 'head -c 200000 /dev/zero | tr "\\0" "x" > "$GIT_DIR/COMMIT_EDITMSG"'],
    ['a NUL in them', 'printf "a\\000b\\n" > "$GIT_DIR/COMMIT_EDITMSG"'],
    ['only spaces', 'printf "  \\n\\n" > "$GIT_DIR/COMMIT_EDITMSG"'],
  ])('%s at the words: the commit keeps its own', async (_, plant) => {
    hook('post-commit', `rm -f "$GIT_DIR/COMMIT_EDITMSG"\n${plant}`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git log -1 --format=%B')).toBe('Work');
  });

  it('settings a hook writes in its folder never reach squad-kit\'s own git, and nothing it plants there runs', async () => {
    const ran = out('ran');
    const evil = path.join(scratch, 'evil.sh');
    fs.writeFileSync(evil, `#!/bin/sh\necho ran >> "${ran}"\ncat\n`, { mode: 0o755 });
    hook('pre-commit', [
      `git config core.fsmonitor "${evil}"`,
      `git config core.sshCommand "${evil}"`,
      `git config diff.external "${evil}"`,
      `git config core.pager "${evil}"`,
      `git config filter.x.clean "${evil}"`,
      `git config alias.status "!${evil}"`,
      `git config core.hooksPath "${path.join(scratch, 'planted')}"`,
      'mkdir -p "$GIT_DIR/hooks"',
      `printf '#!/bin/sh\\necho ran >> "${ran}"\\n' > "$GIT_DIR/hooks/post-commit"`,
      'chmod +x "$GIT_DIR/hooks/post-commit"',
      `echo "${path.join(scratch, 'elsewhere')}" > "$GIT_DIR/commondir"`,
    ].join('\n'));
    hook('post-merge', `echo ran >> "${ran}"`);
    fs.mkdirSync(path.join(scratch, 'planted'));
    fs.writeFileSync(path.join(scratch, 'planted', 'post-commit'), `#!/bin/sh\necho ran >> "${ran}"\n`, { mode: 0o755 });
    work();
    fs.writeFileSync(path.join(copy, '.gitattributes'), '*.txt filter=x\n');
    stageAll(copy);
    const before = fs.readFileSync(path.join(common, 'config'), 'utf8');
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    sh('git status --porcelain && git diff HEAD~1 --stat');
    expect(fs.readFileSync(path.join(common, 'config'), 'utf8')).toBe(before);
    expect(fs.existsSync(ran)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('a formatter that changes a file and does not stage it: the change still goes in', async () => {
    hook('pre-commit', 'echo formatted >> limit.txt');
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git show HEAD:limit.txt')).toBe('limit = 3\nformatted');
    expect(sh('git status --porcelain')).toBe('');
  });

  it('a hook that says no after fixing a file gets its second try with the fix staged', async () => {
    hook('pre-commit', `if grep -q fixed limit.txt; then exit 0; fi\necho fixed >> limit.txt\necho "I fixed it, try again"\nexit 1`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git show HEAD:limit.txt')).toBe('limit = 3\nfixed');
  });

  it('a hook\'s own commit of everything: thrown away, and the change goes in on its own words', async () => {
    const before = sh('git rev-parse HEAD');
    hook('pre-commit', `git commit -qm "the hook's own" --no-verify\ngit rev-parse HEAD > "${out('own')}"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh(`git rev-list --count HEAD ^${before}`)).toBe('1');
    expect(sh('git log -1 --format=%B')).toBe('Work');
    expect(sh('git show HEAD:limit.txt')).toBe('limit = 3');
    expect(isThere(said('own').trim())).toBe(false);
    expect(sh('git status --porcelain')).toBe('');
  });

  it('a hook\'s own commit of a part: both parts go in, as one', async () => {
    const before = sh('git rev-parse HEAD');
    fs.writeFileSync(path.join(copy, 'b.txt'), 'b\n');
    hook('pre-commit', 'git commit -qm "part" --no-verify -- b.txt');
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh(`git rev-list --count HEAD ^${before}`)).toBe('1');
    expect(sh('git log -1 --format=%B')).toBe('Work');
    expect(sh('git show HEAD:b.txt')).toBe('b');
    expect(sh('git show HEAD:limit.txt')).toBe('limit = 3');
  });

  it('a post-commit that makes its own commit: thrown away, and its words are not this change\'s', async () => {
    const before = sh('git rev-parse HEAD');
    hook('post-commit', `[ -e version.txt ] && exit 0\necho bumped > version.txt\ngit add version.txt\ngit commit -qm "bump the version"\ngit rev-parse HEAD > "${out('own')}"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh(`git rev-list --count HEAD ^${before}`)).toBe('1');
    expect(sh('git log -1 --format=%B')).toBe('Work');
    expect(sh('git show HEAD:version.txt')).toBe('bumped');
    expect(isThere(said('own').trim())).toBe(false);
  });

  it('a post-commit that amends: thrown away, and the result is the same', async () => {
    const before = sh('git rev-parse HEAD');
    // Once: its own amend starts this hook again.
    hook('post-commit', `[ -e "${out('once')}" ] && exit 0\ntouch "${out('once')}"\ngit commit -q --amend -m "amended by the hook" --no-verify`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh(`git rev-list --count HEAD ^${before}`)).toBe('1');
    expect(sh('git log -1 --format=%s')).toBe('Work');
    expect(sh('git show HEAD:limit.txt')).toBe('limit = 3');
  });

  it('a post-commit runs once, on the real branch by name, and sees the commit it follows', async () => {
    const before = sh('git rev-parse HEAD');
    hook('post-commit', `{ git rev-parse --abbrev-ref HEAD; git log -1 --format=%s; git rev-parse HEAD~1; } >> "${out('saw')}"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('saw').trim().split('\n')).toEqual(['squad/ap-1', 'Work', before]);
    expect(sh('git rev-parse HEAD~1')).toBe(before);
  });
});

describe('the throwaway folder is always removed', () => {
  it('each try gets a new name, so what an earlier one left running cannot wait for it', async () => {
    hook('pre-commit', `echo "$GIT_DIR" >> "${out('dirs')}"\nexit 1`);
    work();
    await expect(commitChecked(copy, 'Work', 'feat: work', 60_000, how())).rejects.toBeInstanceOf(HookRefused);
    const dirs = said('dirs').trim().split('\n');
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
  });

  it('swapped for a link by a hook: nothing outside it is read as words or removed', async () => {
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'mine\n');
    hook('post-commit', `d="$GIT_DIR"\ncd /\nrm -rf "$d"\nln -s "${outside}" "$d"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git log -1 --format=%B')).toBe('Work');
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('mine\n');
    expect(leftovers()).toEqual([]);
  });

  it('on success and on a refusal', async () => {
    hook('pre-commit', `echo "$GIT_DIR" >> "${out('dir')}"`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(fs.existsSync(said('dir').trim())).toBe(false);
    expect(leftovers()).toEqual([]);
    hook('pre-commit', `echo "$GIT_DIR" >> "${out('dir2')}"\nexit 1`);
    work('limit = 4\n');
    await expect(commitChecked(copy, 'Work', 'feat: work', 60_000, how())).rejects.toBeInstanceOf(HookRefused);
    expect(leftovers()).toEqual([]);
  });

  it('even with something it left still writing there', async () => {
    hook('pre-commit', `( while [ -d "$GIT_DIR" ]; do touch "$GIT_DIR/x" 2>/dev/null; sleep 0.01; done ) > /dev/null 2>&1 &\nsleep 0.2`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(leftovers().filter((f) => !f.includes('.gone-'))).toEqual([]);
    expect(sh('git log -1 --format=%s')).toBe('Work');
  });

  it('even with a folder in it that will not be removed: it is out of the way, and later work in the copy stays', async () => {
    hook('pre-commit', 'mkdir "$GIT_DIR/stuck"\ntouch "$GIT_DIR/stuck/file"\nchmod 555 "$GIT_DIR/stuck"');
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(leftovers()).toEqual([]);
    // Were it still there, the next start would take it for a crash and put the files back over this.
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'later work\n');
    settleCopy(copy);
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('later work\n');
  });

  it('at a time limit, a linter cut off half-way: the files are as they were, and the card says so', async () => {
    hook('pre-commit', `echo half > limit.txt\necho $$ > "${out('started')}"\nexec sleep 30`);
    work();
    await expect(commitChecked(copy, 'Work', 'feat: work', 1500, how())).rejects.toMatchObject({ timedOut: true });
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
    expect(sh('git diff --cached --name-only')).toBe('limit.txt');
    expect(sh('git status --porcelain')).toBe('M  limit.txt');
    expect(leftovers()).toEqual([]);
  });
});

describe('a Stop in the middle of a stash-and-lint hook', () => {
  async function stopIn(body: string) {
    hook('pre-commit', [...body.split('\n'), `echo x > "${out('go')}"`, 'exec sleep 60'].join('\n'));
    work();
    const before = sh('git rev-parse HEAD');
    const stop = new AbortController();
    const saving = commitChecked(copy, 'Work', 'feat: work', 60_000, { ...how(), signal: stop.signal });
    for (let i = 0; i < 800 && !fs.existsSync(out('go')); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(fs.existsSync(out('go'))).toBe(true);
    stop.abort();
    await expect(saving).rejects.toBeInstanceOf(CommitStopped);
    expect(sh('git rev-parse HEAD')).toBe(before);
    expect(sh('git rev-parse --abbrev-ref HEAD')).toBe('squad/ap-1');
    expect(sh('git stash list', project)).toBe('');
    expect(fs.existsSync(path.join(common, 'refs', 'stash'))).toBe(false);
    expect(leftovers()).toEqual([]);
    // The work is there, in the files and staged, as before the hook, and it goes in on the next save.
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
    expect(sh('git status --porcelain')).toBe('M  limit.txt');
    fs.rmSync(path.join(common, 'hooks', 'pre-commit'));
    const saved = await commitAll(copy, 'Saved after', 'chore: saved', how());
    expect(saved.commit).toBeTruthy();
    expect(sh('git diff --name-only HEAD~1 HEAD')).toBe('limit.txt');
  }

  it('with its backup taken and a formatter half-way', () => stopIn('unset GIT_DIR GIT_WORK_TREE\nS=$(git stash create backup)\ngit stash store -m backup "$S"\necho half > limit.txt'));

  it('between its reset and putting its backup back, where the files are all gone', () => stopIn('unset GIT_DIR GIT_WORK_TREE\nS=$(git stash create backup)\ngit stash store -m backup "$S"\ngit reset --hard HEAD'));

  it('with a file removed', () => stopIn('rm limit.txt'));

  it('nothing it wrote to the check itself stays', async () => {
    fs.mkdirSync(path.join(copy, '.husky'));
    fs.writeFileSync(path.join(copy, '.husky', 'pre-commit'), 'echo original\n');
    stageAll(copy);
    hook('pre-commit', `echo evil > .husky/pre-commit\necho evil > .husky/pre-push\necho x > "${out('go')}"\nexec sleep 60`);
    work();
    const stop = new AbortController();
    const saving = commitChecked(copy, 'Work', 'feat: work', 60_000, { ...how(), signal: stop.signal });
    for (let i = 0; i < 800 && !fs.existsSync(out('go')); i += 1) await new Promise((r) => setTimeout(r, 25));
    stop.abort();
    await expect(saving).rejects.toBeInstanceOf(CommitStopped);
    expect(fs.readFileSync(path.join(copy, '.husky', 'pre-commit'), 'utf8')).toBe('echo original\n');
    expect(fs.existsSync(path.join(copy, '.husky', 'pre-push'))).toBe(false);
  });
});

describe.skipIf(inGuard)('a crash at each point', () => {
  /** A commit in a process of its own, ended by its exact number; the hook's own process is ended by its exact number too. */
  async function crashWhile(hookBody: string, opts: { gpg?: boolean } = {}) {
    const run = path.join(scratch, 'run.mts');
    fs.writeFileSync(run, [`import { commitChecked } from ${JSON.stringify(path.join(ROOT, 'src/engine/git.ts'))};`, `import fs from 'node:fs';`, `fs.writeFileSync(${JSON.stringify(out('pid'))}, String(process.pid));`, 'await commitChecked(process.argv[2]!, "Work", "feat: work", 50000);'].join('\n'));
    hook('pre-commit', hookBody);
    work();
    const child = spawn(process.execPath, ['--import', 'tsx', run, copy], { cwd: ROOT, stdio: 'ignore', env: process.env });
    const ended = new Promise<void>((r) => child.on('exit', () => r()));
    if (opts.gpg) return ended;
    for (let i = 0; i < 800 && !fs.existsSync(out('hook')); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(fs.existsSync(out('hook'))).toBe(true);
    process.kill(child.pid!, 'SIGKILL');
    await ended;
    const hookPid = Number(said('hook').trim());
    // It writes its number just before it becomes the sleep: on a slow computer, a look can fall in between.
    for (let i = 0; i < 100 && !sh(`ps -o command= -p ${hookPid}`, scratch).includes('sleep 55'); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(sh(`ps -o command= -p ${hookPid}`, scratch)).toContain('sleep 55');
    process.kill(hookPid, 'SIGKILL');
    return ended;
  }

  it('in the hooks, with the files half-changed: branch not moved, and the next start puts all of it right', async () => {
    const before = sh('git rev-parse HEAD');
    await crashWhile(`echo half > limit.txt\necho $$ > "${out('hook')}"\nexec sleep 55`);
    expect(sh('git rev-parse HEAD')).toBe(before);
    expect(leftovers()).toHaveLength(1);
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('half\n');
    settleCopy(copy);
    expect(leftovers()).toEqual([]);
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
    expect(sh('git status --porcelain')).toBe('M  limit.txt');
    expect(sh('git rev-parse HEAD')).toBe(before);
  });

  it('with a planted hook in the copy: the next start takes it out', async () => {
    await crashWhile(`mkdir -p .githooks\necho evil > .githooks/pre-push\necho $$ > "${out('hook')}"\nexec sleep 55`);
    settleCopy(copy);
    expect(fs.existsSync(path.join(copy, '.githooks', 'pre-push'))).toBe(false);
    expect(sh('git status --porcelain')).toBe('M  limit.txt');
  });

  it('an edit made after the crash is kept, and the next start says where', async () => {
    const before = sh('git rev-parse HEAD');
    await crashWhile(`echo $$ > "${out('hook')}"\nexec sleep 55`);
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = TYPED AFTER THE CRASH\n');
    const kept = settleCopy(copy);
    expect(kept).toBe('refs/squad/on-disk/ap-1');
    expect(sh(`git show ${kept}:limit.txt`)).toBe('limit = TYPED AFTER THE CRASH');
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
    expect(sh('git rev-parse HEAD')).toBe(before);
    // Nothing to tell when there was nothing but what was staged.
    expect(settleCopy(copy)).toBeNull();
  });

  it('a fresh lock at the first start does not leave work to be wiped at the next one', async () => {
    await crashWhile(`echo $$ > "${out('hook')}"\nexec sleep 55`);
    fs.writeFileSync(path.join(own, 'index.lock'), '');
    settleCopy(copy);
    expect(leftovers()).toEqual([]);
    fs.rmSync(path.join(own, 'index.lock'));
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = BUILDER WORK AFTER THE RESTART\n');
    settleCopy(copy);
    expect(fs.readFileSync(path.join(copy, 'limit.txt'), 'utf8')).toBe('limit = BUILDER WORK AFTER THE RESTART\n');
  });

  it('what is left of the hook ends at the next start, by the number noted', async () => {
    // Not in crashWhile: this one must stay running until the next start.
    const run = path.join(scratch, 'run2.mts');
    fs.writeFileSync(run, [`import { commitChecked } from ${JSON.stringify(path.join(ROOT, 'src/engine/git.ts'))};`, 'await commitChecked(process.argv[2]!, "Work", "feat: work", 50000);'].join('\n'));
    hook('pre-commit', `echo $$ > "${out('hook')}"\nexec sleep 55`);
    work();
    const child = spawn(process.execPath, ['--import', 'tsx', run, copy], { cwd: ROOT, stdio: 'ignore', env: process.env });
    const ended = new Promise<void>((r) => child.on('exit', () => r()));
    for (let i = 0; i < 800 && !fs.existsSync(out('hook')); i += 1) await new Promise((r) => setTimeout(r, 25));
    process.kill(child.pid!, 'SIGKILL');
    await ended;
    const hookPid = Number(said('hook').trim());
    // It writes its number just before it becomes the sleep: on a slow computer, a look can fall in between.
    for (let i = 0; i < 100 && !sh(`ps -o command= -p ${hookPid}`, scratch).includes('sleep 55'); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(sh(`ps -o command= -p ${hookPid}`, scratch)).toContain('sleep 55');
    settleCopy(copy);
    for (let i = 0; i < 100 && spawnSync('ps', ['-o', 'pid=', '-p', String(hookPid)], { encoding: 'utf8' }).stdout.trim(); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(spawnSync('ps', ['-o', 'pid=', '-p', String(hookPid)], { encoding: 'utf8' }).stdout.trim()).toBe('');
  });

  it('between the folder made and the hooks starting: nothing to put right but the folder', () => {
    work();
    const left = path.join(squadHome(), 'hook-git');
    const name = `${path.basename(fs.realpathSync(copy))}-${createHash('sha1').update(fs.realpathSync(copy)).digest('hex').slice(0, 12)}`;
    fs.mkdirSync(path.join(left, name, 'git-abc', 'objects'), { recursive: true });
    settleCopy(copy);
    expect(leftovers()).toEqual([]);
    expect(sh('git status --porcelain')).toBe('M  limit.txt');
  });

  it('in the real commit, in a signature: branch not moved, the work staged, and the next save goes through', async () => {
    const before = sh('git rev-parse HEAD');
    const gpg = path.join(scratch, 'gpg-that-dies');
    fs.writeFileSync(gpg, `#!/bin/sh\nkill -9 "$(cat "${out('pid')}")"\nexit 1\n`, { mode: 0o755 });
    sh(`git config commit.gpgsign true && git config gpg.program "${gpg}"`, project);
    await crashWhile('exit 0', { gpg: true });
    expect(sh('git rev-parse HEAD')).toBe(before);
    expect(leftovers()).toEqual([]);
    expect(sh('git status --porcelain')).toBe('M  limit.txt');
    const good = path.join(scratch, 'gpg');
    fs.writeFileSync(good, `#!/bin/sh\ncat > /dev/null\nprintf '[GNUPG:] SIG_CREATED ' >&2\necho "-----BEGIN PGP SIGNATURE-----"\necho x\necho "-----END PGP SIGNATURE-----"\n`, { mode: 0o755 });
    sh(`git config gpg.program "${good}"`, project);
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git cat-file commit HEAD')).toContain('gpgsig');
    expect(sh('git rev-parse HEAD~1')).toBe(before);
  });
});

describe('signing', () => {
  function fakeGpg(body: string) {
    const gpg = path.join(scratch, 'gpg');
    fs.writeFileSync(gpg, `#!/bin/sh\necho signed >> "${out('signed')}"\n${body}\n`, { mode: 0o755 });
    return gpg;
  }
  const SIGNS = `cat > /dev/null\nprintf '[GNUPG:] SIG_CREATED ' >&2\necho "-----BEGIN PGP SIGNATURE-----"\necho x\necho "-----END PGP SIGNATURE-----"`;

  it('only the real commit is signed, and it is, with a setting that is the person\'s own for all their repos', async () => {
    const gpg = fakeGpg(SIGNS);
    const settings = path.join(scratch, 'gitconfig');
    fs.writeFileSync(settings, `[user]\n\tname = Momen\n\temail = momen@example.com\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${gpg}\n`);
    const was = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = settings;
    try {
      hook('pre-commit', 'exit 0');
      work();
      await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    } finally {
      process.env.GIT_CONFIG_GLOBAL = was;
    }
    expect(said('signed').trim().split('\n')).toEqual(['signed']);
    expect(sh('git cat-file commit HEAD')).toContain('gpgsig');
  });

  it('a signature that fails leaves no moved branch, and the work staged', async () => {
    const gpg = fakeGpg('exit 1');
    sh(`git config commit.gpgsign true && git config gpg.program "${gpg}"`, project);
    const before = sh('git rev-parse squad/ap-1', project);
    hook('pre-commit', 'exit 0');
    work();
    await expect(commitChecked(copy, 'Work', 'feat: work', 60_000, how())).rejects.toThrow(/git commit failed|gpg/);
    expect(sh('git rev-parse squad/ap-1', project)).toBe(before);
    expect(sh('git status --porcelain')).toBe('M  limit.txt');
    expect(leftovers()).toEqual([]);
  });
});


describe('a copy cannot be taken away from under squad-kit\'s own git', () => {
  it('moving the copy and planting a .git with a filter: refused, and no program of the hook runs outside the guard', async () => {
    if (!guarded()) return;
    const mark = path.join(base, 'MARK');
    const log = out('log');
    hook('pre-commit', `
cd /
mv "${copy}" "$GIT_DIR/old" 2>>"${log}" && echo "moved" >>"${log}" || { echo "refused" >>"${log}"; exit 0; }
N="$GIT_DIR/new"
mkdir -p "$N/.evil/objects" "$N/.evil/refs/heads"
cp "$GIT_DIR/old/limit.txt" "$N/limit.txt"
printf 'gitdir: .evil\\n' > "$N/.git"
printf 'ref: refs/heads/main\\n' > "$N/.evil/HEAD"
printf '[core]\\n\\trepositoryformatversion = 0\\n[filter "pwn"]\\n\\tclean = "touch ${mark}; cat"\\n' > "$N/.evil/config"
printf '* filter=pwn\\n' > "$N/.gitattributes"
mv "$N" "${copy}"
exit 0`);
    work();
    const link = fs.readFileSync(path.join(copy, '.git'), 'utf8');
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('log')).toContain('refused');
    expect(said('log')).not.toContain('moved');
    expect(fs.existsSync(mark)).toBe(false);
    expect(fs.readFileSync(path.join(copy, '.git'), 'utf8')).toBe(link);
    expect(sh('git log -1 --format=%s')).toBe('Work');
  });
});

describe.skipIf(inGuard)('what a hook leaves running', () => {
  const alive = (pid: number) => spawnSync('ps', ['-o', 'pid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() !== '';

  it('its process group ends when the commit does', async () => {
    hook('pre-commit', `nohup sleep 40 >/dev/null 2>&1 &\necho $! > "${out('pid')}"\nexit 0`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    for (let i = 0; i < 100 && alive(Number(said('pid'))); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(alive(Number(said('pid')))).toBe(false);
  });

  it('even one that left the group cannot get squad-kit to delete a file outside the copy', async () => {
    const victim = path.join(base, 'outside', 'victim');
    fs.mkdirSync(path.dirname(victim));
    fs.writeFileSync(victim, 'THE PERSON\'S\n');
    // It starts when the real index changes, as squad-kit gets to the files the hook left, and swaps .husky for a link.
    const swapper = path.join(base, 'sw.cjs');
    fs.writeFileSync(swapper, `const fs=require('fs'),path=require('path');const [copy,index,outside]=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(out('swapper'))},String(process.pid));const start=fs.statSync(index).mtimeMs;const end=Date.now()+12000;while(Date.now()<end){let m;try{m=fs.statSync(index).mtimeMs}catch{continue}if(m!==start){try{fs.renameSync(path.join(copy,'.husky'),path.join(copy,'.husky-old'));fs.symlinkSync(outside,path.join(copy,'.husky'))}catch{}break}}\n`);
    const starter = path.join(base, 'st.cjs');
    fs.writeFileSync(starter, `require('child_process').spawn(process.execPath,[${JSON.stringify(swapper)},...process.argv.slice(2)],{detached:true,stdio:'ignore'}).unref()\n`);
    hook('pre-commit', `mkdir -p .husky && echo x > .husky/victim\nnode "${starter}" "$PWD" "${path.join(own, 'index')}" "${path.dirname(victim)}"\nsleep 0.5\nexit 0`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    const pid = Number(said('swapper'));
    if (pid && spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.includes('sw.cjs')) process.kill(pid, 'SIGKILL');
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('THE PERSON\'S\n');
  });
});

describe('.husky swapped for a link', () => {
  it('goes back at once: the first save does not fail, and the next does not drop the check', async () => {
    fs.mkdirSync(path.join(project, '.husky'));
    fs.writeFileSync(path.join(project, '.husky', 'pre-commit'), 'echo check\n');
    sh('git add -A && git commit -qm husky', project);
    copy = addWorktree(project, 'AP-2', 'main').dir;
    own = sh('git rev-parse --absolute-git-dir');
    hook('pre-commit', 'rm -rf .husky\nln -s /etc .husky\nexit 0');
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(fs.lstatSync(path.join(copy, '.husky')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(copy, '.husky', 'pre-commit'), 'utf8')).toBe('echo check\n');
    expect(sh('git ls-tree HEAD .husky')).toMatch(/^040000/);
    expect(sh('git show HEAD:.husky/pre-commit')).toBe('echo check');
    expect(sh('git status --porcelain')).toBe('');
  });

  it('a link at the folder where there was none goes too', async () => {
    hook('pre-commit', 'ln -s /etc .husky\nexit 0');
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(fs.lstatSync(path.join(copy, '.husky'), { throwIfNoEntry: false })).toBeUndefined();
    expect(sh('git ls-tree HEAD .husky')).toBe('');
  });
});

describe('tools real projects use', () => {
  it('the pre-commit framework\'s first run: its own repo is made where it asks, with the variables it clears', async () => {
    const cache = path.join(scratch, 'pc');
    const remote = path.join(base, 'hooks-repo');
    newRepo(remote);
    // What the framework does: git with the GIT_ variables cleared, from the copy, to make a clone in its own folder.
    const clean = 'env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX';
    hook('pre-commit', [
      'set -e',
      `${clean} git init --template= "${cache}/repo1"`,
      `cd "${cache}/repo1"`,
      `${clean} git remote add origin "${remote}"`,
      `${clean} git -c protocol.version=2 fetch origin main --depth=1`,
      `${clean} git checkout -q FETCH_HEAD`,
      `${clean} git rev-parse --show-toplevel > "${out('top')}"`,
      `${clean} git -c x.y=z clone -q "${remote}" "${cache}/repo2"`,
    ].join('\n'));
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(fs.existsSync(path.join(cache, 'repo1', '.git', 'HEAD'))).toBe(true);
    expect(fs.realpathSync(said('top').trim())).toBe(fs.realpathSync(path.join(cache, 'repo1')));
    expect(fs.readFileSync(path.join(cache, 'repo1', 'limit.txt'), 'utf8')).toBe('limit = 2\n');
    expect(fs.existsSync(path.join(cache, 'repo2', '.git', 'HEAD'))).toBe(true);
    expect(sh('git log -1 --format=%s')).toBe('Work');
  });

  it('a tool that follows .git for the words (commitlint --edit, with no path) reads this commit\'s words', async () => {
    const follow = `sed -n 's/^gitdir: //p' .git > "${out('own')}"\ncat "$(cat "${out('own')}")/COMMIT_EDITMSG" >> "${out('words')}"`;
    hook('commit-msg', `${follow}\ngrep -q '^feat: ' "$(cat "${out('own')}")/COMMIT_EDITMSG" || { echo "not in the form"; exit 1; }`);
    work();
    await commitChecked(copy, 'Bad words', 'feat: good words', 60_000, how());
    expect(said('words').trim().split('\n')).toEqual(['Bad words', 'feat: good words']);
    expect(sh('git log -1 --format=%s')).toBe('feat: good words');
  });

  it('it is made anew, so a link left there is not written through', async () => {
    const victim = path.join(base, 'victim');
    fs.writeFileSync(victim, 'THE PERSON\'S\n');
    fs.rmSync(path.join(own, 'COMMIT_EDITMSG'), { force: true });
    hook('pre-commit', 'exit 0');
    fs.writeFileSync(path.join(copy, 'limit.txt'), 'limit = 3\n');
    stageAll(copy);
    fs.symlinkSync(victim, path.join(own, 'COMMIT_EDITMSG'));
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(fs.readFileSync(victim, 'utf8')).toBe('THE PERSON\'S\n');
  });

  it('a filter in the repo\'s own settings, as git-crypt keeps there: a file stays plain on disk and coded in the store', async () => {
    // Not one that undoes itself: run twice, that would hide a file gone through it the wrong number of times.
    sh(`git config filter.mark.clean "sed 's/^/CODED:/'" && git config filter.mark.smudge "sed 's/^CODED://'" && git config filter.mark.required true`, project);
    fs.writeFileSync(path.join(project, '.gitattributes'), '*.sec filter=mark\n');
    fs.writeFileSync(path.join(project, 'app.sec'), 'plain secret words\n');
    sh('git add -A && git commit -qm sec', project);
    copy = addWorktree(project, 'AP-2', 'main').dir;
    own = sh('git rev-parse --absolute-git-dir');
    expect(fs.readFileSync(path.join(copy, 'app.sec'), 'utf8')).toBe('plain secret words\n');
    // lint-staged's way when it says no: its backup, a reset, and the backup put back.
    hook('pre-commit', 'S=$(git stash create backup)\ngit stash store -m backup "$S"\ngit reset -q --hard HEAD\ngit stash apply -q --index stash@{0}\ngit status --porcelain --untracked-files=no > "' + out('status') + '"\nexit 1');
    fs.writeFileSync(path.join(copy, 'app.sec'), 'plain words changed\n');
    stageAll(copy);
    await expect(commitChecked(copy, 'Work', 'feat: work', 60_000, how())).rejects.toBeInstanceOf(HookRefused);
    expect(fs.readFileSync(path.join(copy, 'app.sec'), 'utf8')).toBe('plain words changed\n');
    expect(sh('git cat-file blob :app.sec')).toBe('CODED:plain words changed');
    expect(said('status')).toContain('app.sec');
    // And when it says yes, what goes in the store is coded.
    hook('pre-commit', 'exit 0');
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git cat-file blob HEAD:app.sec')).toBe('CODED:plain words changed');
    expect(fs.readFileSync(path.join(copy, 'app.sec'), 'utf8')).toBe('plain words changed\n');
  });

  it('a filter that keeps its key under git\'s folder finds it there, read only', async () => {
    fs.mkdirSync(path.join(common, 'git-crypt'));
    fs.writeFileSync(path.join(common, 'git-crypt', 'key'), 'THE KEY\n');
    hook('pre-commit', `cat "$(git rev-parse --git-dir)/git-crypt/key" > "${out('key')}"\necho x > "$(git rev-parse --git-dir)/git-crypt/key" 2> /dev/null\nexit 0`);
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(said('key').trim()).toBe('THE KEY');
    if (guarded()) expect(fs.readFileSync(path.join(common, 'git-crypt', 'key'), 'utf8')).toBe('THE KEY\n');
  });
});

describe('what a hook stages counts for nothing: only the files come back, as the docs say', () => {
  it('a force-added ignored file stays out, a file it took out goes back in, and an unstaged report goes in', async () => {
    fs.writeFileSync(path.join(copy, 'local.conf'), 'mine\n');
    fs.writeFileSync(path.join(copy, 'ignored.txt'), 'x');
    fs.appendFileSync(path.join(copy, '.gitignore'), 'ignored.txt\n');
    hook('pre-commit', 'git add -f ignored.txt\ngit rm -q --cached --ignore-unmatch local.conf\necho report > report.out\nexit 0');
    work();
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    const files = sh('git ls-tree -r --name-only HEAD').split('\n');
    expect(files).not.toContain('ignored.txt');
    expect(files).toContain('local.conf');
    expect(files).toContain('report.out');
  });
});

describe('a merge being finished, when a hook says no', () => {
  it('the commit that finished it keeps the hooks owed, and the error says so', async () => {
    fs.writeFileSync(path.join(project, 'theirs.txt'), 'theirs\n');
    sh('git add -A && git commit -qm theirs', project);
    work();
    sh('git commit -qm mine --no-verify');
    sh('git merge --no-commit --no-ff main');
    hook('pre-commit', 'echo no\nexit 1');
    const err = (await commitChecked(copy, 'Finish', 'feat: finish', 60_000, how()).catch((e: unknown) => e)) as HookRefused;
    expect(err).toBeInstanceOf(HookRefused);
    expect(err.owed).toBe(true);
  });
});

describe('a Stop leaves nothing new', () => {
  it('new files a killed hook left are gone, and kept with the rest of what was on disk', async () => {
    hook('pre-commit', `echo half > limit.txt\nmkdir -p made\necho left > made/new.txt\necho x > "${out('go')}"\nexec sleep 60`);
    work();
    const stop = new AbortController();
    const saving = commitChecked(copy, 'Work', 'feat: work', 60_000, { ...how(), signal: stop.signal });
    for (let i = 0; i < 800 && !fs.existsSync(out('go')); i += 1) await new Promise((r) => setTimeout(r, 25));
    stop.abort();
    await expect(saving).rejects.toBeInstanceOf(CommitStopped);
    expect(fs.existsSync(path.join(copy, 'made'))).toBe(false);
    expect(sh('git status --porcelain')).toBe('M  limit.txt');
    expect(sh('git ls-files -s')).not.toContain('made/');
    const kept = 'refs/squad/on-disk/ap-1';
    expect(sh(`git show ${kept}:made/new.txt`)).toBe('left');
    expect(sh(`git show ${kept}:limit.txt`)).toBe('half');
    expect(sh(`git reflog show ${kept} --format=%s`)).toContain('cut off');
  });
});

describe('a copy 1.2.1 left in the middle of a save', () => {
  const standIn = 'refs/heads/squad/saving/squad/ap-1/now';
  function leftByCrash(): string {
    const tip = sh('git rev-parse HEAD');
    sh(`git update-ref ${standIn} ${tip} && git symbolic-ref HEAD ${standIn}`);
    return tip;
  }

  it('what its hook planted is not followed, and the next commit has the right parent', async () => {
    const tip = leftByCrash();
    sh('git commit -q --allow-empty -m planted', project);
    const planted = sh('git rev-parse main', project);
    const v1 = path.join(base, 'v1');
    const v2 = path.join(base, 'v2');
    fs.writeFileSync(v1, 'ONE\n');
    fs.writeFileSync(v2, 'TWO\n');
    fs.rmSync(path.join(own, 'COMMIT_EDITMSG'), { force: true });
    fs.symlinkSync(v1, path.join(own, 'COMMIT_EDITMSG'));
    fs.mkdirSync(path.join(own, 'logs'), { recursive: true });
    fs.rmSync(path.join(own, 'logs', 'HEAD'), { force: true });
    fs.symlinkSync(v2, path.join(own, 'logs', 'HEAD'));
    fs.writeFileSync(path.join(own, 'MERGE_HEAD'), `${planted}\n`);
    settleCopy(copy);
    expect(sh('git symbolic-ref HEAD')).toBe('refs/heads/squad/ap-1');
    work('limit = 9\n');
    await commitAll(copy, 'Next save', 'chore: next');
    expect(fs.readFileSync(v1, 'utf8')).toBe('ONE\n');
    expect(fs.readFileSync(v2, 'utf8')).toBe('TWO\n');
    expect(sh('git log -1 --format=%P')).toBe(tip);
    expect(sh('git for-each-ref refs/heads/squad/saving', project)).toBe('');
  });

  it('a linked logs folder goes too, and other refs a hook left in that folder, without touching main', () => {
    const tip = leftByCrash();
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(own, 'logs'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(own, 'logs'));
    sh(`git update-ref refs/heads/squad/saving/junk ${tip}`, project);
    const mainWas = sh('git rev-parse main', project);
    fs.writeFileSync(path.join(common, standIn), 'ref: refs/heads/main\n');
    // A killed git's lock there too, which no git command clears.
    fs.writeFileSync(`${path.join(common, standIn)}.lock`, '');
    settleCopy(copy);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(sh('git rev-parse main', project)).toBe(mainWas);
    expect(sh('git for-each-ref refs/heads/squad/saving', project)).toBe('');
    expect(fs.existsSync(path.join(common, 'refs', 'heads', 'squad', 'saving'))).toBe(false);
    // And the copy is on its own branch, so its next commit does not land on main.
    expect(fs.readFileSync(path.join(own, 'HEAD'), 'utf8').trim()).toBe('ref: refs/heads/squad/ap-1');
    expect(sh('git rev-parse --abbrev-ref HEAD')).toBe('squad/ap-1');
  });

  it('a trial commit on it: the work stays staged, and goes in with the next save', async () => {
    leftByCrash();
    work('limit = 7\n');
    sh('git commit -qm trial');
    settleCopy(copy);
    expect(sh('git diff --cached --name-only')).toBe('limit.txt');
    await commitAll(copy, 'Next', 'chore: next');
    expect(sh('git show HEAD:limit.txt')).toBe('limit = 7');
  });
});

describe('the shapes a repo comes in', () => {
  async function passes(extra = '') {
    hook('pre-commit', `git status --porcelain > "${out('status')}"\ngit log --oneline -1 > "${out('log')}"\n${extra}`);
    work();
    const before = sh('git rev-parse HEAD');
    await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
    expect(sh('git rev-parse HEAD~1')).toBe(before);
    expect(sh('git show HEAD:limit.txt')).toBe('limit = 3');
    expect(said('log')).not.toBe('');
    expect(leftovers()).toEqual([]);
  }

  it('work saved earlier, looked at whole: the hook stands where it started, on the real branch by name', async () => {
    work();
    sh('git commit -qm "work so far" --no-verify');
    const base = sh('git rev-parse main', project);
    const tip = sh('git rev-parse HEAD');
    hook('pre-commit', `{ git rev-parse HEAD; git rev-parse --abbrev-ref HEAD; git diff --cached --name-only; } > "${out('saw')}"`);
    await commitChecked(copy, 'Whole', 'feat: whole', 60_000, { ...how(), from: base });
    expect(said('saw').trim().split('\n')).toEqual([base, 'squad/ap-1', 'limit.txt']);
    expect(sh('git rev-parse HEAD~1')).toBe(tip);
    expect(sh('git log -1 --format=%s')).toBe('Whole');
  });

  it('a merge not finished: finished first, and the hook sees all of it', async () => {
    work();
    sh('git commit -qm mine --no-verify');
    fs.writeFileSync(path.join(project, 'theirs.txt'), 'theirs\n');
    sh('git add -A && git commit -qm theirs', project);
    sh('git merge --no-commit --no-ff main');
    hook('pre-commit', `git diff --cached --name-only > "${out('saw')}"\nls "$GIT_DIR/MERGE_HEAD" 2>&1 >> "${out('saw')}" || true`);
    await commitChecked(copy, 'Finish', 'feat: finish', 60_000, how());
    expect(said('saw')).toContain('theirs.txt');
    expect(sh('git rev-parse -q --verify MERGE_HEAD || echo none')).toBe('none');
    expect(sh('git merge-base --is-ancestor main HEAD && echo yes')).toBe('yes');
  });

  it('a project that is a linked worktree of another', async () => {
    const main = path.join(base, 'main');
    newRepo(main);
    const linked = path.join(base, 'linked');
    sh(`git worktree add -q -b main2 "${linked}"`, main);
    project = linked;
    common = path.resolve(linked, sh('git rev-parse --git-common-dir', linked));
    copy = addWorktree(linked, 'AP-1', 'main2').dir;
    own = sh('git rev-parse --absolute-git-dir');
    await passes();
  });

  it('a project with a submodule: its link stays in the commit, and git does not look inside it', async () => {
    const lib = path.join(base, 'lib');
    newRepo(lib);
    sh(`git -c protocol.file.allow=always submodule add -q "${lib}" sub && git commit -qm sub`, project);
    copy = addWorktree(project, 'AP-2', 'main').dir;
    await passes(`git ls-files --stage sub > "${out('link')}"`);
    expect(said('link')).toContain('160000');
    expect(sh('git ls-files --stage sub')).toContain('160000');
  });

  it('a project that is a submodule: its git folder sits inside the parent\'s', async () => {
    const lib = path.join(base, 'lib');
    newRepo(lib);
    const parent = path.join(base, 'parent');
    newRepo(parent);
    sh(`git -c protocol.file.allow=always submodule add -q "${lib}" proj && git commit -qm sub`, parent);
    const p = path.join(parent, 'proj');
    sh('git config user.name "Momen Y" && git config user.email m@example.com', p);
    place(p);
    await passes();
    expect(common).toContain(path.join('.git', 'modules'));
  });

  it('a path with Arabic letters and spaces', async () => {
    const arabic = path.join(base, 'مشروع جديد', 'app');
    newRepo(arabic);
    place(arabic);
    await passes();
  });

  it('a project in a temp folder', async () => {
    const inTemp = path.join(scratch, 'مؤقت', 'app');
    newRepo(inTemp);
    place(inTemp);
    await passes();
  });

  it('a copy not on a branch', async () => {
    sh('git checkout -q --detach');
    await passes();
    expect(sh('git rev-parse --abbrev-ref HEAD')).toBe('HEAD');
  });

  it('a shallow clone: a hook can read its history', async () => {
    const full = path.join(base, 'full');
    newRepo(full);
    fs.writeFileSync(path.join(full, 'two.txt'), '2\n');
    sh('git add -A && git commit -qm two', full);
    const shallow = path.join(base, 'shallow');
    sh(`git clone -q --depth 1 "file://${full}" "${shallow}"`, base);
    sh('git config user.name "Momen Y" && git config user.email m@example.com', shallow);
    sh('git branch -M main', shallow);
    place(shallow);
    await passes(`git log --format=%s > "${out('all')}" 2>&1 || exit 1`);
    expect(said('all').trim()).toBe('two');
  });

  it('a repo that keeps its index split', async () => {
    sh('git config core.splitIndex true', project);
    copy = addWorktree(project, 'AP-2', 'main').dir;
    sh('git update-index --split-index');
    await passes();
  });

  it('a sha-256 repo', async () => {
    const sha256 = path.join(base, 'sha256');
    newRepo(sha256, '--object-format=sha256');
    place(sha256);
    await passes(`git rev-parse HEAD > "${out('head')}"`);
    expect(said('head').trim()).toHaveLength(64);
  });

  it('a commit with no name set: it still goes through, as squad-kit', async () => {
    const was = process.env.GIT_CONFIG_GLOBAL;
    const empty = path.join(scratch, 'empty-gitconfig');
    fs.writeFileSync(empty, '');
    process.env.GIT_CONFIG_GLOBAL = empty;
    try {
      sh('git config --unset user.name && git config --unset user.email', project);
      hook('pre-commit', `git config user.name > "${out('name')}"`);
      work();
      await commitChecked(copy, 'Work', 'feat: work', 60_000, how());
      expect(said('name').trim()).toBe('squad-kit');
      expect(sh('git log -1 --format=%s')).toBe('Work');
    } finally {
      process.env.GIT_CONFIG_GLOBAL = was;
    }
  });
});

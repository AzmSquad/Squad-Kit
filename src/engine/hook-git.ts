import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../core/home.js';
import { commitArgsFor, git, hookFolder, quoted, realOf, stageAll } from './git.js';
import { takenOver } from './process-group.js';
import { HOOK_GIT_LINK } from './project-guard.js';

/**
 * The git folder a commit's hooks run on. Hooks are the project's own code, so the real git folder is read only to them,
 * all of it. This one is made for each run, outside the project: it reads the real store of objects and writes only its
 * own, and its settings are squad-kit's. Nothing comes back from it but the files in the copy and the commit's words, so
 * no object a hook makes can enter the real store, and squad-kit's own git never reads a setting a hook wrote.
 */

/** Where a copy's folder goes: found from the copy alone, so a crash's leftover is found too. */
function homeFor(dir: string): string {
  const real = realOf(dir);
  return path.join(squadHome(), 'hook-git', `${path.basename(real)}-${createHash('sha1').update(real).digest('hex').slice(0, 12)}`);
}

/** True when a run left its folder behind: a crash cut the hooks off. */
export function hookGitLeft(dir: string): boolean {
  return fs.existsSync(homeFor(dir));
}

/** Moved aside first, so it is gone at once, whatever a hook left in it: something still writing, or a folder it made hard to remove. */
export function clearHookGit(dir: string): void {
  const gone = `${homeFor(dir)}.gone-${process.pid}-${Date.now()}`;
  const remove = () => fs.rmSync(gone, { recursive: true, force: true, maxRetries: 3 });
  try {
    fs.renameSync(homeFor(dir), gone);
  } catch {
    return;
  }
  try {
    remove();
  } catch {
    try {
      execFileSync('chmod', ['-R', 'u+rwx', gone], { stdio: 'ignore' });
      remove();
    } catch {
      // It is out of the way all the same.
    }
  }
}

/** Notes the process group a run's hooks are in, so the next start can end what a crash left of them. */
export function noteHookGroup(dir: string, pid: number): void {
  fs.writeFileSync(path.join(homeFor(dir), 'group'), `${pid}\n${new Date().toISOString()}\n`);
}

/** Ends that group, by the number noted, unless another program has that number by now. */
export function endHookGroup(dir: string): void {
  try {
    const [pid, since] = fs.readFileSync(path.join(homeFor(dir), 'group'), 'utf8').split('\n');
    if (process.platform !== 'win32' && Number(pid) > 1 && !takenOver(Number(pid), since)) process.kill(-Number(pid), 'SIGKILL');
  } catch {
    // None noted, or nothing of it is left.
  }
}

/**
 * Keeps what is on disk in a ref of its own before the files go back, new files too. It works on an index of its own, so
 * a lock on the real one is no bar. Null when the files are as they were staged, so nothing would be lost.
 */
function keepOnDisk(dir: string): string | null {
  const index = path.join(homeFor(dir), 'on-disk');
  fs.copyFileSync(path.join(git(dir, ['rev-parse', '--absolute-git-dir']), 'index'), index);
  const env = { GIT_INDEX_FILE: index };
  git(dir, ['-c', 'core.splitIndex=false', 'update-index', '--no-split-index'], { allowFail: true, env });
  const staged = git(dir, ['write-tree'], { env });
  stageAll(dir, env);
  const onDisk = git(dir, ['write-tree'], { env });
  if (onDisk === staged) return null;
  const commit = git(dir, [...commitArgsFor(dir), 'commit-tree', onDisk, '-p', git(dir, ['rev-parse', 'HEAD']), '-m', 'What was on disk when the project\'s own check was cut off']);
  const ref = `refs/squad/on-disk/${path.basename(realOf(dir))}`;
  git(dir, ['update-ref', '--create-reflog', '-m', 'cut off', ref, commit]);
  return ref;
}

/**
 * Hooks cut off half-way (a linter killed in the middle, lint-staged between its reset and putting its backup back): the
 * files go back to what was staged before them, which they could not touch, and what they left goes. Nothing is lost:
 * what was on disk is kept first, in the ref this returns, whoever wrote it. It throws before any file moves if it cannot.
 */
export function putFilesBack(dir: string): string | null {
  const kept = keepOnDisk(dir);
  git(dir, ['checkout-index', '-f', '-a']);
  git(dir, ['clean', '-fdq']);
  return kept;
}

/** The settings that say how this computer's files behave: `git status` in a hook would see false changes without them. */
const FILE_SETTINGS = '^core\\.(filemode|symlinks|ignorecase|precomposeunicode|autocrlf|eol|safecrlf)$';
const PLAIN_VALUE = /^(?:true|false|input|warn|lf|crlf)$/;

/**
 * Its settings, written here: never a copy of the repo's, which name remotes and programs. Its commit counts for nothing,
 * so it is not signed. The one thing that comes along is the repo's own filters, as git-crypt keeps there, which run only
 * in the guard here: without them a hook's reset would leave a file in its stored form.
 */
function settingsFor(dir: string, start: string): string {
  const said = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  const name = git(dir, ['config', 'user.name'], { allowFail: true });
  const email = git(dir, ['config', 'user.email'], { allowFail: true });
  const files = git(dir, ['config', '--get-regexp', FILE_SETTINGS], { allowFail: true }).split('\n').map((l) => l.split(' ')).filter(([, v]) => v && PLAIN_VALUE.test(v));
  const filters = git(dir, ['config', '--local', '--null', '--get-regexp', '^filter\\.'], { allowFail: true }).split('\0').flatMap((entry) => {
    const line = /^filter\.(.+)\.([^.\n]+)\n([\s\S]*)$/.exec(entry);
    return line ? [`[filter ${said(line[1]!)}]`, `\t${line[2]} = ${said(line[3]!)}`] : [];
  });
  const sha256 = start.length === 64;
  return [
    '[core]',
    `\trepositoryformatversion = ${sha256 ? 1 : 0}`,
    `\tworktree = ${said(realOf(dir))}`,
    `\thooksPath = ${said(path.resolve(dir, hookFolder(dir)))}`,
    '\tfsmonitor = false',
    '\tlogAllRefUpdates = true',
    ...files.map(([key, value]) => `\t${key!.slice('core.'.length)} = ${value}`),
    ...(sha256 ? ['[extensions]', '\tobjectformat = sha256'] : []),
    '[user]',
    `\tname = ${said(name && email ? name : 'squad-kit')}`,
    `\temail = ${said(name && email ? email : 'squad-kit@localhost')}`,
    '[commit]',
    '\tgpgsign = false',
    '[gc]',
    '\tauto = 0',
    '[maintenance]',
    '\tauto = false',
    ...filters,
    '',
  ].join('\n');
}

/**
 * Makes the folder. Its branch is the real one by name, at `start`, with the index as it is staged now. The other
 * branches and tags come by name, as hooks compare with them, and so does what says which files git ignores.
 */
export function makeHookGit(dir: string, start: string, words: string): string {
  clearHookGit(dir);
  fs.mkdirSync(homeFor(dir), { recursive: true });
  // A new name each time: a hook of an earlier run that still runs cannot know it, so it cannot leave a link in what is written here.
  const gitDir = fs.mkdtempSync(path.join(realOf(homeFor(dir)), 'git-'));
  const own = git(dir, ['rev-parse', '--absolute-git-dir']);
  const common = path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']));
  const head = git(dir, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true });
  const refs = git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', 'refs/remotes', 'refs/notes'], { allowFail: true }).split('\n').filter((l) => l && !l.endsWith(` ${head}`));
  if (head) refs.push(`${start} ${head}`);
  for (const at of ['objects/info', 'refs', 'info']) fs.mkdirSync(path.join(gitDir, at), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `${head ? `ref: ${head}` : start}\n`);
  fs.writeFileSync(path.join(gitDir, HOOK_GIT_LINK), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${path.join(common, 'objects')}\n`);
  if (refs.length) fs.writeFileSync(path.join(gitDir, 'packed-refs'), `${refs.join('\n')}\n`);
  fs.writeFileSync(path.join(gitDir, 'config'), settingsFor(dir, start));
  fs.copyFileSync(path.join(own, 'index'), path.join(gitDir, 'index'));
  // An index can keep part of itself in a file beside it: this makes the copy whole.
  git(dir, ['-c', 'core.splitIndex=false', 'update-index', '--no-split-index'], { allowFail: true, env: { GIT_INDEX_FILE: path.join(gitDir, 'index') } });
  for (const rel of ['info/exclude', 'info/attributes', 'shallow']) {
    if (fs.existsSync(path.join(common, rel))) fs.copyFileSync(path.join(common, rel), path.join(gitDir, rel));
  }
  // git-crypt looks for its key under git's folder.
  if (fs.existsSync(path.join(common, 'git-crypt'))) fs.symlinkSync(path.join(common, 'git-crypt'), path.join(gitDir, 'git-crypt'));
  // A tool that follows the copy's `.git` for the commit's words (commitlint --edit, with no path) finds them there. Made anew, so no link is followed.
  fs.rmSync(path.join(own, 'COMMIT_EDITMSG'), { force: true });
  for (const at of [own, gitDir]) fs.writeFileSync(path.join(at, 'COMMIT_EDITMSG'), `${words}\n`, { flag: 'wx' });
  return gitDir;
}

/**
 * The variables that put a commit on the folder. Its work tree is in its settings, not in GIT_WORK_TREE: git would pass
 * that on to the hooks as ".", and a hook that goes into a folder would then take that folder for the top. Some tools clear
 * GIT_DIR before they run git (lint-staged does), then find the copy's real folder, where the guard stops their stash and
 * so every commit. git puts its folder of programs first on the path of all it starts, so a `git` there puts the variable
 * back for a tool working in this copy, then runs the real one with the real folder of programs. Not for `init` or `clone`,
 * which make a repo of their own (the pre-commit framework does, the first time). It is only a help: a tool that goes round
 * it reaches the real folder, read only, and the hook says no. lint-staged goes round it where node and git share a folder,
 * as node's folder comes first on its path: on Linux the guard's mounts settle that (bubblewrapArgs), on a Mac it gets the card.
 */
export function hookGitEnv(dir: string, gitDir: string): Record<string, string> {
  const programs = git(dir, ['--exec-path'], { allowFail: true });
  if (process.platform === 'win32' || !fs.existsSync(path.join(programs, 'git'))) return { GIT_DIR: gitDir };
  const bin = path.join(gitDir, 'exec');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh
GIT_EXEC_PATH=${quoted(programs)}; export GIT_EXEC_PATH
first=$1; [ "$first" = -c ] && first=$3
if [ -z "\${GIT_DIR+set}" ]; then
  case "$first" in -C|init|clone) ;; *)
    case "$(pwd -P)/" in ${quoted(`${realOf(dir)}/`)}*) GIT_DIR=${quoted(gitDir)}; export GIT_DIR ;; esac ;;
  esac
fi
exec ${quoted(path.join(programs, 'git'))} "$@"
`,
    { mode: 0o755 },
  );
  return { GIT_DIR: gitDir, GIT_EXEC_PATH: bin };
}

const WORDS_LIMIT = 64 * 1024;

/**
 * A file in the folder, read outside the guard: never through a link, never a pipe that would hang squad-kit, and never a
 * hard link to a file the hook could not read itself. Null for any of those.
 */
function readHookFile(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const at = fs.fstatSync(fd);
    return at.isFile() && at.nlink === 1 && at.size <= WORDS_LIMIT ? fs.readFileSync(fd, 'utf8') : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** How many commits were made in the folder, by its reflog. */
export function commitsIn(gitDir: string): number {
  return (readHookFile(path.join(gitDir, 'logs', 'HEAD')) ?? '').split('\n').filter((l) => /\tcommit[ :]/.test(l)).length;
}

/** The words the commit ended with, when a hook changed them (a commit-msg hook may); else the words it was given. */
export function hookWords(gitDir: string, asked: string): string {
  const words = readHookFile(path.join(gitDir, 'COMMIT_EDITMSG'))?.trim();
  return words && !words.includes('\0') ? words : asked;
}

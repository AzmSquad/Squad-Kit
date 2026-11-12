import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { SQUAD_DIR, findSquadRoot, isOwnFolder } from '../core/paths.js';
import type { FolderKind } from '../board/setup-state.js';
import { git, gitLater, gitRecords, isRepo } from './git.js';
import { LANG, workspaceRepos } from './repos.js';
import { SELF_NOTE, isSquadKitCode } from './self-project.js';

/**
 * Add project says what it found before the person confirms: existing code with git, code without git, an empty
 * folder, several repos, an older squad-kit project or one that has squad-kit already, and what happens next. A quick
 * look at the files only, with no AI: the Architect reads the project after Add.
 */

export interface FirstLook {
  kind: FolderKind;
  /** "Existing code, new to squad-kit". */
  title: string;
  /** "A Python web app with 15 files and tests." */
  found: string;
  /** What squad-kit does once the person adds it. */
  next: string;
  /** What squad-kit changes in the folder, and what it never touches. */
  safe: string;
  /** How long getting to know it takes. */
  takes: string;
  files: number;
  language?: string;
  web: boolean;
  tests: boolean;
  branch?: string;
  /** Changes in the folder that are not saved in git. */
  unsaved: number;
  repos: string[];
  /** Add must not guess: this folder sits inside something bigger. */
  ask?: AddAsk;
}

/**
 * The folder asked for sits inside something bigger. inside-repo: a subfolder of a repo, whose tests and app run at the
 * repo's top folder, so only that top folder can be the project. inside-project: under another squad-kit project it is no
 * part of (a fresh clone beside its repos, say), which adding must never take over without a word.
 */
export interface AddAsk {
  kind: 'inside-repo' | 'inside-project';
  /** The folder it found above this one. */
  root: string;
  name: string;
  /** What the person reads. */
  words: string;
}

/** Folders nobody counts as the project's own files. */
const NOISE = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__', 'vendor', 'target', 'bin', 'obj', 'venv', SQUAD_DIR]);
const MAX_FILES = 5000;

const WEB_FILE = /\.(html?|vue|jsx|tsx|svelte|cshtml|razor)$/i;
const WEB_DEPS = /"(react|vue|@angular\/core|next|nuxt|svelte|express|hono|fastify|koa|@nestjs\/core)"/;
const WEB_PY = /^(flask|django|fastapi|starlette|bottle|tornado)\b/im;
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Tests?\.(cs|java|kt)$/i;

/**
 * The folder's own files, as git knows them, or as found on disk when it is not in git or is a workspace: how many there
 * are, and the first 5000 of them to read what kind of project it is. All of it beside everything else, and none of the
 * rest kept, so its size breaks nothing.
 */
async function filesOf(dir: string): Promise<{ count: number; files: string[] }> {
  const files: string[] = [];
  let count = 0;
  const add = (f: string) => {
    count += 1;
    if (files.length < MAX_FILES) files.push(f);
  };
  if (isRepo(dir) && !workspaceRepos(dir).length) {
    await gitRecords(dir, ['ls-files', '--cached', '--others', '--exclude-standard'], '\n', (f) => void (f.startsWith(`${SQUAD_DIR}/`) || add(f))).catch(() => undefined);
    if (count) return { count, files };
  }
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || NOISE.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) add(p);
    }
  };
  await walk('');
  return { count, files };
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The language most of the code is in, and whether it is something people open in a browser. */
function kindOfCode(dir: string, files: string[]): { language?: string; web: boolean } {
  const count = new Map<string, number>();
  for (const f of files) {
    const lang = LANG[path.extname(f).toLowerCase()];
    if (lang) count.set(lang, (count.get(lang) ?? 0) + 1);
  }
  // HTML pages beside code in another language: the language names the project.
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]);
  const language = (ranked.find(([l]) => l !== 'HTML') ?? ranked[0])?.[0];
  const web =
    files.some((f) => WEB_FILE.test(f)) ||
    WEB_DEPS.test(read(path.join(dir, 'package.json'))) ||
    WEB_PY.test(read(path.join(dir, 'requirements.txt'))) ||
    /(flask|django|fastapi)/i.test(read(path.join(dir, 'pyproject.toml'))) ||
    files.some((f) => /(^|\/)manage\.py$/.test(f));
  return { ...(language ? { language } : {}), web };
}

function boardOf(dir: string): Record<string, unknown> | null | undefined {
  try {
    const config = yaml.load(fs.readFileSync(path.join(dir, SQUAD_DIR, 'config.yaml'), 'utf8')) as { board?: Record<string, unknown> } | undefined;
    return config?.board ?? null;
  } catch {
    return undefined;
  }
}

/** The real path, so a folder reached through a link compares with what git says. */
function real(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The top folder of the repo this folder is in, or null when it is in none. */
function repoTop(dir: string): string | null {
  const top = git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return top ? real(top) : null;
}

/** True when the folder is the project's own: inside its one repo, or one of the repos it lists above its repos. */
function partOfProject(dir: string, project: string): boolean {
  const abs = real(dir);
  const top = repoTop(abs);
  // No repo of its own between the folder and the project: the project may also sit in a subfolder of its repo.
  if (top && !path.relative(top, real(project)).startsWith('..')) return true;
  const repos = boardOf(project)?.repos;
  if (!Array.isArray(repos)) return false;
  return repos.some((r: { path?: unknown }) => {
    if (typeof r?.path !== 'string') return false;
    const rel = path.relative(real(path.join(project, r.path)), abs);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/** What Add must ask before it does anything with this folder, or null when the folder can simply be added. */
export function addAsk(dir: string): AddAsk | null {
  const abs = path.resolve(dir);
  if (fs.existsSync(path.join(abs, SQUAD_DIR, 'config.yaml'))) return null;
  const above = findSquadRoot(path.dirname(abs));
  if (above) {
    if (partOfProject(abs, above)) return null;
    return {
      kind: 'inside-project',
      root: above,
      name: path.basename(above),
      words: `This folder sits inside another squad-kit project, in ${above}. Open that project, or add this folder on its own?`,
    };
  }
  const top = repoTop(abs);
  if (!top || top === real(abs) || !isOwnFolder(top)) return null;
  return {
    kind: 'inside-repo',
    root: top,
    name: path.basename(top),
    words: `This folder is part of a bigger project, ${path.basename(top)}, in ${top}. Its tests and app run from the top folder, so squad-kit works from there too. Add the top folder instead.`,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function listWords(names: string[]): string {
  if (names.length <= 1) return names.join('');
  const shown = names.slice(0, 4);
  const rest = names.length - shown.length;
  return rest ? `${shown.join(', ')} and ${rest} more` : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

function describeCode(n: number, language: string | undefined, web: boolean, tests: boolean): string {
  const what = language === 'HTML' ? 'web site' : web ? 'web app' : 'project';
  const lang = language && language !== 'HTML' ? `${language} ` : '';
  const head = `${lang}${what}`;
  const article = /^[AEIOU]/.test(head) ? 'An' : 'A';
  return `${article} ${head} with ${plural(n, 'file')}${tests ? ' and tests' : ''}`;
}

const SAFE = "Your code is not changed. squad-kit only adds a .squad folder for the project's memory.";
const TAKES = 'Takes about 3 to 5 minutes. You can keep working meanwhile.';

/** The branch the person's folder is on, and how many changes there are not saved in git. Nothing outside git, or for a workspace. */
export async function gitState(dir: string): Promise<{ branch?: string; unsaved: number }> {
  if (!isRepo(dir) || workspaceRepos(dir).length) return { unsaved: 0 };
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  // A look only: no lock on the person's index that their own git, or a merge, could run into.
  const unsaved = (await gitLater(dir, ['status', '--porcelain'], { allowFail: true, env: { GIT_OPTIONAL_LOCKS: '0' } })).split('\n').filter((l) => l.trim() && !l.slice(3).startsWith(`${SQUAD_DIR}/`)).length;
  return { ...(branch && branch !== 'HEAD' ? { branch } : {}), unsaved };
}

/** How many files the project has, as git knows them. */
export async function countFiles(dir: string): Promise<number> {
  return (await filesOf(dir)).count;
}

/** True when a folder holds at most one file of its own: a folder squad-kit made itself, with no code in it yet. */
export function nextToNothing(dir: string): boolean {
  if (isRepo(dir) && !workspaceRepos(dir).length) {
    const list = git(dir, ['ls-files', '--cached', '--others', '--exclude-standard'], { allowFail: true }).split('\n').filter((f) => f && !f.startsWith(`${SQUAD_DIR}/`));
    if (list.length) return list.length <= 1;
  }
  let found = 0;
  const walk = (at: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      // A folder squad-kit may not read counts for nothing.
    }
    for (const e of entries) {
      if (found > 1) return;
      if (e.name.startsWith('.') || NOISE.has(e.name)) continue;
      if (e.isDirectory()) walk(path.join(at, e.name));
      else if (e.isFile()) found += 1;
    }
  };
  walk(dir);
  return found <= 1;
}

/** What adding this folder means, in plain words. */
export async function firstLook(dir: string): Promise<FirstLook> {
  const abs = path.resolve(dir);
  const board = boardOf(abs);
  const squad = path.join(abs, SQUAD_DIR);
  const [{ count, files }, { branch, unsaved }] = await Promise.all([filesOf(abs), gitState(abs)]);
  const code = kindOfCode(abs, files);
  const tests = files.some((f) => TEST_FILE.test(f));
  const repo = isRepo(abs);
  const nested = workspaceRepos(abs).map((r) => r.path);
  const base = { files: count, ...code, tests, ...(branch ? { branch } : {}), unsaved, repos: nested };
  const ask = addAsk(abs);
  if (ask) {
    return {
      ...base,
      kind: repo ? 'repo' : count ? 'files' : 'empty',
      title: ask.kind === 'inside-repo' ? 'Part of a bigger project' : 'Inside another squad-kit project',
      found: ask.words,
      next: 'Nothing changes until you pick.',
      safe: '',
      takes: '',
      ask,
    };
  }
  const unsavedNote = unsaved ? ` ${plural(unsaved, 'change is', 'changes are')} not saved in git yet: squad-kit works from what is saved.` : '';

  if (board) {
    const tickets = fs.existsSync(path.join(squad, 'tickets')) ? fs.readdirSync(path.join(squad, 'tickets')).filter((f) => !f.startsWith('.')).length : 0;
    return {
      ...base,
      kind: 'project',
      title: 'A squad-kit project',
      found: `This folder has squad-kit already, with ${plural(tickets, 'ticket')}.`,
      next: 'Adding it opens its board. Nothing is set up again.',
      safe: 'Nothing in the folder changes.',
      takes: 'Opens at once.',
    };
  }
  if (board === null || fs.existsSync(path.join(squad, 'board', 'board.yaml'))) {
    const legacy = fs.existsSync(path.join(squad, 'board', 'board.yaml'));
    const stories = fs.existsSync(path.join(squad, 'stories')) ? fs.readdirSync(path.join(squad, 'stories')).filter((f) => !f.startsWith('.')).length : 0;
    return {
      ...base,
      kind: 'older',
      title: 'An older squad-kit project',
      found: legacy
        ? `A board from an older squad-kit is here, in ${describeCode(count, code.language, code.web, tests).replace(/^An? /, 'a ')}.`
        : `squad-kit 0.x files are here${stories ? `, with ${plural(stories, 'story', 'stories')}` : ''}, in ${describeCode(count, code.language, code.web, tests).replace(/^An? /, 'a ')}.`,
      next: legacy
        ? 'Your specs, plans and decisions are moved to the new layout. Nothing is lost: a full copy is kept first. Then squad-kit reads the code and shows you what it understood.'
        : 'Your specs, plans and decisions stay where they are. squad-kit adds its own files beside them, keeps any notes of yours it would write over under a new name, and moves sign-ins out of the project to this computer. Then it reads the code and shows you what it understood.',
      safe: "Your code is not changed. squad-kit only works in the project's .squad folder.",
      takes: TAKES,
    };
  }
  if (nested.length) {
    return {
      ...base,
      kind: 'repos',
      title: 'Several code folders',
      found: `A folder with ${plural(nested.length, 'code folder')} inside: ${listWords(nested)}.`,
      next: 'squad-kit reads each one, finds how to test and run each, then shows you how they fit together.',
      safe: "Your code is not changed. squad-kit only adds a .squad folder beside it for the project's memory.",
      takes: TAKES,
    };
  }
  if (!count) {
    return {
      ...base,
      kind: 'empty',
      title: 'An empty folder',
      found: 'Nothing here yet: a new project.',
      next: repo
        ? 'Start from an idea: squad-kit asks what you want to build.'
        : 'Start from an idea: squad-kit makes a git repo here, and asks what you want to build.',
      safe: "squad-kit adds a .squad folder for the project's memory.",
      takes: 'Takes a few seconds.',
    };
  }
  if (!repo) {
    return {
      ...base,
      kind: 'files',
      title: 'Code without git',
      found: `${describeCode(count, code.language, code.web, tests)}, not in git yet.`,
      next: 'squad-kit puts the files in git first, in one first commit, then reads them, finds how to test and run it, and shows you what it understood.',
      safe: 'Your files stay as they are. Secrets like .env files and built folders stay out of git.',
      takes: TAKES,
    };
  }
  if (isSquadKitCode(abs)) {
    return {
      ...base,
      kind: 'repo',
      title: "squad-kit's own code",
      found: `squad-kit's own code: ${describeCode(count, code.language, code.web, tests).replace(/^An? /, 'a ')}.${unsavedNote}`,
      next: `squad-kit will read it, set up its own way to check and run it, then show you what it understood. ${SELF_NOTE}`,
      safe: SAFE,
      takes: TAKES,
    };
  }
  return {
    ...base,
    kind: 'repo',
    title: 'Existing code, new to squad-kit',
    found: `${describeCode(count, code.language, code.web, tests)}.${unsavedNote}`,
    next: 'squad-kit will read it, find how to test and run it, then show you what it understood.',
    safe: SAFE,
    takes: TAKES,
  };
}

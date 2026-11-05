import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { SQUAD_DIR } from '../core/paths.js';
import type { FolderKind } from '../board/setup-state.js';
import { git, isRepo } from './git.js';
import { findNestedRepos } from './repos.js';

/**
 * Add project says what it found before the person confirms: existing code with git, code without git, an empty
 * folder, several repos, an older squad-kit project or one that has squad-kit already, and what happens next. A quick
 * look at the files only, with no AI: the Architect reads the project after Add.
 */

export interface FirstLook {
  kind: FolderKind;
  /** "Existing code, new to squad-kit". */
  title: string;
  /** "A Python web app with 15 files and tests, on git branch main." */
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
}

/** Folders nobody counts as the project's own files. */
const NOISE = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__', 'vendor', 'target', 'bin', 'obj', 'venv', SQUAD_DIR]);
const MAX_FILES = 5000;

const LANG: Record<string, string> = {
  '.py': 'Python',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.vue': 'JavaScript',
  '.cs': 'C#',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.rs': 'Rust',
  '.swift': 'Swift',
  '.dart': 'Dart',
  '.html': 'HTML',
};

const WEB_FILE = /\.(html?|vue|jsx|tsx|svelte|cshtml|razor)$/i;
const WEB_DEPS = /"(react|vue|@angular\/core|next|nuxt|svelte|express|hono|fastify|koa|@nestjs\/core)"/;
const WEB_PY = /^(flask|django|fastapi|starlette|bottle|tornado)\b/im;
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Tests?\.(cs|java|kt)$/i;

/** The folder's own files, as git knows them, or as found on disk when it is not in git. At most 5000. */
function filesOf(dir: string): string[] {
  if (isRepo(dir)) {
    const out = git(dir, ['ls-files', '--cached', '--others', '--exclude-standard'], { allowFail: true });
    const list = out.split('\n').filter((f) => f && !f.startsWith(`${SQUAD_DIR}/`));
    if (list.length) return list.slice(0, MAX_FILES);
  }
  const found: string[] = [];
  const walk = (rel: string) => {
    if (found.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      if (e.name.startsWith('.') || NOISE.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) found.push(p);
    }
  };
  walk('');
  return found;
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

/** The branch the person's folder is on, and how many changes there are not saved in git. Nothing outside git. */
export function gitState(dir: string): { branch?: string; unsaved: number } {
  if (!isRepo(dir)) return { unsaved: 0 };
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  const unsaved = git(dir, ['status', '--porcelain'], { allowFail: true }).split('\n').filter((l) => l.trim() && !l.slice(3).startsWith(`${SQUAD_DIR}/`)).length;
  return { ...(branch && branch !== 'HEAD' ? { branch } : {}), unsaved };
}

/** How many files the project has, as git knows them (at most 5000). */
export function countFiles(dir: string): number {
  return filesOf(dir).length;
}

/** What adding this folder means, in plain words. */
export function firstLook(dir: string): FirstLook {
  const abs = path.resolve(dir);
  const board = boardOf(abs);
  const squad = path.join(abs, SQUAD_DIR);
  const files = filesOf(abs);
  const code = kindOfCode(abs, files);
  const tests = files.some((f) => TEST_FILE.test(f));
  const repo = isRepo(abs);
  const { branch, unsaved } = gitState(abs);
  const nested = repo ? [] : findNestedRepos(abs).map((r) => r.path);
  const base = { files: files.length, ...code, tests, ...(branch ? { branch } : {}), unsaved, repos: nested };
  const onBranch = base.branch ? `, on git branch ${base.branch}` : '';
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
        ? `A board from an older squad-kit is here, in ${describeCode(files.length, code.language, code.web, tests).replace(/^An? /, 'a ')}${onBranch}.`
        : `squad-kit 0.x files are here${stories ? `, with ${plural(stories, 'story', 'stories')}` : ''}, in ${describeCode(files.length, code.language, code.web, tests).replace(/^An? /, 'a ')}${onBranch}.`,
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
      title: 'Several code repos',
      found: `A folder with ${plural(nested.length, 'code repo')} inside: ${listWords(nested)}.`,
      next: 'squad-kit reads each one, finds how to test and run each, then shows you how they fit together.',
      safe: "Your repos are not changed. squad-kit only adds a .squad folder beside them for the project's memory.",
      takes: TAKES,
    };
  }
  if (!files.length) {
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
      found: `${describeCode(files.length, code.language, code.web, tests)}, not in git yet.`,
      next: 'squad-kit puts the files in git first, in one first commit, then reads them, finds how to test and run it, and shows you what it understood.',
      safe: 'Your files stay as they are. Secrets like .env files and built folders stay out of git.',
      takes: TAKES,
    };
  }
  return {
    ...base,
    kind: 'repo',
    title: 'Existing code, new to squad-kit',
    found: `${describeCode(files.length, code.language, code.web, tests)}${onBranch}.${unsavedNote}`,
    next: 'squad-kit will read it, find how to test and run it, then show you what it understood.',
    safe: SAFE,
    takes: TAKES,
  };
}

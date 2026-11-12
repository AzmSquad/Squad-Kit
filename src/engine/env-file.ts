import fs from 'node:fs';
import path from 'node:path';
import { boardPaths, readMeta, writeMeta, type BoardPaths } from '../board/store.js';
import type { BoardMeta, ProjectCommands } from '../board/types.js';
import { SQUAD_DIR, findSquadRoot } from '../core/paths.js';
import { reposOf } from './repos.js';

/**
 * A part's env file. Many apps whose daily stack runs in Docker Compose get their settings from an env file that Compose
 * hands them (`env_file: .env.dev`), and have no loader of their own: run on this computer, outside Docker, they fall
 * back to their settings file, which may point at another computer's database. The `envFile` setting names that file
 * (one path in the repo, or several with commas), and squad-kit gives its values to every command it starts for the part
 * on this computer, first, with squad-kit's own on top (engine/part-env.ts). The values come from the file in the copy
 * the command runs in: in a story's copy, a local file holds the values kept for stories, never the person's own. Only
 * the path is a setting; the values never reach a log, the board or an agent.
 */

/** A bigger file is no env file: it is not read. */
const ENV_FILE_BYTES = 256 * 1024;

/** A path as people write it, with forward slashes and no `./`. */
function cleanPath(file: string): string {
  return file.trim().replace(/\\/g, '/').split('/').filter((x) => x && x !== '.').join('/');
}

/** A part's env files, from its settings, in the order Compose reads them: a later one wins. */
export function envFilesOf(commands: ProjectCommands | undefined): string[] {
  return [...new Set((commands?.envFile ?? '').split(',').map(cleanPath).filter(Boolean))];
}

/** A repo's env files, by its path in the project. */
export function repoEnvFiles(meta: BoardMeta, repo: string): string[] {
  return envFilesOf(reposOf(meta).find((r) => r.path === repo)?.commands);
}

/** What is wrong with an env file's path, in one plain sentence, or null. */
export function envFileProblem(file: string): string | null {
  const text = file.trim().replace(/\\/g, '/');
  const parts = text.split('/').filter((x) => x && x !== '.');
  if (!parts.length) return "Write the env file's path inside the repo, like .env.dev.";
  if (text.startsWith('/') || /^[a-z]:/i.test(text) || parts.includes('..')) return 'The env file must be inside the repo, like .env.dev.';
  if (parts.includes('.git') || parts.includes(SQUAD_DIR)) return `${parts.join('/')} is not an env file of the app.`;
  if (text.endsWith('/')) return `${parts.join('/')} is a folder. Name the env file in it, like .env.dev.`;
  return null;
}

/** The setting as saved: the paths, cleaned, with commas, or '' for none. A path outside the repo throws a plain sentence. */
export function envFileSetting(given: string | string[] | undefined): string {
  const list = (Array.isArray(given) ? given : (given ?? '').split(',')).map((f) => f.trim()).filter(Boolean);
  for (const f of list) {
    const problem = envFileProblem(f);
    if (problem) throw new Error(problem);
  }
  return [...new Set(list.map(cleanPath))].join(', ');
}

/** Every repo's env file setting cleaned, before settings are saved: a path outside its repo is refused with a plain sentence. */
export function checkEnvFiles(meta: BoardMeta): void {
  for (const c of [meta.commands, ...(meta.repos ?? []).map((r) => r.commands)]) {
    if (!c || c.envFile === undefined) continue;
    const value = envFileSetting(c.envFile);
    if (value) c.envFile = value;
    else delete c.envFile;
  }
}

/** Sets a repo's env files, for Settings and `squad config set env-file`. None takes the setting away. */
export function setEnvFile(bp: BoardPaths, repo: string | undefined, files: string[]): { repo: string; files: string[] } {
  const meta = readMeta(bp);
  const repos = reposOf(meta).map((r) => r.path);
  const r = repo?.trim() || (repos.length === 1 ? repos[0]! : '');
  if (!repos.includes(r)) throw new Error(r ? `There is no code repo at ${r}. The repos: ${repos.join(', ')}.` : `Say which repo it is for: ${repos.join(', ')}.`);
  const value = envFileSetting(files);
  const put = (c: ProjectCommands): ProjectCommands => {
    const { envFile: _was, ...rest } = c;
    return value ? { ...rest, envFile: value } : rest;
  };
  if (meta.repos?.length) writeMeta(bp, { ...meta, repos: meta.repos.map((x) => (x.path === r ? { ...x, commands: put(x.commands) } : x)) });
  else writeMeta(bp, { ...meta, commands: put(meta.commands ?? {}) });
  return { repo: r, files: envFilesOf({ envFile: value }) };
}

/* ── reading one, the way Docker Compose does ───────────── */

/** What a backslash means in double quotes, as Compose reads it: a new line, a return, and the next sign as it is. */
function unescape(c: string): string {
  return c === 'n' ? '\n' : c === 'r' ? '\r' : c;
}

/**
 * The settings in an env file, as Docker Compose reads it: `KEY=VALUE` lines, `export ` before a key, `#` comments on
 * their own line or after a space, single quotes as written, double quotes with `\n` and `\"`, quoted values over several
 * lines, and empty values. A line with no `=` gives nothing. No `$NAME` is filled in: the value is as written.
 */
export function parseEnvFile(text: string): [string, string][] {
  const s = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf('\n', i);
    const lineEnd = nl < 0 ? s.length : nl;
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*=[ \t]*/.exec(s.slice(i, lineEnd));
    if (!m) {
      i = lineEnd + 1;
      continue;
    }
    const key = m[1]!;
    const at = i + m[0].length;
    const quote = s[at];
    if (quote === '"' || quote === "'") {
      let v = '';
      let j = at + 1;
      while (j < s.length && s[j] !== quote) {
        if (quote === '"' && s[j] === '\\' && j + 1 < s.length) {
          v += unescape(s[j + 1]!);
          j += 2;
          continue;
        }
        v += s[j];
        j += 1;
      }
      if (j < s.length) {
        out.set(key, v);
        const after = s.indexOf('\n', j);
        i = after < 0 ? s.length : after + 1;
        continue;
      }
      // No closing quote: the line as written, like any other.
    }
    // A `#` after a space starts a comment; in `KEY=#1` it is the value.
    const raw = s.slice(at, lineEnd);
    const spaced = m[0].length > m[0].trimEnd().length;
    out.set(key, (spaced && raw.startsWith('#') ? '' : raw.split(/[ \t]#/)[0]!).trim());
    i = lineEnd + 1;
  }
  return [...out];
}

export interface EnvFileValues {
  env: Record<string, string>;
  /** The files read, by their paths in the folder. */
  read: string[];
  /** Not in the folder. */
  missing: string[];
  /** Not read: a link out of the folder, a folder, or too big to be an env file. */
  refused: string[];
}

/** The values of env files in a folder, a later file over an earlier one. Nothing outside the folder is ever read. */
export function readEnvFiles(top: string, files: string[]): EnvFileValues {
  const out: EnvFileValues = { env: {}, read: [], missing: [], refused: [] };
  let real: string;
  try {
    real = fs.realpathSync(top);
  } catch {
    return { ...out, missing: [...files] };
  }
  for (const f of files) {
    let file: string;
    try {
      file = fs.realpathSync(path.join(real, f));
    } catch {
      out.missing.push(f);
      continue;
    }
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!file.startsWith(`${real}${path.sep}`) || !stat?.isFile() || stat.size > ENV_FILE_BYTES) {
      out.refused.push(f);
      continue;
    }
    for (const [k, v] of parseEnvFile(fs.readFileSync(file, 'utf8'))) out.env[k] = v;
    out.read.push(f);
  }
  return out;
}

/* ── which part a folder holds ───────────────────────────── */

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The top of the git folder a folder is in, and the person's own repo folder it belongs to. A copy squad-kit made (a
 * story's, Your apps', its own) is a git worktree: its `.git` file leads to the repo it was made from.
 */
function gitTop(dir: string): { top: string; source: string; copy: boolean } | null {
  let at: string;
  try {
    at = fs.realpathSync(dir);
  } catch {
    return null;
  }
  for (;;) {
    const dotGit = path.join(at, '.git');
    const stat = fs.lstatSync(dotGit, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return { top: at, source: at, copy: false };
    if (stat?.isFile()) {
      const own = /^gitdir:\s*(.+)$/m.exec(readText(dotGit))?.[1]?.trim();
      if (!own) return null;
      const gitDir = path.resolve(at, own);
      const common = path.resolve(gitDir, readText(path.join(gitDir, 'commondir')).trim() || '.');
      if (path.basename(common) !== '.git') return null;
      try {
        return { top: at, source: fs.realpathSync(path.dirname(common)), copy: true };
      } catch {
        return null;
      }
    }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

export interface PartEnvFiles {
  /** The top of the folder: the copy, or the person's own repo folder. */
  top: string;
  repo: string;
  files: string[];
  /** A copy squad-kit made, not the person's own folder. */
  copy: boolean;
}

/** The env files of the part a folder holds, from the project's settings as they are now. Null when it has none. */
export function envFilesFor(dir: string): PartEnvFiles | null {
  try {
    const g = gitTop(dir);
    const root = g ? findSquadRoot(g.source) : null;
    if (!g || !root) return null;
    const meta = readMeta(boardPaths(path.join(root, SQUAD_DIR)));
    for (const r of reposOf(meta)) {
      let source: string;
      try {
        source = fs.realpathSync(path.join(root, r.path));
      } catch {
        continue;
      }
      if (source !== g.source) continue;
      const files = envFilesOf(r.commands);
      return files.length ? { top: g.top, repo: r.path, files, copy: g.copy } : null;
    }
  } catch {
    // A project whose settings cannot be read gives no env file: its commands run as before.
  }
  return null;
}

/**
 * The part's env files by their paths from a folder, for reading the app's settings there (engine/service-hosts.ts).
 * `copies`: only in a copy squad-kit made, where squad-kit gives the app their values itself (part-env.ts).
 */
export function envFilesIn(dir: string, copies = false): string[] {
  const part = envFilesFor(dir);
  if (!part || (copies && !part.copy)) return [];
  let from: string;
  try {
    from = fs.realpathSync(dir);
  } catch {
    return [];
  }
  return part.files.map((f) => path.relative(from, path.join(part.top, f)).split(path.sep).join('/')).filter((f) => f && !f.startsWith('..'));
}

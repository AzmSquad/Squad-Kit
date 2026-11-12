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

/** Where a value's `$NAME` is looked up, as Compose looks it up for an env file. */
export interface EnvLookup {
  /**
   * The environment looked up first, as Compose looks up the shell's: the one the command starts with, squad-kit's own
   * keys already taken out. None unless given, so nothing of squad-kit's own ever fills a value.
   */
  env?: Record<string, string | undefined>;
  /** The values of the env files read before this one: a later file reads them, as Compose's later env_file does. */
  before?: Record<string, string>;
  /**
   * A value that names a setting nothing sets: empty in its place, as Compose does (the default), or kept as written,
   * for squad-kit to learn an address only when all of it is there.
   */
  unset?: 'empty' | 'keep';
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const BRACED = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([\s\S]*))?$/;

/**
 * A value with its `$NAME`s filled in, as Compose fills an env file's: `$NAME`, `${NAME}`, `${NAME:-default}` (unset or
 * empty), `${NAME-default}` (unset), `${NAME:+other}` (set and not empty), `${NAME+other}` (set), and `${NAME:?why}`,
 * `${NAME?why}`, which stop Compose and here are only empty. A default is filled in turn, and `$$` is a `$`. A name
 * nothing sets is empty, and `unset` hears it. A `$` with no name after it stays as it is.
 */
function fill(text: string, get: (name: string) => string | undefined, unset: () => void): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('$', i);
    if (at < 0) return out + text.slice(i);
    out += text.slice(i, at);
    i = at + 1;
    if (text[i] === '$') {
      out += '$';
      i += 1;
      continue;
    }
    if (text[i] !== '{') {
      const name = NAME.exec(text.slice(i))?.[0];
      if (name) {
        const v = get(name);
        if (v === undefined) unset();
        out += v ?? '';
        i += name.length;
      } else out += '$';
      continue;
    }
    // `${...}` ends at its own closing brace, after those of any `${...}` inside it.
    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < text.length && end < 0; j++) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}' && depth) depth -= 1;
      else if (text[j] === '}') end = j;
    }
    const m = end < 0 ? null : BRACED.exec(text.slice(i + 1, end));
    if (!m) {
      // No name in it: Compose stops there; here it stays as written.
      out += '$';
      continue;
    }
    const [, name, op, word = ''] = m;
    const v = get(name!);
    const set = v !== undefined;
    const said = op?.startsWith(':') ? set && v !== '' : set;
    if (!op) {
      if (!set) unset();
      out += v ?? '';
    } else if (op.endsWith('-')) out += said ? v! : fill(word, get, unset);
    else if (op.endsWith('+')) out += said ? fill(word, get, unset) : (v ?? '');
    else {
      if (!said) unset();
      out += said ? v! : '';
    }
    i = end + 1;
  }
  return out;
}

/**
 * The settings in an env file, as Docker Compose reads it: `KEY=VALUE` lines, `export ` before a key, `#` comments on
 * their own line or after a space, single quotes as written, double quotes with `\n` and `\"`, quoted values over several
 * lines, and empty values. A line with no `=` gives nothing. Unquoted and double-quoted values have their `$NAME`s filled
 * in (`\$` is a `$`): from the environment given, then the values read before, in earlier files and earlier lines.
 */
export function parseEnvFile(text: string, o: EnvLookup = {}): [string, string][] {
  const s = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out = new Map<string, string>();
  const env = o.env ?? {};
  const known = new Map(Object.entries(o.before ?? {}));
  const get = (name: string) => (Object.hasOwn(env, name) ? env[name] : known.get(name));
  // `template` is what is filled in; `written` is the value as written, kept when it names a setting nothing sets.
  const put = (key: string, template: string, written = template) => {
    let missing = false;
    const value = fill(template, get, () => (missing = true));
    if (missing && o.unset === 'keep') {
      out.set(key, written);
      known.delete(key);
    } else {
      out.set(key, value);
      known.set(key, value);
    }
  };
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
      let t = '';
      let j = at + 1;
      while (j < s.length && s[j] !== quote) {
        if (quote === '"' && s[j] === '\\' && j + 1 < s.length) {
          v += unescape(s[j + 1]!);
          t += s[j + 1] === '$' ? '$$' : unescape(s[j + 1]!);
          j += 2;
          continue;
        }
        v += s[j];
        t += s[j];
        j += 1;
      }
      if (j < s.length) {
        // Single quotes keep the value as written; double quotes have it filled in.
        if (quote === "'") {
          out.set(key, v);
          known.set(key, v);
        } else put(key, t, v);
        const after = s.indexOf('\n', j);
        i = after < 0 ? s.length : after + 1;
        continue;
      }
      // No closing quote: the line as written, like any other.
    }
    // A `#` after a space starts a comment; in `KEY=#1` it is the value.
    const raw = s.slice(at, lineEnd);
    const spaced = m[0].length > m[0].trimEnd().length;
    put(key, (spaced && raw.startsWith('#') ? '' : raw.split(/[ \t]#/)[0]!).trim());
    i = lineEnd + 1;
  }
  return [...out];
}

export interface EnvFileValues {
  env: Record<string, string>;
  /** The file each value is from: the last one that sets it. */
  fileOf: Record<string, string>;
  /** The files read, by their paths in the folder. */
  read: string[];
  /** Not in the folder. */
  missing: string[];
  /** Not read: a link out of the folder, a folder, or too big to be an env file. */
  refused: string[];
}

/**
 * The values of env files in a folder, a later file over an earlier one, and filling its `$NAME`s from the earlier ones.
 * Nothing outside the folder is ever read.
 */
export function readEnvFiles(top: string, files: string[], o: Omit<EnvLookup, 'before'> = {}): EnvFileValues {
  const out: EnvFileValues = { env: {}, fileOf: {}, read: [], missing: [], refused: [] };
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
    for (const [k, v] of parseEnvFile(fs.readFileSync(file, 'utf8'), { ...o, before: out.env })) {
      out.env[k] = v;
      out.fileOf[k] = f;
    }
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

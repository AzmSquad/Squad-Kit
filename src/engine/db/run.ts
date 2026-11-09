import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { scrubSecrets } from '../../core/scrub.js';
import { track } from '../process-group.js';
import { DbError } from './types.js';

/**
 * Running a database's own tools (psql, pg_dump, mysql, mysqldump, mongosh, mongodump, mongorestore, sqlite3). A
 * password never goes on a command line, where any program on the computer could read it: it goes in the tool's
 * environment or in a private file squad-kit removes right after. Whatever a tool says back is cleaned of every
 * password before anyone sees it.
 */

/** Where the tools often are when they are not on the PATH: Homebrew keeps some out of it on purpose. */
function knownDirs(): string[] {
  if (process.platform === 'win32') {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((d): d is string => Boolean(d));
    const under = (root: string, ...parts: string[]) => {
      try {
        return fs.readdirSync(path.join(root, ...parts)).map((v) => path.join(root, ...parts, v, 'bin'));
      } catch {
        return [];
      }
    };
    return pf.flatMap((root) => [...under(root, 'PostgreSQL'), ...under(root, 'MySQL'), ...under(root, 'MongoDB', 'Server'), ...under(root, 'MongoDB', 'Tools'), path.join(root, 'MongoDB', 'mongosh')]);
  }
  const brew = ['/opt/homebrew', '/usr/local'];
  const kegs = ['libpq', 'postgresql@18', 'postgresql@17', 'postgresql@16', 'postgresql@15', 'postgresql@14', 'mysql-client', 'mysql', 'mysql@8.4', 'mysql@8.0', 'mariadb', 'sqlite'];
  const linux = (() => {
    try {
      return fs
        .readdirSync('/usr/lib/postgresql')
        .sort((a, b) => Number(b) - Number(a))
        .map((v) => `/usr/lib/postgresql/${v}/bin`);
    } catch {
      return [];
    }
  })();
  return [...brew.flatMap((b) => [...kegs.map((k) => `${b}/opt/${k}/bin`), `${b}/bin`]), ...linux, '/Applications/Postgres.app/Contents/Versions/latest/bin', '/usr/bin', '/bin'];
}

/** The folders squad-kit looks in for a tool. SQUAD_DB_TOOL_DIRS, when set, is the only place it looks (tests). */
function searchDirs(): string[] {
  const only = process.env.SQUAD_DB_TOOL_DIRS;
  if (only !== undefined) return only.split(path.delimiter).filter(Boolean);
  return [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...knownDirs()];
}

const exts = () => (process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']);

/** The full path of a tool, or null when this computer does not have it. `near` is looked in first. */
export function findTool(name: string, near?: string): string | null {
  const dirs = [...(near ? [path.dirname(near)] : []), ...searchDirs()];
  for (const dir of dirs) {
    for (const ext of exts()) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) {
          if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
          return file;
        }
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/** The tools in the list that this computer does not have. */
export function missing(names: string[]): string[] {
  return names.filter((n) => !findTool(n));
}

/** A tool's full path, or a plain error that says what to install. */
export function needTool(name: string, what: string, near?: string): string {
  const file = findTool(name, near);
  if (!file) throw new DbError(`${what} needs ${name}, which is not on this computer. Install the database's command line tools, then try again.`, 'missing-tool');
  return file;
}

/** Every way a password can show up in what a tool says. */
export function secretsOf(...values: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    out.add(v);
    try {
      out.add(encodeURIComponent(v));
      out.add(decodeURIComponent(v));
    } catch {
      // Not encoded.
    }
  }
  return [...out].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
}

/** The text with every given secret, and everything shaped like one, taken out. */
export function scrub(text: string, secrets: string[]): string {
  return scrubSecrets(text, secrets);
}

export interface RunOptions {
  /** Added to the tool's environment: where passwords go. */
  env?: Record<string, string | undefined>;
  /** Given to the tool as its input. */
  input?: string | Readable;
  /** The tool's output goes to this file instead of coming back, through `through` when given. */
  outFile?: string;
  through?: Transform;
  /** Taken out of anything the tool says. */
  secrets: string[];
  /** What squad-kit was doing, for the error: "Reading the database". */
  doing: string;
  timeoutMs?: number;
}

const TOOL_MS = 30 * 60_000;

/** Runs a tool and gives back its output. A failure is a DbError with what the tool said, cleaned of passwords. */
export async function runTool(file: string, args: string[], o: RunOptions): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const child = track(spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  let err = '';
  let out = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, o.timeoutMs ?? TOOL_MS);
  timer.unref();
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (d: string) => {
    if (err.length < 64_000) err += d;
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  child.stdin!.on('error', () => undefined);
  if (o.input === undefined) child.stdin!.end();
  else if (typeof o.input === 'string') child.stdin!.end(o.input);
  else o.input.pipe(child.stdin!);
  const writing = o.outFile
    ? o.through
      ? pipeline(child.stdout!, o.through, fs.createWriteStream(o.outFile))
      : pipeline(child.stdout!, fs.createWriteStream(o.outFile))
    : new Promise<void>((resolve) => {
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (d: string) => (out += d));
        child.stdout!.on('end', resolve);
      });
  let code: number | null;
  try {
    [code] = await Promise.all([done, writing]);
  } catch (e) {
    clearTimeout(timer);
    child.kill('SIGTERM');
    const why = e instanceof DbError ? e.message : scrub((e as Error).message, o.secrets);
    throw new DbError(`${o.doing} did not finish: ${why}`, e instanceof DbError ? e.reason : 'failed');
  }
  clearTimeout(timer);
  if (timedOut) throw new DbError(`${o.doing} took too long and was stopped.`, 'failed');
  if (code !== 0) {
    // The lines that say what went wrong, when a tool also writes what it was doing.
    const lines = err.trim().split('\n');
    const wrong = lines.filter((l) => /error|failed|fatal|denied|refused|not found|does not exist|unknown/i.test(l));
    const said = scrub((wrong.length ? wrong : lines).slice(-6).join('\n'), o.secrets);
    throw new DbError(`${o.doing} did not work. ${path.basename(file)} said: ${said || `it stopped with code ${code}`}`, 'failed');
  }
  return out;
}

/** A transform that hands each line of text to `fn` and writes what it gives back. */
export function lineByLine(fn: (line: string) => string): Transform {
  let rest = '';
  // A letter can be cut between two chunks (Arabic is two bytes a letter): the decoder holds the half until the rest comes.
  const text8 = new StringDecoder('utf8');
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const text = rest + text8.write(chunk);
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      try {
        cb(null, lines.length ? lines.map(fn).join('\n') + '\n' : '');
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      try {
        rest += text8.end();
        cb(null, rest ? fn(rest) : '');
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

/**
 * A private folder for files that hold a password for one tool run (MySQL's option file, the Mongo tools' config),
 * removed when the work is done, whatever happens.
 */
export async function withPrivateDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-db-'));
  fs.chmodSync(dir, 0o700);
  try {
    return await work(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes a file only its owner can read. */
export function writePrivate(file: string, text: string): void {
  fs.writeFileSync(file, text, { mode: 0o600 });
}

/** The size of a folder's files, in bytes. */
export function folderBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    // Gone.
  }
  return total;
}

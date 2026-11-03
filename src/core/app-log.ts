import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { squadHome } from './home.js';
import { scrubSecrets } from './scrub.js';

/**
 * squad-kit's own log (phase 10): engine events and errors with the time, the project and the ticket, one file a day
 * in ~/.squad-kit/logs/, kept 14 days. It never holds secrets, tokens or what was sent to an agent: callers only pass
 * squad-kit's own words and error messages, and every line is scrubbed. Errors also print in the terminal that runs
 * the app, so an engineer watching it sees them as they happen.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  level?: LogLevel;
  /** The project's name; left out for the app itself. */
  project?: string;
  ticket?: string;
  text: string;
}

export const KEEP_DAYS = 14;
/** A day's file stops taking events here. Errors still get some room after it. */
export const DAY_CAP = 2 * 1024 * 1024;
const ERROR_ROOM = 512 * 1024;
const LINE_MAX = 4000;
const FULL = 'The log for today is full. Only errors are kept until midnight.';

let toTerminal = false;
let prunedOn = '';
let fullOn = '';

/** The app prints its errors in the terminal it runs in; tests and one-off commands stay quiet. */
export function printErrors(on: boolean): void {
  toTerminal = on;
}

export function logsDir(): string {
  return path.join(squadHome(), 'logs');
}

/** "2026-11-03", in this computer's time: one file a day. */
function dayName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function logFile(d = new Date()): string {
  return path.join(logsDir(), `${dayName(d)}.log`);
}

/** One line: "2026-11-03T14:05:12.345Z error [roomflow] RO-7  Stopped at build: …". */
export function logLine(e: LogEntry, at = new Date()): string {
  const where = `[${e.project?.trim() || 'app'}]${e.ticket ? ` ${e.ticket}` : ''}`;
  const text = scrubSecrets(e.text).replace(/\s*\r?\n\s*/g, ' | ').slice(0, LINE_MAX);
  return `${at.toISOString()} ${(e.level ?? 'info').padEnd(5)} ${where}  ${text}`;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Writes one event. Logging never fails the work it describes. */
export function writeLog(e: LogEntry, at = new Date()): void {
  const level = e.level ?? 'info';
  const line = logLine(e, at);
  if (toTerminal && level === 'error') process.stderr.write(`${kleur.red('squad-kit error')} ${line.slice(25)}\n`);
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    const day = dayName(at);
    if (prunedOn !== day) {
      prunedOn = day;
      pruneLogs(at.getTime());
    }
    const file = logFile(at);
    const size = sizeOf(file);
    if (size >= DAY_CAP + ERROR_ROOM || (size >= DAY_CAP && level !== 'error')) {
      // Said once, so a full day reads as full, not as quiet.
      if (fullOn !== day && size < DAY_CAP + ERROR_ROOM) fs.appendFileSync(file, `${logLine({ level: 'warn', text: FULL }, at)}\n`);
      fullOn = day;
      return;
    }
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // A full disk or a read-only home: the work goes on without its log.
  }
}

export const log = {
  info: (text: string, where: Omit<LogEntry, 'text' | 'level'> = {}) => writeLog({ ...where, level: 'info', text }),
  warn: (text: string, where: Omit<LogEntry, 'text' | 'level'> = {}) => writeLog({ ...where, level: 'warn', text }),
  error: (text: string, where: Omit<LogEntry, 'text' | 'level'> = {}) => writeLog({ ...where, level: 'error', text }),
};

/** Days older than {@link KEEP_DAYS} go. */
export function pruneLogs(now = Date.now()): void {
  const oldest = dayName(new Date(now - KEEP_DAYS * 86_400_000));
  try {
    for (const f of fs.readdirSync(logsDir())) {
      const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1]! < oldest) fs.rmSync(path.join(logsDir(), f), { force: true });
    }
  } catch {
    // No logs yet.
  }
}

/** The log files there are, oldest first. */
export function logFiles(): string[] {
  try {
    return fs
      .readdirSync(logsDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
      .map((f) => path.join(logsDir(), f));
  } catch {
    return [];
  }
}

/** The lines written in the last `ms` (24 hours for Report a problem), oldest first, at most `maxBytes` of them. */
export function recentLines(ms: number, now = Date.now(), maxBytes = 3 * 1024 * 1024): string[] {
  const since = new Date(now - ms).toISOString();
  const first = dayName(new Date(now - ms - 86_400_000));
  const lines: string[] = [];
  for (const file of logFiles().filter((f) => path.basename(f, '.log') >= first)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const l of text.split('\n')) if (l && l.slice(0, 24) >= since) lines.push(l);
  }
  let bytes = 0;
  let from = lines.length;
  while (from > 0 && bytes + lines[from - 1]!.length + 1 <= maxBytes) bytes += lines[--from]!.length + 1;
  return lines.slice(from);
}

/** The last `n` lines of the log, across days. */
export function tailLines(n: number): string[] {
  const out: string[] = [];
  for (const file of logFiles().reverse()) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    out.unshift(...text.split('\n').filter(Boolean));
    if (out.length >= n) break;
  }
  return out.slice(-n);
}

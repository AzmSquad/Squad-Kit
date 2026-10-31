import { execFileSync } from 'node:child_process';

/**
 * Nothing the squad runs may hang without the person knowing. Every running step reports progress; when it goes
 * quiet, the watchdog looks at the real processes under it to tell "busy for a long time" from "stuck": a command
 * that has not used the CPU for minutes is usually waiting on the network or on a question nobody will answer.
 */

export interface ProcRow {
  pid: number;
  ppid: number;
  cpuSec: number;
  elapsedSec: number;
  command: string;
}

export interface Quiet {
  since: string;
  kind: 'stuck' | 'long';
  /** One plain sentence for the person. */
  detail: string;
  command?: string;
  pid?: number;
}

/** "1-02:03:04", "02:03:04", "03:04" or "03:04.56" in seconds. */
export function parseClock(s: string): number {
  const [days, rest] = s.includes('-') ? s.split('-') : ['0', s];
  const parts = (rest ?? '').split(':').map((p) => parseFloat(p));
  let sec = 0;
  for (const p of parts) sec = sec * 60 + (Number.isFinite(p) ? p : 0);
  return Number(days) * 86_400 + sec;
}

export function processTable(): ProcRow[] {
  if (process.platform === 'win32') return [];
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,time=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return out
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), elapsedSec: parseClock(m[3]!), cpuSec: parseClock(m[4]!), command: m[5]! }));
  } catch {
    return [];
  }
}

export function descendants(rows: ProcRow[], root: number): ProcRow[] {
  const out: ProcRow[] = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const r of rows) {
      if (r.ppid === parent) {
        out.push(r);
        queue.push(r.pid);
      }
    }
  }
  return out;
}

const SHELL = /^(\S*\/)?(zsh|bash|sh|dash|fish)(\s|$)|^(\S*\/)?(tail|head|tee|cat|sleep)(\s|$)/;

/** The command the step is really waiting on: the oldest process under it that is not a shell or a pipe helper. */
export function waitingOn(rows: ProcRow[], root: number): ProcRow | null {
  const kids = descendants(rows, root).filter((r) => !SHELL.test(r.command));
  if (!kids.length) return null;
  return kids.reduce((a, b) => (b.elapsedSec > a.elapsedSec ? b : a));
}

function short(command: string): string {
  const c = command.replace(/^\S*\/(node|python3?)\s+/, '').replace(/^\S*\/([\w.-]+)/, '$1');
  return c.length > 70 ? `${c.slice(0, 69)}…` : c;
}

function mins(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export class Watchdog {
  private beats = new Map<string, { at: number; pid?: number }>();
  /** Last CPU reading per process, to see if it is doing anything. */
  private cpu = new Map<number, { cpuSec: number; at: number; idleSince: number }>();

  constructor(
    private readonly quietMs = 3 * 60_000,
    private readonly idleMs = 2 * 60_000,
    private readonly longMs = 12 * 60_000,
    private readonly table: () => ProcRow[] = processTable,
  ) {}

  /** The step did something visible: a tool call, a line of output. */
  beat(key: string, pid?: number): void {
    const prev = this.beats.get(key);
    this.beats.set(key, { at: Date.now(), pid: pid ?? prev?.pid });
  }

  /** The process that runs the step, so the watchdog can look under it. */
  track(key: string, pid: number): void {
    this.beats.set(key, { at: this.beats.get(key)?.at ?? Date.now(), pid });
  }

  forget(key: string): void {
    this.beats.delete(key);
  }

  /** Null while the step shows progress; otherwise what it is waiting on and whether that looks stuck. */
  check(key: string, now = Date.now(), rows?: ProcRow[]): Quiet | null {
    const b = this.beats.get(key);
    if (!b) return null;
    const quietFor = now - b.at;
    if (quietFor < this.quietMs) return null;
    const since = new Date(b.at).toISOString();
    const table = rows ?? this.table();
    const proc = b.pid ? waitingOn(table, b.pid) : null;
    const root = b.pid ? table.find((r) => r.pid === b.pid) : undefined;
    const watched = proc ?? root;
    if (!watched) {
      return quietFor >= this.longMs ? { since, kind: 'long', detail: `No progress for ${mins(quietFor / 1000)}.` } : null;
    }
    const seen = this.cpu.get(watched.pid);
    if (!seen || watched.cpuSec - seen.cpuSec > 0.5) {
      this.cpu.set(watched.pid, { cpuSec: watched.cpuSec, at: now, idleSince: now });
    }
    const idleFor = now - (this.cpu.get(watched.pid)?.idleSince ?? now);
    const what = proc ? short(proc.command) : 'Claude Code';
    if (idleFor >= this.idleMs) {
      return {
        since,
        kind: 'stuck',
        detail: proc
          ? `${what} has run for ${mins(proc.elapsedSec)} and has done nothing for ${mins(idleFor / 1000)}. It may be waiting on the network or on a question.`
          : `Claude Code has not answered for ${mins(quietFor / 1000)}. It may be waiting on the model or the network.`,
        ...(proc ? { command: what, pid: proc.pid } : {}),
      };
    }
    if (quietFor >= this.longMs) {
      return {
        since,
        kind: 'long',
        detail: `${what} has been working for ${mins(quietFor / 1000)} with no other progress.`,
        ...(proc ? { command: what, pid: proc.pid } : {}),
      };
    }
    return null;
  }
}

/** Ends a stuck command and everything it started, so the role gets an error back and carries on. */
export function endProcessTree(pid: number, rows: ProcRow[] = processTable()): number {
  const all = [...descendants(rows, pid).reverse(), { pid }];
  let ended = 0;
  for (const p of all) {
    try {
      process.kill(p.pid, 'SIGTERM');
      ended += 1;
    } catch {
      // Already gone.
    }
  }
  return ended;
}

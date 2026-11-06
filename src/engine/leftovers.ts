import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { worktreeRoot } from './git.js';
import { runningPids } from './process-group.js';
import { reposOf } from './repos.js';

/**
 * Nothing is left behind. A program a step started can outlive it: a server an agent ran in the background, a test
 * runner's web server, anything that left its parent or started a process group of its own. Process groups don't catch
 * those, so squad-kit also finds them by where they run. A process whose working folder is inside one of squad-kit's
 * own copies of the project (~/.squad-kit/worktrees/<project>/...), that no run of this squad-kit owns now, is a
 * leftover, and squad-kit stops it.
 *
 * Never touched: a process anywhere else, the copies Your apps run from (they live elsewhere, see run-app.ts), this
 * squad-kit and what it runs now, and a program on a terminal of the person's own.
 *
 * macOS and Linux read the working folder from lsof or /proc. Windows has no reliable way to read another process's
 * working folder without native code, so there no leftover is found by its folder: squad-kit relies on stopping each
 * process it started (process-group.ts), and only tells who holds a port (netstat), never stopping it on its own.
 */

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  /** Its terminal, or '' when it has none. */
  tty: string;
  command: string;
}

export interface Leftover extends Proc {
  cwd: string;
  /** The TCP ports it listens on. */
  ports: number[];
}

const NO_TTY = new Set(['?', '??', '-', '']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits are timed on the clock that never jumps, so a wall clock set back or forward never makes one hang. */
const clock = () => performance.now();
const LOOK = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 5000 };

/** Every process the system lists, from ps (macOS and Linux). */
export function processes(): Proc[] {
  if (process.platform === 'win32') return [];
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,tty=,command='], LOOK)
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tty: NO_TTY.has(m[4]!) ? '' : m[4]!, command: m[5]! }));
  } catch {
    return [];
  }
}

/** The output of a look that may exit with an error once some process is gone meanwhile (lsof does). */
function lookAt(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, LOOK);
  } catch (err) {
    return String((err as { stdout?: unknown }).stdout ?? '');
  }
}

const hasProc = () => process.platform === 'linux' && fs.existsSync('/proc/self/cwd');

/** The working folder of each process, where the system can tell: /proc on Linux, lsof on a Mac. */
export function workingFolders(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!pids.length || process.platform === 'win32') return out;
  if (hasProc()) {
    for (const pid of pids) {
      try {
        out.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // Gone, or someone else's.
      }
    }
    return out;
  }
  for (let i = 0; i < pids.length; i += 400) {
    let pid = 0;
    for (const line of lookAt('lsof', ['-a', '-d', 'cwd', '-p', pids.slice(i, i + 400).join(','), '-Fpn']).split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
    }
  }
  return out;
}

/** Socket inodes of the TCP ports listened on, from /proc/net (Linux). */
function listenInodes(): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // State 0A is LISTEN; the port is the hex after the colon of the local address.
      if (cols[3] !== '0A' || !cols[1] || !cols[9]) continue;
      out.set(cols[9], parseInt(cols[1].split(':')[1] ?? '0', 16));
    }
  }
  return out;
}

/** The TCP ports each process listens on: /proc on Linux, lsof on a Mac. */
export function listeningPorts(pids: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (!pids.length || process.platform === 'win32') return out;
  const add = (pid: number, port: number) => {
    if (!port) return;
    const list = out.get(pid) ?? [];
    if (!list.includes(port)) list.push(port);
    out.set(pid, list);
  };
  if (hasProc()) {
    const inodes = listenInodes();
    for (const pid of pids) {
      try {
        for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
          const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
          const port = m ? inodes.get(m[1]!) : undefined;
          if (port) add(pid, port);
        }
      } catch {
        // Gone, or someone else's.
      }
    }
    return out;
  }
  let pid = 0;
  for (const line of lookAt('lsof', ['-a', '-nP', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-Fpn']).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) add(pid, Number(/:(\d+)$/.exec(line)?.[1] ?? 0));
  }
  return out;
}

/** The process listening on a port, when the system can tell. */
export function listenerOn(port: number): { pid: number; program: string } | null {
  if (process.platform === 'win32') {
    for (const line of lookAt('netstat', ['-ano', '-p', 'TCP']).split('\n')) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
      if (m && Number(m[1]) === port && Number(m[2]) > 0) return { pid: Number(m[2]), program: '' };
    }
    return null;
  }
  if (!hasProc()) {
    const text = lookAt('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
    const pid = Number(/^p(\d+)/m.exec(text)?.[1]);
    return pid ? { pid, program: /^c(.+)$/m.exec(text)?.[1] ?? '' } : null;
  }
  const rows = processes();
  const ports = listeningPorts(rows.map((r) => r.pid));
  const row = rows.find((r) => ports.get(r.pid)?.includes(port));
  return row ? { pid: row.pid, program: path.basename(row.command.split(/\s+/)[0] ?? '') } : null;
}

/** A folder and the real path it stands for (on a Mac /var is /private/var), so either spelling matches. */
function spellings(dir: string): string[] {
  const out = [path.resolve(dir)];
  try {
    out.push(fs.realpathSync.native(dir));
  } catch {
    // Not there (any more): its plain spelling stands.
  }
  return [...new Set(out)];
}

/** The folder of `dirs` that `cwd` is in (or is), else null. */
export function folderOf(cwd: string, dirs: string[]): string | null {
  for (const d of dirs) {
    for (const s of spellings(d)) {
      const rel = path.relative(s, cwd);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return d;
    }
  }
  return null;
}

/**
 * What this squad-kit owns now, so it is never a leftover: itself and the processes above it, everything still under
 * it, and every process group it started that still runs (a program in one of those ends with its run).
 */
function ownedNow(rows: Proc[]): Set<number> {
  const owned = new Set<number>([process.pid]);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  for (let up = byPid.get(process.pid)?.ppid; up && up > 1 && !owned.has(up); up = byPid.get(up)?.ppid) owned.add(up);
  const kids = new Map<number, number[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const queue = [process.pid];
  while (queue.length) {
    for (const k of kids.get(queue.pop()!) ?? []) {
      if (owned.has(k)) continue;
      owned.add(k);
      queue.push(k);
    }
  }
  const groups = new Set(runningPids());
  for (const r of rows) if (groups.has(r.pgid)) owned.add(r.pid);
  return owned;
}

/** True for this squad-kit, what is above it, and what it runs now: never a leftover, and never stopped for an agent. */
export function ownedBySquadKit(pid: number): boolean {
  return pid <= 1 || ownedNow(processes()).has(pid);
}

export interface LookOptions {
  /** Folders inside `dirs` to leave alone: the copies of steps running now, of a ticket taken over. */
  busy?: string[];
  /** Only the ones that listen on a port. */
  listening?: boolean;
}

/** The leftovers in squad-kit's copies `dirs`, with the ports they listen on. Nothing is stopped. */
export function leftoversIn(dirs: string[], opts: LookOptions = {}): Leftover[] {
  if (!dirs.length || process.platform === 'win32') return [];
  const rows = processes();
  const owned = ownedNow(rows);
  // A program on a terminal is the person's own (a shell in the copy, a tool they run there); this squad-kit's own
  // terminal is the one exception, as the programs it starts may share it.
  const mine = rows.find((r) => r.pid === process.pid)?.tty ?? '';
  const maybe = rows.filter((r) => !owned.has(r.pid) && (!r.tty || r.tty === mine));
  const cwds = workingFolders(maybe.map((r) => r.pid));
  const found = maybe
    .map((r) => ({ ...r, cwd: cwds.get(r.pid) ?? '' }))
    .filter((r) => r.cwd && folderOf(r.cwd, dirs) && !folderOf(r.cwd, opts.busy ?? []));
  const ports = listeningPorts(found.map((r) => r.pid));
  return found.map((r) => ({ ...r, ports: (ports.get(r.pid) ?? []).sort((a, b) => a - b) })).filter((r) => !opts.listening || r.ports.length);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Gone already, or not ours to signal.
  }
}

/**
 * Stops the leftovers in `dirs`: each by itself (never a whole group, which may hold something outside the copies),
 * TERM first, then KILL for what is still there after `graceMs`, looked at again first so a process number used again
 * meanwhile is never hit. Says what it stopped. The TERM goes out before this returns its promise.
 */
export async function stopLeftovers(dirs: string[], opts: LookOptions & { graceMs?: number; only?: number[] } = {}): Promise<Leftover[]> {
  const found = leftoversIn(dirs, opts).filter((p) => !opts.only || opts.only.includes(p.pid));
  if (!found.length) return [];
  for (const p of found) signal(p.pid, 'SIGTERM');
  const until = clock() + (opts.graceMs ?? 3000);
  while (found.some((p) => alive(p.pid)) && clock() < until) await sleep(100);
  if (found.some((p) => alive(p.pid))) {
    const still = new Set(leftoversIn(dirs, { busy: opts.busy ?? [] }).map((p) => p.pid));
    for (const p of found) if (still.has(p.pid)) signal(p.pid, 'SIGKILL');
    const gone = clock() + 2000;
    while (found.some((p) => still.has(p.pid) && alive(p.pid)) && clock() < gone) await sleep(100);
  }
  return found;
}

/** Waits until no run squad-kit started works inside `dirs` any more, for at most `ms`: what it leaves shows only then. */
export async function runsEnded(dirs: string[], ms: number): Promise<void> {
  const until = clock() + ms;
  while (clock() < until) {
    const live = runningPids();
    if (!live.length || ![...workingFolders(live).values()].some((c) => folderOf(c, dirs))) return;
    await sleep(150);
  }
}

/* ── squad-kit's own copies of a project ─────────────── */

/** The folders that hold squad-kit's copies of the project's code: one per repo. Your apps run from elsewhere. */
export function projectCopies(bp: BoardPaths): string[] {
  let repos: string[] = ['.'];
  try {
    repos = reposOf(readMeta(bp)).map((r) => r.path);
  } catch {
    // An unreadable board: the project folder itself stands.
  }
  // A workspace's story folders sit under the project's own name.
  return [...new Set([...repos.map((r) => worktreeRoot(path.join(bp.root, r))), ...(repos.length > 1 || repos[0] !== '.' ? [worktreeRoot(bp.root), path.join(bp.localDir, 'product')] : [])])];
}

/** A ticket's own copies: its worktree, and the copy of the code as it was that its before screenshots run in. */
export function ticketCopies(bp: BoardPaths, t: Pick<Ticket, 'id' | 'worktree' | 'storyDir'>): string[] {
  const roots = projectCopies(bp);
  const name = t.id.toLowerCase();
  const own = t.storyDir ? [t.storyDir] : t.worktree ? [t.worktree] : roots.map((r) => path.join(r, name));
  return [...new Set([...own, ...[...roots, ...own.map((w) => path.dirname(w))].map((r) => path.join(r, `${name}-before`))])];
}

/** Whose copy a folder is, in words: "this ticket's copy", "MA-4's copy". */
export function copyWords(bp: BoardPaths, cwd: string, t?: Pick<Ticket, 'id' | 'worktree' | 'storyDir'>, ids: string[] = []): string {
  if (t && folderOf(cwd, ticketCopies(bp, t))) return "this ticket's copy";
  const root = folderOf(cwd, projectCopies(bp));
  const first = root ? path.relative(spellings(root).find((s) => folderOf(cwd, [s])) ?? root, cwd).split(path.sep)[0] ?? '' : '';
  const id = ids.find((x) => [x.toLowerCase(), `${x.toLowerCase()}-before`].includes(first));
  return id ? `${id}'s copy` : 'another copy squad-kit made of this project';
}

/**
 * One plain line per copy with a server stopped ("Stopped a leftover test server from this ticket's copy"), and one
 * for the other programs of a copy without a server. A server's helpers (the npm that started it) go with its line.
 */
export function stoppedLines(found: Leftover[], words: (cwd: string) => string): string[] {
  const lines: string[] = [];
  const byCopy = new Map<string, Leftover[]>();
  for (const p of found) byCopy.set(words(p.cwd), [...(byCopy.get(words(p.cwd)) ?? []), p]);
  for (const [copy, list] of byCopy) {
    const ports = [...new Set(list.flatMap((p) => p.ports))].sort((a, b) => a - b);
    if (ports.length) {
      lines.push(`Stopped ${ports.length === 1 ? 'a leftover test server' : 'leftover test servers'} from ${copy}`);
      continue;
    }
    lines.push(`Stopped ${list.length === 1 ? 'a program' : `${list.length} programs`} left running in ${copy}`);
  }
  return lines;
}

/** Stops one process the person asked squad-kit to stop: TERM, then KILL when it is still there after `graceMs`. */
export async function endProcess(pid: number, graceMs = 3000): Promise<void> {
  signal(pid, 'SIGTERM');
  const until = clock() + graceMs;
  while (alive(pid) && clock() < until) await sleep(100);
  if (alive(pid)) signal(pid, 'SIGKILL');
  const gone = clock() + 2000;
  while (alive(pid) && clock() < gone) await sleep(100);
}

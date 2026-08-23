import fs, { createWriteStream, type WriteStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { SquadPaths } from './paths.js';
import type { PlannerEvent } from '../planner/events.js';
import { RUN_EVENT_JSONL_UNCOMPRESSED_HEAD, RUN_HISTORY_RING_SIZE } from './run-retention.js';

const SUFFIX_JSONL = '.events.jsonl';
const SUFFIX_GZ = '.events.jsonl.gz';

export function redactPlannerEventForDisk(e: PlannerEvent): PlannerEvent {
  if (e.kind === 'thinking_delta') return { ...e, delta: '' };
  if (e.kind === 'auth_info') {
    // `mode`, `reason`, `credentialHint`, and `apiKeySource` are safe to keep; the account block
    // (email, organization, plan) is live-stream only and never touches disk.
    const { account: _account, ...rest } = e;
    return rest;
  }
  return e;
}

function runsDir(paths: SquadPaths): string {
  return path.join(paths.squadDir, 'runs');
}

function logAppendErrorOnce(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[run-events-store] append failed:', err);
}

export interface RunEventsStore {
  append(e: PlannerEvent): Promise<void>;
  close(): Promise<void>;
  bytesWritten(): number;
}

class RunEventsStoreImpl implements RunEventsStore {
  private stream: WriteStream | null;
  private bytes = 0;
  private closed = false;
  private loggedError = false;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.stream = createWriteStream(file, { flags: 'a' });
    this.stream.on('error', (err) => {
      if (!this.loggedError) {
        this.loggedError = true;
        logAppendErrorOnce(err);
      }
    });
  }

  bytesWritten(): number {
    return this.bytes;
  }

  async append(e: PlannerEvent): Promise<void> {
    if (!this.stream || this.closed) return;
    const line = JSON.stringify(redactPlannerEventForDisk(e)) + '\n';
    this.bytes += Buffer.byteLength(line, 'utf8');
    await new Promise<void>((resolve) => {
      const s = this.stream;
      if (!s) {
        resolve();
        return;
      }
      s.write(line, (err) => {
        if (err && !this.loggedError) {
          this.loggedError = true;
          logAppendErrorOnce(err);
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const s = this.stream;
    this.stream = null;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.end(() => resolve());
      s.on('error', () => resolve());
    });
  }
}

export function createRunEventsStore(paths: SquadPaths, runId: string): RunEventsStore {
  const dir = runsDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}${SUFFIX_JSONL}`);
  return new RunEventsStoreImpl(file);
}

export interface RunEventsReader {
  iterate(opts?: { fromIndex?: number; limit?: number }): AsyncIterable<PlannerEvent>;
  count(): Promise<number>;
}

class RunEventsReaderImpl implements RunEventsReader {
  private readonly filePath: string;
  private useGunzip: boolean;
  private _count: number | null = null;

  constructor(filePath: string, useGunzip: boolean) {
    this.filePath = filePath;
    this.useGunzip = useGunzip;
  }

  async count(): Promise<number> {
    if (this._count !== null) return this._count;
    let n = 0;
    for await (const _ of this.iterate()) {
      n++;
    }
    this._count = n;
    return n;
  }

  async *iterate(opts?: { fromIndex?: number; limit?: number }): AsyncIterable<PlannerEvent> {
    const fromIndex = Math.max(0, opts?.fromIndex ?? 0);
    const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
    let logical = 0;
    let yielded = 0;

    const stream = fs.createReadStream(this.filePath);
    const input: NodeJS.ReadableStream = this.useGunzip ? stream.pipe(zlib.createGunzip()) : stream;

    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev: PlannerEvent;
        try {
          ev = JSON.parse(trimmed) as PlannerEvent;
        } catch {
          continue;
        }
        if (logical >= fromIndex && yielded < limit) {
          yield ev;
          yielded++;
          if (yielded >= limit) break;
        }
        logical++;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }
}

export async function openRunEventsReader(paths: SquadPaths, runId: string): Promise<RunEventsReader | null> {
  const dir = runsDir(paths);
  const jsonl = path.join(dir, `${runId}${SUFFIX_JSONL}`);
  const gz = path.join(dir, `${runId}${SUFFIX_GZ}`);
  let jsonlStat: { mtimeMs: number } | null = null;
  let gzStat: { mtimeMs: number } | null = null;
  try {
    jsonlStat = await fsPromises.stat(jsonl).then((s) => ({ mtimeMs: s.mtimeMs }));
  } catch {
    jsonlStat = null;
  }
  try {
    gzStat = await fsPromises.stat(gz).then((s) => ({ mtimeMs: s.mtimeMs }));
  } catch {
    gzStat = null;
  }
  // If both exist (crash window), prefer the gzip artifact — reader ignores orphan `.jsonl` until removed.
  if (gzStat && jsonlStat) return new RunEventsReaderImpl(gz, true);
  if (gzStat) return new RunEventsReaderImpl(gz, true);
  if (jsonlStat) return new RunEventsReaderImpl(jsonl, false);
  return null;
}

interface EventLogEntry {
  runId: string;
  mtimeMs: number;
  jsonlPath: string | null;
  gzPath: string | null;
}

let rotateChain: Promise<void> = Promise.resolve();

function collectEventLogs(dir: string, names: string[]): EventLogEntry[] {
  const byRun = new Map<string, { mtimeMs: number; jsonlPath: string | null; gzPath: string | null }>();
  for (const name of names) {
    let runId: string | null = null;
    let kind: 'jsonl' | 'gz' | null = null;
    if (name.endsWith(SUFFIX_GZ)) {
      runId = name.slice(0, -SUFFIX_GZ.length);
      kind = 'gz';
    } else if (name.endsWith(SUFFIX_JSONL)) {
      runId = name.slice(0, -SUFFIX_JSONL.length);
      kind = 'jsonl';
    }
    if (!runId || !kind) continue;
    const full = path.join(dir, name);
    let st: { mtimeMs: number };
    try {
      st = { mtimeMs: fs.statSync(full).mtimeMs };
    } catch {
      continue;
    }
    const cur = byRun.get(runId) ?? { mtimeMs: 0, jsonlPath: null, gzPath: null };
    cur.mtimeMs = Math.max(cur.mtimeMs, st.mtimeMs);
    if (kind === 'jsonl') cur.jsonlPath = full;
    else cur.gzPath = full;
    byRun.set(runId, cur);
  }
  const out: EventLogEntry[] = [];
  for (const [runId, v] of byRun) {
    out.push({ runId, mtimeMs: v.mtimeMs, jsonlPath: v.jsonlPath, gzPath: v.gzPath });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

async function fsyncFile(filePath: string): Promise<void> {
  const fh = await fsPromises.open(filePath, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function gzipAtomic(jsonlPath: string, gzPath: string): Promise<void> {
  const gzTmp = `${gzPath}.tmp`;
  await fsPromises.rm(gzTmp, { force: true });

  await pipeline(fs.createReadStream(jsonlPath), zlib.createGzip(), fs.createWriteStream(gzTmp));
  await fsyncFile(gzTmp);
  await fsPromises.rename(gzTmp, gzPath);
  await fsPromises.unlink(jsonlPath);
}

async function rotateRunEventsUnlocked(paths: SquadPaths): Promise<void> {
  const dir = runsDir(paths);
  let names: string[];
  try {
    names = await fsPromises.readdir(dir);
  } catch {
    return;
  }

  for (const name of names) {
    if (name.endsWith(`${SUFFIX_GZ}.tmp`)) {
      await fsPromises.rm(path.join(dir, name), { force: true });
    }
  }

  names = await fsPromises.readdir(dir);
  const ordered = collectEventLogs(dir, names);

  for (let i = RUN_HISTORY_RING_SIZE; i < ordered.length; i++) {
    const e = ordered[i]!;
    const summary = path.join(dir, `${e.runId}.json`);
    await fsPromises.rm(summary, { force: true });
    if (e.jsonlPath) await fsPromises.rm(e.jsonlPath, { force: true });
    if (e.gzPath) await fsPromises.rm(e.gzPath, { force: true });
  }

  const keep = ordered.slice(0, RUN_HISTORY_RING_SIZE);
  for (let i = RUN_EVENT_JSONL_UNCOMPRESSED_HEAD; i < keep.length; i++) {
    const e = keep[i]!;
    const jsonl = e.jsonlPath;
    if (!jsonl) continue;
    const gz = path.join(dir, `${e.runId}${SUFFIX_GZ}`);
    await gzipAtomic(jsonl, gz);
  }
}

/** Apply gzip rotation: leave RUN_EVENT_JSONL_UNCOMPRESSED_HEAD newest uncompressed, gzip the rest within the ring, drop oldest beyond RUN_HISTORY_RING_SIZE. */
export function rotateRunEvents(paths: SquadPaths): Promise<void> {
  rotateChain = rotateChain.then(() => rotateRunEventsUnlocked(paths)).catch(() => {});
  return rotateChain;
}

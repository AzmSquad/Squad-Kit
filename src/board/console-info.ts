import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../core/home.js';
import { takenOver } from '../engine/process-group.js';
import type { BoardPaths } from './store.js';

/**
 * One board per project. The running board records where it lives (port, link token, which squad-kit build), so a
 * second `squad console` points to it instead of starting a second squad, and a restart keeps the same link.
 */

export interface ConsoleInfo {
  pid: number | null;
  port: number;
  token: string;
  startedAt: string;
  version: string;
  /** When the squad-kit code it runs was built; a newer build on disk means the board should restart. */
  build: number;
}

function infoFile(bp: BoardPaths): string {
  return bp.consoleFile;
}

export function readConsoleInfo(bp: BoardPaths): ConsoleInfo | null {
  try {
    return JSON.parse(fs.readFileSync(infoFile(bp), 'utf8')) as ConsoleInfo;
  } catch {
    return null;
  }
}

/** The link token is a secret for this computer only, so the file is readable by the owner alone. */
export function writeConsoleInfo(bp: BoardPaths, info: ConsoleInfo): void {
  fs.mkdirSync(bp.localDir, { recursive: true });
  fs.writeFileSync(infoFile(bp), `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** The one app on this computer (ADR-001) records where it runs the same way, in ~/.squad-kit/app.json. */
function appFile(): string {
  return path.join(squadHome(), 'app.json');
}

export function readAppInfo(): ConsoleInfo | null {
  try {
    return JSON.parse(fs.readFileSync(appFile(), 'utf8')) as ConsoleInfo;
  } catch {
    return null;
  }
}

export function writeAppInfo(info: ConsoleInfo): void {
  fs.mkdirSync(squadHome(), { recursive: true });
  fs.writeFileSync(appFile(), `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** The app, when it runs in another process. */
export function runningApp(): (ConsoleInfo & { pid: number }) | null {
  const info = readAppInfo();
  return info && isAlive(info.pid) && !takenOver(info.pid, info.startedAt) ? (info as ConsoleInfo & { pid: number }) : null;
}

export function isAlive(pid: number | null | undefined): pid is number {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The board already running for this project, if any. Older boards only left their pid in squad.pid. */
export function runningConsole(bp: BoardPaths): (Partial<ConsoleInfo> & { pid: number }) | null {
  const info = readConsoleInfo(bp);
  if (info && isAlive(info.pid) && !takenOver(info.pid, info.startedAt)) return info as ConsoleInfo & { pid: number };
  // A board started before the move kept its files in .squad/board.
  for (const file of [bp.pidFile, path.join(bp.legacyDir, 'console.json'), path.join(bp.legacyDir, 'squad.pid')]) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      const pid = file.endsWith('.json') ? Number((JSON.parse(text) as ConsoleInfo).pid) : Number(text);
      if (isAlive(pid)) return file.endsWith('.json') ? ({ ...(JSON.parse(text) as ConsoleInfo), pid }) : { pid };
    } catch {
      // No such file.
    }
  }
  return null;
}

/** When the squad-kit code that is running now was built. */
export function buildStamp(entry = process.argv[1]): number {
  try {
    return Math.round(fs.statSync(fs.realpathSync(entry ?? '')).mtimeMs);
  } catch {
    return 0;
  }
}

/** Stops a board the way Ctrl-C does, then harder if it does not stop in time. */
export async function stopConsole(pid: number, waitMs = 20_000): Promise<boolean> {
  const gone = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!isAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return !isAlive(pid);
  };
  try {
    process.kill(pid, 'SIGINT');
  } catch {
    return true;
  }
  if (await gone(waitMs)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true;
  }
  return gone(5_000);
}

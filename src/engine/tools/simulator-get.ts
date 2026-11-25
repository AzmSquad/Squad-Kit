import { spawn } from 'node:child_process';
import { writeLog } from '../../core/app-log.js';
import { OWN_GROUP, endGroup } from '../process-group.js';
import { GetTrouble, setTrouble, startOne, type Getting } from './get.js';

/**
 * The iPhone simulator, got by Xcode's own download: `xcodebuild -downloadPlatform iOS`, Apple's command, from Apple,
 * into Xcode's simulators, with no password asked. Only on the person's press: it is big (about 8 GB). Its progress is
 * read from what it prints ("45.2%"); while it says none, the time it usually takes stands in. A run that ends without
 * its runtime says so in plain words, and the log keeps what it printed.
 */

/** It usually takes about this long on a home connection, until a percent says better. */
export const SIMULATOR_GET_S = 15 * 60;

export interface SimRun {
  done: Promise<number | null>;
  stop(): void;
}
export type SimSpawn = (cmd: string, args: string[], on: (text: string) => void) => SimRun;

const realSpawn: SimSpawn = (cmd, args, on) => {
  const child = spawn(cmd, args, { detached: OWN_GROUP, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d: Buffer) => on(d.toString()));
  child.stderr?.on('data', (d: Buffer) => on(d.toString()));
  return {
    stop: () => endGroup(child),
    done: new Promise((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', () => resolve(null));
    }),
  };
};

let spawnIt: SimSpawn = realSpawn;

/** Tests run a made-up xcodebuild. Null goes back to the real one. */
export function useSimSpawn(s: SimSpawn | null): void {
  spawnIt = s ?? realSpawn;
}

/** The last percent xcodebuild printed, or null. */
export function percentOf(said: string): number | null {
  const all = [...said.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)];
  const n = all.length ? Number(all[all.length - 1]![1]) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** Starts getting the iPhone simulator, beside everything else. `after` runs once it ends, whichever way. */
export function startSimulatorGet(after?: () => void): Getting {
  const first: Getting = { tool: 'simulator', name: 'iPhone simulator', startedAt: new Date().toISOString(), step: 'download', done: 0, total: 100, secondsLeft: SIMULATOR_GET_S };
  return startOne(
    first,
    async (set) => {
      setTrouble('simulator');
      const t0 = Date.now();
      let said = '';
      const run = spawnIt('xcodebuild', ['-downloadPlatform', 'iOS'], (text) => {
        said = (said + text).slice(-20_000);
        const pct = percentOf(text);
        const elapsed = (Date.now() - t0) / 1000;
        const left = pct && pct > 1 ? (elapsed * (100 - pct)) / pct : Math.max(30, SIMULATOR_GET_S - elapsed);
        set({ ...first, done: pct ?? 0, secondsLeft: Math.round(left), words: 'Getting the iPhone simulator from Apple' });
      });
      const code = await run.done;
      if (code === 0) return;
      writeLog({ level: 'warn', text: `Getting the iPhone simulator: xcodebuild -downloadPlatform iOS ended with ${code}:\n${said.slice(-4000)}` });
      const words = /space/i.test(said)
        ? 'There is not enough room on this Mac for the iPhone simulator (about 8 GB). Make room, then press Get it again.'
        : "Apple's download of the iPhone simulator did not finish. Check the internet connection, then press Get it again.";
      setTrouble('simulator', words);
      throw new GetTrouble(words);
    },
    after,
  );
}

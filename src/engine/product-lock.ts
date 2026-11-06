import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';

/**
 * One story at a time runs the product. A product with several parts keeps each part's usual address, as many cannot move
 * (a web app that may only call its API from one address, say), so two runs at once would clash. The lock lives in a file
 * on this computer: a terminal's `squad` and the app see the same one, and a holder whose program is gone holds nothing.
 */

export type HoldKind = 'story' | 'try' | 'apps';

export interface ProductHold {
  holder: string;
  kind: HoldKind;
  pid: number;
  at: string;
  /** A story waiting for it, so a forgotten Try it yourself can end. */
  wanted?: string;
}

const lockFile = (bp: BoardPaths): string => path.join(bp.localDir, 'product-lock.json');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function productHold(bp: BoardPaths): ProductHold | null {
  try {
    const hold = JSON.parse(fs.readFileSync(lockFile(bp), 'utf8')) as ProductHold;
    if (alive(hold.pid)) return hold;
    fs.rmSync(lockFile(bp), { force: true });
  } catch {
    // None, or a file that cannot be read: it holds nothing.
  }
  return null;
}

/** Takes the product for `holder`. Null when it is theirs now; else who has it. */
export function takeProduct(bp: BoardPaths, holder: string, kind: HoldKind): ProductHold | null {
  const now = productHold(bp);
  if (now?.holder === holder) return null;
  if (now) return now;
  try {
    fs.mkdirSync(bp.localDir, { recursive: true });
    fs.writeFileSync(lockFile(bp), JSON.stringify({ holder, kind, pid: process.pid, at: new Date().toISOString() } satisfies ProductHold), { flag: 'wx' });
    return null;
  } catch {
    // Someone took it in the same moment.
    return productHold(bp) ?? { holder: 'another run', kind: 'story', pid: process.pid, at: new Date().toISOString() };
  }
}

export function leaveProduct(bp: BoardPaths, holder: string): void {
  if (productHold(bp)?.holder === holder) fs.rmSync(lockFile(bp), { force: true });
}

export const WAIT_LIMIT_MS = 45 * 60_000;
const LOOK_EVERY_MS = 2000;

/** Waits for its turn. `onWait` hears once who it waits for. A Stop, or waiting too long, ends with the reason. */
export async function waitForProduct(bp: BoardPaths, holder: string, kind: HoldKind, o: { signal?: AbortSignal; onWait?: (hold: ProductHold) => void; limitMs?: number; lookMs?: number } = {}): Promise<void> {
  const until = Date.now() + (o.limitMs ?? WAIT_LIMIT_MS);
  let said = false;
  for (;;) {
    const other = takeProduct(bp, holder, kind);
    if (!other) return;
    if (!said) {
      said = true;
      o.onWait?.(other);
    }
    if (other.wanted !== holder) {
      try {
        fs.writeFileSync(lockFile(bp), JSON.stringify({ ...other, wanted: holder }));
      } catch {
        // It just left: the next look takes it.
      }
    }
    if (o.signal?.aborted) throw new Error('You stopped the squad.');
    if (Date.now() > until) throw new Error(`${other.holder} kept the running product too long`);
    await new Promise((r) => setTimeout(r, o.lookMs ?? LOOK_EVERY_MS));
  }
}

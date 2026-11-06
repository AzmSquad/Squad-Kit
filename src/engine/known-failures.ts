import { readMeta, writeMeta, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { repoFor } from './repos.js';

/**
 * The checks squad-kit already saw fail on code nobody had touched: the tests of the first run, in its own copy
 * (engine/onboard.ts). The Builder is told, so it fixes what its story broke and leaves other screens alone. The gate
 * stays as it is: the checks must still pass, or the story stops. Once the same command passes, it is not known to fail.
 */

export interface KnownFailure {
  name: string;
  command: string;
  /** What it printed then, its last lines. */
  output?: string;
}

/** Which of these failed checks already failed before any story touched the code. */
export function knownFailures(bp: BoardPaths, t: Ticket, failed: { name: string; command: string }[]): KnownFailure[] {
  const meta = readMeta(bp);
  const repos = [repoFor(meta, t).path, ...(t.copies ?? []).map((c) => c.repo)];
  const runs = meta.setup?.proof?.tests ?? [];
  return failed.flatMap((f) => {
    const run = runs.find((r) => !r.ok && !r.passedSince && r.command.trim() === f.command.trim() && repos.includes(r.repo ?? '.'));
    return run ? [{ name: f.name, command: f.command, ...(run.output ? { output: run.output } : {}) }] : [];
  });
}

/** The tests passed at the first try, so the failure the first run saw is gone. */
export function forgetKnownFailure(bp: BoardPaths, t: Ticket, command: string): void {
  const meta = readMeta(bp);
  const repo = repoFor(meta, t).path;
  const stale = (meta.setup?.proof?.tests ?? []).filter((r) => !r.ok && !r.passedSince && r.command.trim() === command.trim() && (r.repo ?? '.') === repo);
  if (!stale.length) return;
  for (const r of stale) r.passedSince = new Date().toISOString();
  writeMeta(bp, meta);
}

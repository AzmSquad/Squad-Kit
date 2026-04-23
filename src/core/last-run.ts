import fs from 'node:fs/promises';
import path from 'node:path';
import type { PlannerRunStats } from '../planner/types.js';
import type { SquadPaths } from './paths.js';

export interface LastRunRecord {
  stats: PlannerRunStats;
  /** ISO-8601 timestamp the run completed. */
  completedAt: string;
  /** Which provider/model were used. For doctor's diagnostic output. */
  provider: string;
  model: string;
  /** Schema version so future shape changes don't misparse. */
  version: 1;
}

export async function writeLastRun(paths: SquadPaths, rec: Omit<LastRunRecord, 'version'>): Promise<void> {
  const file = path.join(paths.squadDir, '.last-run.json');
  await fs.writeFile(file, JSON.stringify({ ...rec, version: 1 }, null, 2) + '\n', 'utf8');
}

export async function readLastRun(paths: SquadPaths): Promise<LastRunRecord | undefined> {
  const file = path.join(paths.squadDir, '.last-run.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as LastRunRecord;
    if (parsed.version !== 1) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

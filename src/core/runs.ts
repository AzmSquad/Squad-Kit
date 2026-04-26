import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PlannerRunStats } from '../planner/types.js';
import type { SquadPaths } from './paths.js';

export interface RunRecord {
  runId: string;
  provider: string;
  model: string;
  feature: string;
  storyId: string;
  startedAt: string;
  completedAt: string;
  success: boolean;
  partial: boolean;
  planFile: string | null;
  stats: PlannerRunStats;
  cacheEnabled: boolean;
  durationMs: number;
  version: 1;
}

const RING_SIZE = 20;

export function newRunId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rnd = randomBytes(8).toString('hex');
  return `${ts}-${rnd}`;
}

export async function appendRun(paths: SquadPaths, rec: Omit<RunRecord, 'version'>): Promise<void> {
  const dir = path.join(paths.squadDir, 'runs');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${rec.runId}.json`);
  await fs.writeFile(file, JSON.stringify({ ...rec, version: 1 }, null, 2) + '\n', 'utf8');
  await pruneOldRuns(dir);
}

async function pruneOldRuns(dir: string): Promise<void> {
  const entries = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  if (entries.length <= RING_SIZE) return;
  entries.sort();
  const drop = entries.slice(0, entries.length - RING_SIZE);
  await Promise.all(drop.map((n) => fs.rm(path.join(dir, n), { force: true })));
}

export async function listRuns(paths: SquadPaths): Promise<RunRecord[]> {
  const dir = path.join(paths.squadDir, 'runs');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((n) => n.endsWith('.json')).sort().reverse();
  const out: RunRecord[] = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      const parsed = JSON.parse(raw) as RunRecord;
      if (parsed.version === 1) out.push(parsed);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

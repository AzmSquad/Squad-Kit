import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PlannerRunStats } from '../planner/types.js';
import type { ProviderName } from '../planner/types.js';
import type { AnthropicProviderSpecific } from '../planner/runtimes/types.js';
import type { SquadPaths } from './paths.js';
import { RUN_HISTORY_RING_SIZE } from './run-retention.js';
import { rotateRunEvents } from './run-events-store.js';

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
  /** Present on new runs: which planner LLM runtime was used (Anthropic Agent SDK vs Vercel AI SDK). */
  plannerRuntime?: { kind: 'vercel' | 'agent-sdk'; provider: ProviderName };
  /**
   * Which credential the run authenticated with, from `describeAuth(auth).mode`. Absent on
   * records written before 0.12.0 — readers render `—` rather than guessing a mode.
   */
  authMode?: 'subscription' | 'api-key';
  /** Snapshot of Anthropic Agent SDK tuning for this run (optional). */
  providerOptionsSnapshot?: {
    anthropic?: { draft?: AnthropicProviderSpecific; scout?: AnthropicProviderSpecific };
  };
  scout?: { enabled: boolean; selectedCount?: number; tokensUsed?: number; durationMs?: number };
  validation?: {
    enabled: boolean;
    issuesCount: number;
    issuesByKind?: Partial<
      Record<'missing_path' | 'line_range_too_large' | 'symbol_not_found' | 'malformed_metadata', number>
    >;
    durationMs?: number;
  };
}

export function newRunId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rnd = randomBytes(8).toString('hex');
  return `${ts}-${rnd}`;
}

async function pruneOldRuns(paths: SquadPaths): Promise<void> {
  const dir = path.join(paths.squadDir, 'runs');
  const entries = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  if (entries.length <= RUN_HISTORY_RING_SIZE) return;
  entries.sort();
  const drop = entries.slice(0, entries.length - RUN_HISTORY_RING_SIZE);
  await Promise.all(
    drop.map(async (n) => {
      const runPath = path.join(dir, n);
      const runId = n.replace(/\.json$/u, '');
      await fs.rm(runPath, { force: true });
      await fs.rm(path.join(dir, `${runId}.events.jsonl`), { force: true });
      await fs.rm(path.join(dir, `${runId}.events.jsonl.gz`), { force: true });
    }),
  );
}

export async function appendRun(paths: SquadPaths, rec: Omit<RunRecord, 'version'>): Promise<void> {
  const dir = path.join(paths.squadDir, 'runs');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${rec.runId}.json`);
  await fs.writeFile(file, JSON.stringify({ ...rec, version: 1 }, null, 2) + '\n', 'utf8');
  await pruneOldRuns(paths);
  await rotateRunEvents(paths);
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

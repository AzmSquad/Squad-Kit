import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPaths } from '../src/core/paths.js';
import { appendRun, listRuns } from '../src/core/runs.js';
import type { PlannerRunStats } from '../src/planner/types.js';

const stats = (over: Partial<PlannerRunStats> = {}): PlannerRunStats => ({
  turns: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  cacheHitRatio: 0,
  durationMs: 1,
  ...over,
});

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-runs-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, '.squad'), { recursive: true });
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runs storage', () => {
  it('appendRun + listRuns returns newest first', async () => {
    const paths = buildPaths(tmp);
    const r1 = '01-older-runid-test';
    const r2 = '02-newer-runid-test';
    await appendRun(paths, {
      runId: r1,
      provider: 'anthropic',
      model: 'm1',
      feature: 'f',
      storyId: 'a',
      startedAt: new Date(1).toISOString(),
      completedAt: new Date(2).toISOString(),
      success: true,
      partial: false,
      planFile: 'p.md',
      stats: stats(),
      cacheEnabled: true,
      durationMs: 10,
    });
    await appendRun(paths, {
      runId: r2,
      provider: 'anthropic',
      model: 'm2',
      feature: 'f',
      storyId: 'b',
      startedAt: new Date(3).toISOString(),
      completedAt: new Date(4).toISOString(),
      success: true,
      partial: false,
      planFile: 'q.md',
      stats: stats(),
      cacheEnabled: true,
      durationMs: 11,
    });
    const rows = await listRuns(paths);
    expect(rows.map((r) => r.runId)).toEqual([r2, r1]);
  });

  it('prunes to the last 20 runs', async () => {
    const paths = buildPaths(tmp);
    const ids: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const id = `${i.toString(36).padStart(9, '0')}-deadbeef${i.toString(16).padStart(8, '0')}`;
      ids.push(id);
      await appendRun(paths, {
        runId: id,
        provider: 'anthropic',
        model: 'm',
        feature: 'f',
        storyId: 's',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        success: true,
        partial: false,
        planFile: null,
        stats: stats(),
        cacheEnabled: true,
        durationMs: 1,
      });
    }
    const rows = await listRuns(paths);
    expect(rows).toHaveLength(20);
    const kept = new Set(rows.map((r) => r.runId));
    expect(kept.has(ids[ids.length - 1]!)).toBe(true);
    expect(kept.has(ids[0]!)).toBe(false);
  });

  it('keeps exactly 20 runs without pruning', async () => {
    const paths = buildPaths(tmp);
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = `${i.toString(36).padStart(9, '0')}-cafebabe${i.toString(16).padStart(8, '0')}`;
      ids.push(id);
      await appendRun(paths, {
        runId: id,
        provider: 'anthropic',
        model: 'm',
        feature: 'f',
        storyId: 's',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        success: true,
        partial: false,
        planFile: null,
        stats: stats(),
        cacheEnabled: true,
        durationMs: 1,
      });
    }
    const rows = await listRuns(paths);
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((r) => r.runId)).size).toBe(20);
  });
});

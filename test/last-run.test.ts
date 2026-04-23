import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPaths } from '../src/core/paths.js';
import { readLastRun, writeLastRun } from '../src/core/last-run.js';
import type { PlannerRunStats } from '../src/planner/types.js';

let tmp: string;

const sampleStats: PlannerRunStats = {
  turns: 3,
  inputTokens: 10_000,
  outputTokens: 500,
  cacheCreationTokens: 1200,
  cacheReadTokens: 20_000,
  cacheHitRatio: 0.67,
  durationMs: 12_000,
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-lastrun-'));
  fs.mkdirSync(path.join(tmp, '.squad'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('last-run', () => {
  it('writeLastRun and readLastRun round-trip stats', async () => {
    const paths = buildPaths(tmp);
    await writeLastRun(paths, {
      stats: sampleStats,
      completedAt: '2026-01-01T00:00:00.000Z',
      provider: 'anthropic',
      model: 'm',
    });
    const read = await readLastRun(paths);
    expect(read?.stats).toEqual(sampleStats);
    expect(read?.provider).toBe('anthropic');
    expect(read?.model).toBe('m');
    expect(read?.version).toBe(1);
  });

  it('readLastRun returns undefined when file is missing', async () => {
    const read = await readLastRun(buildPaths(tmp));
    expect(read).toBeUndefined();
  });

  it('readLastRun returns undefined when JSON is malformed', async () => {
    const paths = buildPaths(tmp);
    await fs.promises.writeFile(path.join(tmp, '.squad', '.last-run.json'), '{ not json', 'utf8');
    const read = await readLastRun(paths);
    expect(read).toBeUndefined();
  });

  it('readLastRun returns undefined when version is unknown', async () => {
    const paths = buildPaths(tmp);
    await fs.promises.writeFile(
      path.join(tmp, '.squad', '.last-run.json'),
      JSON.stringify({ version: 99, stats: sampleStats, completedAt: '', provider: 'x', model: 'y' }),
      'utf8',
    );
    const read = await readLastRun(paths);
    expect(read).toBeUndefined();
  });
});

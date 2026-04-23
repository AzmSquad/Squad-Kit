import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPlannerCache } from '../src/commands/doctor.js';
import { buildPaths, SQUAD_DIR } from '../src/core/paths.js';
import { saveConfig, type SquadConfig } from '../src/core/config.js';
import { writeLastRun } from '../src/core/last-run.js';
import type { PlannerRunStats } from '../src/planner/types.js';

let tmp: string;
let previousCwd: string;

function basePlanner() {
  return {
    enabled: true as const,
    provider: 'anthropic' as const,
    mode: 'auto' as const,
    budget: { maxFileReads: 10, maxContextBytes: 20_000, maxDurationSeconds: 60 },
  };
}

function stats(partial: Partial<PlannerRunStats> & Pick<PlannerRunStats, 'turns'>): PlannerRunStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheHitRatio: 0,
    durationMs: 0,
    ...partial,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-doctcache-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
});
afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function runCheck(overrides: { config: SquadConfig }): ReturnType<typeof checkPlannerCache> {
  saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), overrides.config);
  return checkPlannerCache(buildPaths(tmp), { config: overrides.config, hasLegacyPromptsDir: false });
}

describe('checkPlannerCache', () => {
  it('cache disabled in config → warn', async () => {
    const r = await runCheck({
      config: {
        version: 1,
        project: { name: 'n', projectRoots: ['.'] },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
        planner: { ...basePlanner(), cache: { enabled: false } },
      },
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/disabled/i);
  });

  it('cache enabled but no .last-run.json → skip', async () => {
    const full: SquadConfig = {
      version: 1,
      project: { name: 'n', projectRoots: ['.'] },
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: [],
      planner: { ...basePlanner(), cache: { enabled: true } },
    };
    const r = await runCheck({ config: full });
    expect(r.status).toBe('skip');
  });

  it('0% hits across many turns → fail', async () => {
    const full: SquadConfig = {
      version: 1,
      project: { name: 'n', projectRoots: ['.'] },
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: [],
      planner: { ...basePlanner() },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), full);
    const paths = buildPaths(tmp);
    await writeLastRun(paths, {
      stats: stats({ turns: 5, inputTokens: 10_000, cacheReadTokens: 0, cacheHitRatio: 0 }),
      completedAt: new Date().toISOString(),
      provider: 'openai',
      model: 'gpt-5',
    });
    const r = await checkPlannerCache(paths, { config: full, hasLegacyPromptsDir: false });
    expect(r.status).toBe('fail');
  });

  it('65% hit rate, 8 turns → ok', async () => {
    const full: SquadConfig = {
      version: 1,
      project: { name: 'n', projectRoots: ['.'] },
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: [],
      planner: { ...basePlanner() },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), full);
    const paths = buildPaths(tmp);
    await writeLastRun(paths, {
      stats: stats({
        turns: 8,
        inputTokens: 3_500,
        cacheReadTokens: 6_500,
        cacheHitRatio: 0.65,
      }),
      completedAt: new Date().toISOString(),
      provider: 'anthropic',
      model: 'm',
    });
    const r = await checkPlannerCache(paths, { config: full, hasLegacyPromptsDir: false });
    expect(r.status).toBe('ok');
  });

  it('18% hit rate, 6 turns → warn (low but nonzero)', async () => {
    const full: SquadConfig = {
      version: 1,
      project: { name: 'n', projectRoots: ['.'] },
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: [],
      planner: { ...basePlanner() },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), full);
    const paths = buildPaths(tmp);
    await writeLastRun(paths, {
      stats: stats({ turns: 6, inputTokens: 8_200, cacheReadTokens: 1_800, cacheHitRatio: 0.18 }),
      completedAt: new Date().toISOString(),
      provider: 'openai',
      model: 'gpt-5',
    });
    const r = await checkPlannerCache(paths, { config: full, hasLegacyPromptsDir: false });
    expect(r.status).toBe('warn');
  });

  it('18% hit with only 2 turns → ok (warmup)', async () => {
    const full: SquadConfig = {
      version: 1,
      project: { name: 'n', projectRoots: ['.'] },
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: [],
      planner: { ...basePlanner() },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), full);
    const paths = buildPaths(tmp);
    await writeLastRun(paths, {
      stats: stats({ turns: 2, inputTokens: 8_200, cacheReadTokens: 1_800, cacheHitRatio: 0.18 }),
      completedAt: new Date().toISOString(),
      provider: 'openai',
      model: 'gpt-5',
    });
    const r = await checkPlannerCache(paths, { config: full, hasLegacyPromptsDir: false });
    expect(r.status).toBe('ok');
  });
});

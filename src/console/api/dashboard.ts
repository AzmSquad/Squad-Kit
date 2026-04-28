import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { listStories } from '../../core/stories.js';
import { readLastRun } from '../../core/last-run.js';
import { listRuns } from '../../core/runs.js';
import { readInstalledPackage } from '../../core/package-info.js';

export function mountDashboardApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/dashboard', async (c) => {
    const cfg = loadConfig(opts.paths.configFile);
    const lastRun = (await readLastRun(opts.paths)) ?? null;
    const runs = await listRuns(opts.paths);
    const stories = listStories(opts.paths);
    return c.json({
      version: readInstalledPackage().version,
      root: opts.paths.root,
      project: cfg.project,
      planner: cfg.planner ? { provider: cfg.planner.provider, enabled: cfg.planner.enabled } : null,
      tracker: { type: cfg.tracker.type },
      lastRun,
      runs: runs.map((r) => ({
        runId: r.runId,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        success: r.success,
        partial: r.partial,
        inputTokens: r.stats.inputTokens,
        outputTokens: r.stats.outputTokens,
        cacheHitRatio: r.stats.cacheHitRatio,
      })),
      storyCounts: countStories(stories),
      stories: stories.map((s) => ({
        feature: s.feature,
        id: s.id,
        intakePath: s.intakePath,
        storyDir: s.storyDir,
        planFile: s.planFile ?? null,
        titleHint: s.titleHint ?? null,
      })),
    });
  });
}

function countStories(stories: ReturnType<typeof listStories>) {
  const total = stories.length;
  const planned = stories.filter((s) => !!s.planFile).length;
  return { total, planned, unplanned: total - planned };
}

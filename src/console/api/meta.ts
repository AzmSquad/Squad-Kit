import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { readLastRun } from '../../core/last-run.js';
import { readInstalledPackage } from '../../core/package-info.js';

export function mountMetaApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/meta', async (c) => {
    const config = loadConfig(opts.paths.configFile);
    const lastRun = await readLastRun(opts.paths);
    return c.json({
      version: readInstalledPackage().version,
      root: opts.paths.root,
      project: config.project,
      planner: config.planner
        ? { provider: config.planner.provider, enabled: config.planner.enabled }
        : null,
      tracker: { type: config.tracker.type },
      lastRun,
    });
  });

  app.get('/api/last-run', async (c) => {
    const lastRun = await readLastRun(opts.paths);
    return c.json(lastRun ?? null);
  });
}

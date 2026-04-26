import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { gatherContextForApi, runAllChecksForApi } from '../../commands/doctor-api.js';
import { summarise } from '../../commands/doctor-engine.js';

export function mountDoctorApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/doctor', async (c) => {
    const ctx = await gatherContextForApi(opts.paths);
    const checks = await runAllChecksForApi(opts.paths, ctx, false);
    return c.json({ root: opts.paths.root, checks, summary: summarise(checks) });
  });

  app.post('/api/doctor/fix', async (c) => {
    const ctx = await gatherContextForApi(opts.paths);
    const checks = await runAllChecksForApi(opts.paths, ctx, true);
    return c.json({ root: opts.paths.root, checks, summary: summarise(checks) });
  });
}

import { z } from 'zod';
import type { Hono } from 'hono';
import { loadConfig, saveConfig } from '../../core/config.js';
import type { SquadPaths } from '../../core/paths.js';

const ConfigBody = z.object({}).passthrough();

export function mountConfigApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/config', (c) => {
    const config = loadConfig(opts.paths.configFile);
    return c.json(config);
  });

  app.put('/api/config', async (c) => {
    const body = ConfigBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'invalid_body', issues: body.error.issues }, 400);
    try {
      saveConfig(opts.paths.configFile, body.data as never);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: 'invalid_config', detail: (err as Error).message }, 400);
    }
  });
}

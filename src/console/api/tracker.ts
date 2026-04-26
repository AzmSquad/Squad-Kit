import type { Hono } from 'hono';
import { z } from 'zod';
import type { SquadPaths } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { loadSecrets } from '../../core/secrets.js';
import { clientFor, overlayTrackerEnv } from '../../tracker/index.js';
import { TrackerError } from '../../tracker/types.js';
import { createStoryRecordFromIssue } from '../../core/story-mutations.js';

const SearchQuery = z.object({ q: z.string().max(500) });
const ImportBody = z.object({
  issueId: z.string().min(1),
  feature: z.string().min(1).max(80),
  withAttachments: z.boolean().optional(),
});

export function mountTrackerApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/tracker/search', async (c) => {
    const q = SearchQuery.safeParse({ q: c.req.query('q') });
    if (!q.success) return c.json({ error: 'invalid_query' }, 400);
    const cfg = loadConfig(opts.paths.configFile);
    const secrets = overlayTrackerEnv(loadSecrets(opts.paths.secretsFile));
    const { client, error } = clientFor(cfg, secrets);
    if (!client) {
      return c.json({ error: error?.kind ?? 'unsupported', detail: error?.detail ?? '' }, 400);
    }
    try {
      const results = await client.searchIssues(q.data.q);
      return c.json({ ok: true, results });
    } catch (err) {
      if (err instanceof TrackerError) {
        return c.json({ ok: false, kind: err.kind, status: err.statusCode, detail: err.message }, 200);
      }
      return c.json({ ok: false, detail: (err as Error).message }, 200);
    }
  });

  app.post('/api/tracker/import', async (c) => {
    const body = ImportBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'invalid_body', issues: body.error.issues }, 400);
    const cfg = loadConfig(opts.paths.configFile);
    const secrets = overlayTrackerEnv(loadSecrets(opts.paths.secretsFile));
    const { client, error } = clientFor(cfg, secrets);
    if (!client) {
      return c.json({ error: error?.kind ?? 'unsupported', detail: error?.detail ?? '' }, 400);
    }
    try {
      const issue = await client.fetchIssue(body.data.issueId);
      const created = await createStoryRecordFromIssue({
        paths: opts.paths,
        feature: body.data.feature,
        issue,
        withAttachments: body.data.withAttachments ?? true,
        client,
        config: cfg,
      });
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof TrackerError) return c.json({ error: err.kind, detail: err.message }, 502);
      return c.json({ error: 'fetch_failed', detail: (err as Error).message }, 500);
    }
  });
}

import { z } from 'zod';
import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { loadSecrets, mergeSecrets, saveSecrets, type SquadSecrets } from '../../core/secrets.js';
import { maskToken } from '../../core/mask-token.js';
import { fetchProviderModelIds, probeJiraConnectivity, probeAzureConnectivity } from '../../core/probes.js';
import { loadConfig } from '../../core/config.js';
import type { ProviderName } from '../../planner/types.js';

const PROVIDERS: readonly ProviderName[] = ['anthropic', 'openai', 'google'] as const;

export { maskToken };

export function mountSecretsApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/secrets', (c) => {
    const s = loadSecrets(opts.paths.secretsFile);
    return c.json({
      planner: {
        anthropic: maskToken(s.planner?.anthropic),
        openai: maskToken(s.planner?.openai),
        google: maskToken(s.planner?.google),
      },
      tracker: {
        jira: {
          host: s.tracker?.jira?.host ?? null,
          email: s.tracker?.jira?.email ?? null,
          token: maskToken(s.tracker?.jira?.token),
        },
        azure: {
          organization: s.tracker?.azure?.organization ?? null,
          project: s.tracker?.azure?.project ?? null,
          pat: maskToken(s.tracker?.azure?.pat),
        },
      },
    });
  });

  const PutBody = z.object({
    planner: z
      .object({
        anthropic: z.string().optional(),
        openai: z.string().optional(),
        google: z.string().optional(),
      })
      .optional(),
    tracker: z
      .object({
        jira: z
          .object({
            host: z.string().optional(),
            email: z.string().optional(),
            token: z.string().optional(),
          })
          .optional(),
        azure: z
          .object({
            organization: z.string().optional(),
            project: z.string().optional(),
            pat: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  });

  app.put('/api/secrets', async (c) => {
    const parse = PutBody.safeParse(await c.req.json());
    if (!parse.success) return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400);
    const current = loadSecrets(opts.paths.secretsFile);
    const merged = mergeSecrets(current, parse.data as SquadSecrets);
    saveSecrets(opts.paths.secretsFile, merged);
    return c.json({ ok: true });
  });

  for (const p of PROVIDERS) {
    app.post(`/api/secrets/test/${p}`, async (c) => {
      const s = loadSecrets(opts.paths.secretsFile);
      const key = s.planner?.[p];
      if (!key) return c.json({ ok: false, detail: `${p} key not saved` }, 400);
      const result = await fetchProviderModelIds(p, key);
      if (result.ok) return c.json({ ok: true, modelCount: result.ids.size });
      return c.json({ ok: false, status: result.status, detail: result.body.slice(0, 200) }, 200);
    });
  }

  app.post('/api/secrets/test/jira', async (c) => {
    const cfg = loadConfig(opts.paths.configFile);
    const s = loadSecrets(opts.paths.secretsFile);
    return c.json(await probeJiraConnectivity(s, cfg));
  });

  app.post('/api/secrets/test/azure', async (c) => {
    const cfg = loadConfig(opts.paths.configFile);
    const s = loadSecrets(opts.paths.secretsFile);
    return c.json(await probeAzureConnectivity(s, cfg));
  });
}

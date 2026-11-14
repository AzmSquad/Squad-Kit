import path from 'node:path';
import { z } from 'zod';
import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { loadSecrets, mergeSecrets, saveSecrets, type SquadSecrets } from '../../core/secrets.js';
import { maskToken } from '../../core/mask-token.js';
import {
  fetchProviderModelIds,
  probeAzureConnectivity,
  probeGitHubConnectivity,
} from '../../core/probes.js';
import { loadConfig } from '../../core/config.js';
import type { ProviderName } from '../../planner/types.js';
import { trackerModule } from '../../modules/registry.js';

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
        /**
         * `claude setup-token` output. Masked exactly like the API keys — the Claude account
         * card shows it so a user can tell "a token is stored here" from "the OS login store
         * is being used". Never returned in full, and never by `/api/planner-auth`.
         */
        anthropicOauthToken: maskToken(s.planner?.anthropicOauthToken),
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
        github: {
          host: s.tracker?.github?.host ?? null,
          pat: maskToken(s.tracker?.github?.pat),
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
        anthropicOauthToken: z.string().optional(),
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
        github: z
          .object({
            host: z.string().optional(),
            pat: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  });

  app.put('/api/secrets', async (c) => {
    const parse = PutBody.safeParse(await c.req.json());
    if (!parse.success) return c.json({ error: 'invalid_body', issues: parse.error.issues }, 400);
    // A Jira host is only ever saved with its own token: never a new host next to an older site's token.
    const jira = parse.data.tracker?.jira;
    if (jira?.host?.trim() && !jira.token?.trim()) return c.json({ error: 'jira_host_needs_token', detail: 'Send the Jira token with its host.' }, 400);
    const current = loadSecrets(opts.paths.secretsFile);
    const merged = mergeSecrets(current, parse.data as SquadSecrets);
    // `mergeSecrets` drops empty strings so a partial update cannot clobber a sibling, which
    // means there is no "clear" path through it. The Claude account card's Remove action needs
    // one, so an explicitly-empty OAuth token is honoured as a delete here — and only here, so
    // saving a blank API key stays the no-op it has always been.
    if (parse.data.planner?.anthropicOauthToken === '' && merged.planner) {
      delete merged.planner.anthropicOauthToken;
    }
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

  // Through the tracker module, as the board checks it: the token goes only to the host saved with it.
  app.post('/api/secrets/test/jira', async (c) => {
    const mod = trackerModule('jira')!;
    const root = path.dirname(opts.paths.squadDir);
    const tracker = mod.open(root);
    if (!tracker) return c.json({ ok: false, detail: mod.read(root).note ?? 'Jira has no token for the team\'s site on this computer.' });
    try {
      return c.json({ ok: true, detail: await tracker.whoAmI() });
    } catch (err) {
      return c.json({ ok: false, detail: (err as Error).message });
    }
  });

  app.post('/api/secrets/test/azure', async (c) => {
    const cfg = loadConfig(opts.paths.configFile);
    const s = loadSecrets(opts.paths.secretsFile);
    return c.json(await probeAzureConnectivity(s, cfg));
  });

  app.post('/api/secrets/test/github', async (c) => {
    const cfg = loadConfig(opts.paths.configFile);
    const s = loadSecrets(opts.paths.secretsFile);
    return c.json(await probeGitHubConnectivity(s, cfg));
  });
}

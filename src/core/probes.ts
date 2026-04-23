import type { SquadConfig } from './config.js';
import type { SquadSecrets } from './secrets.js';
import { overlayTrackerEnv } from '../tracker/env-overlay.js';
import type { ProviderName } from '../planner/types.js';

export async function fetchProviderModelIds(
  provider: ProviderName,
  apiKey: string,
): Promise<
  { ok: true; ids: Set<string> } | { ok: false; kind: 'http'; status: number; body: string }
> {
  switch (provider) {
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=200', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) {
        return { ok: false, kind: 'http', status: res.status, body: await res.text() };
      }
      const body = (await res.json()) as { data: { id: string }[] };
      return { ok: true, ids: new Set((body.data ?? []).map((m) => m.id)) };
    }
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        return { ok: false, kind: 'http', status: res.status, body: await res.text() };
      }
      const body = (await res.json()) as { data: { id: string }[] };
      return { ok: true, ids: new Set((body.data ?? []).map((m) => m.id)) };
    }
    case 'google': {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
      );
      if (!res.ok) {
        return { ok: false, kind: 'http', status: res.status, body: await res.text() };
      }
      const body = (await res.json()) as { models: { name: string }[] };
      return {
        ok: true,
        ids: new Set((body.models ?? []).map((m) => m.name.replace(/^models\//, ''))),
      };
    }
  }
}

function jiraMyselfUrl(host: string): string {
  const normHost = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${normHost}/rest/api/3/myself`;
}

export async function probeJiraConnectivity(
  secrets: SquadSecrets,
  config: SquadConfig,
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const jira = overlayTrackerEnv(secrets).tracker?.jira ?? {};
  const host = jira.host ?? config.tracker.workspace ?? '';
  const email = jira.email ?? '';
  const token = jira.token ?? '';
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const url = jiraMyselfUrl(host);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, detail: (await res.text()).slice(0, 200) };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export async function probeAzureConnectivity(
  secrets: SquadSecrets,
  config: SquadConfig,
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const az = overlayTrackerEnv(secrets).tracker?.azure ?? {};
  const org = az.organization ?? config.tracker.workspace ?? '';
  const pat = az.pat ?? '';
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects?api-version=7.1`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, detail: (await res.text()).slice(0, 200) };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

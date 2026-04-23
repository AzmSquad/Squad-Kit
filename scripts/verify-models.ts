#!/usr/bin/env tsx
import process from 'node:process';
import { PLANNER_MODEL_MAP } from '../src/core/planner-models.js';

interface ModelCheck {
  provider: 'anthropic' | 'openai' | 'google';
  ids: string[];
  probe: (apiKey: string) => Promise<Set<string>>;
}

const CHECKS: ModelCheck[] = [
  {
    provider: 'anthropic',
    ids: [PLANNER_MODEL_MAP.anthropic.plan, PLANNER_MODEL_MAP.anthropic.execute],
    probe: async (key) => {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=200', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { data: { id: string }[] };
      return new Set(body.data.map((m) => m.id));
    },
  },
  {
    provider: 'openai',
    ids: [PLANNER_MODEL_MAP.openai.plan, PLANNER_MODEL_MAP.openai.execute],
    probe: async (key) => {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { data: { id: string }[] };
      return new Set(body.data.map((m) => m.id));
    },
  },
  {
    provider: 'google',
    ids: [PLANNER_MODEL_MAP.google.plan, PLANNER_MODEL_MAP.google.execute],
    probe: async (key) => {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`,
      );
      if (!res.ok) throw new Error(`google ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { models: { name: string }[] };
      return new Set(body.models.map((m) => m.name.replace(/^models\//, '')));
    },
  },
];

const ENV_VAR: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

async function main(): Promise<void> {
  let failures = 0;
  let skipped = 0;
  for (const c of CHECKS) {
    const envVar = ENV_VAR[c.provider]!;
    const key = process.env[envVar];
    if (!key) {
      console.warn(`⚠  ${c.provider}: ${envVar} not set — skipping (set it to verify).`);
      skipped++;
      continue;
    }
    try {
      const available = await c.probe(key);
      for (const id of c.ids) {
        if (!available.has(id)) {
          console.error(`✗  ${c.provider}: pinned model "${id}" not found in /v1/models response.`);
          failures++;
        } else {
          console.log(`✓  ${c.provider}: ${id}`);
        }
      }
    } catch (err) {
      console.error(`✗  ${c.provider}: probe failed — ${(err as Error).message}`);
      failures++;
    }
  }
  console.log('');
  if (failures > 0) {
    console.error(`${failures} pinned model(s) failed to resolve. Refuse to publish.`);
    process.exit(1);
  }
  if (skipped > 0 && process.env.CI === 'true') {
    console.error(`In CI but ${skipped} provider(s) skipped. All keys must be present in CI.`);
    process.exit(2);
  }
  console.log(`All pinned models verified (${skipped} provider(s) skipped).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});

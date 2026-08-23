import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlanner } from '../../src/planner/loop.js';
import { resolveRuntime } from '../../src/planner/runtimes/index.js';
import { apiKeyAuth } from '../support/planner-auth-fixtures.js';
import { Budget } from '../../src/planner/budget.js';

const SHOULD_RUN =
  process.env.SQUAD_INTEGRATION_TEST === '1' && !!process.env.ANTHROPIC_API_KEY;

/** Prefer Haiku for cost; override with SQUAD_AGENT_SDK_SMOKE_MODEL for Opus checks. */
const SMOKE_MODEL = process.env.SQUAD_AGENT_SDK_SMOKE_MODEL ?? 'claude-3-5-haiku-20241022';

describe.skipIf(!SHOULD_RUN)('Agent SDK smoke (live Anthropic)', () => {
  it(
    'draft-only runPlanner completes with agent-sdk runtime',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-agent-sdk-smoke-'));
      try {
        fs.mkdirSync(path.join(root, '.squad', 'stories', 'smoke'), { recursive: true });
        fs.writeFileSync(
          path.join(root, '.squad', 'stories', 'smoke', 'intake.md'),
          '# Smoke\n\nImplement a tiny hello function.\n',
          'utf8',
        );

        const runtime = resolveRuntime({
          provider: 'anthropic',
          modelId: SMOKE_MODEL,
          auth: apiKeyAuth(process.env.ANTHROPIC_API_KEY!),
          anthropicRuntime: 'agent-sdk',
        });
        expect(runtime.kind).toBe('agent-sdk');

        const budget = new Budget({
          maxFileReads: 8,
          maxContextBytes: 80_000,
          maxDurationSeconds: 180,
        });

        const result = await runPlanner({
          root,
          runtime,
          provider: 'anthropic',
          modelId: SMOKE_MODEL,
          systemPrompt:
            'You are a planning assistant. Produce a short markdown plan (two or three headings only).',
          userPrompt: 'Plan the hello feature from the intake. Be brief.',
          budget,
          stages: { scout: { enabled: false } },
          validation: { enabled: false },
          maxIterations: 6,
          maxOutputTokens: 2048,
        });

        expect(result.planText.length).toBeGreaterThan(30);
        expect(result.finishedNormally).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

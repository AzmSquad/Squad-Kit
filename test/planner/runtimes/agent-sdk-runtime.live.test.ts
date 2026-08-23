import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlanner } from '../../../src/planner/loop.js';
import { resolveRuntime } from '../../../src/planner/runtimes/index.js';
import { apiKeyAuth } from '../../support/planner-auth-fixtures.js';
import { Budget } from '../../../src/planner/budget.js';
import { PlannerEventBus, type PlannerEvent } from '../../../src/planner/events.js';

const SHOULD_RUN =
  process.env.SQUAD_INTEGRATION_TEST === '1' && !!process.env.ANTHROPIC_API_KEY;

const LIVE_MODEL = process.env.SQUAD_AGENT_SDK_LIVE_MODEL ?? 'claude-3-5-haiku-20241022';

describe.skipIf(!SHOULD_RUN)('Agent SDK runtime (live telemetry)', () => {
  it(
    'emits partial usage, runtime_info, and tool telemetry during a real run',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-agent-sdk-live-'));
      try {
        fs.mkdirSync(path.join(root, '.squad', 'stories', 'live'), { recursive: true });
        fs.writeFileSync(
          path.join(root, '.squad', 'stories', 'live', 'intake.md'),
          '# Live\n\nCall read_file on notes.txt then write a tiny plan.\n',
          'utf8',
        );
        fs.writeFileSync(path.join(root, 'notes.txt'), 'hello world\n', 'utf8');

        const runtime = resolveRuntime({
          provider: 'anthropic',
          modelId: LIVE_MODEL,
          auth: apiKeyAuth(process.env.ANTHROPIC_API_KEY!),
          anthropicRuntime: 'agent-sdk',
        });
        expect(runtime.kind).toBe('agent-sdk');

        const budget = new Budget({
          maxFileReads: 8,
          maxContextBytes: 80_000,
          maxDurationSeconds: 180,
        });
        const bus = new PlannerEventBus();
        const events: PlannerEvent[] = [];
        bus.subscribe((e) => events.push(e));

        await runPlanner({
          root,
          runtime,
          provider: 'anthropic',
          modelId: LIVE_MODEL,
          events: bus,
          systemPrompt:
            'You are a planning assistant. You MUST call read_file on notes.txt once, then output a very short markdown plan (one heading).',
          userPrompt: 'Plan from intake and notes.txt.',
          budget,
          stages: { scout: { enabled: false } },
          validation: { enabled: false },
          maxIterations: 6,
          maxOutputTokens: 2048,
        });

        expect(events[0]?.kind).toBe('started');
        expect(events[1]?.kind).toBe('runtime_info');

        expect(events.some((e) => e.kind === 'usage')).toBe(true);

        const startedTools = events.filter((e) => e.kind === 'tool_call_started');
        expect(startedTools.length).toBeGreaterThanOrEqual(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

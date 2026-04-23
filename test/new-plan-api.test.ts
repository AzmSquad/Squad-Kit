import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPaths, SQUAD_DIR } from '../src/core/paths.js';
import { DEFAULT_CONFIG, saveConfig } from '../src/core/config.js';
import { runNewPlan } from '../src/commands/new-plan.js';
import { READ_FILE_TOOL } from '../src/planner/tools.js';
import type { PlannerProvider } from '../src/planner/types.js';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../src/planner/providers/index.js', () => ({
  providerFor: (): PlannerProvider => ({
    name: 'anthropic',
    send: mockSend,
  }),
}));

let tmp: string;
let prevCwd: string;
let prevKey: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-plan-api-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
  prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockSend.mockReset();

  const squad = path.join(tmp, SQUAD_DIR);
  fs.mkdirSync(squad, { recursive: true });
  saveConfig(path.join(squad, 'config.yaml'), {
    ...DEFAULT_CONFIG,
    planner: {
      enabled: true,
      provider: 'anthropic',
      mode: 'auto',
      budget: {
        maxFileReads: 25,
        maxContextBytes: 50_000,
        maxDurationSeconds: 180,
      },
    },
  });

  const paths = buildPaths(tmp);
  const intakeDir = path.join(paths.storiesDir, 'feat', 'sid');
  fs.mkdirSync(intakeDir, { recursive: true });
  fs.writeFileSync(path.join(intakeDir, 'intake.md'), '# Intake\nDo the thing.\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'only.txt'), 'x', 'utf8');
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevKey;
});

describe('runNewPlan API path', () => {
  it('writes plan file with metadata and assistant text', async () => {
    mockSend
      .mockResolvedValueOnce({
        toolCalls: [{ id: 'c1', name: READ_FILE_TOOL.name, input: { path: 'only.txt' } }],
        stopReason: 'tool_use' as const,
        usage: { inputTokens: 5, outputTokens: 5 },
      })
      .mockResolvedValueOnce({
        text: '# Story 01 — Done\n\nBody.\n',
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      });

    const intake = path.join(tmp, '.squad/stories/feat/sid/intake.md');
    await runNewPlan(intake, { yes: true });

    const planDir = path.join(tmp, '.squad/plans/feat');
    const files = fs.readdirSync(planDir).filter((f) => f.endsWith('.md') && f !== '00-overview.md');
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(planDir, files[0]!), 'utf8');
    expect(content.startsWith('<!-- squad-kit:')).toBe(true);
    expect(content).toContain('# Story 01 — Done');
    expect(content).toContain('Body.');
  });

  it('throws when API key is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SQUAD_PLANNER_API_KEY;
    const intake = path.join(tmp, '.squad/stories/feat/sid/intake.md');
    await expect(runNewPlan(intake, { yes: true, api: true })).rejects.toThrow(/Missing ANTHROPIC_API_KEY/);
  });

  it('rejects --api and --copy together', async () => {
    const intake = path.join(tmp, '.squad/stories/feat/sid/intake.md');
    await expect(runNewPlan(intake, { yes: true, api: true, copy: true })).rejects.toThrow(
      /Pass either --api or --copy/,
    );
  });
});

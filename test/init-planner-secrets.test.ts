import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { input, select, checkbox, confirm, password } from '@inquirer/prompts';
import { runInit } from '../src/commands/init.js';
import { loadSecrets } from '../src/core/secrets.js';
import * as ui from '../src/ui/index.js';
import { SQUAD_DIR } from '../src/core/paths.js';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
  checkbox: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
}));

let tmp: string;
let previousCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-init-planner-sec-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  vi.mocked(input).mockReset();
  vi.mocked(select).mockReset();
  vi.mocked(checkbox).mockReset();
  vi.mocked(confirm).mockReset();
  vi.mocked(password).mockReset();
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('init planner key → secrets (interactive, mocked)', () => {
  it('saves anthropic key to secrets when user chooses save to file', async () => {
    // @ts-expect-error inquirer Prompt result types use Promise & { cancel }
    vi.mocked(input).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.startsWith('Project name')) return 'proj';
      if (m.startsWith('Primary language')) return 'ts';
      throw new Error(`unexpected input: ${m}`);
    });
    // @ts-expect-error inquirer select mock
    vi.mocked(select).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.includes('Issue tracker')) return 'github';
      if (m.includes('Planner provider')) return 'anthropic';
      if (m.includes('How do you want to store')) return 'secrets';
      throw new Error(`unexpected select: ${m}`);
    });
    vi.mocked(checkbox).mockResolvedValue([] as string[]);
    // @ts-expect-error inquirer confirm mock
    vi.mocked(confirm).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.includes('Include tracker id')) return false;
      if (m.includes('Enable automatic plan')) return true;
      return false;
    });
    vi.mocked(password).mockResolvedValue('sk-1234567890123456789');

    await runInit({});

    const sec = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(sec.planner?.anthropic).toBe('sk-1234567890123456789');
  });

  it('does not write planner key when user defers to env, and shows missing warning', async () => {
    // @ts-expect-error vitest spy on ui.warning
    const warn = vi.spyOn(ui, 'warning').mockImplementation(() => undefined);

    // @ts-expect-error inquirer input mock
    vi.mocked(input).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.startsWith('Project name')) return 'proj';
      if (m.startsWith('Primary language')) return 'ts';
      throw new Error(`unexpected input: ${m}`);
    });
    // @ts-expect-error inquirer select mock
    vi.mocked(select).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.includes('Issue tracker')) return 'none';
      if (m.includes('Planner provider')) return 'openai';
      if (m.includes('How do you want to store')) return 'env';
      throw new Error(`unexpected select: ${m}`);
    });
    vi.mocked(checkbox).mockResolvedValue([] as string[]);
    // @ts-expect-error inquirer confirm mock
    vi.mocked(confirm).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.includes('Enable automatic plan')) return true;
      return false;
    });

    const prevOpen = process.env.OPENAI_API_KEY;
    const prevSquad = process.env.SQUAD_PLANNER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SQUAD_PLANNER_API_KEY;
    try {
      await runInit({});

      const secretsFile = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
      if (fs.existsSync(secretsFile)) {
        const s = loadSecrets(secretsFile);
        expect(s.planner?.openai).toBeUndefined();
      }
      expect(warn).toHaveBeenCalledWith('Planner key not found in environment or .squad/secrets.yaml.');
    } finally {
      if (prevOpen !== undefined) process.env.OPENAI_API_KEY = prevOpen;
      if (prevSquad !== undefined) process.env.SQUAD_PLANNER_API_KEY = prevSquad;
    }
  });
});

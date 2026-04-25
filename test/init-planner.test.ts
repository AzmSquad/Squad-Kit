import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../src/commands/init.js';
import { loadConfig } from '../src/core/config.js';

let tmp: string;
let previousCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-init-planner-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('init planner (non-interactive)', () => {
  it('leaves planner unset when -y and no --planner', async () => {
    await runInit({ yes: true });
    const config = loadConfig(path.join(tmp, '.squad', 'config.yaml'));
    expect(config.planner).toBeUndefined();
  });

  it('enables anthropic with default budget when -y and --planner anthropic', async () => {
    await runInit({ yes: true, planner: 'anthropic' });
    const config = loadConfig(path.join(tmp, '.squad', 'config.yaml'));
    expect(config.planner).toEqual({
      enabled: true,
      provider: 'anthropic',
      mode: 'auto',
      budget: {
        maxFileReads: 25,
        maxContextBytes: 50_000,
        maxDurationSeconds: 180,
      },
      cache: { enabled: true },
      maxOutputTokens: 16384,
    });
  });

  it('throws on bogus --planner', async () => {
    await expect(runInit({ yes: true, planner: 'bogus' })).rejects.toThrow(
      /anthropic \| openai \| google/,
    );
  });
});

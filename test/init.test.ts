import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../src/commands/init.js';
import { SQUAD_DIR } from '../src/core/paths.js';

let tmp: string;
let previousCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-init-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('init layout', () => {
  it('does not create .squad/prompts on fresh init', async () => {
    await runInit({ yes: true });
    const prompts = path.join(tmp, SQUAD_DIR, 'prompts');
    expect(fs.existsSync(prompts)).toBe(false);
  });

  it('creates config and stories dir', async () => {
    await runInit({ yes: true });
    expect(fs.existsSync(path.join(tmp, SQUAD_DIR, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, SQUAD_DIR, 'stories'))).toBe(true);
  });

  it('does not create .squad/prompts on init --force after existing config', async () => {
    await runInit({ yes: true });
    await runInit({ yes: true, force: true });
    expect(fs.existsSync(path.join(tmp, SQUAD_DIR, 'prompts'))).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select } from '@inquirer/prompts';
import { runInit } from '../src/commands/init.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import * as tty from '../src/ui/tty.js';
import * as ui from '../src/ui/index.js';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
  checkbox: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
}));

vi.mock('../src/commands/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/commands/config/index.js')>();
  return {
    ...actual,
    runConfigSetPlanner: vi.fn(() => Promise.resolve()),
    runConfigSetTracker: vi.fn(() => Promise.resolve()),
  };
});

import { runConfigSetPlanner } from '../src/commands/config/index.js';

let tmp: string;
let previousCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-initrec-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('init when .squad exists', () => {
  it('reconfigure planner routes to runConfigSetPlanner', async () => {
    await runInit({ yes: true });
    vi.spyOn(tty, 'isInteractive').mockReturnValue(true);
    vi.mocked(select).mockResolvedValueOnce('planner' as never);
    await runInit({});
    expect(runConfigSetPlanner).toHaveBeenCalled();
  });

  it('--force: rewrites config', async () => {
    await runInit({ yes: true });
    const p = path.join(tmp, SQUAD_DIR, 'config.yaml');
    const before = fs.readFileSync(p, 'utf8');
    await runInit({ yes: true, force: true });
    const after = fs.readFileSync(p, 'utf8');
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
  });

  it('non-interactive without --force: warning', async () => {
    await runInit({ yes: true });
    const warn = vi.spyOn(ui, 'warning');
    await runInit({ yes: true });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already exists/));
  });
});

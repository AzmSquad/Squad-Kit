import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { runConfigUnsetPlanner } from '../src/commands/config/unset-planner.js';
import { runConfigUnsetTracker } from '../src/commands/config/unset-tracker.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import { loadConfig, saveConfig, type SquadConfig } from '../src/core/config.js';
import { loadSecrets } from '../src/core/secrets.js';
import * as tty from '../src/ui/tty.js';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}));

let tmp: string;
let previousCwd: string;

function plannerCfg(): SquadConfig {
  return {
    version: 1,
    project: { name: 'n', projectRoots: ['.'] },
    tracker: { type: 'none' },
    naming: { includeTrackerId: false, globalSequence: true },
    agents: [],
    planner: {
      enabled: true,
      provider: 'openai',
      mode: 'auto',
      budget: { maxFileReads: 5, maxContextBytes: 1, maxDurationSeconds: 1 },
    },
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cfgun-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
  vi.mocked(confirm).mockReset();
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('config unset', () => {
  it('unset planner -y: removes planner; secrets kept', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), plannerCfg());
    fs.writeFileSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml'), 'planner:\n  openai: sk-XXXX\n', 'utf8');

    await runConfigUnsetPlanner({ yes: true });

    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(c.planner).toBeUndefined();
    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(s.planner?.openai).toBe('sk-XXXX');
  });

  it('unset planner --remove-credentials -y: clears planner secrets', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), plannerCfg());
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      'planner:\n  openai: sk-XXXX\n  anthropic: sk-YYYY\n',
      'utf8',
    );
    await runConfigUnsetPlanner({ yes: true, removeCredentials: true });
    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(s.planner).toBeUndefined();
  });

  it('unset tracker: type none, tracker secrets preserved', async () => {
    const cfg: SquadConfig = {
      ...plannerCfg(),
      tracker: { type: 'jira', workspace: 'h' },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      'tracker:\n  jira:\n    host: h\n    email: a@a\n    token: t\n',
      'utf8',
    );
    await runConfigUnsetTracker({ yes: true });
    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(c.tracker.type).toBe('none');
    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(s.tracker?.jira?.host).toBe('h');
  });

  it('confirm no cancels', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), plannerCfg());
    vi.spyOn(tty, 'isInteractive').mockReturnValue(true);
    vi.mocked(confirm).mockResolvedValue(false);
    const before = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    await runConfigUnsetPlanner({ yes: false });
    const after = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(after.planner).toEqual(before.planner);
  });
});

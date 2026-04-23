import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirm, input, password, select } from '@inquirer/prompts';
import { runConfigSetPlanner } from '../src/commands/config/set-planner.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import { loadConfig, saveConfig, type SquadConfig } from '../src/core/config.js';
import { loadSecrets } from '../src/core/secrets.js';
import * as tty from '../src/ui/tty.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
}));

let tmp: string;
let previousCwd: string;
const prevOpen = process.env.OPENAI_API_KEY;
const prevCi = process.env.CI;

function baseConfig(): SquadConfig {
  return {
    version: 1,
    project: { name: 'n', projectRoots: ['.'] },
    tracker: { type: 'none' },
    naming: { includeTrackerId: false, globalSequence: true },
    agents: [],
  };
}

beforeEach(() => {
  process.env.CI = '1';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cfgplanner-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
  vi.mocked(select).mockReset();
  vi.mocked(confirm).mockReset();
  vi.mocked(input).mockReset();
  vi.mocked(password).mockReset();
  vi.spyOn(tty, 'isInteractive').mockReturnValue(true);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (prevOpen === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = prevOpen;
  }
  if (prevCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = prevCi;
  }
  vi.restoreAllMocks();
});

describe('config set planner', () => {
  it('interactive: saves key and config with anthropic; secrets 0600 on POSIX', async () => {
    const cfg: SquadConfig = {
      ...baseConfig(),
      planner: {
        enabled: true,
        provider: 'anthropic',
        mode: 'auto',
        budget: { maxFileReads: 10, maxContextBytes: 1, maxDurationSeconds: 1 },
      },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('anthropic' as never);
    const key = 'sk-12345678901234567890abcdefghij';
    vi.mocked(password).mockResolvedValueOnce(key);
    vi.mocked(confirm).mockResolvedValueOnce(false);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runConfigSetPlanner({});

    const sec = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(sec.planner?.anthropic).toBe(key);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('change provider: anthropic key preserved when switching to openai', async () => {
    const cfg: SquadConfig = {
      ...baseConfig(),
      planner: {
        enabled: true,
        provider: 'anthropic',
        mode: 'auto',
        budget: { maxFileReads: 10, maxContextBytes: 1, maxDurationSeconds: 1 },
      },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    const secretsPath = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
    fs.writeFileSync(
      secretsPath,
      'planner:\n  anthropic: sk-AAAAAAAAAAAAAAAAAAABBBB\n',
      'utf8',
    );

    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('openai' as never);
    vi.mocked(confirm).mockResolvedValueOnce(false);
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(password).mockResolvedValue('sk-OPEN9999999999999999999OPEN999');

    await runConfigSetPlanner({});

    const sec = loadSecrets(secretsPath);
    expect(sec.planner?.anthropic).toBe('sk-AAAAAAAAAAAAAAAAAAABBBB');
    expect(sec.planner?.openai).toBe('sk-OPEN9999999999999999999OPEN999');
    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(c.planner?.provider).toBe('openai');
  });

  it('preserves an existing planner.modelOverride across re-runs (no prompt for override in 0.3+)', async () => {
    const cfg: SquadConfig = {
      ...baseConfig(),
      planner: {
        enabled: true,
        provider: 'anthropic',
        mode: 'auto',
        modelOverride: { anthropic: 'preserved-override-id' },
        budget: { maxFileReads: 10, maxContextBytes: 1, maxDurationSeconds: 1 },
      },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      'planner:\n  anthropic: sk-12345678901234567890abcdefghijk\n',
      'utf8',
    );

    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('anthropic' as never);
    vi.mocked(confirm).mockResolvedValueOnce(false);
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runConfigSetPlanner({});

    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(c.planner?.modelOverride?.anthropic).toBe('preserved-override-id');
  });

  it('interactive: cache prompt default preserves planner.cache when false in config', async () => {
    const cfg: SquadConfig = {
      ...baseConfig(),
      planner: {
        enabled: true,
        provider: 'anthropic',
        mode: 'auto',
        budget: { maxFileReads: 10, maxContextBytes: 1, maxDurationSeconds: 1 },
        cache: { enabled: false },
      },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      'planner:\n  anthropic: sk-12345678901234567890abcdefghijk\n',
      'utf8',
    );
    vi.mocked(select).mockResolvedValueOnce('change' as never);
    vi.mocked(select).mockResolvedValueOnce('anthropic' as never);
    vi.mocked(confirm).mockResolvedValueOnce(false);
    vi.mocked(confirm).mockResolvedValueOnce(false);
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await runConfigSetPlanner({});

    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(c.planner?.cache?.enabled).toBe(false);
  });

  it('non-interactive: --yes + openai with no key throws a dead-end error', async () => {
    if (process.env.OPENAI_API_KEY) {
      delete process.env.OPENAI_API_KEY;
    }
    const cfg: SquadConfig = { ...baseConfig() };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    await expect(runConfigSetPlanner({ yes: true, provider: 'openai' })).rejects.toThrow(/planner credential for `openai`/i);
  });

  it('non-interactive: with env key saves config, does not require secrets file write for key', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-only-key-1234567890123456';
    const cfg: SquadConfig = { ...baseConfig() };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    await runConfigSetPlanner({ yes: true, provider: 'openai' });
    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(c.planner?.enabled).toBe(true);
    expect(c.planner?.provider).toBe('openai');
    if (!fs.existsSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml'))) {
      // ok: key only in env
    } else {
      const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
      expect(s.planner?.openai).toBeUndefined();
    }
  });
});

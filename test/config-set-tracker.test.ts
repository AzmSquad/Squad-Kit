import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { input, password, select } from '@inquirer/prompts';
import { runConfigSetTracker } from '../src/commands/config/set-tracker.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import { loadConfig, saveConfig, type SquadConfig } from '../src/core/config.js';
import { loadSecrets } from '../src/core/secrets.js';
import * as tty from '../src/ui/tty.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  checkbox: vi.fn(),
}));

let tmp: string;
let previousCwd: string;
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cfgtrk-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
  vi.mocked(select).mockReset();
  vi.mocked(input).mockReset();
  vi.mocked(password).mockReset();
  vi.spyOn(tty, 'isInteractive').mockReturnValue(true);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (prevCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = prevCi;
  }
  vi.restoreAllMocks();
});

describe('config set tracker', () => {
  it('interactive jira: saves host, config, and secrets', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), baseConfig());
    vi.mocked(select).mockResolvedValueOnce('jira' as never);
    vi.mocked(input)
      .mockResolvedValueOnce('my.atlassian.net')
      .mockResolvedValueOnce('a@b.c');
    vi.mocked(password).mockResolvedValueOnce('token1234567890');

    await runConfigSetTracker({});

    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(c.tracker.type).toBe('jira');
    expect(c.tracker.workspace).toBe('my.atlassian.net');
    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(s.tracker?.jira?.host).toBe('my.atlassian.net');
    expect(s.tracker?.jira?.token).toBe('token1234567890');
    if (process.platform !== 'win32' && fs.existsSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml'))) {
      const mode = fs.statSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('interactive azure: saves org, project, pat', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), baseConfig());
    vi.mocked(select).mockResolvedValueOnce('azure' as never);
    vi.mocked(input).mockResolvedValueOnce('myorg').mockResolvedValueOnce('prj');
    vi.mocked(password).mockResolvedValueOnce('PAT-'.repeat(8));

    await runConfigSetTracker({});

    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(c.tracker.type).toBe('azure');
    expect(c.tracker.workspace).toBe('myorg');
    expect(c.tracker.project).toBe('prj');
    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(s.tracker?.azure?.organization).toBe('myorg');
  });

  it('jira to azure: keeps jira in secrets', async () => {
    const cfg: SquadConfig = {
      ...baseConfig(),
      tracker: { type: 'jira', workspace: 'h.net' },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      'tracker:\n  jira:\n    host: h.net\n    email: e@e.e\n    token: tokjira9999999\n',
      'utf8',
    );
    vi.mocked(select).mockResolvedValueOnce('azure' as never);
    vi.mocked(input).mockResolvedValueOnce('orgx').mockResolvedValueOnce('px');
    vi.mocked(password).mockResolvedValueOnce('PAT-'.repeat(8));

    await runConfigSetTracker({});

    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(s.tracker?.jira?.host).toBe('h.net');
    expect(s.tracker?.azure?.organization).toBe('orgx');
  });

  it('--type none: clears type; keeps credentials in secrets', async () => {
    const cfg: SquadConfig = {
      ...baseConfig(),
      tracker: { type: 'jira', workspace: 'h.net' },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      'tracker:\n  jira:\n    host: h.net\n    email: a@a.a\n    token: t\n',
      'utf8',
    );
    await runConfigSetTracker({ yes: true, type: 'none' });
    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(c.tracker.type).toBe('none');
    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(s.tracker?.jira?.host).toBe('h.net');
  });
});

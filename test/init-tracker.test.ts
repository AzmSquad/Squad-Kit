import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { input, select, checkbox, confirm, password } from '@inquirer/prompts';
import { runInit } from '../src/commands/init.js';
import { loadConfig } from '../src/core/config.js';
import { loadSecrets } from '../src/core/secrets.js';
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-init-tracker-'));
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
});

describe('init tracker (non-interactive)', () => {
  it('does not write secrets.yaml for -y --tracker jira', async () => {
    await runInit({ yes: true, tracker: 'jira' });
    const secretsFile = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
    expect(fs.existsSync(secretsFile)).toBe(false);
  });
});

describe('init tracker (interactive, mocked)', () => {
  it('writes jira block to secrets.yaml and updates gitignore', async () => {
    // @ts-expect-error inquirer input mock
    vi.mocked(input).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.startsWith('Project name')) return 'proj';
      if (m.startsWith('Primary language')) return 'ts';
      if (m.includes('Jira workspace host')) return 'acme.atlassian.net';
      if (m.includes('Jira account email')) return 'u@acme.com';
      throw new Error(`unexpected input: ${m}`);
    });
    // @ts-expect-error inquirer select mock
    vi.mocked(select).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.includes('Issue tracker')) return 'jira';
      throw new Error(`unexpected select: ${m}`);
    });
    vi.mocked(checkbox).mockResolvedValue([] as string[]);
    // @ts-expect-error inquirer confirm mock
    vi.mocked(confirm).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.includes('Include tracker id')) return true;
      if (m.includes('Enable automatic plan')) return false;
      return false;
    });
    vi.mocked(password).mockResolvedValue('12345678901');

    await runInit({});

    const secretsFile = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
    expect(fs.existsSync(secretsFile)).toBe(true);
    const st = fs.statSync(secretsFile);
    if (process.platform !== 'win32') {
      expect(st.mode & 0o777).toBe(0o600);
    }
    const sec = loadSecrets(secretsFile);
    expect(sec.tracker?.jira).toEqual({
      host: 'acme.atlassian.net',
      email: 'u@acme.com',
      token: '12345678901',
    });

    const config = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    expect(config.tracker.type).toBe('jira');
    expect(config.tracker.workspace).toBe('acme.atlassian.net');

    const gi = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
    expect(gi).toContain('.squad/secrets.yaml');
  });

  it('writes azure block to secrets.yaml', async () => {
    // @ts-expect-error inquirer input mock
    vi.mocked(input).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.startsWith('Project name')) return 'proj';
      if (m.startsWith('Primary language')) return 'ts';
      if (m.includes('Azure DevOps organization')) return 'myorg';
      if (m.includes('Azure DevOps project')) return 'myproj';
      throw new Error(`unexpected input: ${m}`);
    });
    // @ts-expect-error inquirer select mock
    vi.mocked(select).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.includes('Issue tracker')) return 'azure';
      throw new Error(`unexpected select: ${m}`);
    });
    vi.mocked(checkbox).mockResolvedValue([] as string[]);
    // @ts-expect-error inquirer confirm mock
    vi.mocked(confirm).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.includes('Include tracker id')) return false;
      if (m.includes('Enable automatic plan')) return false;
      return false;
    });
    vi.mocked(password).mockResolvedValue('12345678901234567890');

    await runInit({});

    const secretsFile = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
    const sec = loadSecrets(secretsFile);
    expect(sec.tracker?.azure).toEqual({
      organization: 'myorg',
      project: 'myproj',
      pat: '12345678901234567890',
    });
    const raw = fs.readFileSync(path.join(tmp, SQUAD_DIR, 'config.yaml'), 'utf8');
    const cfg = yaml.load(raw) as { tracker: { type: string; workspace?: string; project?: string } };
    expect(cfg.tracker.type).toBe('azure');
    expect(cfg.tracker.workspace).toBe('myorg');
    expect(cfg.tracker.project).toBe('myproj');
  });
});

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
import { EMAIL, SITE, fakeJira } from './fakes/jira.js';

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
  vi.unstubAllGlobals();
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const NEW_SETUP = { type: 'jira', workspace: SITE, project: 'PAY', options: { updates: 'on', board: '1', boardName: 'PAY board' } };

describe('init tracker (non-interactive)', () => {
  it('-y --tracker jira with nothing to check it with: no tracker yet, nothing half set up, and the next step said', async () => {
    vi.stubGlobal('fetch', fakeJira().fetch);
    await runInit({ yes: true, tracker: 'jira' });
    expect(fs.existsSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml'))).toBe(false);
    expect(loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml')).tracker).toEqual({ type: 'none' });
  });

  it('-y --tracker jira with the site, project and a JIRA_* sign-in: the setup Save and check writes, checked with Jira', async () => {
    vi.stubGlobal('fetch', fakeJira('12345678901').fetch);
    process.env.JIRA_HOST = SITE;
    process.env.JIRA_EMAIL = EMAIL;
    process.env.JIRA_API_TOKEN = '12345678901';
    await runInit({ yes: true, tracker: 'jira', trackerWorkspace: SITE, trackerProject: 'PAY' });
    expect(loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml')).tracker).toEqual(NEW_SETUP);
  });
});

describe('init tracker (interactive, mocked)', () => {
  it('sets Jira up as Settings does: asks its fields, checks them with Jira, keeps the token apart, updates gitignore', async () => {
    // @ts-expect-error inquirer input mock
    vi.mocked(input).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.startsWith('Project name')) return 'proj';
      if (m.startsWith('Primary language')) return 'ts';
      if (m === 'Site') return 'acme';
      if (m === 'Email') return EMAIL;
      if (m.startsWith('Project')) return 'PAY';
      throw new Error(`unexpected input: ${m}`);
    });
    // @ts-expect-error inquirer select mock
    vi.mocked(select).mockImplementation(async (opts) => {
      const m = String((opts as { message: string }).message);
      if (m.includes('Issue tracker')) return 'jira';
      if (m === 'Sprints from') return '';
      throw new Error(`unexpected select: ${m}`);
    });
    vi.mocked(checkbox).mockResolvedValue([] as string[]);
    vi.stubGlobal('fetch', fakeJira('12345678901').fetch);
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
    expect(sec.tracker?.jira).toEqual({ host: SITE, email: EMAIL, token: '12345678901' });

    // The setup Save and check writes: the team's site, project and board, checked with Jira.
    expect(loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml')).tracker).toEqual(NEW_SETUP);
    expect(fs.readFileSync(path.join(tmp, SQUAD_DIR, 'README.md'), 'utf8')).toContain('**Tracker:** jira');

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

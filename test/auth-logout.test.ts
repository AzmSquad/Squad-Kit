import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { runAuthLogout } from '../src/commands/auth/logout.js';
import { saveConfig, type SquadConfig } from '../src/core/config.js';
import { loadSecrets } from '../src/core/secrets.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import * as ui from '../src/ui/index.js';
import * as tty from '../src/ui/tty.js';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

let tmp: string;
let previousCwd: string;

const FULL_SECRETS = [
  'planner:',
  '  anthropic: sk-ant-api03-keep-this-key-1234567890',
  '  openai: sk-openai-keep-1234567890',
  '  anthropicOauthToken: sk-ant-oat01-remove-me-0123456789',
  'tracker:',
  '  jira:',
  '    host: h.example.com',
  '    email: a@b.co',
  '    token: jira-token-1234567890',
  '',
].join('\n');

function config(): SquadConfig {
  return {
    version: 1,
    project: { name: 'n', projectRoots: ['.'] },
    tracker: { type: 'none' },
    naming: { includeTrackerId: false, globalSequence: true },
    agents: [],
    planner: {
      enabled: true,
      provider: 'anthropic',
      mode: 'auto',
      auth: { anthropic: 'subscription' },
      budget: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
    },
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-auth-logout-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, SQUAD_DIR), { recursive: true });
  saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), config());
  fs.writeFileSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml'), FULL_SECRETS, 'utf8');
  fs.chmodSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml'), 0o600);
  vi.mocked(confirm).mockReset();
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('squad auth logout', () => {
  it('removes only planner.anthropicOauthToken and leaves every sibling secret intact', async () => {
    await runAuthLogout({ yes: true });

    const secretsFile = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
    const after = loadSecrets(secretsFile);
    expect(after.planner?.anthropicOauthToken).toBeUndefined();
    expect(after.planner?.anthropic).toBe('sk-ant-api03-keep-this-key-1234567890');
    expect(after.planner?.openai).toBe('sk-openai-keep-1234567890');
    expect(after.tracker?.jira?.host).toBe('h.example.com');
    expect(after.tracker?.jira?.email).toBe('a@b.co');
    expect(after.tracker?.jira?.token).toBe('jira-token-1234567890');

    if (process.platform !== 'win32') {
      expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
    }
  });

  it('says the Claude Code login is untouched and names squad auth login for the still-subscription mode', async () => {
    const infos: string[] = [];
    vi.spyOn(ui, 'info').mockImplementation((m: string) => {
      infos.push(m);
      return true;
    });
    vi.spyOn(ui, 'success').mockImplementation(() => true);

    await runAuthLogout({ yes: true });

    expect(infos.some((m) => m.includes('Your Claude Code login is untouched'))).toBe(true);
    expect(infos.some((m) => m.includes('`squad auth login`'))).toBe(true);
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.spyOn(tty, 'isInteractive').mockReturnValue(true);
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await runAuthLogout({});

    const after = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(after.planner?.anthropicOauthToken).toBe('sk-ant-oat01-remove-me-0123456789');
  });

  it('is a no-op with a clear message when nothing is stored', async () => {
    fs.writeFileSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml'), 'planner:\n  openai: sk-o-123\n', 'utf8');
    const infos: string[] = [];
    vi.spyOn(ui, 'info').mockImplementation((m: string) => {
      infos.push(m);
      return true;
    });

    await runAuthLogout({ yes: true });

    expect(infos.some((m) => m.includes('nothing to remove'))).toBe(true);
    expect(loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml')).planner?.openai).toBe('sk-o-123');
  });
});

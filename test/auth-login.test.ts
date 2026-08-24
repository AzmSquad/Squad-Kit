import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirm, password } from '@inquirer/prompts';
import { runAuthLogin, NON_TTY_LOGIN_MESSAGE } from '../src/commands/auth/login.js';
import { extractOauthToken, validateOauthToken } from '../src/commands/auth/shared.js';
import { spawnSetupToken } from '../src/commands/auth/setup-token.js';
import { saveConfig, type SquadConfig } from '../src/core/config.js';
import { loadSecrets } from '../src/core/secrets.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import * as tty from '../src/ui/tty.js';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  password: vi.fn(),
}));

vi.mock('../src/commands/auth/setup-token.js', () => ({
  spawnSetupToken: vi.fn(),
}));

// The verification probe must never spawn anything in the suite.
vi.mock('../src/planner/runtimes/auth-probe.js', () => ({
  probeClaudeAuth: vi.fn(async () => ({ ok: true as const })),
  DEFAULT_AUTH_PROBE_TIMEOUT_MS: 10_000,
}));

const VALID_TOKEN = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

let tmp: string;
let previousCwd: string;

function baseConfig(): SquadConfig {
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
      budget: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
    },
  };
}

beforeEach(() => {
  process.env.CI = '1';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-auth-login-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, SQUAD_DIR), { recursive: true });
  saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), baseConfig());
  vi.mocked(confirm).mockReset();
  vi.mocked(password).mockReset();
  vi.mocked(spawnSetupToken).mockReset();
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('validateOauthToken', () => {
  it('rejects an Anthropic API key by prefix', () => {
    expect(() => validateOauthToken('sk-ant-api03-abcdefghijklmnopqrstuvwx')).toThrow(
      /looks like an Anthropic API key/,
    );
  });

  it('rejects values containing whitespace', () => {
    expect(() => validateOauthToken('sk-ant-oat01-abc def ghijklmnopqrstuv')).toThrow(/whitespace/);
  });

  it('rejects an empty value', () => {
    expect(() => validateOauthToken('   ')).toThrow(/empty/);
  });

  it('rejects an implausibly short value', () => {
    expect(() => validateOauthToken('sk-ant-oat01-x')).toThrow(/too short/);
  });

  it('accepts a plausible setup-token value and trims it', () => {
    expect(validateOauthToken(`  ${VALID_TOKEN}\n`)).toBe(VALID_TOKEN);
  });

  it('accepts an opaque non-sk value of sane length', () => {
    const opaque = 'a'.repeat(64);
    expect(validateOauthToken(opaque)).toBe(opaque);
  });
});

describe('extractOauthToken', () => {
  it('finds the token in noisy login output', () => {
    const out = [
      'Open this URL to authorize:',
      'https://claude.ai/oauth/authorize?code=1',
      '',
      `Your token: ${VALID_TOKEN}`,
      'Store it somewhere safe.',
    ].join('\n');
    expect(extractOauthToken(out)).toBe(VALID_TOKEN);
  });

  it('returns undefined rather than guessing when the prefix is absent', () => {
    expect(extractOauthToken('login complete, no token printed')).toBeUndefined();
    expect(extractOauthToken('sk-ant-api03-abcdefghijklmnopqrstuvwx')).toBeUndefined();
  });
});

describe('runAuthLogin non-TTY guard', () => {
  it('fails with instructions and spawns nothing when there is no terminal', async () => {
    vi.spyOn(tty, 'isInteractive').mockReturnValue(false);

    await expect(runAuthLogin({})).rejects.toThrow(NON_TTY_LOGIN_MESSAGE);
    expect(spawnSetupToken).not.toHaveBeenCalled();
  });
});

describe('runAuthLogin --token', () => {
  it('stores the token, sets auth: subscription, and never spawns the browser flow', async () => {
    vi.spyOn(tty, 'isInteractive').mockReturnValue(true);

    await runAuthLogin({ token: VALID_TOKEN });

    const secrets = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(secrets.planner?.anthropicOauthToken).toBe(VALID_TOKEN);
    const raw = fs.readFileSync(path.join(tmp, SQUAD_DIR, 'config.yaml'), 'utf8');
    expect(raw).toMatch(/anthropic: subscription/);
    expect(spawnSetupToken).not.toHaveBeenCalled();
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('rejects an API key before touching the filesystem', async () => {
    await expect(runAuthLogin({ token: 'sk-ant-api03-abcdefghijklmnopqrstuvwx' })).rejects.toThrow(
      /squad config set planner/,
    );
    expect(fs.existsSync(path.join(tmp, SQUAD_DIR, 'secrets.yaml'))).toBe(false);
  });

  it('refuses --token together with --print-only', async () => {
    await expect(runAuthLogin({ token: VALID_TOKEN, printOnly: true })).rejects.toThrow(
      /either --token or --print-only/,
    );
  });

  it('keeps the existing token when the overwrite confirmation is declined', async () => {
    vi.spyOn(tty, 'isInteractive').mockReturnValue(true);
    const secretsFile = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
    fs.writeFileSync(secretsFile, `planner:\n  anthropicOauthToken: ${VALID_TOKEN}-old\n`, 'utf8');
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await runAuthLogin({ token: VALID_TOKEN });

    expect(loadSecrets(secretsFile).planner?.anthropicOauthToken).toBe(`${VALID_TOKEN}-old`);
  });
});

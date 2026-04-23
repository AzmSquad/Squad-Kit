import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { runMigrate, MIGRATIONS } from '../src/commands/migrate.js';
import { saveConfig, DEFAULT_CONFIG, type SquadConfig } from '../src/core/config.js';
import { SQUAD_DIR, buildPaths } from '../src/core/paths.js';
import { ensureGitignore } from '../src/core/gitignore.js';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}));

let tmp: string;
let previousCwd: string;
let exitMock: MockInstance<typeof process.exit>;

function installWorkspace(cfg: SquadConfig = DEFAULT_CONFIG): void {
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
  saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
}

function stubStdinTTY(value: boolean): () => void {
  const desc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  return () => {
    if (desc) Object.defineProperty(process.stdin, 'isTTY', desc);
    else Reflect.deleteProperty(process.stdin as object, 'isTTY');
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-migrate-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.mocked(confirm).mockReset();
  vi.mocked(confirm).mockResolvedValue(true);
  delete process.env.CI;
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runMigrate', () => {
  it('reports no migrations when .squad/ is already 0.2.0-shaped', async () => {
    installWorkspace();
    ensureGitignore(tmp);
    await runMigrate({ yes: true });
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('removes legacy .squad/prompts/ and is idempotent', async () => {
    installWorkspace();
    ensureGitignore(tmp);
    const legacyDir = path.join(tmp, SQUAD_DIR, 'prompts');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'generate-plan.md'), 'stale', 'utf8');

    await runMigrate({ yes: true });
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(exitMock).not.toHaveBeenCalled();

    await runMigrate({ yes: true });
    expect(exitMock).not.toHaveBeenCalled();
  });

  it('appends .gitignore managed block when missing', async () => {
    installWorkspace();
    expect(fs.existsSync(path.join(tmp, '.gitignore'))).toBe(false);

    await runMigrate({ yes: true });
    expect(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8')).toContain('.squad/secrets.yaml');
  });

  it('tightens secrets.yaml to 0600 on POSIX', async () => {
    if (process.platform === 'win32') {
      expect(true).toBe(true);
      return;
    }
    installWorkspace();
    ensureGitignore(tmp);
    const secrets = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
    fs.writeFileSync(secrets, 'planner: {}\n', 'utf8');
    fs.chmodSync(secrets, 0o644);
    const before = fs.statSync(secrets).mode & 0o777;
    expect(before).toBe(0o644);

    await runMigrate({ yes: true });
    expect(fs.statSync(secrets).mode & 0o777).toBe(0o600);
  });

  it('backfills planner.budget in config when enabled planner lacks budget in YAML', async () => {
    installWorkspace();
    ensureGitignore(tmp);
    const cfgPath = path.join(tmp, SQUAD_DIR, 'config.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'version: 1',
        'project: { name: "m" }',
        'tracker: { type: none }',
        'naming: { includeTrackerId: false, globalSequence: true }',
        'agents: []',
        'planner:',
        '  enabled: true',
        '  provider: anthropic',
        '  mode: auto',
        '',
      ].join('\n'),
      'utf8',
    );

    const rawBefore = fs.readFileSync(cfgPath, 'utf8');
    expect(rawBefore).not.toMatch(/^\s*budget:/m);

    await runMigrate({ yes: true });
    const after = fs.readFileSync(cfgPath, 'utf8');
    expect(after).toMatch(/^\s*budget:/m);
  });

  it('dry-run lists pending work and does not change the filesystem', async () => {
    installWorkspace();
    const legacyDir = path.join(tmp, SQUAD_DIR, 'prompts');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'x.md'), 'x', 'utf8');

    await runMigrate({ dryRun: true });
    expect(fs.existsSync(legacyDir)).toBe(true);
  });

  it('exits 1 in non-interactive mode without --yes', async () => {
    installWorkspace();
    const legacyDir = path.join(tmp, SQUAD_DIR, 'prompts');
    fs.mkdirSync(legacyDir, { recursive: true });

    const restoreTty = stubStdinTTY(false);
    exitMock.mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`EXIT:${code ?? ''}`);
    });
    try {
      await expect(runMigrate({})).rejects.toThrow('EXIT:1');
    } finally {
      exitMock.mockImplementation(() => undefined as never);
      restoreTty();
    }
  });

  it('cancels when confirm returns false', async () => {
    installWorkspace();
    ensureGitignore(tmp);
    const legacyDir = path.join(tmp, SQUAD_DIR, 'prompts');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'x.md'), 'x', 'utf8');

    vi.mocked(confirm).mockResolvedValue(false);
    const restoreTty = stubStdinTTY(true);

    await runMigrate({});

    expect(fs.existsSync(legacyDir)).toBe(true);
    restoreTty();
  });
});

describe('legacy prompts path safety', () => {
  it('refuses a suspicious promptsDir', async () => {
    const m = MIGRATIONS.find((x) => x.id === 'legacy-prompts');
    expect(m).toBeDefined();
    const safeRoot = path.join(tmp, 'repo');
    const paths = {
      ...buildPaths(safeRoot),
      promptsDir: path.join(path.sep, 'tmp', 'random', 'weird-path'),
    };
    expect(() => m!.apply(paths)).toThrow(/Refusing to delete suspicious path/);
  });
});

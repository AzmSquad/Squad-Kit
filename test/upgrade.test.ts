import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import { runUpgrade } from '../src/commands/upgrade.js';
import { readInstalledPackage } from '../src/core/package-info.js';
import type { InstalledPackage } from '../src/core/package-info.js';
import { isNewer } from '../src/core/registry.js';
import { detectPackageManager, installCommandFor } from '../src/core/package-manager.js';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}));

vi.mock('../src/core/package-info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/package-info.js')>();
  return {
    ...actual,
    readInstalledPackage: vi.fn(),
  };
});

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function baseInstalled(overrides: Partial<InstalledPackage> = {}): InstalledPackage {
  return {
    name: 'squad-kit',
    version: '0.2.0',
    root: '/global/node_modules/squad-kit',
    repositoryUrl: 'https://github.com/AzmSquad/squad-kit',
    isDevInstall: false,
    ...overrides,
  };
}

function mockRegistry(latest: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        'dist-tags': { latest },
        versions: Object.fromEntries([latest, '0.2.0', '0.1.0'].map((v) => [v, {}])),
      }),
    }),
  );
}

function stubStdinTTY(value: boolean): () => void {
  const desc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  return () => {
    if (desc) Object.defineProperty(process.stdin, 'isTTY', desc);
    else Reflect.deleteProperty(process.stdin as object, 'isTTY');
  };
}

/** Real `process.exit` terminates the process; a no-op mock lets code fall through — use a throw instead. */
function mockExitThrows() {
  return vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`PROCESS_EXIT:${code ?? 0}`);
  });
}

let restoreStdinTTY: (() => void) | undefined;

beforeEach(() => {
  vi.mocked(readInstalledPackage).mockReturnValue(baseInstalled());
  vi.mocked(confirm).mockReset();
  vi.mocked(confirm).mockResolvedValue(true);
  delete process.env.CI;
  delete process.env.npm_config_user_agent;
  restoreStdinTTY = stubStdinTTY(true);
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const ee = new EventEmitter();
    queueMicrotask(() => ee.emit('exit', 0));
    return ee as ChildProcess;
  });
  mockRegistry('0.2.1');
});

afterEach(() => {
  restoreStdinTTY?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runUpgrade', () => {
  it('reports already on latest when registry matches installed', async () => {
    mockRegistry('0.2.0');
    const exitSpy = vi.spyOn(process, 'exit');
    await runUpgrade({});
    expect(exitSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('upgrades on newer patch with --yes and spawns pnpm when user-agent is pnpm', async () => {
    process.env.npm_config_user_agent = 'pnpm/8.15.0 npm/? node/v20.0.0 darwin arm64';
    const exitSpy = vi.spyOn(process, 'exit');
    await runUpgrade({ yes: true });
    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm',
      ['add', '-g', 'squad-kit@0.2.1'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('allows newer minor within same major', async () => {
    mockRegistry('0.3.0');
    process.env.npm_config_user_agent = 'pnpm/8.15.0';
    const exitSpy = vi.spyOn(process, 'exit');
    await runUpgrade({ yes: true });
    expect(spawnMock).toHaveBeenCalledWith(
      'pnpm',
      ['add', '-g', 'squad-kit@0.3.0'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('refuses major bump without spawn', async () => {
    mockRegistry('1.0.0');
    mockExitThrows();
    await expect(runUpgrade({ yes: true })).rejects.toThrow('PROCESS_EXIT:1');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('handles registry unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    mockExitThrows();
    await expect(runUpgrade({})).rejects.toThrow('PROCESS_EXIT:1');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses dev install', async () => {
    vi.mocked(readInstalledPackage).mockReturnValue(baseInstalled({ isDevInstall: true }));
    mockExitThrows();
    await expect(runUpgrade({})).rejects.toThrow('PROCESS_EXIT:1');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('--check prints command and does not spawn', async () => {
    process.env.npm_config_user_agent = 'npm/10.0.0';
    const exitSpy = vi.spyOn(process, 'exit');
    await runUpgrade({ check: true });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('refuses non-interactive without --yes', async () => {
    restoreStdinTTY?.();
    const undoNoTty = stubStdinTTY(false);
    mockExitThrows();
    try {
      await expect(runUpgrade({})).rejects.toThrow('PROCESS_EXIT:1');
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      undoNoTty();
      restoreStdinTTY = stubStdinTTY(true);
    }
  });

  it('does not spawn when user declines confirm', async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    const exitSpy = vi.spyOn(process, 'exit');
    await runUpgrade({});
    expect(spawnMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe('detectPackageManager', () => {
  it('uses npm_config_user_agent for pnpm', () => {
    process.env.npm_config_user_agent = 'pnpm/8.15.0';
    expect(detectPackageManager('/tmp')).toEqual({ pm: 'pnpm', reason: 'npm_config_user_agent' });
  });

  it('detects pnpm from install path when no user-agent', () => {
    delete process.env.npm_config_user_agent;
    const root = `/Users/me/Library/pnpm/global/5/node_modules/squad-kit`;
    expect(detectPackageManager(root).pm).toBe('pnpm');
  });

  it('falls back to npm', () => {
    delete process.env.npm_config_user_agent;
    expect(detectPackageManager('/usr/local/lib/node_modules/squad-kit')).toEqual({
      pm: 'npm',
      reason: 'default fallback',
    });
  });
});

describe('installCommandFor', () => {
  it('returns correct commands per package manager', () => {
    expect(installCommandFor('pnpm', 'squad-kit', '1.2.3')).toEqual({
      cmd: 'pnpm',
      args: ['add', '-g', 'squad-kit@1.2.3'],
    });
    expect(installCommandFor('npm', 'squad-kit', '1.2.3')).toEqual({
      cmd: 'npm',
      args: ['install', '-g', 'squad-kit@1.2.3'],
    });
    expect(installCommandFor('yarn', 'squad-kit', '1.2.3')).toEqual({
      cmd: 'yarn',
      args: ['global', 'add', 'squad-kit@1.2.3'],
    });
    expect(installCommandFor('bun', 'squad-kit', '1.2.3')).toEqual({
      cmd: 'bun',
      args: ['install', '-g', 'squad-kit@1.2.3'],
    });
  });
});

describe('isNewer', () => {
  it('compares semver tuples', () => {
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('0.2.0', '0.2.1')).toBe(false);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
  });
});

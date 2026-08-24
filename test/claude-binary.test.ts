import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  claudeBinaryPackageNames,
  claudeBinaryPackageSpecs,
  resetClaudeBinaryCache,
  resolveClaudeBinary,
} from '../src/core/claude-binary.js';

const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

const req = createRequire(import.meta.url);

function sdkOptionalDependencies(): string[] {
  const entry = req.resolve('@anthropic-ai/claude-agent-sdk');
  const pkgFile = path.join(path.dirname(entry), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as {
    optionalDependencies?: Record<string, string>;
  };
  return Object.keys(pkg.optionalDependencies ?? {});
}

const realPlatform = process.platform;

function forcePlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  resetClaudeBinaryCache();
});

afterEach(() => {
  forcePlatform(realPlatform);
  resetClaudeBinaryCache();
  vi.restoreAllMocks();
});

describe('claudeBinaryPackageNames', () => {
  it('constructs names that exist in the SDK optionalDependencies for the running platform', () => {
    const optional = sdkOptionalDependencies();
    expect(optional).toHaveLength(8);
    const names = claudeBinaryPackageNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(optional).toContain(name);
    }
  });

  it('covers every SDK platform package across the eight platform/arch combinations', () => {
    const optional = new Set(sdkOptionalDependencies());
    const covered = new Set<string>();
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const arch of ['x64', 'arm64'] as const) {
        for (const name of claudeBinaryPackageNames(platform, arch)) covered.add(name);
      }
    }
    expect([...covered].sort()).toEqual([...optional].sort());
  });

  it('mirrors the SDK resolver: musl first on linux, .exe first on win32', () => {
    expect(claudeBinaryPackageSpecs('linux', 'x64')).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
      '@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    ]);
    expect(claudeBinaryPackageSpecs('win32', 'arm64')[0]).toBe(
      '@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe',
    );
  });
});

describe('resolveClaudeBinary', () => {
  it('falls back to PATH when the bundled resolve throws', () => {
    // No `@anthropic-ai/claude-agent-sdk-freebsd-*` package exists, so every bundled candidate throws.
    forcePlatform('freebsd');
    execFileSyncMock.mockReturnValue(`${process.execPath}\n`);

    const found = resolveClaudeBinary();

    expect(found).toEqual({ path: process.execPath, source: 'path' });
    expect(execFileSyncMock).toHaveBeenCalledWith('which', ['claude'], expect.anything());
  });

  it('returns undefined when neither the bundled package nor PATH resolves', () => {
    forcePlatform('freebsd');
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(resolveClaudeBinary()).toBeUndefined();
  });

  it('prefers the bundled binary and never consults PATH when it resolves', () => {
    execFileSyncMock.mockReturnValue(`${process.execPath}\n`);
    const bundledPresent = claudeBinaryPackageSpecs().some((spec) => {
      try {
        req.resolve(spec);
        return true;
      } catch {
        return false;
      }
    });

    const found = resolveClaudeBinary();

    if (!bundledPresent && found?.source !== 'bundled') {
      // Installed with --omit=optional; the PATH fallback is the correct answer there.
      expect(found?.source).toBe('path');
      return;
    }
    expect(found?.source).toBe('bundled');
    expect(found?.path.endsWith('claude') || found?.path.endsWith('claude.exe')).toBe(true);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('caches the answer across calls', () => {
    forcePlatform('freebsd');
    execFileSyncMock.mockReturnValue(`${process.execPath}\n`);

    resolveClaudeBinary();
    resolveClaudeBinary();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { copyToClipboard } from '../src/utils/clipboard.js';

const envKeys = ['DISPLAY', 'WAYLAND_DISPLAY', 'TERMUX_VERSION'];
const snapshots: Record<string, string | undefined> = {};

function clearEnv(): void {
  for (const k of envKeys) {
    snapshots[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreEnv(): void {
  for (const k of envKeys) {
    if (snapshots[k] === undefined) delete process.env[k];
    else process.env[k] = snapshots[k];
  }
}

describe('copyToClipboard', () => {
  beforeEach(() => {
    clearEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('returns a structured result with ok and reason', async () => {
    const result = await copyToClipboard('hello world');
    expect(result).toHaveProperty('ok');
    if (!result.ok) {
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe('string');
    } else {
      expect(result.tool).toBeTruthy();
    }
  });

  it('on Linux without DISPLAY/WAYLAND explains headless context', async () => {
    if (process.platform !== 'linux') return;
    const result = await copyToClipboard('x');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/display server|clipboard tool detected/);
  });

  it('on macOS copies through pbcopy: the stand-in, so the person\'s clipboard stays as it is', async () => {
    if (process.platform !== 'darwin') return;
    const tool = execFileSync('/bin/sh', ['-c', 'command -v pbcopy'], { encoding: 'utf8' }).trim();
    expect(tool.startsWith(process.env.SQUAD_KIT_HOME!)).toBe(true);
    const result = await copyToClipboard('squad-kit clipboard test');
    expect(result).toEqual({ ok: true, tool: 'pbcopy' });
    expect(fs.readFileSync(path.join(process.env.SQUAD_KIT_HOME!, 'clipboard.txt'), 'utf8')).toBe('squad-kit clipboard test');
  });
});

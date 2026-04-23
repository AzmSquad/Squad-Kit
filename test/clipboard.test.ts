import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('on macOS returns ok when pbcopy is available', async () => {
    if (process.platform !== 'darwin') return;
    const result = await copyToClipboard('squad-kit clipboard test');
    if (result.ok) {
      expect(result.tool).toBe('pbcopy');
    } else {
      expect(result.reason).toBeTruthy();
    }
  });
});

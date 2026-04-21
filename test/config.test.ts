import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/core/config.js';

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cfg-'));
  file = path.join(tmp, 'config.yaml');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('config load/save', () => {
  it('round-trips the default config', () => {
    saveConfig(file, DEFAULT_CONFIG);
    const loaded = loadConfig(file);
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });

  it('merges partial overrides onto defaults', () => {
    fs.writeFileSync(file, 'version: 1\ntracker:\n  type: github\n  workspace: my-org\n', 'utf8');
    const loaded = loadConfig(file);
    expect(loaded.tracker.type).toBe('github');
    expect(loaded.tracker.workspace).toBe('my-org');
    expect(loaded.project.name).toBe(DEFAULT_CONFIG.project.name);
    expect(loaded.naming.globalSequence).toBe(true);
  });

  it('throws on non-object YAML', () => {
    fs.writeFileSync(file, 'just a string\n', 'utf8');
    expect(() => loadConfig(file)).toThrow(/Invalid config/);
  });
});

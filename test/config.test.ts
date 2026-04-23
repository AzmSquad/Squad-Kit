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

  it('preserves a valid planner block after merge', () => {
    fs.writeFileSync(
      file,
      [
        'version: 1',
        'project:',
        '  name: x',
        '  projectRoots: ["."]',
        'tracker:',
        '  type: none',
        'naming:',
        '  includeTrackerId: false',
        '  globalSequence: true',
        'agents: []',
        'planner:',
        '  enabled: true',
        '  provider: openai',
        '  mode: copy',
        '  budget:',
        '    maxFileReads: 10',
        '    maxContextBytes: 20000',
        '    maxDurationSeconds: 60',
        '    maxCostUsd: 0.5',
      ].join('\n'),
      'utf8',
    );
    const loaded = loadConfig(file);
    expect(loaded.planner).toEqual({
      enabled: true,
      provider: 'openai',
      mode: 'copy',
      budget: {
        maxFileReads: 10,
        maxContextBytes: 20000,
        maxDurationSeconds: 60,
        maxCostUsd: 0.5,
      },
      cache: { enabled: true },
    });
  });

  it('throws when planner.budget.maxFileReads is 0 and planner enabled', () => {
    fs.writeFileSync(
      file,
      [
        'version: 1',
        'project: { name: x, projectRoots: ["."] }',
        'tracker: { type: none }',
        'naming: { includeTrackerId: false, globalSequence: true }',
        'agents: []',
        'planner:',
        '  enabled: true',
        '  budget:',
        '    maxFileReads: 0',
        '    maxContextBytes: 100',
        '    maxDurationSeconds: 1',
      ].join('\n'),
      'utf8',
    );
    expect(() => loadConfig(file)).toThrow(/maxFileReads must be > 0/);
  });

  it('rejects secret-looking keys with a clear path', () => {
    fs.writeFileSync(
      file,
      [
        'version: 1',
        'project: { name: x, projectRoots: ["."] }',
        'tracker: { type: none }',
        'naming: { includeTrackerId: false, globalSequence: true }',
        'agents: []',
        'planner:',
        '  enabled: false',
        '  nested:',
        '    apiKey: abc',
      ].join('\n'),
      'utf8',
    );
    expect(() => loadConfig(file)).toThrow(/planner\.nested\.apiKey/);
  });

  it('returns planner undefined when no planner block', () => {
    fs.writeFileSync(
      file,
      [
        'version: 1',
        'project: { name: x, projectRoots: ["."] }',
        'tracker: { type: none }',
        'naming: { includeTrackerId: false, globalSequence: true }',
        'agents: []',
      ].join('\n'),
      'utf8',
    );
    const loaded = loadConfig(file);
    expect(loaded.planner).toBeUndefined();
  });
});

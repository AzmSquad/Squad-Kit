import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, type SquadConfig } from '../src/core/config.js';

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cfgcache-'));
  file = path.join(tmp, 'config.yaml');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('planner.cache config', () => {
  it('defaults planner.cache.enabled to true when absent from YAML', () => {
    fs.writeFileSync(
      file,
      [
        'version: 1',
        'project: { name: n, projectRoots: ["."] }',
        'tracker: { type: none }',
        'naming: { includeTrackerId: false, globalSequence: true }',
        'agents: []',
        'planner:',
        '  enabled: true',
        '  provider: anthropic',
        '  mode: auto',
        '  budget:',
        '    maxFileReads: 1',
        '    maxContextBytes: 1',
        '    maxDurationSeconds: 1',
      ].join('\n'),
      'utf8',
    );
    const loaded = loadConfig(file);
    expect(loaded.planner?.cache?.enabled).toBe(true);
  });

  it('explicit enabled: false round-trips through load', () => {
    saveConfig(
      file,
      {
        version: 1,
        project: { name: 'n', projectRoots: ['.'] },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
        planner: {
          enabled: true,
          provider: 'openai',
          mode: 'auto',
          budget: { maxFileReads: 10, maxContextBytes: 100, maxDurationSeconds: 60 },
          cache: { enabled: false },
        },
      } satisfies Partial<SquadConfig> as SquadConfig,
    );
    const loaded = loadConfig(file);
    expect(loaded.planner?.cache?.enabled).toBe(false);
  });

  it('rejects string enabled: "true" with a clear error', () => {
    fs.writeFileSync(
      file,
      [
        'version: 1',
        'project: { name: n, projectRoots: ["."] }',
        'tracker: { type: none }',
        'naming: { includeTrackerId: false, globalSequence: true }',
        'agents: []',
        'planner:',
        '  enabled: true',
        '  provider: anthropic',
        '  mode: auto',
        '  cache:',
        '    enabled: "true"',
        '  budget:',
        '    maxFileReads: 1',
        '    maxContextBytes: 1',
        '    maxDurationSeconds: 1',
      ].join('\n'),
      'utf8',
    );
    expect(() => loadConfig(file)).toThrow(/boolean/);
  });
});

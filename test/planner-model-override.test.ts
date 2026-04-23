import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelFor, PLANNER_MODEL_MAP } from '../src/core/planner-models.js';
import { loadConfig, saveConfig, DEFAULT_CONFIG, type SquadConfig } from '../src/core/config.js';
import type { PlannerConfig } from '../src/planner/types.js';

describe('modelFor override', () => {
  it('returns the pinned MAP value when no override is supplied', () => {
    expect(modelFor('anthropic', 'plan')).toBe(PLANNER_MODEL_MAP.anthropic.plan);
  });

  it('returns override for plan phase when set for that provider', () => {
    expect(modelFor('anthropic', 'plan', { anthropic: 'claude-opus-5-0' })).toBe('claude-opus-5-0');
  });

  it('ignores override for execute phase', () => {
    expect(modelFor('anthropic', 'execute', { anthropic: 'claude-opus-5-0' })).toBe(
      PLANNER_MODEL_MAP.anthropic.execute,
    );
  });

  it('ignores override keys for other providers', () => {
    expect(modelFor('openai', 'plan', { anthropic: 'x' })).toBe(PLANNER_MODEL_MAP.openai.plan);
  });
});

describe('planner.modelOverride config', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-mo-'));
    file = path.join(tmp, 'config.yaml');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const basePlanner: PlannerConfig = {
    enabled: true,
    provider: 'anthropic',
    mode: 'auto',
    budget: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
  };

  it('accepts modelOverride.anthropic and round-trips through save/load', () => {
    const cfg: SquadConfig = {
      ...DEFAULT_CONFIG,
      planner: { ...basePlanner, modelOverride: { anthropic: 'claude-foo' } },
    };
    saveConfig(file, cfg);
    const loaded = loadConfig(file);
    expect(loaded.planner?.modelOverride).toEqual({ anthropic: 'claude-foo' });
  });

  it('rejects empty string modelOverride with a clear error', () => {
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
        '  provider: anthropic',
        '  mode: auto',
        '  budget:',
        '    maxFileReads: 25',
        '    maxContextBytes: 50000',
        '    maxDurationSeconds: 180',
        '  modelOverride:',
        '    anthropic: ""',
      ].join('\n'),
      'utf8',
    );
    expect(() => loadConfig(file)).toThrow(/planner\.modelOverride\.anthropic/);
  });

  it('drops empty modelOverride after load (clean YAML)', () => {
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
        '  provider: anthropic',
        '  mode: auto',
        '  budget:',
        '    maxFileReads: 25',
        '    maxContextBytes: 50000',
        '    maxDurationSeconds: 180',
        '  modelOverride: {}',
      ].join('\n'),
      'utf8',
    );
    const loaded = loadConfig(file);
    expect(loaded.planner?.modelOverride).toBeUndefined();
  });
});

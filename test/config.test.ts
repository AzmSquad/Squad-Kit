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
      ].join('\n'),
      'utf8',
    );
    const loaded = loadConfig(file);
    expect(loaded.planner).toMatchObject({
      enabled: true,
      provider: 'openai',
      mode: 'copy',
      budget: {
        maxFileReads: 10,
        maxContextBytes: 20000,
        maxDurationSeconds: 60,
      },
      cache: { enabled: true },
      maxOutputTokens: 16384,
      stages: { scout: { enabled: true, maxFiles: 12, maxOutputTokens: 2048 } },
      tools: { grep: true, listDir: true, rangedRead: true },
      validation: { enabled: true, strict: false },
    });
  });

  it('defaults planner.maxOutputTokens when planner block has no key', () => {
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
      ].join('\n'),
      'utf8',
    );
    expect(loadConfig(file).planner?.maxOutputTokens).toBe(16384);
  });

  it('respects planner.maxOutputTokens within bounds', () => {
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
        '  maxOutputTokens: 24576',
        '  budget:',
        '    maxFileReads: 25',
        '    maxContextBytes: 50000',
        '    maxDurationSeconds: 180',
      ].join('\n'),
      'utf8',
    );
    expect(loadConfig(file).planner?.maxOutputTokens).toBe(24576);
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

  it('rejects planner.anthropicOauthToken in config.yaml, pointing at secrets.yaml', () => {
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
        '  anthropicOauthToken: oat-abc',
      ].join('\n'),
      'utf8',
    );
    expect(() => loadConfig(file)).toThrow(/planner\.anthropicOauthToken/);
    expect(() => loadConfig(file)).toThrow(/\.squad\/secrets\.yaml/);
  });

  it('still accepts planner.maxOutputTokens (forbidden keys match exactly, not by substring)', () => {
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
        '  maxOutputTokens: 20000',
      ].join('\n'),
      'utf8',
    );
    expect(loadConfig(file).planner?.maxOutputTokens).toBe(20000);
  });

  it('loads planner.auth.anthropic: subscription — the value is not a secret-looking key', () => {
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
        '  auth:',
        '    anthropic: subscription',
      ].join('\n'),
      'utf8',
    );
    expect(loadConfig(file).planner?.auth).toEqual({ anthropic: 'subscription' });
  });

  it('rejects tracker.notion.token in config.yaml (secret must live in secrets.yaml)', () => {
    fs.writeFileSync(
      file,
      [
        'version: 1',
        'project: { name: x, projectRoots: ["."] }',
        'tracker:',
        '  type: notion',
        '  notion:',
        '    token: secret_should_not_be_here',
        'naming: { includeTrackerId: false, globalSequence: true }',
        'agents: []',
      ].join('\n'),
      'utf8',
    );
    expect(() => loadConfig(file)).toThrow(/tracker\.notion\.token/);
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

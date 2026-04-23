import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  modelFor,
  providerEnvVar,
  readProviderKey,
  resolveProviderKey,
  resolveTrackerCredential,
} from '../src/core/planner-models.js';
import type { SquadSecrets } from '../src/core/secrets.js';

const keys = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'SQUAD_PLANNER_API_KEY',
  'JIRA_TEST_TOKEN',
] as const;

function clearPlannerEnv(): void {
  for (const k of keys) {
    delete process.env[k];
  }
  delete process.env.SQUAD_TRACKER_API_KEY;
}

let tmp: string;
let previousCwd: string;

beforeEach(() => {
  clearPlannerEnv();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-pm-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, '.squad'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.squad', 'config.yaml'), 'version: 1\n', 'utf8');
});
afterEach(() => {
  process.chdir(previousCwd);
  clearPlannerEnv();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('planner-models', () => {
  afterEach(() => {
    clearPlannerEnv();
  });

  it('modelFor returns non-empty plan model for anthropic', () => {
    expect(modelFor('anthropic', 'plan').length).toBeGreaterThan(0);
  });

  it('modelFor execute differs from plan for anthropic', () => {
    expect(modelFor('anthropic', 'execute')).not.toBe(modelFor('anthropic', 'plan'));
  });

  it('providerEnvVar returns known env names', () => {
    expect(providerEnvVar('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(providerEnvVar('openai')).toBe('OPENAI_API_KEY');
    expect(providerEnvVar('google')).toBe('GOOGLE_API_KEY');
  });

  it('readProviderKey reads ANTHROPIC_API_KEY when set', () => {
    clearPlannerEnv();
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(readProviderKey('anthropic')).toBe('sk-test');
  });

  it('readProviderKey falls back to SQUAD_PLANNER_API_KEY', () => {
    clearPlannerEnv();
    process.env.SQUAD_PLANNER_API_KEY = 'fallback';
    expect(readProviderKey('anthropic')).toBe('fallback');
    expect(readProviderKey('openai')).toBe('fallback');
  });

  it('readProviderKey returns undefined when no keys set', () => {
    clearPlannerEnv();
    expect(readProviderKey('anthropic')).toBeUndefined();
  });
});

describe('resolveProviderKey', () => {
  it("returns { source: 'env', detail: 'ANTHROPIC_API_KEY' } when that env var is set", () => {
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';
    const r = resolveProviderKey('anthropic');
    expect(r).toEqual({
      value: 'sk-from-env',
      source: 'env',
      detail: 'ANTHROPIC_API_KEY',
    });
  });

  it("returns { source: 'fallback-env', detail: 'SQUAD_PLANNER_API_KEY' } when only fallback is set", () => {
    process.env.SQUAD_PLANNER_API_KEY = 'fb';
    const r = resolveProviderKey('openai');
    expect(r).toEqual({
      value: 'fb',
      source: 'fallback-env',
      detail: 'SQUAD_PLANNER_API_KEY',
    });
  });

  it("returns { source: 'secrets', detail: '.squad/secrets.yaml' } when only secrets file has the key", () => {
    fs.writeFileSync(
      path.join(tmp, '.squad', 'secrets.yaml'),
      'planner:\n  google: key-from-yaml\n',
      'utf8',
    );
    const r = resolveProviderKey('google');
    expect(r).toEqual({
      value: 'key-from-yaml',
      source: 'secrets',
      detail: '.squad/secrets.yaml',
    });
  });

  it('returns undefined when nothing is set and secrets file is absent', () => {
    expect(resolveProviderKey('anthropic')).toBeUndefined();
  });

  it('prefers primary env over fallback and secrets', () => {
    process.env.ANTHROPIC_API_KEY = 'primary';
    process.env.SQUAD_PLANNER_API_KEY = 'fb';
    fs.writeFileSync(
      path.join(tmp, '.squad', 'secrets.yaml'),
      'planner:\n  anthropic: from-file\n',
      'utf8',
    );
    expect(resolveProviderKey('anthropic')?.value).toBe('primary');
  });

  it('readProviderKey returns the same raw string as resolve for env, fallback, and secrets', () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    expect(readProviderKey('anthropic')).toBe(resolveProviderKey('anthropic')?.value);
    clearPlannerEnv();
    process.env.SQUAD_PLANNER_API_KEY = 'b';
    expect(readProviderKey('google')).toBe(resolveProviderKey('google')?.value);
    clearPlannerEnv();
    fs.writeFileSync(
      path.join(tmp, '.squad', 'secrets.yaml'),
      'planner:\n  google: c\n',
      'utf8',
    );
    expect(readProviderKey('google')).toBe('c');
  });
});

describe('resolveTrackerCredential', () => {
  it('resolves from env, then fallback, then secrets', () => {
    process.env.JIRA_TEST_TOKEN = 'from-env';
    const lookup = {
      envVars: ['JIRA_TEST_TOKEN'] as string[],
      fallbackEnv: 'SQUAD_TRACKER_API_KEY' as const,
      fromSecrets: (s: SquadSecrets) => s.tracker?.jira?.token,
    };
    expect(resolveTrackerCredential(lookup)?.value).toBe('from-env');

    delete process.env.JIRA_TEST_TOKEN;
    process.env.SQUAD_TRACKER_API_KEY = 'from-fb';
    expect(resolveTrackerCredential(lookup)?.source).toBe('fallback-env');

    delete process.env.SQUAD_TRACKER_API_KEY;
    fs.writeFileSync(
      path.join(tmp, '.squad', 'secrets.yaml'),
      'tracker:\n  jira:\n    token: from-file\n',
      'utf8',
    );
    expect(resolveTrackerCredential(lookup)).toEqual({
      value: 'from-file',
      source: 'secrets',
      detail: '.squad/secrets.yaml',
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSecrets, saveSecrets, mergeSecrets, type SquadSecrets } from '../src/core/secrets.js';

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-sec-'));
  file = path.join(tmp, '.squad', 'secrets.yaml');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loadSecrets', () => {
  it('returns empty when the file does not exist', () => {
    expect(loadSecrets(file)).toEqual({});
  });

  it('returns the parsed object when the file contains valid YAML', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      'planner:\n  anthropic: sk-test\ntracker:\n  jira:\n    host: x.atlassian.net\n',
      'utf8',
    );
    const s = loadSecrets(file);
    expect(s.planner?.anthropic).toBe('sk-test');
    expect(s.tracker?.jira?.host).toBe('x.atlassian.net');
  });

  it('throws a friendly error when the YAML is malformed', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'planner: [\n  bad', 'utf8');
    expect(() => loadSecrets(file)).toThrow(/Invalid YAML/);
  });

  it('throws when the top-level is not an object', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '- one\n- two\n', 'utf8');
    expect(() => loadSecrets(file)).toThrow(/expected a YAML object/);
  });
});

describe('saveSecrets', () => {
  it('round-trips save then load with the same shape', () => {
    const s: SquadSecrets = {
      planner: { openai: 'k-open' },
      tracker: { jira: { host: 'h', token: 't' } },
    };
    saveSecrets(file, s);
    expect(loadSecrets(file)).toEqual(s);
  });

  it('creates the parent directory if missing', () => {
    const nested = path.join(tmp, 'a', 'b', 'secrets.yaml');
    saveSecrets(nested, { planner: { google: 'g' } });
    expect(fs.existsSync(nested)).toBe(true);
    expect(loadSecrets(nested).planner?.google).toBe('g');
  });

  it('sets mode 0o600 on POSIX', () => {
    if (process.platform === 'win32') return;
    saveSecrets(file, {});
    const mode = fs.statSync(file).mode;
    expect(mode & 0o777).toBe(0o600);
  });
});

describe('mergeSecrets', () => {
  it('preserves existing providers not in the patch', () => {
    const base: SquadSecrets = { planner: { openai: 'a', google: 'g' } };
    const patch: SquadSecrets = { planner: { anthropic: 'b' } };
    expect(mergeSecrets(base, patch).planner).toEqual({
      openai: 'a',
      google: 'g',
      anthropic: 'b',
    });
  });

  it('overrides fields present in the patch', () => {
    const base: SquadSecrets = { planner: { anthropic: 'old' } };
    const patch: SquadSecrets = { planner: { anthropic: 'new' } };
    expect(mergeSecrets(base, patch).planner?.anthropic).toBe('new');
  });

  it('ignores empty-string patch values', () => {
    const base: SquadSecrets = { planner: { anthropic: 'keep' } };
    const patch: SquadSecrets = { planner: { anthropic: '' } };
    expect(mergeSecrets(base, patch).planner?.anthropic).toBe('keep');
  });

  it('merges nested tracker jira and azure', () => {
    const base: SquadSecrets = {
      tracker: { jira: { host: 'h', email: 'e' }, azure: { organization: 'o' } },
    };
    const patch: SquadSecrets = { tracker: { jira: { token: 't' } } };
    const m = mergeSecrets(base, patch);
    expect(m.tracker?.jira).toEqual({ host: 'h', email: 'e', token: 't' });
    expect(m.tracker?.azure).toEqual({ organization: 'o' });
  });
});

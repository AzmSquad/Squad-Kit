import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConfigRemoveCredential } from '../src/commands/config/remove-credential.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import { saveConfig, type SquadConfig } from '../src/core/config.js';
import { loadSecrets } from '../src/core/secrets.js';
let tmp: string;
let previousCwd: string;

const base: SquadConfig = {
  version: 1,
  project: { name: 'n', projectRoots: ['.'] },
  tracker: { type: 'none' },
  naming: { includeTrackerId: false, globalSequence: true },
  agents: [],
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cfgrm-'));
  previousCwd = process.cwd();
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(tmp, SQUAD_DIR, 'plans'), { recursive: true });
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('config remove-credential', () => {
  it('planner -y: removes planner; file remains', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), base);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      'planner:\n  openai: sk-SECRET1\n  anthropic: sk-SECRET2\ntracker:\n  jira:\n    token: t\n',
      'utf8',
    );
    await runConfigRemoveCredential('planner', { yes: true });
    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(s.planner).toBeUndefined();
    expect(s.tracker?.jira?.token).toBe('t');
  });

  it('tracker -y: removes tracker subtree', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), base);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      'planner:\n  openai: x\ntracker:\n  jira:\n    token: t\n',
      'utf8',
    );
    await runConfigRemoveCredential('tracker', { yes: true });
    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    expect(s.tracker).toBeUndefined();
    expect(s.planner?.openai).toBe('x');
  });

  it('invalid section: throws with remove-credential hint', async () => {
    await expect(runConfigRemoveCredential('other', { yes: true })).rejects.toThrow(/squad config remove-credential/);
  });

  it('does not print secret to stderr', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), base);
    const token = 'supersecret-token-do-not-echo-99999';
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      `planner:\n  anthropic: ${token}\n`,
      'utf8',
    );
    const out: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk, ...rest) => {
      out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return (orig as (chunk: string | Uint8Array, ...args: unknown[]) => boolean)(chunk, ...rest);
    });
    try {
      await runConfigRemoveCredential('planner', { yes: true });
    } finally {
      spy.mockRestore();
    }
    expect(out.join('')).not.toContain(token);
  });
});

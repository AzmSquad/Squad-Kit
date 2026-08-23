import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSecrets, saveSecrets, type SquadSecrets } from '../src/core/secrets.js';
import {
  mergePlannerKeyIntoSecrets,
  mergePlannerOauthTokenIntoSecrets,
} from '../src/commands/config/shared.js';

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-oauth-'));
  file = path.join(tmp, '.squad', 'secrets.yaml');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('planner OAuth token in secrets.yaml', () => {
  it('saving an OAuth token preserves an existing Anthropic API key', () => {
    const base: SquadSecrets = { planner: { anthropic: 'sk-ant-keep', openai: 'sk-open' } };
    const merged = mergePlannerOauthTokenIntoSecrets(base, 'oat-new');
    expect(merged.planner).toEqual({
      anthropic: 'sk-ant-keep',
      openai: 'sk-open',
      anthropicOauthToken: 'oat-new',
    });
  });

  it('saving an API key preserves an existing OAuth token', () => {
    const base: SquadSecrets = { planner: { anthropicOauthToken: 'oat-keep' } };
    const merged = mergePlannerKeyIntoSecrets(base, 'anthropic', 'sk-ant-new');
    expect(merged.planner).toEqual({
      anthropicOauthToken: 'oat-keep',
      anthropic: 'sk-ant-new',
    });
  });

  it('an empty token does not clobber the stored one', () => {
    const base: SquadSecrets = { planner: { anthropicOauthToken: 'oat-keep' } };
    expect(mergePlannerOauthTokenIntoSecrets(base, '').planner?.anthropicOauthToken).toBe('oat-keep');
  });

  it('round-trips through saveSecrets → loadSecrets', () => {
    saveSecrets(file, mergePlannerOauthTokenIntoSecrets({ planner: { anthropic: 'sk-a' } }, 'oat-1'));
    const loaded = loadSecrets(file);
    expect(loaded.planner?.anthropicOauthToken).toBe('oat-1');
    expect(loaded.planner?.anthropic).toBe('sk-a');
  });

  it('leaves the file at mode 0o600 on POSIX', () => {
    if (process.platform === 'win32') return;
    saveSecrets(file, mergePlannerOauthTokenIntoSecrets({}, 'oat-1'));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

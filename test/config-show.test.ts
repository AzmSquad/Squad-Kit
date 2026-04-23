import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { runConfigShow, buildConfigShowPayload } from '../src/commands/config/show.js';
import { SQUAD_DIR } from '../src/core/paths.js';
import { saveConfig, loadConfig, type SquadConfig } from '../src/core/config.js';
import { loadSecrets } from '../src/core/secrets.js';

let tmp: string;
let previousCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cfgshow-'));
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

describe('config show', () => {
  it('JSON output masks planner keys (prefix + … + last four)', async () => {
    const cfg: SquadConfig = {
      version: 1,
      project: { name: 'n', projectRoots: ['.'] },
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: [],
      planner: {
        enabled: true,
        provider: 'anthropic',
        mode: 'auto',
        budget: { maxFileReads: 10, maxContextBytes: 1, maxDurationSeconds: 1 },
      },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      yaml.dump(
        { planner: { anthropic: 'sk-ant-api03-ABCD1234567890ZZZZ' } },
        { noRefs: true, sortKeys: false },
      ),
      'utf8',
    );

    const write = vi.spyOn(process.stdout, 'write');
    const chunks: string[] = [];
    write.mockImplementation((d: string | Uint8Array) => {
      chunks.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8'));
      return true;
    });
    try {
      await runConfigShow({ json: true });
    } finally {
      write.mockRestore();
    }
    const out = chunks.join('');
    const parsed = JSON.parse(out) as { planner: { credentials: { anthropic: string } } };
    const masked = parsed.planner.credentials.anthropic;
    expect(masked).toMatch(/…/);
    expect(masked).toMatch(/ZZZZ$/);
    expect(out).not.toContain('ABCD1234567890');
  });

  it('JSON has no raw secret tokens', () => {
    const cfg: SquadConfig = {
      version: 1,
      project: { name: 'n', projectRoots: ['.'] },
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: [],
      planner: {
        enabled: true,
        provider: 'openai',
        mode: 'auto',
        budget: { maxFileReads: 10, maxContextBytes: 1, maxDurationSeconds: 1 },
      },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    fs.writeFileSync(
      path.join(tmp, SQUAD_DIR, 'secrets.yaml'),
      yaml.dump(
        { planner: { openai: 'sk-proj-SECRETVALUE9999' } },
        { noRefs: true, sortKeys: false },
      ),
      'utf8',
    );
    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    const s = loadSecrets(path.join(tmp, SQUAD_DIR, 'secrets.yaml'));
    const p = buildConfigShowPayload(c, s);
    expect(JSON.stringify(p)).not.toContain('SECRETVALUE9999');
  });

  it('works when secrets.yaml is missing', () => {
    const cfg: SquadConfig = {
      version: 1,
      project: { name: 'n', projectRoots: ['.'] },
      tracker: { type: 'jira', workspace: 'h.atlassian.net' },
      naming: { includeTrackerId: false, globalSequence: true },
      agents: [],
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    const c = loadConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'));
    const p = buildConfigShowPayload(c, {});
    expect(p.tracker.credentials.jira).toBeUndefined();
  });
});

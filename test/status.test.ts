import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ui from '../src/ui/index.js';
import { runStatus } from '../src/commands/status.js';
import { saveConfig, type SquadConfig } from '../src/core/config.js';
import { SQUAD_DIR } from '../src/core/paths.js';

let tmp: string;
let previousCwd: string;

const baseJiraConfig: SquadConfig = {
  version: 1,
  project: { name: 'p', projectRoots: ['.'] },
  tracker: { type: 'jira', workspace: 'h.example.com' },
  naming: { includeTrackerId: false, globalSequence: true },
  agents: [],
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-status-'));
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

function writeJiraSecrets(host: string, email: string, token: string): void {
  const f = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
  fs.writeFileSync(
    f,
    `tracker:\n  jira:\n    host: ${host}\n    email: ${email}\n    token: ${token}\n`,
    'utf8',
  );
}

describe('runStatus tracker + planner key rows', () => {
  it('shows tracker key from secrets when env token is unset', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), baseJiraConfig);
    writeJiraSecrets('h.example.com', 'a@b.co', 'tok1234567890');

    const rows: { k: string; v: string }[] = [];
    const spy = vi.spyOn(ui, 'kv').mockImplementation((k: string, v: string) => {
      rows.push({ k, v: String(v) });
    });
    const banner = vi.spyOn(ui, 'banner').mockImplementation(() => true);
    const step = vi.spyOn(ui, 'step').mockImplementation(() => true);
    const blank = vi.spyOn(ui, 'blank').mockImplementation(() => true);

    await runStatus();

    const tk = rows.find((r) => r.k === 'tracker key');
    expect(tk?.v).toContain('set via .squad/secrets.yaml');
    const tr = rows.find((r) => r.k === 'tracker');
    expect(tr?.v).toContain('jira');
    expect(tr?.v).toContain('h.example.com');
    spy.mockRestore();
    banner.mockRestore();
    step.mockRestore();
    blank.mockRestore();
  });

  it('prefers environment variable when JIRA_API_TOKEN is set', async () => {
    const prev = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'from-env-12345';
    try {
      saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), baseJiraConfig);
      writeJiraSecrets('h.example.com', 'a@b.co', 'filetoken12345');

      const rows: { k: string; v: string }[] = [];
      const spy = vi.spyOn(ui, 'kv').mockImplementation((k: string, v: string) => {
        rows.push({ k, v: String(v) });
      });
      vi.spyOn(ui, 'banner').mockImplementation(() => true);
      vi.spyOn(ui, 'step').mockImplementation(() => true);
      vi.spyOn(ui, 'blank').mockImplementation(() => true);

      await runStatus();

      const tk = rows.find((r) => r.k === 'tracker key');
      expect(tk?.v).toContain('environment');
    } finally {
      if (prev === undefined) delete process.env.JIRA_API_TOKEN;
      else process.env.JIRA_API_TOKEN = prev;
    }
  });

  it('shows missing with hint when credentials incomplete', async () => {
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), {
      ...baseJiraConfig,
      tracker: { type: 'jira' },
    });

    const rows: { k: string; v: string }[] = [];
    const spy = vi.spyOn(ui, 'kv').mockImplementation((k: string, v: string) => {
      rows.push({ k, v: String(v) });
    });
    vi.spyOn(ui, 'banner').mockImplementation(() => true);
    vi.spyOn(ui, 'step').mockImplementation(() => true);
    vi.spyOn(ui, 'blank').mockImplementation(() => true);

    await runStatus();

    const tk = rows.find((r) => r.k === 'tracker key');
    expect(tk?.v).toMatch(/^missing — /);
    spy.mockRestore();
  });

  it('planner key row uses resolveProviderKey detail', async () => {
    const cfg: SquadConfig = {
      ...baseJiraConfig,
      planner: {
        enabled: true,
        provider: 'anthropic',
        mode: 'auto',
        budget: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
      },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    writeJiraSecrets('h.example.com', 'a@b.co', 'tok1234567890');
    const f = path.join(tmp, SQUAD_DIR, 'secrets.yaml');
    const body = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(
      f,
      `${body}planner:\n  anthropic: sk-1234567890123456789\n`,
      'utf8',
    );

    const rows: { k: string; v: string }[] = [];
    const spy = vi.spyOn(ui, 'kv').mockImplementation((k: string, v: string) => {
      rows.push({ k, v: String(v) });
    });
    vi.spyOn(ui, 'banner').mockImplementation(() => true);
    vi.spyOn(ui, 'step').mockImplementation(() => true);
    vi.spyOn(ui, 'blank').mockImplementation(() => true);

    await runStatus();

    const pk = rows.find((r) => r.k === 'planner key');
    expect(pk?.v).toContain('.squad/secrets.yaml');

    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-env-override-12345';
    try {
      const rows2: { k: string; v: string }[] = [];
      const spy2 = vi.spyOn(ui, 'kv').mockImplementation((k: string, v: string) => {
        rows2.push({ k, v: String(v) });
      });
      await runStatus();
      const pk2 = rows2.find((r) => r.k === 'planner key');
      expect(pk2?.v).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
    spy.mockRestore();
  });

  it('annotates planner row with (override) when planner.modelOverride is set for provider', async () => {
    const cfg: SquadConfig = {
      ...baseJiraConfig,
      planner: {
        enabled: true,
        provider: 'anthropic',
        mode: 'auto',
        budget: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
        modelOverride: { anthropic: 'claude-opus-5-0-fake' },
      },
    };
    saveConfig(path.join(tmp, SQUAD_DIR, 'config.yaml'), cfg);
    writeJiraSecrets('h.example.com', 'a@b.co', 'tok1234567890');

    const rows: { k: string; v: string }[] = [];
    const spy = vi.spyOn(ui, 'kv').mockImplementation((k: string, v: string) => {
      rows.push({ k, v: String(v) });
    });
    vi.spyOn(ui, 'banner').mockImplementation(() => true);
    vi.spyOn(ui, 'step').mockImplementation(() => true);
    vi.spyOn(ui, 'blank').mockImplementation(() => true);

    await runStatus();

    const pl = rows.find((r) => r.k === 'planner');
    expect(pl?.v).toContain('anthropic/');
    expect(pl?.v).toContain('claude-opus-5-0-fake');
    expect(pl?.v).toContain('(override)');
    spy.mockRestore();
  });
});

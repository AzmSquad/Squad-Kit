import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runNewStory } from '../src/commands/new-story.js';
import * as ui from '../src/ui/index.js';
import { buildPaths } from '../src/core/paths.js';
import { DEFAULT_CONFIG, saveConfig, type SquadConfig } from '../src/core/config.js';
import { saveSecrets, type SquadSecrets } from '../src/core/secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Env vars that overlay secrets — must be unset so tests use secrets.yaml only. */
const TRACKER_ENV_KEYS = [
  'JIRA_HOST',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'SQUAD_TRACKER_API_KEY',
  'AZURE_DEVOPS_ORG',
  'AZURE_DEVOPS_PROJECT',
  'AZURE_DEVOPS_PAT',
] as const;

function loadMinimalIssue(): Record<string, unknown> {
  const raw = readFileSync(path.join(__dirname, 'fixtures/jira/issue-minimal.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

let tmp: string;
let prevCwd: string;
let envBackup: Record<string, string | undefined> = {};

function writeJiraWorkspace(configOverrides: Partial<SquadConfig> = {}): void {
  const paths = buildPaths(tmp);
  fs.mkdirSync(paths.squadDir, { recursive: true });
  const config: SquadConfig = {
    ...DEFAULT_CONFIG,
    tracker: { type: 'jira', workspace: 'mycompany.atlassian.net' },
    naming: { includeTrackerId: false, globalSequence: true },
    ...configOverrides,
  };
  saveConfig(paths.configFile, config);
}

function writeJiraSecrets(secrets: SquadSecrets): void {
  const paths = buildPaths(tmp);
  saveSecrets(paths.secretsFile, secrets);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-new-story-fetch-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
  envBackup = {};
  for (const k of TRACKER_ENV_KEYS) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fetch must be stubbed'))) as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of TRACKER_ENV_KEYS) {
    const v = envBackup[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('new-story tracker fetch', () => {
  it('happy path: prepends Source block and downloads attachment', async () => {
    const payload = loadMinimalIssue();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/rest/api/3/issue/')) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (url.includes('/attachment/content/')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    writeJiraWorkspace();
    writeJiraSecrets({
      tracker: { jira: { email: 'e@e.com', token: 'tok' } },
    });

    const warn = vi.spyOn(ui, 'warning').mockImplementation(() => true);

    await runNewStory('my-feature', { id: 'PROJ-42', yes: true });

    const intakePath = path.join(tmp, '.squad/stories/my-feature/PROJ-42/intake.md');
    const body = fs.readFileSync(intakePath, 'utf8');
    const firstBlock = body.split(/\n\n+/).find((p) => p.trim().length > 0) ?? '';
    expect(firstBlock).toMatch(/\*\*Fetched from jira:\*\*/);
    expect(body).toContain('## Source — work item (from tracker)');
    expect(body).toContain('**Title:** Login fails when MFA enabled');
    expect(body).toContain('**Type:** Bug');
    expect(body).toContain('**Labels:** frontend, bug');
    expect(body).toMatch(/\| `attachments\/screenshot\.png` \| .* \| downloaded \|/);

    const titleInTemplate = body.match(/(?:^|\n)## Title\b[\s\S]*?\n```(?:[\w-]*)?\s*\n([\s\S]*?)\n```/);
    expect(titleInTemplate?.[1]?.trim()).toBe('Login fails when MFA enabled');
    const descInTemplate = body.match(/(?:^|\n)## Description\b[\s\S]*?\n```(?:[\w-]*)?\s*\n([\s\S]*?)\n```/);
    expect(descInTemplate?.[1]?.trim()).toContain('Same text, as HTML.');
    const acInTemplate = body.match(/(?:^|\n)## Acceptance criteria\b[\s\S]*?\n```(?:[\w-]*)?\s*\n([\s\S]*?)\n```/);
    expect(acInTemplate?.[1]?.trim()).toBe('');
    expect(body).toContain('**Work item id:** `PROJ-42`');

    const attachDir = path.join(tmp, '.squad/stories/my-feature/PROJ-42/attachments');
    expect(fs.readdirSync(attachDir)).toContain('screenshot.png');
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    warn.mockRestore();
  });

  it('--no-fetch: does not call fetch and omits Source block', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('should not run')));
    vi.stubGlobal('fetch', fetchMock);

    writeJiraWorkspace();
    writeJiraSecrets({
      tracker: { jira: { email: 'e@e.com', token: 'tok' } },
    });

    await runNewStory('feat', { id: 'PROJ-9', yes: true, fetch: false });

    const intakePath = path.join(tmp, '.squad/stories/feat/PROJ-9/intake.md');
    const body = fs.readFileSync(intakePath, 'utf8');
    expect(body).not.toContain('## Source — work item (from tracker)');
    expect(body).not.toContain('Tracker auto-fetch skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('--no-attachments: fetches issue but not attachment binary', async () => {
    const payload = loadMinimalIssue();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/rest/api/3/issue/')) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    writeJiraWorkspace();
    writeJiraSecrets({
      tracker: { jira: { email: 'e@e.com', token: 'tok' } },
    });

    await runNewStory('feat', { id: 'PROJ-42', yes: true, attachments: false });

    expect(fetchMock.mock.calls.length).toBe(1);
    const onlyUrl = fetchMock.mock.calls[0]![0] as string;
    expect(onlyUrl).toContain('/rest/api/3/issue/');

    const intakePath = path.join(tmp, '.squad/stories/feat/PROJ-42/intake.md');
    const body = fs.readFileSync(intakePath, 'utf8');
    expect(body).toContain('## Source — work item (from tracker)');
    expect(body).toMatch(/not downloaded \(--no-attachments\)/);
    const attachDir = path.join(tmp, '.squad/stories/feat/PROJ-42/attachments');
    expect(fs.readdirSync(attachDir)).toEqual([]);
  });

  it('missing credentials: fallback preamble and warning', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    writeJiraWorkspace();
    const warn = vi.spyOn(ui, 'warning').mockImplementation(() => true);

    await runNewStory('feat', { id: 'PROJ-1', yes: true });

    expect(fetchMock).not.toHaveBeenCalled();
    const intakePath = path.join(tmp, '.squad/stories/feat/PROJ-1/intake.md');
    const body = fs.readFileSync(intakePath, 'utf8');
    expect(body).toContain('> **Tracker auto-fetch skipped.**');
    expect(body).toContain('Jira credentials are incomplete');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Tracker fetch skipped'));
    warn.mockRestore();
  });

  it('401: fallback preamble, warning, full intake present', async () => {
    writeJiraWorkspace();
    writeJiraSecrets({
      tracker: { jira: { email: 'e@e.com', token: 'bad' } },
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const warn = vi.spyOn(ui, 'warning').mockImplementation(() => true);

    await runNewStory('feat', { id: 'PROJ-1', yes: true });

    const intakePath = path.join(tmp, '.squad/stories/feat/PROJ-1/intake.md');
    const body = fs.readFileSync(intakePath, 'utf8');
    expect(body).toContain('> **Tracker auto-fetch skipped.**');
    expect(body).toMatch(/authentication failed|HTTP 401/i);
    expect(body).not.toContain('## Source — work item (from tracker)');
    expect(body.length).toBeGreaterThan(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('404: fallback preamble and warning', async () => {
    writeJiraWorkspace();
    writeJiraSecrets({
      tracker: { jira: { email: 'e@e.com', token: 'tok' } },
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

    const warn = vi.spyOn(ui, 'warning').mockImplementation(() => true);

    await runNewStory('feat', { id: 'MISSING-99', yes: true });

    const body = fs.readFileSync(path.join(tmp, '.squad/stories/feat/MISSING-99/intake.md'), 'utf8');
    expect(body).toContain('> **Tracker auto-fetch skipped.**');
    expect(body).toMatch(/not found|HTTP 404/i);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('attachment oversize: skipped row, no file written', async () => {
    const payload = loadMinimalIssue() as {
      fields: { attachment: Array<{ size: number }> };
    };
    payload.fields.attachment[0]!.size = 50 * 1024 * 1024;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/rest/api/3/issue/')) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    writeJiraWorkspace();
    writeJiraSecrets({
      tracker: { jira: { email: 'e@e.com', token: 'tok' } },
    });

    await runNewStory('feat', { id: 'PROJ-42', yes: true });

    expect(fetchMock.mock.calls.length).toBe(1);

    const body = fs.readFileSync(path.join(tmp, '.squad/stories/feat/PROJ-42/intake.md'), 'utf8');
    expect(body).toContain('| File | Size | Status |');
    expect(body).toMatch(/skipped.*exceeds cap \(10 MB\)/);
    const attachDir = path.join(tmp, '.squad/stories/feat/PROJ-42/attachments');
    expect(fs.readdirSync(attachDir)).toEqual([]);
  });

  it('tracker type none: no Source block, no tracker warning', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const paths = buildPaths(tmp);
    fs.mkdirSync(paths.squadDir, { recursive: true });
    saveConfig(paths.configFile, {
      ...DEFAULT_CONFIG,
      tracker: { type: 'none' },
      naming: { includeTrackerId: false, globalSequence: true },
    });

    const warn = vi.spyOn(ui, 'warning').mockImplementation(() => true);

    await runNewStory('feat', { id: 'ignored-123', yes: true });

    const body = fs.readFileSync(path.join(tmp, '.squad/stories/feat/ignored-123/intake.md'), 'utf8');
    expect(body).not.toContain('## Source — work item (from tracker)');
    expect(body).not.toContain('Tracker auto-fetch skipped');
    expect(warn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type SquadConfig } from '../src/core/config.js';
import type { SquadSecrets } from '../src/core/secrets.js';
import { clientFor } from '../src/tracker/index.js';
import { firstFetchCall } from './support/fetch-test-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMinimalIssue(): Record<string, unknown> {
  const raw = readFileSync(path.join(__dirname, 'fixtures/jira/issue-minimal.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function loadMinimalAzure(): Record<string, unknown> {
  const raw = readFileSync(path.join(__dirname, 'fixtures/azure/workitem-minimal.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fetch must be stubbed in this test'))) as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clientFor', () => {
  it('returns unsupported-tracker for tracker.type none', () => {
    const config: SquadConfig = { ...DEFAULT_CONFIG, tracker: { type: 'none' } };
    const res = clientFor(config, {});
    expect(res.client).toBeUndefined();
    expect(res.error).toEqual({
      kind: 'unsupported-tracker',
      message: 'Tracker type "none" does not support auto-fetch in 0.2.0.',
      detail:
        'Run `squad config set tracker` to use jira, azure, or github for fetch, or pass `--no-fetch` on new-story. Run `squad doctor` to review tracker setup.',
    });
  });

  it('returns missing-credentials for jira without full secrets', () => {
    const config: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'jira', workspace: 'w.atlassian.net' },
    };
    const res = clientFor(config, { tracker: { jira: { email: 'e@e.com' } } });
    expect(res.client).toBeUndefined();
    expect(res.error?.kind).toBe('missing-credentials');
    expect(res.error?.message).toContain('Jira');
  });

  it('returns jira client when credentials are complete', () => {
    const config: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'jira', workspace: 'w.atlassian.net' },
    };
    const secrets: SquadSecrets = {
      tracker: { jira: { email: 'e@e.com', token: 'tok' } },
    };
    const res = clientFor(config, secrets);
    expect(res.error).toBeUndefined();
    expect(res.client?.name).toBe('jira');
  });

  it('returns missing-credentials for azure without full secrets', () => {
    const config: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'azure', workspace: 'org', project: 'proj' },
    };
    const res = clientFor(config, { tracker: { azure: { organization: 'org' } } });
    expect(res.client).toBeUndefined();
    expect(res.error?.kind).toBe('missing-credentials');
    expect(res.error?.message).toContain('Azure');
  });

  it('returns azure client when credentials are complete', () => {
    const config: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'azure', workspace: 'org', project: 'proj' },
    };
    const secrets: SquadSecrets = {
      tracker: { azure: { pat: 'pat' } },
    };
    const res = clientFor(config, secrets);
    expect(res.error).toBeUndefined();
    expect(res.client?.name).toBe('azure');
  });

  it('returns missing-credentials for github without owner/repo', () => {
    const config: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'github' },
    };
    const res = clientFor(config, { tracker: { github: { pat: 'p' } } });
    expect(res.client).toBeUndefined();
    expect(res.error?.kind).toBe('missing-credentials');
    expect(res.error?.message).toContain('GitHub');
  });

  it('returns missing-credentials for github without pat', () => {
    const config: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'github', workspace: 'octocat', project: 'hello-world' },
    };
    const res = clientFor(config, {});
    expect(res.client).toBeUndefined();
    expect(res.error?.kind).toBe('missing-credentials');
    expect(res.error?.message).toContain('GitHub');
  });

  it('returns github client when credentials are complete', () => {
    const config: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'github', workspace: 'octocat', project: 'hello-world' },
    };
    const secrets: SquadSecrets = {
      tracker: { github: { pat: 'ghp_test' } },
    };
    const res = clientFor(config, secrets);
    expect(res.error).toBeUndefined();
    expect(res.client?.name).toBe('github');
  });

  it('prefers secrets.tracker.jira.host over config.tracker.workspace for requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(loadMinimalIssue()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const config: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'jira', workspace: 'config-host.atlassian.net' },
    };
    const secrets: SquadSecrets = {
      tracker: {
        jira: {
          host: 'secret-host.atlassian.net',
          email: 'e@e.com',
          token: 't',
        },
      },
    };
    const res = clientFor(config, secrets);
    expect(res.client).toBeDefined();
    await res.client!.fetchIssue('PROJ-1');
    const { url } = firstFetchCall(fetchMock);
    expect(url.startsWith('https://secret-host.atlassian.net/rest/api/3/issue/')).toBe(true);
  });

  it('prefers secrets.tracker.azure.organization over config.tracker.workspace', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(loadMinimalAzure()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const config: SquadConfig = {
      ...DEFAULT_CONFIG,
      tracker: { type: 'azure', workspace: 'config-org', project: 'config-proj' },
    };
    const secrets: SquadSecrets = {
      tracker: {
        azure: {
          organization: 'secret-org',
          project: 'secret-proj',
          pat: 'p',
        },
      },
    };
    const res = clientFor(config, secrets);
    expect(res.client).toBeDefined();
    await res.client!.fetchIssue('42');
    const { url } = firstFetchCall(fetchMock);
    expect(url).toContain('/secret-org/');
    expect(url).toContain('/secret-proj/');
  });
});

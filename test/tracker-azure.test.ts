import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AzureDevOpsClient } from '../src/tracker/azure.js';
import { TrackerError } from '../src/tracker/types.js';
import { firstFetchCall } from './support/fetch-test-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMinimalWorkItem(): Record<string, unknown> {
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

describe('AzureDevOpsClient', () => {
  it('fetchIssue maps minimal fixture to FetchIssueResult', async () => {
    const payload = loadMinimalWorkItem();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AzureDevOpsClient({
      organization: 'myorg',
      project: 'myproject',
      pat: 'patsecret',
    });
    const res = await client.fetchIssue('42');

    expect(res.id).toBe('42');
    expect(res.title).toBe('Sample user story');
    // `<br/>` → newline; `</p>` adds paragraph breaks, then `trim()` drops trailing whitespace.
    expect(res.description).toBe('hello \n world');
    expect(res.acceptanceCriteria).toBe('AC1: user can log in');
    expect(res.labels).toEqual(['frontend', 'bug']);
    expect(res.type).toBe('User Story');
    expect(res.assignee).toBe('Dev One');
    expect(res.status).toBe('Active');
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0]!.filename).toBe('mock.png');
    expect(res.attachments[0]!.url).toContain('attachments/mock-abc');
    expect(res.url).toBe('https://dev.azure.com/myorg/myproject/_workitems/edit/42');
    expect(Number.isNaN(Date.parse(res.fetchedAt))).toBe(false);

    const { url } = firstFetchCall(fetchMock);
    expect(url).toBe(
      'https://dev.azure.com/myorg/myproject/_apis/wit/workitems/42?$expand=all&api-version=7.1',
    );
  });

  it('sends Basic auth with empty username and PAT', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(loadMinimalWorkItem()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new AzureDevOpsClient({
      organization: 'o',
      project: 'p',
      pat: 'my-pat',
    }).fetchIssue('1');

    const { init } = firstFetchCall(fetchMock);
    const headers = init?.headers as Record<string, string>;
    const auth = headers['authorization'];
    expect(auth).toMatch(/^Basic /);
    const decoded = Buffer.from(auth!.slice(6), 'base64').toString('utf8');
    expect(decoded).toBe(':my-pat');
  });

  it('401 throws TrackerError auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const client = new AzureDevOpsClient({ organization: 'o', project: 'p', pat: 't' });
    await expect(client.fetchIssue('1')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'auth',
      statusCode: 401,
    });
  });

  it('404 throws TrackerError not-found mentioning org and project', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const client = new AzureDevOpsClient({ organization: 'acme', project: 'web', pat: 't' });
    try {
      await client.fetchIssue('99');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TrackerError);
      const err = e as TrackerError;
      expect(err.kind).toBe('not-found');
      expect(err.message).toContain('acme');
      expect(err.message).toContain('web');
    }
  });

  it('429 throws TrackerError rate-limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const client = new AzureDevOpsClient({ organization: 'o', project: 'p', pat: 't' });
    await expect(client.fetchIssue('1')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'rate-limited',
      statusCode: 429,
    });
  });

  it('fetch rejection throws TrackerError network', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNRESET'))));
    const client = new AzureDevOpsClient({ organization: 'o', project: 'p', pat: 't' });
    await expect(client.fetchIssue('1')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'network',
    });
  });

  it('constructor throws when organization, project, or pat is missing', () => {
    expect(() => new AzureDevOpsClient({ organization: '', project: 'p', pat: 't' })).toThrow(
      /organization/,
    );
    expect(() => new AzureDevOpsClient({ organization: 'o', project: '', pat: 't' })).toThrow(/project/);
    expect(() => new AzureDevOpsClient({ organization: 'o', project: 'p', pat: '' })).toThrow(/pat/);
  });

  it('parseTags trims and splits semicolon tags', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 1,
            fields: {
              'System.Title': 't',
              'System.Tags': '  foo ; bar;',
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new AzureDevOpsClient({ organization: 'o', project: 'p', pat: 't' });
    const res = await client.fetchIssue('1');
    expect(res.labels).toEqual(['foo', 'bar']);
  });

  it('parseTags returns empty array for empty string tags', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 1,
            fields: { 'System.Title': 't', 'System.Tags': '' },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new AzureDevOpsClient({ organization: 'o', project: 'p', pat: 't' });
    const res = await client.fetchIssue('1');
    expect(res.labels).toEqual([]);
  });
});

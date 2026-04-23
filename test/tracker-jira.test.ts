import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JiraClient } from '../src/tracker/jira.js';
import { TrackerError } from '../src/tracker/types.js';
import { firstFetchCall } from './support/fetch-test-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMinimalIssue(): Record<string, unknown> {
  const raw = readFileSync(path.join(__dirname, 'fixtures/jira/issue-minimal.json'), 'utf8');
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

describe('JiraClient', () => {
  it('fetchIssue maps minimal fixture to FetchIssueResult', async () => {
    const payload = loadMinimalIssue();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new JiraClient({
      host: 'mycompany.atlassian.net',
      email: 'user@example.com',
      token: 'tok',
    });
    const res = await client.fetchIssue('PROJ-42');

    expect(res.id).toBe('PROJ-42');
    expect(res.title).toBe('Login fails when MFA enabled');
    expect(res.description.length).toBeGreaterThan(0);
    expect(res.description).toContain('Same text, as HTML.');
    expect(res.labels).toEqual(['frontend', 'bug']);
    expect(res.type).toBe('Bug');
    expect(res.assignee).toBe('Jamie Doe');
    expect(res.status).toBe('In Progress');
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0]!.filename).toBe('screenshot.png');
    expect(Number.isNaN(Date.parse(res.fetchedAt))).toBe(false);

    const { url } = firstFetchCall(fetchMock);
    expect(url).toBe(
      'https://mycompany.atlassian.net/rest/api/3/issue/PROJ-42?fields=summary,description,labels,issuetype,assignee,status,attachment&expand=renderedFields',
    );
  });

  it('prefers renderedFields.description over ADF when present', async () => {
    const payload = loadMinimalIssue() as {
      fields: { description: unknown };
      renderedFields: { description: string };
    };
    payload.renderedFields.description = '<p>Rendered only</p>';
    payload.fields.description = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'ADF only should not win' }] },
      ],
    };

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));

    const client = new JiraClient({
      host: 'x.atlassian.net',
      email: 'e@e.com',
      token: 't',
    });
    const res = await client.fetchIssue('K-1');
    expect(res.description).toBe('Rendered only');
  });

  it('401 throws TrackerError auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const client = new JiraClient({ host: 'h.atlassian.net', email: 'e', token: 't' });
    await expect(client.fetchIssue('X')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'auth',
      statusCode: 401,
    });
  });

  it('404 throws TrackerError not-found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const client = new JiraClient({ host: 'h.atlassian.net', email: 'e', token: 't' });
    await expect(client.fetchIssue('MISSING')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'not-found',
      statusCode: 404,
    });
  });

  it('429 throws TrackerError rate-limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const client = new JiraClient({ host: 'h.atlassian.net', email: 'e', token: 't' });
    await expect(client.fetchIssue('X')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'rate-limited',
      statusCode: 429,
    });
  });

  it('500 throws TrackerError other', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const client = new JiraClient({ host: 'h.atlassian.net', email: 'e', token: 't' });
    try {
      await client.fetchIssue('X');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TrackerError);
      const err = e as TrackerError;
      expect(err.kind).toBe('other');
      expect(err.statusCode).toBe(500);
    }
  });

  it('fetch rejection throws TrackerError network', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ENOTFOUND'))));
    const client = new JiraClient({ host: 'h.atlassian.net', email: 'e', token: 't' });
    await expect(client.fetchIssue('X')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'network',
    });
  });

  it('normalises host with scheme and trailing slash in request URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(loadMinimalIssue()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new JiraClient({
      host: 'https://foo.atlassian.net/',
      email: 'e',
      token: 't',
    });
    await client.fetchIssue('A-1');
    const { url } = firstFetchCall(fetchMock);
    expect(url.startsWith('https://foo.atlassian.net/rest/api/3/issue/')).toBe(true);
  });

  it('sends Basic auth derived from email and token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(loadMinimalIssue()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new JiraClient({
      host: 'z.atlassian.net',
      email: 'alice@co.test',
      token: 'secret-token',
    }).fetchIssue('Z-9');

    const { init } = firstFetchCall(fetchMock);
    const headers = init?.headers as Record<string, string>;
    const auth = headers['authorization'];
    expect(auth).toMatch(/^Basic /);
    const decoded = Buffer.from(auth!.slice(6), 'base64').toString('utf8');
    expect(decoded).toBe('alice@co.test:secret-token');
  });
});

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
    expect(res.acceptanceCriteria).toBe('');
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

  it('reads each HTML entity once, so a written &lt; stays as text', async () => {
    const payload = loadMinimalIssue() as { renderedFields: { description: string } };
    payload.renderedFields.description = '<p>Type <b>&amp;lt;br&amp;gt;</b> for a break, &lt;b&gt; for bold &amp; more</p>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const client = new JiraClient({ host: 'x.atlassian.net', email: 'e@e.com', token: 't' });
    const res = await client.fetchIssue('K-2');
    expect(res.description).toBe('Type &lt;br&gt; for a break, <b> for bold & more');
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

describe('JiraClient.searchIssues', () => {
  function makeClient(): JiraClient {
    return new JiraClient({ host: 'h.atlassian.net', email: 'e', token: 't' });
  }

  function searchOkStub() {
    return vi.fn(async () => new Response(JSON.stringify({ issues: [], isLast: true }), { status: 200 }));
  }

  it('hits /rest/api/3/search/jql with empty query and a bounded JQL', async () => {
    const fetchMock = searchOkStub();
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().searchIssues('');
    const { url } = firstFetchCall(fetchMock);
    expect(url.startsWith('https://h.atlassian.net/rest/api/3/search/jql?')).toBe(true);
    expect(url.includes('/rest/api/3/search?')).toBe(false);
    const u = new URL(url);
    // Bounded by `updated >= -90d` to satisfy /search/jql; ORDER BY preserved.
    expect(u.searchParams.get('jql')).toBe('updated >= -90d ORDER BY updated DESC');
    expect(u.searchParams.get('fields')).toBe('summary,status,issuetype');
    expect(u.searchParams.get('maxResults')).toBe('25');
  });

  it('hits /rest/api/3/search/jql with issuekey JQL for "PROJ-42"', async () => {
    const fetchMock = searchOkStub();
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().searchIssues('PROJ-42');
    const { url } = firstFetchCall(fetchMock);
    const u = new URL(url);
    expect(u.pathname).toBe('/rest/api/3/search/jql');
    expect(u.searchParams.get('jql')).toBe('issuekey = "PROJ-42"');
  });

  it('hits /rest/api/3/search/jql with text-CONTAINS JQL and escaped quotes for free text', async () => {
    const fetchMock = searchOkStub();
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().searchIssues('o"malley');
    const { url } = firstFetchCall(fetchMock);
    const u = new URL(url);
    expect(u.searchParams.get('jql')).toBe('text ~ "o\\"malley" order by updated DESC');
    expect(url).toContain('text%20~%20%22o%5C%22malley%22%20order%20by%20updated%20DESC');
  });

  it('maps issues from the new envelope (nextPageToken / isLast, no total/startAt)', async () => {
    const body = {
      issues: [
        {
          key: 'PROJ-1',
          fields: { summary: 'First', issuetype: { name: 'Bug' }, status: { name: 'Open' } },
        },
        {
          key: 'PROJ-2',
          fields: { summary: 'Second' },
        },
      ],
      nextPageToken: 'abc',
      isLast: false,
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const rows = await makeClient().searchIssues('foo');

    expect(rows).toEqual([
      {
        id: 'PROJ-1',
        title: 'First',
        type: 'Bug',
        status: 'Open',
        url: 'https://h.atlassian.net/browse/PROJ-1',
      },
      {
        id: 'PROJ-2',
        title: 'Second',
        type: undefined,
        status: undefined,
        url: 'https://h.atlassian.net/browse/PROJ-2',
      },
    ]);
  });

  it('HTTP 410 on Jira search (deprecated endpoint regression) maps to TrackerError other with upgrade-squad-kit message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 410 })));

    try {
      await makeClient().searchIssues('');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toMatchObject({
        name: 'TrackerError',
        kind: 'other',
        statusCode: 410,
      });
      expect(e instanceof TrackerError && e.message.includes('removed by Atlassian')).toBe(true);
      expect(e instanceof TrackerError && e.message.toLowerCase().includes('upgrade squad-kit')).toBe(true);
    }
  });

  it('HTTP 401 on search still maps to auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    await expect(makeClient().searchIssues('')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'auth',
      statusCode: 401,
    });
  });

  it('respects opts.limit clamped to [1, 50]', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ issues: [], isLast: true }), { status: 200 }),
    );

    vi.stubGlobal('fetch', fetchMock);

    await makeClient().searchIssues('', { limit: 100 });
    expect(new URL(firstFetchCall(fetchMock).url).searchParams.get('maxResults')).toBe('50');

    fetchMock.mockClear();
    await makeClient().searchIssues('', { limit: 0 });
    expect(new URL(firstFetchCall(fetchMock).url).searchParams.get('maxResults')).toBe('1');
  });

  it('HTTP 400 from /search/jql carries Atlassian errorMessages in TrackerError.message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errorMessages: [
                'The query is unbounded. The query must be bounded by something like a project, an assignee, or a date range.',
              ],
              errors: {},
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    try {
      await makeClient().searchIssues('');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toMatchObject({ name: 'TrackerError', kind: 'other', statusCode: 400 });
      const err = e as TrackerError;
      expect(err.message).toContain('Jira search failed (HTTP 400).');
      expect(err.message).toContain('The query is unbounded.');
    }
  });

  it('HTTP 400 with non-JSON body falls back to a truncated raw snippet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad Request: malformed JQL', { status: 400 })),
    );
    await expect(makeClient().searchIssues('foo')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'other',
      statusCode: 400,
      message: expect.stringContaining('Bad Request: malformed JQL'),
    });
  });

  it('HTTP 500 surfaces Atlassian errorMessages on fetchIssue too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ errorMessages: ['Server error processing JQL'], errors: {} }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    try {
      await new JiraClient({ host: 'h.atlassian.net', email: 'e', token: 't' }).fetchIssue('PROJ-1');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toMatchObject({ name: 'TrackerError', kind: 'other', statusCode: 500 });
      expect((e as TrackerError).message).toContain('Server error processing JQL');
    }
  });

  it('401 still ignores body and emits the generic auth message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ errorMessages: ['ignored on auth'], errors: {} }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    try {
      await makeClient().searchIssues('');
      expect.fail('expected throw');
    } catch (e) {
      expect((e as TrackerError).message).not.toContain('ignored on auth');
      expect((e as TrackerError).message).toContain('authentication failed');
    }
  });
});

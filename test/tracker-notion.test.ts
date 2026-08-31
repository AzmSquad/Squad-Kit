import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotionClient } from '../src/tracker/notion.js';
import { TrackerError } from '../src/tracker/types.js';
import { firstFetchCall } from './support/fetch-test-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadPage(): Record<string, unknown> {
  const raw = readFileSync(path.join(__dirname, 'fixtures/notion/page-minimal.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function loadSearch(): Record<string, unknown> {
  const raw = readFileSync(path.join(__dirname, 'fixtures/notion/search-minimal.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * fetchIssue makes two calls: GET /pages/{id} then GET /blocks/{id}/children.
 * Route by URL so the block-children read returns a small body.
 */
function pageThenBlocksStub(page: Record<string, unknown>) {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/blocks/')) {
      return new Response(
        JSON.stringify({
          results: [
            {
              type: 'paragraph',
              paragraph: { rich_text: [{ plain_text: 'Body line one.' }] },
            },
            {
              type: 'heading_2',
              heading_2: { rich_text: [{ plain_text: 'A heading' }] },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(page), { status: 200 });
  });
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

describe('NotionClient.fetchIssue', () => {
  it('maps the minimal page fixture to FetchIssueResult', async () => {
    const fetchMock = pageThenBlocksStub(loadPage());
    vi.stubGlobal('fetch', fetchMock);

    const client = new NotionClient({ token: 'secret_tok' });
    const res = await client.fetchIssue('11112222-3333-4444-5555-666677778888');

    expect(res.id).toBe('11112222-3333-4444-5555-666677778888');
    expect(res.title).toBe('Login fails when MFA enabled');
    expect(res.description).toContain('Body line one.');
    expect(res.description).toContain('A heading');
    expect(res.acceptanceCriteria).toBe('');
    expect(res.labels).toEqual(['frontend', 'bug']);
    expect(res.type).toBe('Page');
    expect(res.assignee).toBe('Jamie Doe');
    expect(res.status).toBe('In Progress');
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0]!.filename).toBe('screenshot.png');
    expect(Number.isNaN(Date.parse(res.fetchedAt))).toBe(false);
  });

  it('sends Bearer auth and the Notion-Version header', async () => {
    const fetchMock = pageThenBlocksStub(loadPage());
    vi.stubGlobal('fetch', fetchMock);

    await new NotionClient({ token: 'secret_abc' }).fetchIssue('11112222333344445555666677778888');

    const { url, init } = firstFetchCall(fetchMock);
    expect(url.startsWith('https://api.notion.com/v1/pages/')).toBe(true);
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer secret_abc');
    expect(headers['notion-version']).toBe('2022-06-28');
  });

  it('normalises a bare 32-hex id to a dashed UUID in the request path', async () => {
    const fetchMock = pageThenBlocksStub(loadPage());
    vi.stubGlobal('fetch', fetchMock);

    await new NotionClient({ token: 't-token-value-1234' }).fetchIssue(
      '11112222333344445555666677778888',
    );

    const { url } = firstFetchCall(fetchMock);
    expect(url).toBe(
      'https://api.notion.com/v1/pages/11112222-3333-4444-5555-666677778888',
    );
  });

  it('401 throws TrackerError auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(new NotionClient({ token: 'tok-value-1234' }).fetchIssue('X')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'auth',
      statusCode: 401,
    });
  });

  it('leaks no token into the attachment ref urls it returns', async () => {
    const fetchMock = pageThenBlocksStub(loadPage());
    vi.stubGlobal('fetch', fetchMock);

    const res = await new NotionClient({ token: 'secret_leaky' }).fetchIssue(
      '11112222333344445555666677778888',
    );

    for (const a of res.attachments) expect(a.url).not.toContain('secret_leaky');
  });

  it('403 throws TrackerError auth (share hint)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(new NotionClient({ token: 'tok-value-1234' }).fetchIssue('X')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'auth',
      statusCode: 403,
    });
  });

  it('404 throws TrackerError not-found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(
      new NotionClient({ token: 'tok-value-1234' }).fetchIssue('deadbeef'),
    ).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'not-found',
      statusCode: 404,
    });
  });

  it('429 throws TrackerError rate-limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    await expect(new NotionClient({ token: 'tok-value-1234' }).fetchIssue('X')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'rate-limited',
      statusCode: 429,
    });
  });

  it('500 throws TrackerError other and surfaces the Notion message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'internal boom' }), { status: 500 })),
    );
    try {
      await new NotionClient({ token: 'tok-value-1234' }).fetchIssue('X');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TrackerError);
      const err = e as TrackerError;
      expect(err.kind).toBe('other');
      expect(err.statusCode).toBe(500);
      expect(err.message).toContain('internal boom');
    }
  });

  it('fetch rejection throws TrackerError network', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ENOTFOUND'))));
    await expect(new NotionClient({ token: 'tok-value-1234' }).fetchIssue('X')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'network',
    });
  });
});

describe('NotionClient.searchIssues', () => {
  function makeClient(): NotionClient {
    return new NotionClient({ token: 'tok-value-1234' });
  }

  it('POSTs /v1/search with an object=page filter and maps results', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(loadSearch()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await makeClient().searchIssues('login');

    const { url, init } = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.notion.com/v1/search');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as {
      query: string;
      filter: { property: string; value: string };
      page_size: number;
    };
    expect(body.query).toBe('login');
    expect(body.filter).toEqual({ property: 'object', value: 'page' });

    expect(rows).toEqual([
      {
        id: 'aaaa1111-bbbb-2222-cccc-333344445555',
        title: 'First result',
        type: 'Page',
        status: 'To Do',
        url: 'https://www.notion.so/First-result-aaaa1111bbbb2222cccc333344445555',
      },
      {
        id: 'bbbb2222-cccc-3333-dddd-444455556666',
        title: 'Second result',
        type: 'Page',
        status: undefined,
        url: 'https://www.notion.so/Second-result-bbbb2222cccc3333dddd444455556666',
      },
    ]);
  });

  it('clamps opts.limit into [1, 50]', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().searchIssues('x', { limit: 100 });
    expect(JSON.parse(firstFetchCall(fetchMock).init?.body as string).page_size).toBe(50);

    fetchMock.mockClear();
    await makeClient().searchIssues('x', { limit: 0 });
    expect(JSON.parse(firstFetchCall(fetchMock).init?.body as string).page_size).toBe(1);
  });

  it('401 on search maps to auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(makeClient().searchIssues('x')).rejects.toMatchObject({
      name: 'TrackerError',
      kind: 'auth',
      statusCode: 401,
    });
  });
});

describe('NotionClient.downloadAttachments', () => {
  /**
   * Notion attachment URLs are pre-signed S3 links. S3 rejects a request that carries both a
   * signature and an `Authorization` header, and forwarding the integration token to a
   * third-party host would leak it outright — so the download must send *no* auth headers.
   * This is the security-sensitive half of the adapter; assert the wire, not the call.
   */
  it('sends no authorization header to the pre-signed URL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-notion-att-'));
    const fetchMock = vi.fn(async () => new Response(Buffer.from('png-bytes'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await new NotionClient({ token: 'secret_must_not_leak' }).downloadAttachments(
      [{ filename: 'shot.png', url: 'https://s3.us-west-2.amazonaws.com/secure.notion-static.com/x?X-Amz-Signature=abc', size: 0 }],
      dir,
    );

    expect(out[0]!.outcome).toBe('written');
    const { init } = firstFetchCall(fetchMock);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // No auth of any casing, and the token appears nowhere in the outgoing headers.
    for (const key of Object.keys(headers)) expect(key.toLowerCase()).not.toBe('authorization');
    expect(JSON.stringify(headers)).not.toContain('secret_must_not_leak');
  });

  it('makes no request at all when there are no refs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-notion-att-'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NotionClient({ token: 'secret_tok' }).downloadAttachments([], dir)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

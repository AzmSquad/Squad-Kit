import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The sign-in helper at auth.squad-kit.com (auth-helper/, ADR-012): it adds the app's secret to Atlassian's code
 * exchange and refresh, sends the person back only to squad-kit's door on 127.0.0.1, and keeps nothing. Atlassian here
 * is made up, answering in the shapes of its OAuth 2.0 (3LO) docs.
 */

interface Helper {
  fetch(request: Request, env: Record<string, string | undefined>): Promise<Response>;
}

let helper: Helper;
const ENV = { ATLASSIAN_CLIENT_ID: 'client-123', ATLASSIAN_CLIENT_SECRET: 'the-secret' };
const NONCE = 'n'.repeat(43);
const BASE = 'https://auth.squad-kit.com';

beforeAll(async () => {
  // A plain JS module, outside the package: loaded by its path.
  helper = ((await import(pathToFileURL(path.resolve(__dirname, '../auth-helper/src/worker.js')).href)) as { default: Helper }).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Atlassian's token endpoint, made up: what it was sent, and its answer. */
function fakeAtlassian(status: number, body: unknown) {
  const sent: { url: string; body: Record<string, string> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, string> });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return sent;
}

const get = (p: string) => helper.fetch(new Request(`${BASE}${p}`), ENV);
const post = (p: string, body: unknown, headers: Record<string, string> = {}, env: Record<string, string | undefined> = ENV) =>
  helper.fetch(new Request(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env);

describe('the callback', () => {
  it('sends the code on to squad-kit on 127.0.0.1, at the port in the state, and nowhere else', async () => {
    const res = await get(`/atlassian/callback?code=abc.DEF-123&state=51234.${NONCE}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`http://127.0.0.1:51234/atlassian?code=abc.DEF-123&state=51234.${NONCE}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('Cancel on Atlassian’s page still goes back, so squad-kit can say so; its free text never does', async () => {
    const res = await get(`/atlassian/callback?error=access_denied&error_description=${encodeURIComponent('<b>no</b>')}&state=51234.${NONCE}`);
    expect(res.headers.get('location')).toBe(`http://127.0.0.1:51234/atlassian?error=access_denied&state=51234.${NONCE}`);
    const odd = await get(`/atlassian/callback?error=${encodeURIComponent('<script>')}&state=51234.${NONCE}`);
    expect(odd.headers.get('location')).toBe(`http://127.0.0.1:51234/atlassian?error=invalid_request&state=51234.${NONCE}`);
    const none = await get(`/atlassian/callback?state=51234.${NONCE}`);
    expect(none.headers.get('location')).toContain('error=invalid_request');
  });

  it.each([
    ['no state', ''],
    ['a port below 1024', `&state=80.${NONCE}`],
    ['a port above 65535', `&state=70000.${NONCE}`],
    ['a short nonce', '&state=51234.abc'],
    ['a host in the state', `&state=${encodeURIComponent('evil.com:80')}.${NONCE}`],
    ['something else after the nonce', `&state=51234.${NONCE}/../x`],
  ])('a state squad-kit did not make (%s) gets a plain page, never a redirect', async (_why, state) => {
    const res = await get(`/atlassian/callback?code=abc${state}`);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.text()).toContain('This sign-in link is not one squad-kit made');
  });
});

describe('the code exchange and the refresh', () => {
  it('adds the client id and secret and the fixed callback, and gives Atlassian’s answer back as it is', async () => {
    const answer = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'read:jira-work offline_access' };
    const sent = fakeAtlassian(200, answer);
    const res = await post('/atlassian/token', { code: 'the-code' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(sent).toEqual([
      {
        url: 'https://auth.atlassian.com/oauth/token',
        body: { grant_type: 'authorization_code', client_id: 'client-123', client_secret: 'the-secret', code: 'the-code', redirect_uri: 'https://auth.squad-kit.com/atlassian/callback' },
      },
    ]);
  });

  it('a refresh gives the new pair, as Atlassian rotates it', async () => {
    const sent = fakeAtlassian(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'read:jira-work' });
    const res = await post('/atlassian/refresh', { refresh_token: 'rt-1' });
    expect(await res.json()).toMatchObject({ access_token: 'at-2', refresh_token: 'rt-2' });
    expect(sent[0]!.body).toEqual({ grant_type: 'refresh_token', client_id: 'client-123', client_secret: 'the-secret', refresh_token: 'rt-1' });
  });

  it('Atlassian’s no comes back with its own status and words', async () => {
    fakeAtlassian(403, { error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' });
    const res = await post('/atlassian/refresh', { refresh_token: 'old' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' });
  });

  it('Atlassian out of reach, or answering with a page, is a 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    expect((await post('/atlassian/token', { code: 'c' })).status).toBe(502);
    fakeAtlassian(503, '<html>down</html>');
    const res = await post('/atlassian/token', { code: 'c' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('refuses what is not squad-kit’s: no JSON, too big, a missing field, a web page calling it, no secret set', async () => {
    const sent = fakeAtlassian(200, {});
    expect((await post('/atlassian/token', 'code=x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await post('/atlassian/token', '{not json')).status).toBe(400);
    expect((await post('/atlassian/token', { refresh_token: 'x' })).status).toBe(400);
    expect((await post('/atlassian/refresh', { code: 'x' })).status).toBe(400);
    expect((await post('/atlassian/token', { code: 'x'.repeat(5000) })).status).toBe(400);
    expect((await post('/atlassian/token', { code: 'x', pad: 'y'.repeat(9000) })).status).toBe(413);
    expect((await post('/atlassian/token', { code: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/atlassian/token', { code: 'x' }, {}, { ATLASSIAN_CLIENT_ID: 'client-123' })).status).toBe(500);
    // The placeholder id in wrangler.jsonc, before the owner registers the app, is not set up either.
    const placeholder = await post('/atlassian/refresh', { refresh_token: 'x' }, {}, { ATLASSIAN_CLIENT_ID: 'ATLASSIAN_CLIENT_ID_NOT_SET', ATLASSIAN_CLIENT_SECRET: 's' });
    expect(placeholder.status).toBe(500);
    expect(await placeholder.json()).toEqual({ error: 'server_error', error_description: 'The sign-in helper is not set up yet.' });
    expect(sent).toEqual([]);
  });

  it('too many from one address: a plain 429, counted by Cloudflare’s rate limit per address', async () => {
    const sent = fakeAtlassian(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    const seen: string[] = [];
    let left = 2;
    const TOKEN_LIMIT = { limit: async ({ key }: { key: string }) => (seen.push(key), { success: left-- > 0 }) };
    const env = { ...ENV, TOKEN_LIMIT } as unknown as Record<string, string>;
    const ask = () => post('/atlassian/refresh', { refresh_token: 'rt-1' }, { 'cf-connecting-ip': '203.0.113.7' }, env);
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    const no = await ask();
    expect(no.status).toBe(429);
    expect(await no.json()).toEqual({ error: 'slow_down', error_description: 'Too many sign-in requests from this address. Wait a minute, then try again.' });
    expect(seen).toEqual(['203.0.113.7', '203.0.113.7', '203.0.113.7']);
    expect(sent).toHaveLength(2);
  });

  it('the rate limit failing on Cloudflare’s side never stops a sign-in: it fails open', async () => {
    const sent = fakeAtlassian(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    const TOKEN_LIMIT = { limit: async () => Promise.reject(new Error('rate limiter unavailable')) };
    const res = await post('/atlassian/refresh', { refresh_token: 'rt-1' }, {}, { ...ENV, TOKEN_LIMIT } as unknown as Record<string, string>);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe('everything else', () => {
  it.each([
    ['GET', '/'],
    ['GET', '/atlassian/token'],
    ['POST', '/atlassian/callback'],
    ['GET', '/atlassian/callback/x'],
    ['PUT', '/atlassian/refresh'],
  ])('%s %s is a 404', async (method, p) => {
    const sent = fakeAtlassian(200, {});
    const res = await helper.fetch(new Request(`${BASE}${p}`, { method, ...(method === 'GET' ? {} : { body: '{}' }) }), ENV);
    expect(res.status).toBe(404);
    expect(sent).toEqual([]);
  });

  it('logs nothing', async () => {
    const said = vi.spyOn(console, 'log');
    const warned = vi.spyOn(console, 'warn');
    const failed = vi.spyOn(console, 'error');
    fakeAtlassian(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    await post('/atlassian/token', { code: 'the-code' });
    await get(`/atlassian/callback?code=the-code&state=51234.${NONCE}`);
    expect([...said.mock.calls, ...warned.mock.calls, ...failed.mock.calls]).toEqual([]);
  });
});

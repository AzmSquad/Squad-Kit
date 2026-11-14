// squad-kit's sign-in helper for "Sign in with Atlassian", at https://auth.squad-kit.com (ADR-012).
//
// Atlassian's OAuth 2.0 (3LO) asks for the app's client secret on every code exchange and every refresh, and a secret
// cannot ship inside an npm package. This Worker keeps the secret, adds it, and passes Atlassian's answer straight back
// to squad-kit on the person's computer. It keeps no code and no token, and logs nothing; Cloudflare counts requests per
// address for about a minute, to stop abuse.

const ATLASSIAN_TOKEN = 'https://auth.atlassian.com/oauth/token';
/** The one address Atlassian sends the person back to, as registered for squad-kit's app. */
const REDIRECT_URI = 'https://auth.squad-kit.com/atlassian/callback';
/** A code or a refresh token is a few hundred characters; a request body is never more than this. */
const MAX_BODY = 8 * 1024;
const MAX_VALUE = 4096;
/** squad-kit's state: the port of its one-shot door on 127.0.0.1, a dot, and a random nonce. */
const STATE = /^(\d{4,5})\.([A-Za-z0-9_-]{32,128})$/;
/** Atlassian's own error words are short codes, like access_denied: only those go back, never free text. */
const ERROR = /^[a-z_]{1,64}$/;
const CODE = /^[\x21-\x7e]{1,4096}$/;
/** The client id in wrangler.jsonc until the owner registers the app: the helper is not set up yet. */
const NOT_SET = 'ATLASSIAN_CLIENT_ID_NOT_SET';

const PLAIN = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function json(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { ...PLAIN, 'content-type': 'application/json' } });
}

const refuse = (status, error, description) => json(status, { error, error_description: description });

function page(status, title, text) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1d2433;background:#fff}h1{font-size:1.25rem}@media (prefers-color-scheme:dark){body{color:#e6e9ef;background:#11151c}}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { ...PLAIN, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" },
  });
}

const notFound = () => new Response('Not found', { status: 404, headers: { ...PLAIN, 'content-type': 'text/plain; charset=utf-8' } });

/**
 * Atlassian sends the person here after they press Accept or Cancel. The answer goes on to squad-kit's door on this
 * same computer, 127.0.0.1 and the port in the state, and nowhere else. A state squad-kit did not make gets a plain page.
 */
function callback(url) {
  const state = url.searchParams.get('state') ?? '';
  const m = STATE.exec(state);
  const port = m ? Number(m[1]) : 0;
  if (!m || port < 1024 || port > 65535) {
    return page(400, 'This sign-in link is not one squad-kit made', 'Nothing was signed in. Start Sign in with Atlassian again from squad-kit.');
  }
  const back = new URL(`http://127.0.0.1:${port}/atlassian`);
  const code = url.searchParams.get('code') ?? '';
  const error = url.searchParams.get('error');
  if (!error && CODE.test(code)) back.searchParams.set('code', code);
  // Cancel on Atlassian's page (access_denied) still goes back, so squad-kit can say so.
  else back.searchParams.set('error', error && ERROR.test(error) ? error : 'invalid_request');
  back.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { ...PLAIN, location: back.toString() } });
}

/** The body as text, or null when it is longer than MAX_BODY, whatever its Content-Length says. */
async function capped(request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A code (grant authorization_code) or a refresh token (grant refresh_token) goes to Atlassian with the app's client id
 * and secret. Atlassian's JSON and status come back as they are; Atlassian rotates refresh tokens, so a refresh answers
 * with a new pair.
 */
async function exchange(request, env, grant) {
  // squad-kit calls this from Node, never from a web page: a browser always says where it comes from.
  if (request.headers.has('origin')) return refuse(403, 'invalid_request', 'Only squad-kit on your computer calls this.');
  if (!env.ATLASSIAN_CLIENT_ID || env.ATLASSIAN_CLIENT_ID === NOT_SET || !env.ATLASSIAN_CLIENT_SECRET) return refuse(500, 'server_error', 'The sign-in helper is not set up yet.');
  // About 30 a minute from one address (Cloudflare's rate limiting binding, per location); a refresh is once an hour.
  // The limit failing on Cloudflare's side never stops a sign-in: it fails open.
  let allowed = true;
  try {
    if (env.TOKEN_LIMIT) allowed = (await env.TOKEN_LIMIT.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' })).success !== false;
  } catch {
    allowed = true;
  }
  if (!allowed) return refuse(429, 'slow_down', 'Too many sign-in requests from this address. Wait a minute, then try again.');
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return refuse(415, 'invalid_request', 'Send JSON.');
  const text = await capped(request);
  if (text === null) return refuse(413, 'invalid_request', 'The request is too big.');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'invalid_request', 'Send JSON.');
  }
  const field = grant === 'authorization_code' ? 'code' : 'refresh_token';
  const value = body && typeof body === 'object' ? body[field] : undefined;
  if (typeof value !== 'string' || !value || value.length > MAX_VALUE) return refuse(400, 'invalid_request', `Send ${field}.`);
  const upstream = {
    grant_type: grant,
    client_id: env.ATLASSIAN_CLIENT_ID,
    client_secret: env.ATLASSIAN_CLIENT_SECRET,
    [field]: value,
    ...(grant === 'authorization_code' ? { redirect_uri: REDIRECT_URI } : {}),
  };
  let res;
  try {
    res = await fetch(ATLASSIAN_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(upstream),
      redirect: 'manual',
    });
  } catch {
    return refuse(502, 'temporarily_unavailable', 'Atlassian could not be reached just now.');
  }
  const out = await res.text().catch(() => null);
  if (out === null || !isJson(out)) return refuse(502, 'temporarily_unavailable', 'Atlassian answered with something else than its data.');
  return json(res.status, out);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/atlassian/callback' && request.method === 'GET') return callback(url);
    if (url.pathname === '/atlassian/token' && request.method === 'POST') return exchange(request, env, 'authorization_code');
    if (url.pathname === '/atlassian/refresh' && request.method === 'POST') return exchange(request, env, 'refresh_token');
    return notFound();
  },
};

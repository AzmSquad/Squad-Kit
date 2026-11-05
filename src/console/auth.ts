import type { MiddlewareHandler } from 'hono';

/**
 * Token gate for /api/* routes.
 *
 * Accepts the token via:
 *   - `Authorization: Bearer <token>` (preferred; used by `fetch`).
 *   - `?t=<token>` query string, on reads only (`EventSource`, pictures and links can't set headers). A write never
 *     takes it: a page anywhere can send a POST with a query string, but not with this header unless the board allows it.
 *
 * Constant-time compare to avoid timing oracles on guess attempts.
 */
export function authMiddleware(expected: string): MiddlewareHandler {
  return async (c, next) => {
    const presented = readPresentedToken(c.req.raw);
    if (!presented || !timingSafeEqualHex(presented, expected)) {
      return c.json({ error: 'unauthorized', detail: 'missing or invalid session token' }, 401);
    }
    await next();
  };
}

export function readPresentedToken(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice('bearer '.length).trim();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const url = new URL(req.url);
  return url.searchParams.get('t');
}

/** The names this computer's own board answers to. It listens on 127.0.0.1 only; a link may say localhost. */
const OWN_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What a browser shows at any other address, instead of raw data. */
const NOT_OUR_ADDRESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>squad-kit</title></head><body style="font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem"><h1 style="font-size:20px">This is not squad-kit's own address</h1><p>Open squad-kit from the link it shows when it starts, on this computer.</p></body></html>`;

/**
 * Only this computer's own address, on every route: a site whose name was pointed at this computer (DNS rebinding) sends
 * its own name as the Host, and gets nothing. Writes come only from the board's own pages: a page on another site, or
 * on another local port such as the project's own app, sends its Origin and is refused. A request with no Origin (the
 * terminal, an agent's window) is no web page, and goes on to the token gate.
 */
export function ownAddressOnly(port: number): MiddlewareHandler {
  const hosts = new Set(OWN_NAMES.map((n) => `${n}:${port}`));
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return async (c, next) => {
    if (!hosts.has((c.req.header('host') ?? '').toLowerCase())) {
      if (c.req.header('accept')?.includes('text/html')) return c.html(NOT_OUR_ADDRESS, 403);
      return c.json({ error: 'forbidden', detail: "This is not squad-kit's own address." }, 403);
    }
    const origin = c.req.header('origin');
    if (!READS.has(c.req.method) && origin !== undefined && !origins.has(origin.toLowerCase())) {
      return c.json({ error: 'forbidden', detail: "Changes come only from squad-kit's own pages." }, 403);
    }
    await next();
  };
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

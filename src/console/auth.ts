import type { MiddlewareHandler } from 'hono';

/**
 * Token gate for /api/* routes.
 *
 * Accepts the token via:
 *   - `Authorization: Bearer <token>` (preferred; used by `fetch`).
 *   - `?t=<token>` query string (used by `EventSource`, which can't set headers).
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
  const url = new URL(req.url);
  return url.searchParams.get('t');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

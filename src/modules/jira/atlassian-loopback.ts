import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/**
 * The one-shot door Atlassian's answer comes back through (ADR-012): a listener on 127.0.0.1 only, on a port the system
 * picks, for one path and GET only. Atlassian sends the person to squad-kit's sign-in helper, which sends them on here
 * with the code (or Cancel) and the state squad-kit made: `<port>.<nonce>`. The nonce is checked in constant time and
 * taken once. The door closes after that one answer, after 15 minutes, or on Cancel.
 */

export type DoorAnswer = { code: string } | { error: string };

export interface Door {
  port: number;
  /** The answer, or null when the door closed without one (15 minutes, Cancel). */
  answer: Promise<DoorAnswer | null>;
  close(): void;
}

const PATH = '/atlassian';

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The page the person's browser shows: plain, nothing to load, nothing sent on. */
function page(res: http.ServerResponse, status: number, title: string, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    connection: 'close',
  });
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`,
  );
}

export function openDoor(nonce: string, lifeMs: number): Promise<Door> {
  return new Promise((resolve, reject) => {
    let settle: (a: DoorAnswer | null) => void = () => undefined;
    const answer = new Promise<DoorAnswer | null>((r) => (settle = r));
    let taken = false;
    let port = 0;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // Only the address squad-kit gave: a page on another name (DNS rebinding) or another path gets nothing.
      if (req.method !== 'GET' || url.pathname !== PATH || req.headers.host !== `127.0.0.1:${port}`) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('Not found');
        return;
      }
      const [p, n] = (url.searchParams.get('state') ?? '').split(/\.(.*)/s);
      if (taken || p !== String(port) || !n || !same(n, nonce)) {
        page(res, 400, 'This sign-in is not the one squad-kit is waiting for', 'Nothing was signed in. Go back to squad-kit and press Sign in with Atlassian again.');
        return;
      }
      taken = true;
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (code && !error) page(res, 200, 'Approved', 'squad-kit is finishing the sign-in. You can close this tab and go back to squad-kit.');
      else page(res, 200, error === 'access_denied' ? 'Cancelled' : 'Not signed in', 'Nothing was signed in. You can close this tab and go back to squad-kit.');
      settle(code && !error ? { code } : { error: (error ?? 'invalid_request').slice(0, 64) });
      close();
    });
    const timer = setTimeout(() => close(), lifeMs);
    timer.unref();
    function close() {
      clearTimeout(timer);
      settle(null);
      server.close();
      server.closeIdleConnections();
    }
    server.on('error', (err) => reject(err));
    server.listen(0, '127.0.0.1', () => {
      const at = server.address();
      port = typeof at === 'object' && at ? at.port : 0;
      resolve({ port, answer, close });
    });
  });
}

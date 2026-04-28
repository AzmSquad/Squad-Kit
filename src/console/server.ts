import { createServer } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import * as ui from '../ui/index.js';
import type { SquadPaths } from '../core/paths.js';
import { readInstalledPackage } from '../core/package-info.js';
import { mountApi } from './api/index.js';
import { mountStaticAssets } from './static-assets.js';
import { authMiddleware } from './auth.js';

export interface StartConsoleServerOptions {
  paths: SquadPaths;
  requestedPort: number;
  token: string;
}

export interface ConsoleServer {
  port: number;
  /** Resolves when the server has fully shut down (SIGINT, SIGTERM, or programmatic close). */
  done: Promise<void>;
  /** Programmatic close (used by tests). */
  close(): Promise<void>;
}

export async function startConsoleServer(opts: StartConsoleServerOptions): Promise<ConsoleServer> {
  const bindPort =
    opts.requestedPort === 0
      ? await reserveEphemeralPort()
      : await findFreePortFromBase(opts.requestedPort);

  const app = new Hono();

  // Public health endpoint (no auth) — used by tests and external uptime checks.
  app.get('/healthz', (c) =>
    c.json(
      { ok: true, version: readInstalledPackage().version, port: bindPort },
      200,
      {
        'cache-control': 'no-store',
      },
    ),
  );

  // Tighten headers everywhere. Static asset and API responses inherit these.
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: 'no-referrer',
    }),
  );

  // Disable CORS in production builds — same-origin only.
  app.use('*', cors({ origin: 'http://127.0.0.1:' + bindPort }));

  // API: token-gated.
  app.use('/api/*', authMiddleware(opts.token));
  mountApi(app, { paths: opts.paths });

  // Static SPA: public reads from project/dist/console-ui (story 02 fills it in).
  mountStaticAssets(app, { paths: opts.paths });

  const nodeServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: bindPort });

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const actualPort = (() => {
    const addr = nodeServer.address();
    if (addr && typeof addr === 'object') return addr.port;
    return bindPort;
  })();

  const shutdown = (onClose: (err?: Error) => void) => {
    nodeServer.close((err) => {
      onClose(err);
    });
  };

  const stop = () => {
    shutdown((err) => {
      if (err) ui.warning(`server close: ${err.message}`);
      resolveDone();
    });
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  return {
    port: actualPort,
    done,
    close: () =>
      new Promise<void>((resolve, reject) => {
        shutdown((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
          resolveDone();
        });
      }),
  };
}

/** Picks a free port, lets the OS choose the number, then returns it (avoids passing `0` into URLs). */
function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Could not determine ephemeral port'));
        }
      });
    });
  });
}

async function findFreePortFromBase(start: number, attempts = 20): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = start + i;
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(
    `Could not find a free port in [${start}, ${start + attempts - 1}]. Pass \`--port <n>\` to pick another base.`,
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

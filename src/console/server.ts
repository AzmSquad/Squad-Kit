import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import { isatty } from 'node:tty';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import * as ui from '../ui/index.js';
import type { SquadPaths } from '../core/paths.js';
import { readInstalledPackage } from '../core/package-info.js';
import { mountAppApi } from './api/app.js';
import { mountUpdateApi } from './api/update.js';
import { mountSupportApi, onUnexpected } from './api/support.js';
import { log } from '../core/app-log.js';
import { UpdateService, runsNow, ticketsInProgress, type UpdateDeps } from './updates.js';
import { mountStaticAssets } from './static-assets.js';
import { authMiddleware, ownAddressOnly } from './auth.js';
import { OpenProjects, type OpenProject } from './open-projects.js';
import type { ConsoleInfo } from '../board/console-info.js';
import { KEEP_IDLE_MS, answerWindow, closeServer, windowAt } from '../engine/window-server.js';

export interface StartConsoleServerOptions {
  /** The project to open first. Its API also answers at the addresses one board had, without the /p/<id> prefix. */
  paths?: SquadPaths;
  /** The one app (ADR-001): also open every project on the app's list in ~/.squad-kit/projects.json, and keep it. */
  app?: boolean;
  requestedPort: number;
  token: string;
  /** When the running squad-kit code was built; the board compares it with the code on disk to spot updates. */
  build?: number;
  /** The Update button's registry, installer and restart; tests and checks pass fakes. */
  update?: UpdateDeps;
  /** Started to outlive its terminal (startedToOutlive): closing the terminal does not stop it. */
  keepOnHangup?: boolean;
}

export interface ConsoleServer {
  port: number;
  /** Resolves when the server has fully shut down (SIGINT, SIGTERM, or programmatic close). */
  done: Promise<void>;
  /** Programmatic close (used by tests). */
  close(): Promise<void>;
  /** True when the person pressed Restart on the board; the console command then starts a fresh one. */
  restartRequested(): boolean;
  /** The projects open in this app, each with its own squad. */
  projects: OpenProjects;
  /** The Update button; `watch()` looks for a new squad-kit on start and once a day. */
  updates: UpdateService;
}

export async function startConsoleServer(opts: StartConsoleServerOptions): Promise<ConsoleServer> {
  const bindPort =
    opts.requestedPort === 0
      ? await reserveEphemeralPort()
      : await findFreePortFromBase(opts.requestedPort);

  const app = new Hono();

  const startedAt = new Date().toISOString();
  let restart = false;
  let stopForRestart: () => void = () => {};

  // Before anything else, on every route: only this computer's own address, and writes only from the board's pages.
  app.use('*', ownAddressOnly(bindPort));

  // Public health endpoint (no auth) — used by tests and external uptime checks.
  app.get('/healthz', (c) =>
    c.json(
      { ok: true, version: readInstalledPackage().version, port: bindPort, startedAt },
      200,
      {
        'cache-control': 'no-store',
      },
    ),
  );

  const MOCKUP_PATH = /^(\/p\/[^/]+)?\/mockup\/[^/]+$/;
  const MOCKUP_CSP = "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

  // Tighten headers everywhere. Static asset and API responses inherit these.
  const strict = secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: 'no-referrer',
  });
  // A ticket's PDF opens beside the chat, inside the board's own page.
  const FILE_PATH = /\/tickets\/[^/]+\/file$/;
  app.use('*', async (c, next) => {
    if (!MOCKUP_PATH.test(c.req.path)) {
      await strict(c, next);
      const csp = c.res.headers.get('content-security-policy');
      if (FILE_PATH.test(c.req.path) && c.res.headers.get('content-type') === 'application/pdf' && csp) {
        c.res.headers.set('content-security-policy', csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
      }
      return;
    }
    // An agent's HTML mockup: its own inline scripts may run, sealed in a sandbox with no network and no board origin.
    await next();
    c.res.headers.set('content-security-policy', MOCKUP_CSP);
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'no-referrer');
  });

  // Disable CORS in production builds — same-origin only.
  app.use('*', cors({ origin: 'http://127.0.0.1:' + bindPort }));

  const control = {
    startedAt,
    build: opts.build ?? 0,
    restart: () => {
      restart = true;
      // Answer the request first, then stop.
      setTimeout(() => stopForRestart(), 200);
    },
  };
  let actualPort = bindPort;
  const info = (): ConsoleInfo => ({ pid: process.pid, port: actualPort, token: opts.token, startedAt, version: readInstalledPackage().version, build: opts.build ?? 0 });
  const projects = new OpenProjects({ token: opts.token, control, info, remember: Boolean(opts.app) });

  // API: token-gated. The app's own calls first; each project checks the token again for its own.
  app.use('/api/*', authMiddleware(opts.token));
  mountAppApi(app, { projects });
  const updates = new UpdateService({
    busy: () => runsNow(projects),
    carrying: () => ticketsInProgress(projects),
    restart: control.restart,
    ...opts.update,
  });
  mountUpdateApi(app, updates);
  mountSupportApi(app, { projects });
  app.onError(onUnexpected);

  // Every project's API names it: /p/<id>/api/v1/board reaches that project's /api/v1/board. This is the one place
  // the prefix is made, so each project keeps the routes one board always had. Its pages go to the board app below.
  app.all('/p/:project/*', async (c, next) => {
    const url = new URL(c.req.url);
    const prefix = url.pathname.split('/').slice(0, 3).join('/');
    url.pathname = url.pathname.slice(prefix.length);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/mockup/')) return next();
    const p = projects.get(c.req.param('project'));
    if (!p) return c.json({ error: 'This project is not open in the app. Add it from Home.' }, 404);
    return p.api.fetch(new Request(url, c.req.raw), c.env);
  });

  // The first project also answers at the old addresses, so older links, tools and tests keep working.
  const first = (): OpenProject | undefined => (projects.first ? projects.get(projects.first) : undefined);
  app.all('/api/*', (c) => {
    const p = first();
    return p ? p.api.fetch(c.req.raw, c.env) : c.json({ error: 'Name the project: /p/<project id>/api/v1/…' }, 404);
  });
  // An agent's mockup link names no project: the project whose ticket holds that file answers it.
  app.get('/mockup/:id', async (c) => {
    for (const p of [first(), ...projects.all()]) {
      if (!p) continue;
      const res = await p.api.fetch(c.req.raw, c.env);
      if (res.status !== 404) return res;
    }
    return c.text('not found', 404);
  });

  // squad-kit's own tools for each agent run (the window), over MCP. Each run's key opens only its own tools.
  app.all('/mcp', (c) => answerWindow(c.req.raw));

  // Static SPA: public reads from project/dist/console-ui.
  mountStaticAssets(app, { paths: opts.paths });

  const nodeServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: bindPort });
  // Agents reach their window here too: see KEEP_IDLE_MS.
  (nodeServer as unknown as HttpServer).keepAliveTimeout = KEEP_IDLE_MS;
  actualPort = (() => {
    const addr = nodeServer.address();
    if (addr && typeof addr === 'object') return addr.port;
    return bindPort;
  })();

  // Agent runs reach their window at the board's own address.
  windowAt(`http://127.0.0.1:${actualPort}`);

  // Each project runs its own squad; the tickets running at once are limited across all of them.
  if (opts.paths) projects.first = projects.openReady(opts.paths).id;
  if (opts.app) projects.openSaved();
  log.info(`squad-kit ${readInstalledPackage().version} started on port ${actualPort} with ${projects.all().length} project${projects.all().length === 1 ? '' : 's'} open (Node ${process.version})`);
  const stopSquad = () => projects.closeAll();

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const shutdown = (onClose: (err?: Error) => void) => {
    log.info('squad-kit stopped');
    // A process that outlives its board (a restart keeper, tests) must not stop it again on a later Ctrl-C.
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', onHangup);
    stopSquad();
    windowAt(null);
    closeServer(nodeServer as unknown as HttpServer, onClose);
  };

  const stop = () => {
    shutdown((err) => {
      if (err) ui.warning(`server close: ${err.message}`);
      resolveDone();
    });
  };

  stopForRestart = stop;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // The terminal closed: the same clean stop, or the agents (in their own process groups) would go on, and go on spending.
  // Started to outlive its terminal, it goes on: Node sets this signal back to "end the process" as it starts, so the
  // listener is what keeps it running.
  const onHangup = opts.keepOnHangup ? () => log.info('The terminal closed; squad-kit keeps running, as it was started to outlive it') : stop;
  if (opts.keepOnHangup) process.on('SIGHUP', onHangup);
  else process.once('SIGHUP', onHangup);

  return {
    port: actualPort,
    done,
    restartRequested: () => restart,
    projects,
    updates,
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

/**
 * True when squad-kit was started to outlive its terminal, such as with nohup: its output goes to files, not to a
 * terminal and not down a pipe (`nohup squad > app.log 2>&1 &`, or nohup's own nohup.out). What nohup itself did to the
 * signal cannot be read: Node resets it before any of this runs. A pipe does not count: `squad | tee` ends with its
 * terminal, and the agents must not go on spending after it.
 */
export function startedToOutlive(fds: number[] = [1, 2], info: { isatty(fd: number): boolean; fstat(fd: number): { isFIFO(): boolean; isSocket(): boolean } } = { isatty, fstat: fs.fstatSync }): boolean {
  return fds.every((fd) => {
    try {
      if (info.isatty(fd)) return false;
      const st = info.fstat(fd);
      return !st.isFIFO() && !st.isSocket();
    } catch {
      return false;
    }
  });
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

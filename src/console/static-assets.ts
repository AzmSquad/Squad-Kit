import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../core/paths.js';

/** Passed by `@hono/node-server` as `c.env` (second argument to `app.fetch`). */
type NodeServerEnv = { incoming?: IncomingMessage };

function pathnameForStatic(c: Context): string {
  const rawUrl = (c.env as NodeServerEnv).incoming?.url;
  if (typeof rawUrl === 'string' && rawUrl.startsWith('/')) {
    const pathOnly = rawUrl.split('?', 1)[0] ?? rawUrl;
    try {
      return decodeURIComponent(pathOnly);
    } catch {
      return pathOnly;
    }
  }
  try {
    return decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return new URL(c.req.url).pathname;
  }
}

export interface MountStaticOptions {
  paths: SquadPaths;
}

export function mountStaticAssets(app: Hono, _opts: MountStaticOptions): void {
  const distDir = resolveConsoleUiDist();

  app.get('/logo.svg', (c) => serveFile(c, distDir, 'logo.svg', 'image/svg+xml'));
  app.get('/favicon.ico', (c) => serveFile(c, distDir, 'favicon.ico', 'image/x-icon'));

  app.get('*', (c) => {
    const pathname = pathnameForStatic(c);

    if (pathname.startsWith('/assets/')) {
      return assetResponse(c, distDir, pathname);
    }

    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/healthz')) return c.notFound();
    if (!distDir) return c.text('UI not built. Run `pnpm -C console-ui build`.', 404);
    const indexHtml = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexHtml)) return c.text('UI not built', 404);
    return c.html(fs.readFileSync(indexHtml, 'utf8'), 200, { 'cache-control': 'no-store' });
  });
}

function assetResponse(c: Context, distDir: string | null, pathname: string): Response {
  if (!distDir) return c.text('UI not built', 404);
  const rel = pathname.replace(/^\//, '');
  const abs = path.normalize(path.join(distDir, rel));
  if (!isInside(abs, distDir)) return c.text('forbidden', 403);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return c.text('not found', 404);
  const body = Readable.toWeb(fs.createReadStream(abs)) as ReadableStream;
  return new Response(body, {
    headers: {
      'content-type': contentTypeFor(abs),
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

function serveFile(c: Context, distDir: string | null, name: string, ct: string) {
  if (!distDir) return c.text('UI not built', 404);
  const abs = path.join(distDir, name);
  if (!fs.existsSync(abs)) return c.text('not found', 404);
  return new Response(fs.readFileSync(abs), {
    headers: { 'content-type': ct, 'cache-control': 'public, max-age=86400' },
  });
}

function contentTypeFor(p: string): string {
  if (p.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.woff2')) return 'font/woff2';
  if (p.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function isInside(abs: string, parent: string): boolean {
  const a = path.resolve(abs) + path.sep;
  const p = path.resolve(parent) + path.sep;
  return a.startsWith(p);
}

function resolveConsoleUiDist(): string | null {
  const fromEnv = process.env.SQUAD_CONSOLE_UI_DIST;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'index.html'))) return fromEnv;

  // `import.meta.url` is either dist/cli.js (published bundle) or src/console/static-assets.ts (tsx dev).
  const candidates = [
    fileURLToPath(new URL('./console-ui/', import.meta.url)), // dist/cli.js → dist/console-ui/
    fileURLToPath(new URL('../../dist/console-ui/', import.meta.url)), // src/console/*.ts → project/dist/console-ui/
    fileURLToPath(new URL('../console-ui/dist/', import.meta.url)), // dist/cli.js → project/console-ui/dist
    fileURLToPath(new URL('../../console-ui/dist/', import.meta.url)), // src/console/*.ts → project/console-ui/dist
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

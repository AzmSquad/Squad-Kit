import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * The board answers only at this computer's own address, and takes changes only from its own pages. A page on another
 * site, or on another local port (the project's own app), sends its Origin and is refused, even with the token. Real
 * server, raw requests: a browser's own rules are not what is being checked here.
 */

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const actions = await import('../src/board/actions.js');
await import('../src/engine/live.js');
const { buildPaths } = await import('../src/core/paths.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { startConsoleServer } = await import('../src/console/server.js');
const { KEEP_IDLE_MS, closeServer } = await import('../src/engine/window-server.js');

const TOKEN = 'a'.repeat(64);
let tmp: string;
let bp: ReturnType<typeof boardPaths>;
let server: Awaited<ReturnType<typeof startConsoleServer>>;
let id: string;

function call(method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((done, fail) => {
    const r = http.request({ host: '127.0.0.1', port: server.port, method, path: p, headers: { ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body: s }));
    });
    r.on('error', fail);
    if (body) r.write(body);
    r.end();
  });
}

const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const own = () => `127.0.0.1:${server.port}`;
function theirs(owner = 'Somebody Else') {
  const t = actions.createTicket(bp, { title: 'Theirs' });
  updateTicket(bp, t.id, (x) => {
    x.owner = owner;
    x.squad = null;
    x.live = false;
    x.waiting = null;
  });
  return t.id;
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-address-')));
  const project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  execSync('git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m start', { cwd: project });
  setupProject(project);
  bp = ensureLiveBoard(boardPaths(path.join(project, '.squad')), 'App').bp;
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false }, runner: 'direct' });
  server = await startConsoleServer({ paths: buildPaths(project), requestedPort: 0, token: TOKEN });
  id = bp.projectId;
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('any other address', () => {
  it('a browser gets a short plain page, not raw data; anything else keeps the plain refusal', async () => {
    const page = await call('GET', '/', { host: 'evil.example.com', accept: 'text/html,application/xhtml+xml' });
    expect(page.status).toBe(403);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain("This is not squad-kit's own address");
    expect(page.body).not.toContain('forbidden');
    const other = await call('GET', '/', { host: 'evil.example.com' });
    expect(other.status).toBe(403);
    expect(JSON.parse(other.body)).toMatchObject({ error: 'forbidden' });
  });
});

describe('the token', () => {
  it('in the address is for reads only: a write with ?t= is refused, as text/plain from a page or not', async () => {
    const t = theirs();
    const body = JSON.stringify({ reason: 'from another site' });
    const res = await call('POST', `/p/${id}/api/v1/tickets/${t}/take-back?t=${TOKEN}`, { 'content-type': 'text/plain' }, body);
    expect(res.status).toBe(401);
    expect(readTicket(bp, t)?.owner).toBe('Somebody Else');
    // The old address too.
    expect((await call('POST', `/api/v1/tickets/${t}/take-back?t=${TOKEN}`, { 'content-type': 'text/plain' }, body)).status).toBe(401);
    expect((await call('PUT', `/api/v1/settings?t=${TOKEN}`, { 'content-type': 'text/plain' }, '{}')).status).toBe(401);
    expect(readTicket(bp, t)?.owner).toBe('Somebody Else');
  });

  it('still opens reads from a link, as pictures and the event stream need', async () => {
    expect((await call('GET', `/p/${id}/api/v1/board?t=${TOKEN}`)).status).toBe(200);
    expect((await call('GET', `/p/${id}/api/v1/board`)).status).toBe(401);
  });
});

describe('the Host', () => {
  it("answers only at this computer's own names and the board's own port, on every route", async () => {
    for (const host of ['evil.example', `evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`, '127.0.0.1', `localhost.evil.example:${server.port}`]) {
      for (const p of ['/', '/healthz', '/api/v1/app/projects', `/p/${id}/api/v1/board?t=${TOKEN}`, `/p/${id}/board`, '/mcp']) {
        const res = await call('GET', p, { host, authorization: `Bearer ${TOKEN}` });
        expect([host, p, res.status]).toEqual([host, p, 403]);
      }
    }
    expect((await call('GET', '/healthz', { host: own() })).status).toBe(200);
    expect((await call('GET', '/healthz', { host: `localhost:${server.port}` })).status).toBe(200);
    expect((await call('GET', '/healthz', { host: `[::1]:${server.port}` })).status).toBe(200);
    expect((await call('GET', '/', { host: own() })).status).not.toBe(403);
  });
});

describe('the Origin', () => {
  it('a write from a page that is not the board is refused, with the token and all', async () => {
    for (const origin of ['http://evil.example', `http://127.0.0.1:${server.port + 1}`, 'http://localhost:3000', 'null', `https://127.0.0.1:${server.port}`]) {
      const t = theirs();
      const res = await call('POST', `/p/${id}/api/v1/tickets/${t}/take-back`, { ...bearer, origin }, JSON.stringify({ reason: 'x' }));
      expect([origin, res.status]).toEqual([origin, 403]);
      expect(readTicket(bp, t)?.owner).toBe('Somebody Else');
    }
  });

  it("the board's own pages write, at either of its names", async () => {
    for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`]) {
      const t = theirs();
      const res = await call('POST', `/p/${id}/api/v1/tickets/${t}/take-back`, { ...bearer, origin }, JSON.stringify({ reason: 'mine now' }));
      expect([origin, res.status]).toEqual([origin, 200]);
    }
  });

  it('no Origin is no web page: the terminal goes on working, with its token', async () => {
    const t = theirs();
    const res = await fetch(`http://127.0.0.1:${server.port}/p/${id}/api/v1/tickets/${t}/take-back`, { method: 'POST', headers: bearer, body: JSON.stringify({ reason: 'from the terminal' }) });
    expect(res.status).toBe(200);
    expect(readTicket(bp, t)?.owner).toBe(readMeta(bp).user.name);
    expect((await call('POST', `/p/${id}/api/v1/tickets/${theirs()}/take-back`, { 'content-type': 'application/json' }, JSON.stringify({ reason: 'x' }))).status).toBe(401);
  });

  it("an agent's window (the bridge) posts with no Origin, past this gate to its own key check", async () => {
    const res = await call('POST', '/mcp', { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer not-a-run-key' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    expect(res.status).not.toBe(403);
  });

  it('a read from another page gets no way to see the answer', async () => {
    const res = await call('GET', `/p/${id}/api/v1/board`, { ...bearer, origin: 'http://evil.example' });
    expect(res.headers['access-control-allow-origin']).not.toBe('http://evil.example');
  });
});

describe('a connection left idle', () => {
  it('stays open through the time an agent thinks between two calls', async () => {
    const res = await call('GET', '/healthz');
    expect(res.headers['keep-alive']).toBe('timeout=120');
  });

  it('does not hold up closing, even when its last answer was still going out', async () => {
    let going: http.ServerResponse | undefined;
    const srv = http.createServer((q, r) => {
      r.writeHead(200);
      r.write('x');
      going = r;
    });
    srv.keepAliveTimeout = KEEP_IDLE_MS;
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const agent = new http.Agent({ keepAlive: true });
    const closed = new Promise<void>((done, fail) => {
      http.get({ host: '127.0.0.1', port: (srv.address() as { port: number }).port, agent }, (res) => {
        // It closes while the answer is on its way: the connection is not idle yet.
        closeServer(srv, (err) => (err ? fail(err) : done()));
        res.resume();
        going!.end();
      }).on('error', fail);
    });
    // Far less than the time a connection may stay idle: this test's own limit is the check.
    await closed;
    agent.destroy();
  });
});

describe("project content at the board's own address", () => {
  it('a mockup is sealed: its scripts run with no origin, so they never reach the stored token', async () => {
    const res = await call('GET', '/mockup/none?path=x&k=y');
    expect(res.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(res.headers['content-security-policy']).not.toContain('allow-same-origin');
  });

  it('a ticket file that can carry scripts downloads, and nothing it holds runs', async () => {
    const t = actions.createTicket(bp, { title: 'With files' });
    const folder = path.join(bp.proofDir);
    fs.mkdirSync(folder, { recursive: true });
    const html = path.join(folder, 'x.html');
    const svg = path.join(folder, 'x.svg');
    fs.writeFileSync(html, '<script>1</script>');
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    for (const file of [html, svg]) {
      const res = await call('GET', `/p/${id}/api/v1/tickets/${t.id}/file?path=${encodeURIComponent(file)}`, bearer);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment/);
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});

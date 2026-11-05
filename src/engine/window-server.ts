import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { RunWindow } from '../modules/ai-tool/types.js';
import { readInstalledPackage } from '../core/package-info.js';
import type { AgentWindow } from './window.js';

/**
 * The window's door: MCP over HTTP (JSON-RPC in a POST, one JSON answer back), served by the board on 127.0.0.1 at
 * /mcp. Each agent run has its own key, good for that run only and tied to its ticket and step; when the run ends
 * the key goes. The key only reaches what the window offers: its few tools and their checks, never the board's API.
 * Without a board in this process (the terminal, tests), squad-kit serves the same door on a port of its own.
 */

/** The name the agent sees the tools under. */
export const WINDOW_NAME = 'squad';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;

/**
 * How long a connection may sit idle before this side closes it. An agent thinks between its calls, and at Node's own 5
 * seconds its next call often went out just as the connection closed: "read ECONNRESET", and a tool call that failed
 * for nothing, more often the busier the computer was. A client that keeps connections goes by this number and closes
 * first, so nobody is caught in the middle.
 */
export const KEEP_IDLE_MS = 120_000;

const windows = new Map<string, AgentWindow>();
let board: string | null = null;
let own: Promise<string> | null = null;
let ownServer: http.Server | null = null;

/** The board answers at this address now (null: it closed). */
export function windowAt(base: string | null): void {
  board = base ? base.replace(/\/$/, '') : null;
}

/** A run's window, open for calls with its key. */
export function openWindow(w: AgentWindow): void {
  windows.set(w.key, w);
}

/** The run ended: its key stops working at once, and what it started stops. */
export async function closeWindow(w: AgentWindow): Promise<void> {
  windows.delete(w.key);
  await w.close();
}

/** The windows open now, for tests. */
export function openWindows(): number {
  return windows.size;
}

/** The built CLI, which runs the stdio bridge: this file itself once bundled, else the package's dist/cli.js. */
export function cliEntry(): string {
  const here = fileURLToPath(import.meta.url);
  if (/[\\/]cli\.js$/.test(here)) return here;
  return path.resolve(path.dirname(here), '../../dist/cli.js');
}

/** What a run's agent needs to reach its window: the address, the key, the tools, and the bridge for stdio. */
export async function windowAccess(w: AgentWindow): Promise<RunWindow> {
  const base = board ?? (await ownBase());
  return { name: WINDOW_NAME, url: `${base}/mcp`, key: w.key, tools: [...w.tools], bridge: { command: process.execPath, args: [cliEntry(), 'mcp-bridge'] } };
}

/** squad-kit's own door on a free port of this computer, when no board serves it. Started once. */
function ownBase(): Promise<string> {
  own ??= new Promise<string>((resolve, reject) => {
    const srv = http.createServer((req, res) => void serveNode(req, res));
    srv.keepAliveTimeout = KEEP_IDLE_MS;
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.unref();
      ownServer = srv;
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
  return own;
}

/**
 * Closes a server with connections kept open (KEEP_IDLE_MS). What is idle goes at once. An answer still going out when
 * it closes leaves its connection idle right after, and that goes then too, or closing would wait out all that time.
 */
export function closeServer(s: http.Server, done: (err?: Error) => void): void {
  const sweep = setInterval(() => s.closeIdleConnections(), 100);
  s.close((err) => {
    clearInterval(sweep);
    done(err);
  });
}

/** Closes squad-kit's own door, for tests. */
export async function closeOwnDoor(): Promise<void> {
  const s = ownServer;
  own = null;
  ownServer = null;
  if (s) await new Promise<void>((r) => closeServer(s, () => r()));
}

async function serveNode(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) break;
    chunks.push(c as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`;
  const r = await answerWindow(new Request(url, { method: req.method ?? 'GET', headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }));
  res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
  res.end(Buffer.from(await r.arrayBuffer()));
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rpcError = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** The run a request's key opens, or null. Keys are compared in constant time. */
function windowOf(req: Request): AgentWindow | null {
  const auth = req.headers.get('authorization') ?? '';
  const key = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!key) return null;
  const given = Buffer.from(key);
  for (const [k, w] of windows) {
    const known = Buffer.from(k);
    if (given.length === known.length && timingSafeEqual(given, known)) return w;
  }
  return null;
}

/**
 * One request to the window, as the board's route and squad-kit's own door pass it. Only a POST from a program on
 * this computer (no browser page: no Origin) to a loopback address, with the key of a run that is still going.
 */
export async function answerWindow(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  if (req.headers.get('origin')) return json(rpcError(null, -32000, 'squad-kit takes these calls only from programs on this computer.'), 403);
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return json(rpcError(null, -32000, 'squad-kit takes these calls only on this computer.'), 403);
  const w = windowOf(req);
  if (!w || w.isClosed) return json(rpcError(null, -32001, 'squad-kit does not know this key, or its run has ended.'), 401);
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_BODY) return json(rpcError(null, -32600, 'The request is too large.'), 413);
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(rpcError(null, -32600, 'The request is too large.'), 413);
    body = JSON.parse(raw);
  } catch {
    return json(rpcError(null, -32700, 'The request is not JSON.'), 400);
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as Rpc[];
  if (!messages.length || messages.length > 20) return json(rpcError(null, -32600, 'Send one message, or a few.'), 400);
  const answers: unknown[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      answers.push(rpcError(null, -32600, 'Not a JSON-RPC message.'));
      continue;
    }
    // A notification (initialized, cancelled) or an answer from the client: nothing to answer.
    if (m.id === undefined || m.id === null || !m.method) continue;
    answers.push(await dispatch(w, m));
  }
  if (!answers.length) return new Response(null, { status: 202 });
  return json(batch ? answers : answers[0]);
}

async function dispatch(w: AgentWindow, m: Rpc): Promise<unknown> {
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize': {
      const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      return {
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'squad-kit', version: readInstalledPackage().version },
          instructions: "squad-kit's own tools for this step. squad-kit checks every field and does the work itself, on this story's own app on this computer.",
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: m.id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: m.id, result: { tools: w.listTools() } };
    case 'tools/call': {
      const name = typeof p.name === 'string' ? p.name : '';
      const result = await w.call(name, p.arguments ?? {});
      return { jsonrpc: '2.0', id: m.id, result };
    }
    default:
      return rpcError(m.id, -32601, `squad-kit does not offer ${String(m.method).slice(0, 60)}.`);
  }
}

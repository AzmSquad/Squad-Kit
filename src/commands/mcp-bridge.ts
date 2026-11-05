import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * `squad mcp-bridge`: the window for an agent that takes MCP only over stdio. Its AI tool starts this command; each
 * JSON-RPC line it writes goes to the board's window at SQUAD_WINDOW_URL with the run's key (SQUAD_WINDOW_KEY), and
 * each answer comes back as one line. The bridge adds nothing: the board checks every call, as it does over HTTP.
 * It ends when its input closes.
 */

export interface BridgeOptions {
  url: string;
  key: string;
  input: Readable;
  output: Writable;
  fetch?: typeof fetch;
}

type Message = { id?: string | number | null; method?: string };

/** Forwards every line until the input closes. */
export async function runBridge(o: BridgeOptions): Promise<void> {
  const send = o.fetch ?? fetch;
  const write = (msg: unknown) => o.output.write(`${JSON.stringify(msg)}\n`);
  const going = new Set<Promise<void>>();
  const lines = createInterface({ input: o.input, crlfDelay: Infinity });
  for await (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    let msg: Message | Message[];
    try {
      msg = JSON.parse(text) as Message | Message[];
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'The message is not JSON.' } });
      continue;
    }
    const ids = (Array.isArray(msg) ? msg : [msg]).filter((m) => m && m.method && m.id !== undefined && m.id !== null).map((m) => m.id);
    const job = (async () => {
      try {
        const res = await send(o.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${o.key}` },
          body: text,
        });
        if (res.status === 202) return;
        const body = await res.text();
        if (!body.trim()) return;
        // An answer is passed on as it came, on one line.
        write(JSON.parse(body));
      } catch (err) {
        for (const id of ids) write({ jsonrpc: '2.0', id, error: { code: -32000, message: `squad-kit's board did not answer: ${(err as Error).message}` } });
      }
    })();
    going.add(job);
    void job.finally(() => going.delete(job));
  }
  await Promise.all(going);
}

/** The command itself: the address and the key come from the environment the AI tool starts it with. */
export async function runMcpBridge(): Promise<void> {
  const url = process.env.SQUAD_WINDOW_URL?.trim();
  const key = process.env.SQUAD_WINDOW_KEY?.trim();
  if (!url || !key) {
    process.stderr.write('squad mcp-bridge is started by squad-kit for an agent run; it needs SQUAD_WINDOW_URL and SQUAD_WINDOW_KEY.\n');
    process.exitCode = 1;
    return;
  }
  await runBridge({ url, key, input: process.stdin, output: process.stdout });
}

import type { RunWindow } from '../../src/modules/ai-tool/types.js';

/**
 * A fake agent pressing one of squad-kit's own tools, over the real MCP transport: a JSON-RPC POST to the run's
 * window with the run's key, as Claude Code sends it.
 */

export interface ToolAnswer {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
}

let next = 1;

/** One JSON-RPC call to a window: the HTTP status and the JSON body. */
export async function rpc(w: Pick<RunWindow, 'url' | 'key'>, method: string, params: unknown = {}, key = w.key): Promise<{ status: number; body: any }> {
  const res = await fetch(w.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A tool call, as the agent sees its answer. */
export async function callTool(w: Pick<RunWindow, 'url' | 'key'>, name: string, args: unknown = {}): Promise<ToolAnswer> {
  const r = await rpc(w, 'tools/call', { name, arguments: args });
  if (!r.body?.result) throw new Error(`The window did not answer the call: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.result as ToolAnswer;
}

/** The words of a tool's answer, without its pictures. */
export function textOf(a: ToolAnswer): string {
  return a.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('\n');
}

/** The file names a take_screenshots answer saved, in order. */
export function savedFiles(a: ToolAnswer): string[] {
  return [...textOf(a).matchAll(/saved as (\S+\.png)/g)].map((m) => m[1]!);
}

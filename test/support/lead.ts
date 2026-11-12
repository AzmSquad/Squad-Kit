import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions } from '../../src/modules/claude/direct.js';

/**
 * What the Squad lead's tests share: a live sample board in a temp folder, a good answer to start from, and the
 * fake agent's way to press a tool in the lead's window, over the window's real MCP door with the run's own key.
 */

export async function leadBoard(prefix = 'squad-lead-'): Promise<{ tmp: string; bp: ReturnType<typeof import('../../src/board/store.js')['boardPaths']> }> {
  const { boardPaths, readMeta, writeMeta } = await import('../../src/board/store.js');
  const { seedDemoBoard } = await import('../../src/board/demo.js');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });
  return { tmp, bp };
}

/** A complete answer; a test changes what it needs. */
export function goodAnswer(more: Record<string, unknown> = {}): Record<string, unknown> {
  return { headline: 'Search finds a case by its number.', body: 'Type the number in the search box.', evidence: [], sources: [], cards: [], ...more };
}

/** The fake agent presses one of the window's tools, as an MCP client would. */
export async function pressTool(opts: RunOptions, name: string, args: Record<string, unknown> = {}): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> {
  const w = opts.window!;
  const res = await fetch(w.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${w.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return ((await res.json()) as { result: { content: { type: string; text?: string }[]; isError?: boolean } }).result;
}

/** The text of a tool's answer. */
export function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

import fs from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { readTicket, type BoardPaths } from '../../board/store.js';
import { allowedFile, ticketFolders } from '../../engine/conversations.js';
import { timingSafeEqualHex } from '../auth.js';

/** Signs mockup links for this run of the board only. */
const MOCKUP_SECRET = randomBytes(32);

function mockupKey(id: string, file: string): string {
  return createHmac('sha256', MOCKUP_SECRET).update(`${id}\0${file}`).digest('hex');
}

/** An HTML file inside the ticket's own folders, at most 5 MB, or null. */
function mockupFile(bp: BoardPaths, id: string, asked: string): string | null {
  const t = readTicket(bp, id);
  if (!t || !/\.html?$/i.test(asked)) return null;
  const file = allowedFile(asked.replace(/^file:\/\//, ''), ticketFolders(t, bp));
  return file && fs.statSync(file).size <= 5 * 1024 * 1024 ? file : null;
}

/**
 * Added at the end of every mockup page: Esc pressed inside it closes the board's viewer (components/MockupViewer.tsx).
 * The page stays sealed, so it can only tell the frame around it, with no words of its own; the viewer listens to that
 * one frame. A mockup that uses Esc itself (it calls preventDefault) keeps it.
 */
export const MOCKUP_ESCAPE = `<script>addEventListener('keydown',function(e){if(e.key==='Escape'&&!e.defaultPrevented)parent.postMessage({squadKit:'mockup-escape'},'*')})</script>`;

/**
 * An HTML mockup an agent made, shown in a sandboxed frame. The frame gets a key for that one file, never the board's
 * token, because the mockup's own scripts can read their address.
 */
export function mountMockupApi(app: Hono, bp: BoardPaths): void {
  app.get('/api/v1/tickets/:id/mockup-link', (c) => {
    const id = c.req.param('id');
    const file = mockupFile(bp, id, c.req.query('path') ?? '');
    if (!file) return c.json({ error: 'not found' }, 404);
    return c.json({ url: `/mockup/${encodeURIComponent(id)}?path=${encodeURIComponent(file)}&k=${mockupKey(id, file)}` });
  });

  // Outside /api, so no token: the key proves the board handed out this link. Sent with its own sealed policy.
  app.get('/mockup/:id', (c) => {
    const id = c.req.param('id');
    const file = mockupFile(bp, id, c.req.query('path') ?? '');
    const k = c.req.query('k') ?? '';
    if (!file || !timingSafeEqualHex(k, mockupKey(id, file))) return c.text('not found', 404);
    return new Response(Buffer.concat([fs.readFileSync(file), Buffer.from(`\n${MOCKUP_ESCAPE}\n`)]), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' } });
  });
}

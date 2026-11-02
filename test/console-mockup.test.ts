import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { buildPaths } from '../src/core/paths.js';
import { startConsoleServer, type ConsoleServer } from '../src/console/server.js';
import { boardPaths, updateTicket } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';

// Never spawn a real Claude login probe from a test (see console-server.test.ts).
vi.mock('../src/planner/runtimes/auth-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/planner/runtimes/auth-probe.js')>()),
  probeClaudeAuth: async () => ({ ok: true }),
}));

let server: ConsoleServer;
let base: string;
let mockup: string;
const TOKEN = 'c'.repeat(64);
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'squad-mockup-'));
  const paths = buildPaths(root);
  await mkdir(paths.squadDir, { recursive: true });
  await writeFile(paths.configFile, yaml.dump({ version: 1, project: { name: 'mockup-test', primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }), 'utf8');
  const bp = boardPaths(paths.squadDir);
  seedDemoBoard(bp, { speed: 0.001 });
  const dir = path.join(bp.ticketsDir, 'SK-148');
  fs.mkdirSync(dir, { recursive: true });
  mockup = path.join(dir, 'mockup.html');
  fs.writeFileSync(mockup, '<button onclick="document.body.className=\'dark\'">Dark</button>');
  updateTicket(bp, 'SK-148', (t) => (t.mockup = mockup));
  server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe('agent mockups', () => {
  it('hands out a signed link without the board token, served under a sealed policy', async () => {
    const link = await fetch(`${base}/api/v1/tickets/SK-148/mockup-link?path=${encodeURIComponent(mockup)}`, auth);
    expect(link.status).toBe(200);
    const { url } = (await link.json()) as { url: string };
    expect(url).toMatch(/^\/mockup\/SK-148\?path=.+&k=[0-9a-f]{64}$/);
    expect(url).not.toContain(TOKEN);

    const page = await fetch(base + url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<button');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('allow-same-origin');
  });

  it('refuses a wrong key, a file outside the ticket, and a link without the token', async () => {
    expect((await fetch(`${base}/mockup/SK-148?path=${encodeURIComponent(mockup)}&k=${'0'.repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/tickets/SK-148/mockup-link?path=${encodeURIComponent('/etc/hosts.html')}`, auth)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/tickets/SK-148/mockup-link?path=${encodeURIComponent(mockup)}`)).status).toBe(401);
  });

  it('keeps the strict policy on the board itself', async () => {
    const res = await fetch(`${base}/api/v1/board`, auth);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it("lets a ticket's PDF open beside the chat, framed by the board only", async () => {
    const pdf = path.join(path.dirname(mockup), 'rules.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
    const res = await fetch(`${base}/api/v1/tickets/SK-148/file?path=${encodeURIComponent(pdf)}`, auth);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("script-src 'self'");
    const png = path.join(path.dirname(mockup), 'shot.png');
    fs.writeFileSync(png, 'png');
    const pic = await fetch(`${base}/api/v1/tickets/SK-148/file?path=${encodeURIComponent(png)}`, auth);
    expect(pic.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

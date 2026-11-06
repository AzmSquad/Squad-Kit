import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { callTool, rpc, textOf } from './support/window.js';
import { tinyWorkbook } from './support/xlsx.js';

/**
 * Proof for what no page shows: the Tester asks the product's API through squad-kit, which reaches only the product's own
 * addresses, and saves the call as it happened. The saved file then goes through the proof like a picture.
 */

vi.mock('../src/modules/claude/direct.js', async (orig) => ({ ...(await orig<typeof import('../src/modules/claude/direct.js')>()) }));

const { AgentWindow, ALL_TOOLS, MAX_API_CALLS, toolsFor } = await import('../src/engine/window.js');
const { openWindow, closeWindow, windowAccess } = await import('../src/engine/window-server.js');
const { isApiProof, addPictures } = await import('../src/engine/proof-verdict.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
let proof: string;
let server: http.Server;
let other: http.Server;
let base: string;
let otherBase: string;
const lines: string[] = [];
const seen: { method?: string; url?: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
const opened: InstanceType<typeof AgentWindow>[] = [];
let otherHits = 0;

const big = 'x'.repeat(150 * 1024);
const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, () => r(`http://localhost:${(s.address() as AddressInfo).port}`)));

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-api-proof-')));
  proof = path.join(tmp, 'proof');
  fs.mkdirSync(proof);
  lines.length = 0;
  seen.length = 0;
  otherHits = 0;
  server = http.createServer((q, s) => {
    let body = '';
    q.on('data', (d) => (body += d));
    q.on('end', () => {
      seen.push({ method: q.method!, url: q.url!, body, headers: q.headers });
      if (q.url === '/price') return s.setHeader('content-type', 'application/json').end('{"cents":200,"sale":150}');
      if (q.url === '/big') return s.setHeader('content-type', 'text/plain').end(big);
      if (q.url === '/workbook') return s.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').end(tinyWorkbook([['Totals', [['Judgments', 'First'], ['1', '2']]]]));
      if (q.url === '/report') return s.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').end(Buffer.from([0x50, 0x4b, 3, 4, 0, 255]));
      if (q.url === '/away') return s.writeHead(302, { location: otherBase }).end();
      if (q.url === '/broken') return s.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
      s.setHeader('content-type', 'text/plain').end(`${q.method} ${q.url} ${body}`);
    });
  });
  other = http.createServer((_q, s) => {
    otherHits += 1;
    s.end('secret');
  });
  base = await listen(server);
  otherBase = await listen(other);
});

afterEach(async () => {
  for (const w of opened.splice(0)) await closeWindow(w);
  await Promise.all([server, other].map((s) => new Promise((r) => s.close(r))));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A Tester's window whose app is already running, as the proof hands it over. */
async function tester(more: Record<string, unknown> = {}) {
  const w = new AgentWindow({
    ticket: 'AP-1',
    step: 'proof',
    who: 'Tester',
    tools: [...ALL_TOOLS, 'ask_api'],
    app: { cwd: tmp, start: 'true', url: base },
    running: { url: base, stop: () => undefined, ended: () => false },
    api: () => ({ api: { name: 'API', url: `${base}/price` } }),
    proofDir: proof,
    prefix: 'ap-1-after',
    say: (t: string) => lines.push(t),
    ...more,
  } as never);
  openWindow(w);
  opened.push(w);
  return { w, access: await windowAccess(w) };
}

const record = (file: string) => JSON.parse(fs.readFileSync(path.join(proof, file), 'utf8'));

describe('asking', () => {
  it('asks the part, and saves what was asked and answered, as a file the Tester can hand in', async () => {
    const { w, access } = await tester();
    const a = await callTool(access, 'ask_api', { part: 'api', path: '/price' });
    expect(textOf(a)).toContain('API answered 200');
    expect(textOf(a)).toContain('"sale":150');
    expect(textOf(a)).toContain('Saved as ap-1-after-api-1.api.json');
    expect(record('ap-1-after-api-1.api.json')).toMatchObject({ part: 'API', method: 'GET', path: '/price', status: 200, answer: '{"cents":200,"sale":150}' });
    // It counts as taken in this step, and the list says what it is.
    expect(w.pictures.has('ap-1-after-api-1.api.json')).toBe(true);
    expect(w.pictureList()).toContain('the saved answer to GET /price on API');
    expect(lines).toContain('squad-kit asked API for the Tester: GET /price answered 200');
  });

  it('sends a body and headers, and keeps a query', async () => {
    const { access } = await tester();
    await callTool(access, 'ask_api', { part: 'api', method: 'post', path: '/orders?x=1', body: { item: 3 }, headers: { 'x-user-email': 'a@b.c' } });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/orders?x=1', body: '{"item":3}' });
    expect(seen[0]!.headers['x-user-email']).toBe('a@b.c');
    expect(seen[0]!.headers['content-type']).toBe('application/json');
  });

  it('a bad answer is an answer too: saved as it is', async () => {
    const { access } = await tester();
    expect(textOf(await callTool(access, 'ask_api', { part: 'api', path: '/broken' }))).toContain('API answered 500');
    expect(record('ap-1-after-api-1.api.json')).toMatchObject({ status: 500, answer: '{"error":"boom"}' });
  });

  it('keeps only so much of a long answer, and says so', async () => {
    const { access } = await tester();
    const a = await callTool(access, 'ask_api', { part: 'api', path: '/big' });
    expect(textOf(a).length).toBeLessThan(9000);
    const r = record('ap-1-after-api-1.api.json');
    expect(r.cut).toBe(true);
    expect(r.answer.length).toBe(100 * 1024);
  });

  it('saves a file answer whole, for the person to open, and never as text', async () => {
    const { access } = await tester();
    const a = await callTool(access, 'ask_api', { part: 'api', path: '/report' });
    expect(textOf(a)).toContain('A file of 6 bytes');
    const r = record('ap-1-after-api-1.api.json');
    expect(r.file).toBe('ap-1-after-api-1-answer.xlsx');
    expect(r.answer).toBeUndefined();
    expect(fs.readFileSync(path.join(proof, r.file)).length).toBe(6);
    expect(r.sheets).toBeUndefined();
  });

  it('an Excel answer also says what it holds, so the Tester and the check can read the numbers', async () => {
    const { access } = await tester();
    const a = await callTool(access, 'ask_api', { part: 'api', path: '/workbook' });
    expect(textOf(a)).toContain('Sheet "Totals", 2 rows');
    expect(textOf(a)).toContain('Judgments | First');
    expect(textOf(a)).toContain('1 | 2');
    const r = record('ap-1-after-api-1.api.json');
    expect(r.file).toBe('ap-1-after-api-1-answer.xlsx');
    expect(r.sheets).toEqual([{ name: 'Totals', rows: [['Judgments', 'First'], ['1', '2']], total: 2 }]);
  });
});

describe('it reaches nothing else', () => {
  it.each([['full address', () => otherBase], ['no leading slash', () => 'price'], ['another host with //', () => `//localhost:${new URL(otherBase).port}/`], ['a backslash way out', () => `/\\/localhost:${new URL(otherBase).port}/`]])('refuses %s', async (_n, p) => {
    const { access } = await tester();
    const a = await callTool(access, 'ask_api', { part: 'api', path: p() });
    expect(otherHits).toBe(0);
    expect(a.isError).toBe(true);
    expect(textOf(a)).toContain('squad-kit refused');
    expect(fs.readdirSync(proof)).toEqual([]);
  });

  it('has no field for a host or a command', async () => {
    const { access } = await tester();
    for (const extra of [{ url: otherBase }, { host: 'evil' }, { command: 'rm -rf /' }]) {
      const a = await callTool(access, 'ask_api', { part: 'api', path: '/price', ...extra });
      expect(a.isError).toBe(true);
      expect(textOf(a)).toContain('squad-kit refused');
    }
    expect(seen).toEqual([]);
  });

  it('never follows a redirect off its address', async () => {
    const { access } = await tester();
    const a = await callTool(access, 'ask_api', { part: 'api', path: '/away' });
    expect(textOf(a)).toContain('API answered 302');
    expect(otherHits).toBe(0);
  });

  it('a part not in the product, a method not on the list, a header that would change where it goes', async () => {
    const { access } = await tester();
    expect(textOf(await callTool(access, 'ask_api', { part: 'nope', path: '/price' }))).toContain('this product has no part "nope"');
    expect(textOf(await callTool(access, 'ask_api', { part: 'api', method: 'TRACE', path: '/price' }))).toContain('method is one of');
    expect(textOf(await callTool(access, 'ask_api', { part: 'api', path: '/price', headers: { Host: 'evil' } }))).toContain('cannot be sent');
    expect(seen).toEqual([]);
  });

  it(`stops at ${MAX_API_CALLS} calls in a step`, async () => {
    const { w, access } = await tester();
    (w as unknown as { apiCalls: number }).apiCalls = MAX_API_CALLS;
    expect(textOf(await callTool(access, 'ask_api', { part: 'api', path: '/price' }))).toContain(`this step has made its ${MAX_API_CALLS} calls`);
    expect(seen).toEqual([]);
  });

  it('only the Tester has it', async () => {
    expect(toolsFor({ app: true })).not.toContain('ask_api');
    expect(ALL_TOOLS).not.toContain('ask_api');
    const { access } = await tester({ tools: ALL_TOOLS });
    const list = await rpc(access, 'tools/list');
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).not.toContain('ask_api');
  });
});

describe('in the proof', () => {
  it('goes through like a picture, and is known for what it is', () => {
    expect(isApiProof('ap-1-after-api-1.api.json')).toBe(true);
    expect(isApiProof('ap-1-after-1.png')).toBe(false);
    const row = { criterion: 'x', before: '', after: '', beforeLabel: 'Before', afterLabel: 'After' };
    addPictures(row as never, [{ file: 'a.api.json', page: '', note: 'Asked for the price. It answered 150.' }] as never);
    expect(row.after).toBe('a.api.json');
  });

  it('tells the Tester when to ask, and a picture comes first', () => {
    const meta = { project: 'x', map: [], lessons: [] } as never;
    const t = { id: 'AP-1', title: 'x', ask: 'x', criteria: [{ given: 'a', when: 'b', then: 'c' }], activity: [] } as never;
    const prompt = P.proofPrompt(meta, t, 'after', undefined, 'http://localhost:1', {}, ['api', 'web']);
    expect(prompt).toContain('ask_api with part (api, web)');
    expect(prompt).toContain('a picture comes first');
    expect(prompt).toContain('never offScreen');
    expect(P.proofPrompt(meta, t, 'after', undefined, 'http://localhost:1')).not.toContain('ask_api');
  });

  it("tells squad-kit's own check to judge by the answer, not the Tester's words", () => {
    const t = { id: 'AP-1', title: 'x', ask: 'x', criteria: [{ given: 'a', when: 'b', then: 'c' }], activity: [] } as never;
    const prompt = P.proofCheckPrompt(t, [{ criterion: 1, file: 'a.api.json', note: 'It works', size: 'answer' }] as never);
    expect(prompt).toContain('judge by what was answered, not by what the Tester says');
  });
});

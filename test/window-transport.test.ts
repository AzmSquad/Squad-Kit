import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { RunWindow } from '../src/modules/ai-tool/types.js';

/**
 * How an agent reaches its window: over ACP, MCP over HTTP when the agent takes it, else squad-kit's stdio bridge; in
 * the direct `claude -p` fallback, --mcp-config. The agents here are small fakes in their own processes that really
 * call the window, so the address and the key are proven to work from outside squad-kit.
 */

const { runAcp, windowServer } = await import('../src/engine/acp-runner.js');
const { AgentWindow } = await import('../src/engine/window.js');
const { openWindow, closeWindow, windowAccess } = await import('../src/engine/window-server.js');
const { claudeRunOptions, claudeLaunch, windowTools, WINDOW_ENV } = await import('../src/modules/claude/index.js');
const { runClaude, windowConfig } = await import('../src/modules/claude/direct.js');
const { runBridge } = await import('../src/commands/mcp-bridge.js');

const ROOT = path.resolve(__dirname, '..');

/** An ACP adapter that says whether it takes MCP over HTTP, then, as the agent, lists the window's tools. */
const ADAPTER = (http: boolean) => `
import readline from 'node:readline';
import { spawn } from 'node:child_process';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let servers = [];
async function listTools() {
  const s = servers[0];
  if (!s) return 'no window';
  if (s.type === 'http') {
    const headers = Object.fromEntries(s.headers.map((h) => [h.name, h.value]));
    const res = await fetch(s.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    return 'http:' + (await res.json()).result.tools.map((t) => t.name).join(',');
  }
  // stdio: start the bridge as an MCP client would, and talk to it line by line.
  const child = spawn(s.command, s.args, { env: { ...process.env, ...Object.fromEntries(s.env.map((e) => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const answer = new Promise((resolve) => lines.once('line', resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\\n');
  const got = JSON.parse(await answer);
  child.stdin.end();
  return 'stdio:' + got.result.tools.map((t) => t.name).join(',');
}
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: ${http} } } } });
  if (msg.method === 'session/new') {
    servers = msg.params.mcpServers;
    return send({ id: msg.id, result: { sessionId: 's1' } });
  }
  if (msg.method === 'session/prompt') {
    const text = await listTools().catch((e) => 'failed: ' + e.message);
    send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    return send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

/** A stand-in for Claude Code's headless mode: with --mcp-config, it lists the window's tools over HTTP itself. */
const CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const at = args.indexOf('--mcp-config');
(async () => {
  let said = 'no window';
  if (at >= 0) {
    const s = Object.values(JSON.parse(args[at + 1]).mcpServers)[0];
    const res = await fetch(s.url, { method: 'POST', headers: { ...s.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    said = s.type + ':' + (await res.json()).result.tools.map((t) => t.name).join(',') + ':' + process.env.MCP_TOOL_TIMEOUT;
  }
  out({ type: 'result', subtype: 'success', result: said, session_id: 's' });
})();
`;

let dir: string;
let bin: string;

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-window-acp-')));
  fs.writeFileSync(path.join(dir, 'http.mjs'), ADAPTER(true));
  fs.writeFileSync(path.join(dir, 'stdio.mjs'), ADAPTER(false));
  bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), CLAUDE, { mode: 0o755 });
  // The bridge from the source, as `squad mcp-bridge` runs it once built.
  fs.writeFileSync(path.join(dir, 'bridge.mts'), `import { runMcpBridge } from ${JSON.stringify(path.join(ROOT, 'src/commands/mcp-bridge.ts'))};\nawait runMcpBridge();\n`);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let opened: InstanceType<typeof AgentWindow>[] = [];
beforeEach(async () => {
  for (const w of opened) await closeWindow(w);
  opened = [];
});

async function access(): Promise<RunWindow> {
  const w = new AgentWindow({ ticket: 'RO-7', step: 'build', who: 'Builder', tools: ['i_am_stuck', 'app_status'], proofDir: path.join(dir, 'proof'), prefix: 'ro-7-builder', say: () => undefined });
  openWindow(w);
  opened.push(w);
  const a = await windowAccess(w);
  // The bridge from the source here; squad-kit itself runs `node dist/cli.js mcp-bridge`.
  return { ...a, bridge: { command: process.execPath, args: ['--import', pathToFileURL(path.join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, path.join(dir, 'bridge.mts')] } };
}

const launch = (script: string) => ({
  command: process.execPath,
  args: [path.join(dir, script)],
  env: process.env,
  meta: {},
  canResume: () => false,
  explain: (raw: string) => raw,
  toolName: () => undefined,
});

describe('over ACP', () => {
  it('goes as MCP over HTTP when the agent takes it, with the run key in a header', async () => {
    const w = await access();
    expect(windowServer(w, true)).toEqual({ type: 'http', name: 'squad', url: w.url, headers: [{ name: 'Authorization', value: `Bearer ${w.key}` }] });
    const r = await runAcp(launch('http.mjs'), { cwd: dir, prompt: 'go', window: w, timeoutMs: 20_000 });
    expect(r.text).toBe('http:i_am_stuck,app_status');
  });

  it("goes through squad-kit's stdio bridge when the agent does not take HTTP, the key in its environment", async () => {
    const w = await access();
    const s = windowServer(w, false) as { command: string; args: string[]; env: { name: string; value: string }[] };
    expect(s.env).toEqual([
      { name: 'SQUAD_WINDOW_URL', value: w.url },
      { name: 'SQUAD_WINDOW_KEY', value: w.key },
    ]);
    // The key never goes on the command line, where every program on the computer could read it.
    expect(s.args.join(' ')).not.toContain(w.key);
    const r = await runAcp(launch('stdio.mjs'), { cwd: dir, prompt: 'go', window: w, timeoutMs: 30_000 });
    expect(r.text).toBe('stdio:i_am_stuck,app_status');
  }, 40_000);

  it('offers no window when the run has none', async () => {
    const r = await runAcp(launch('http.mjs'), { cwd: dir, prompt: 'go', timeoutMs: 20_000 });
    expect(r.text).toBe('no window');
  });
});

describe('Claude Code', () => {
  it("allows the window's tools outright, so no permission question ever asks for them", async () => {
    const w = await access();
    const opts = claudeRunOptions({ cwd: dir, prompt: 'x', permissions: ['read'], window: w });
    expect(windowTools(w)).toEqual(['mcp__squad__i_am_stuck', 'mcp__squad__app_status']);
    expect(opts.allowedTools).toEqual(expect.arrayContaining(['Read', 'mcp__squad__i_am_stuck', 'mcp__squad__app_status']));
    expect(claudeLaunch(opts, '/adapter.js', '/bin/claude').env).toMatchObject(WINDOW_ENV);
    expect(windowConfig(w)).toEqual({ mcpServers: { squad: { type: 'http', url: w.url, headers: { Authorization: `Bearer ${w.key}` } } } });
  });

  it('reaches the window in the direct fallback too, through --mcp-config', async () => {
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    const w = await access();
    const r = await runClaude({ ...claudeRunOptions({ cwd: dir, prompt: 'x', permissions: ['read'], window: w }), timeoutMs: 20_000 });
    expect(r.text).toBe('http:i_am_stuck,app_status:240000');
    vi.unstubAllEnvs();
  });
});

describe('the stdio bridge', () => {
  it('forwards each line with the key and passes each answer back on one line; a notification gets none', async () => {
    const w = await access();
    const input = new PassThrough();
    const output = new PassThrough();
    const got: string[] = [];
    output.on('data', (d: Buffer) => got.push(...d.toString().split('\n').filter(Boolean)));
    const done = runBridge({ url: w.url, key: w.key, input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'app_status', arguments: {} } })}\n`);
    input.write('not json\n');
    input.end();
    await done;
    const msgs = got.map((l) => JSON.parse(l) as { id: number | null; result?: any; error?: { message: string } });
    expect(msgs.find((m) => m.id === 1)?.result.serverInfo.name).toBe('squad-kit');
    expect(msgs.find((m) => m.id === 2)?.result.content[0].text).toBe('This step has no app squad-kit can start.');
    expect(msgs.find((m) => m.id === null)?.error?.message).toBe('The message is not JSON.');
    expect(msgs).toHaveLength(3);
  });

  it("says so to the agent when the board does not answer, and a wrong key opens nothing", async () => {
    const w = await access();
    const input = new PassThrough();
    const output = new PassThrough();
    const got: string[] = [];
    output.on('data', (d: Buffer) => got.push(d.toString()));
    const done = runBridge({ url: w.url, key: 'not-the-key', input, output });
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
    await done;
    expect(JSON.parse(got.join('')).error.message).toBe('squad-kit does not know this key, or its run has ended.');
    const gone = new PassThrough();
    const out2 = new PassThrough();
    const said: string[] = [];
    out2.on('data', (d: Buffer) => said.push(d.toString()));
    const off = runBridge({ url: 'http://127.0.0.1:9/mcp', key: w.key, input: gone, output: out2 });
    gone.end(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' })}\n`);
    await off;
    expect(JSON.parse(said.join('')).error.message).toMatch(/^squad-kit's board did not answer/);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpStartError, runAcp, type AcpLaunch } from '../src/engine/acp-runner.js';
import type { ToolEvent } from '../src/modules/ai-tool/types.js';

/**
 * The agent gateway against a small fake ACP adapter: it asks permission to write a file, then gives its answer
 * through a tool call. The gateway must say no, save every update, and pick up the answer.
 */

const ADAPTER = `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
let waiting = null;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 900 && !msg.method) return waiting(msg.result.outcome.optionId);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write', rawInput: { file_path: '/app/x.txt' }, _meta: { fake: { toolName: 'Write' } } });
    waiting = (choice) => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'permission:' + choice } });
      update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Answer', rawInput: { word: 'ok' }, _meta: { fake: { toolName: 'Answer' } } });
      send({ id: msg.id, result: { stopReason: 'end_turn' } });
    };
    send({ id: 900, method: 'session/request_permission', params: { sessionId: 's1', options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } });
  }
});
`;

/** An adapter that starts each session in the person's own mode, here "bypass", until the client sets one. */
const MODE_ADAPTER = `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let mode = 'bypassPermissions';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's2' } });
  if (msg.method === 'session/set_mode') {
    mode = msg.params.sessionId === 's2' ? msg.params.modeId : 'wrong session';
    return send({ id: msg.id, result: {} });
  }
  if (msg.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 's2', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'mode:' + mode } } } });
    return send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

/** An adapter that sends its messages in small pieces, as the real one does, with a tool call between two messages. */
const PIECES_ADAPTER = `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const piece = (text) => send({ method: 'session/update', params: { sessionId: 's3', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's3' } });
  if (msg.method === 'session/prompt') {
    piece('Let me ');
    piece('look.');
    send({ method: 'session/update', params: { sessionId: 's3', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', rawInput: {}, _meta: { fake: { toolName: 'Read' } } } } });
    piece('The word ');
    piece('is ');
    piece('mango.');
    return send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

/** An adapter whose agent keeps a to-do list: ACP's plan update, the whole list each time, with fields squad-kit does not keep. */
const PLAN_ADAPTER = `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const plan = (entries) => send({ method: 'session/update', params: { sessionId: 's4', update: { sessionUpdate: 'plan', entries } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's4' } });
  if (msg.method === 'session/prompt') {
    plan([{ content: 'Add the words', status: 'in_progress', priority: 'medium' }, { content: 'Add the page', status: 'pending', priority: 'medium' }]);
    plan([{ content: 'Add the words', status: 'completed', priority: 'medium' }, { content: 'Add the page', status: 'in_progress', priority: 'high' }, { status: 'odd' }]);
    return send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

let dir: string;
let script: string;
let modeScript: string;
let piecesScript: string;
let planScript: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-acp-'));
  script = path.join(dir, 'adapter.mjs');
  fs.writeFileSync(script, ADAPTER);
  modeScript = path.join(dir, 'mode-adapter.mjs');
  fs.writeFileSync(modeScript, MODE_ADAPTER);
  piecesScript = path.join(dir, 'pieces-adapter.mjs');
  fs.writeFileSync(piecesScript, PIECES_ADAPTER);
  planScript = path.join(dir, 'plan-adapter.mjs');
  fs.writeFileSync(planScript, PLAN_ADAPTER);
});

const launch = (args: string[]): AcpLaunch => ({
  command: process.execPath,
  args,
  env: process.env,
  meta: {},
  canResume: () => false,
  explain: (raw) => raw,
  toolName: (u) => u._meta?.fake?.toolName,
  structuredTool: 'Answer',
});

describe('the agent gateway', () => {
  it('says no to a permission question, saves every update, and picks up the answer', async () => {
    const tools: ToolEvent[] = [];
    const logDir = path.join(dir, 'logs');
    const r = await runAcp(launch([script]), { cwd: dir, prompt: 'go', expectStructured: true, logDir, timeoutMs: 20_000, onTool: (e) => tools.push(e) });
    expect(r).toMatchObject({ ok: true, sessionId: 's1', text: 'permission:no', structured: { word: 'ok' } });
    expect(tools).toEqual([{ name: 'Write', input: { file_path: '/app/x.txt' } }]);
    expect(fs.readFileSync(path.join(logDir, 's1.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it("sets the step's own mode on the session before the prompt, whatever mode the person's settings start it in", async () => {
    const own = await runAcp(launch([modeScript]), { cwd: dir, prompt: 'go', timeoutMs: 20_000 });
    expect(own.text).toBe('mode:bypassPermissions');
    const set = await runAcp({ ...launch([modeScript]), mode: 'default' }, { cwd: dir, prompt: 'go', timeoutMs: 20_000 });
    expect(set).toMatchObject({ ok: true, text: 'mode:default' });
  });

  it('keeps the whole last message, not its last piece', async () => {
    const pieces: string[] = [];
    const r = await runAcp(launch([piecesScript]), { cwd: dir, prompt: 'go', timeoutMs: 20_000, onText: (t) => pieces.push(t) });
    expect(r).toMatchObject({ ok: true, text: 'The word is mango.' });
    expect(pieces).toEqual(['Let me ', 'look.', 'The word ', 'is ', 'mango.']);
  });

  it("hands on the agent's to-do list each time it changes, as ACP's plan update gives it: words and where each stands", async () => {
    const plans: unknown[] = [];
    const r = await runAcp(launch([planScript]), { cwd: dir, prompt: 'go', timeoutMs: 20_000, onPlan: (p) => plans.push(p) });
    expect(r.ok).toBe(true);
    expect(plans).toEqual([
      [{ content: 'Add the words', status: 'in_progress' }, { content: 'Add the page', status: 'pending' }],
      [{ content: 'Add the words', status: 'completed' }, { content: 'Add the page', status: 'in_progress' }, { content: '', status: 'pending' }],
    ]);
  });

  it('tells the caller when the adapter cannot start, so it can fall back', async () => {
    await expect(runAcp(launch(['-e', 'process.exit(1)']), { cwd: dir, prompt: 'go', timeoutMs: 20_000 })).rejects.toBeInstanceOf(AcpStartError);
  });
});

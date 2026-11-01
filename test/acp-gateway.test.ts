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

let dir: string;
let script: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-acp-'));
  script = path.join(dir, 'adapter.mjs');
  fs.writeFileSync(script, ADAPTER);
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

  it('tells the caller when the adapter cannot start, so it can fall back', async () => {
    await expect(runAcp(launch(['-e', 'process.exit(1)']), { cwd: dir, prompt: 'go', timeoutMs: 20_000 })).rejects.toBeInstanceOf(AcpStartError);
  });
});

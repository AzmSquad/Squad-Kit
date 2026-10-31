import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { childEnv, claudeBinary, deniedTools, plainError, sessionExists, type RunOptions, type RunResult } from './claude.js';

/**
 * Runs a role through the Agent Client Protocol (ACP): squad-kit is the ACP client and talks JSON-RPC over stdio to
 * the official Claude adapter, which drives the person's own Claude Code on their subscription. Every update the agent
 * sends (messages, tool calls with diffs, plans) is saved as it arrives, so the board shows the conversation natively.
 */

export interface AcpRunOptions extends RunOptions {
  /** Folder for the ACP updates of each session, one `<sessionId>.jsonl` file per session, one JSON line per update. */
  acpLogDir?: string;
}

/** The adapter's entry point, or null when it is not installed. */
export function acpAdapterPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
    const entry = path.join(path.dirname(pkg), 'dist', 'index.js');
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** Raised when the adapter could not start, before any work began, so the caller can fall back safely. */
export class AcpStartError extends Error {}

type Pending = { resolve(v: unknown): void; reject(e: Error): void };

class Rpc {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private onNotify: (method: string, params: Record<string, any>) => void,
    private onRequest: (method: string, params: Record<string, any>) => unknown,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk.toString('utf8')));
    child.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('The Claude ACP adapter stopped.'));
      this.pending.clear();
    });
  }

  private write(msg: object): void {
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  request<T = any>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: object): void {
    this.write({ method, params });
  }

  private read(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && !msg.method && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
        else p.resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        Promise.resolve()
          .then(() => this.onRequest(msg.method, msg.params ?? {}))
          .then((result) => this.write({ id: msg.id, result }))
          .catch((err: Error) => this.write({ id: msg.id, error: { code: -32601, message: err.message } }));
      } else if (msg.method) {
        this.onNotify(msg.method, msg.params ?? {});
      }
    }
  }
}

/** Same contract as runClaude: one step of one role, with the session saved for follow-ups. */
export async function runClaudeAcp(opts: AcpRunOptions): Promise<RunResult> {
  const adapter = acpAdapterPath();
  const bin = claudeBinary();
  if (!adapter) throw new AcpStartError('The Claude ACP adapter is not installed.');
  if (!bin) return { ok: false, sessionId: opts.resume ?? opts.sessionId ?? '', text: '', error: 'Claude Code is not installed. Install it and log in, then try again.' };

  const env = { ...childEnv(), CLAUDE_CODE_EXECUTABLE: bin };
  const child = spawn(process.execPath, [adapter], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  if (child.pid) opts.onSpawn?.(child.pid);
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-4000)));
  if (opts.acpLogDir) fs.mkdirSync(opts.acpLogDir, { recursive: true });

  // Tool calls arrive first as a stub, then their details (name, input, diff) in updates.
  const tools = new Map<string, { name?: string; input?: Record<string, unknown>; reported?: boolean; structured?: unknown }>();
  let lastText = '';
  let structured: unknown;
  let sessionId = opts.resume ?? opts.sessionId ?? '';

  const rpc = new Rpc(
    child,
    (method, params) => {
      if (method !== 'session/update') return;
      const update = params.update as Record<string, any>;
      opts.onActivity?.();
      if (opts.acpLogDir && sessionId) fs.appendFileSync(path.join(opts.acpLogDir, `${sessionId}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), update })}\n`);
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        lastText = update.content.text;
        opts.onText?.(update.content.text);
      }
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const t = tools.get(update.toolCallId) ?? {};
        const name = update._meta?.claudeCode?.toolName ?? (update.sessionUpdate === 'tool_call' ? undefined : t.name);
        if (name) t.name = name;
        if (update.rawInput && Object.keys(update.rawInput).length) t.input = update.rawInput;
        if (t.name === 'StructuredOutput' && t.input) structured = t.input;
        // Report each tool once, when its name and input are known, the way the direct runner does.
        if (!t.reported && t.name && t.input && t.name !== 'StructuredOutput') {
          t.reported = true;
          opts.onTool?.({ name: t.name, input: t.input });
        }
        tools.set(update.toolCallId, t);
      }
    },
    (method, params) => {
      // squad-kit sets the allowed tools up front, so any permission question gets the first "allow" choice.
      if (method === 'session/request_permission') {
        const options = (params.options ?? []) as { optionId: string; kind: string }[];
        const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind.startsWith('allow')) ?? options[0];
        return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } };
      }
      throw new Error(`squad-kit does not offer ${method}`);
    },
  );

  const stop = (reason: string) => {
    try {
      if (sessionId) rpc.notify('session/cancel', { sessionId });
    } catch {
      // Already gone.
    }
    setTimeout(() => child.kill('SIGTERM'), 1500);
    return reason;
  };
  let stoppedBy: string | null = null;
  opts.signal?.addEventListener('abort', () => (stoppedBy = stop('You stopped the squad.')));
  const timer = setTimeout(() => (stoppedBy = stop(`It took longer than ${Math.round((opts.timeoutMs ?? 20 * 60_000) / 60_000)} minutes, so squad-kit stopped it.`)), opts.timeoutMs ?? 20 * 60_000);
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));

  const denied = deniedTools(opts);
  const options = {
    ...(opts.allowedTools?.length ? { allowedTools: opts.allowedTools } : {}),
    ...(denied.length ? { disallowedTools: denied } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.schema ? { outputFormat: { type: 'json_schema', schema: opts.schema } } : {}),
    ...(opts.appendSystemPrompt ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.appendSystemPrompt } } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.addDirs?.length ? { additionalDirectories: opts.addDirs } : {}),
  };

  try {
    try {
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'squad-kit', version: '1' },
      });
    } catch (err) {
      throw new AcpStartError(`The Claude ACP adapter did not start: ${(err as Error).message} ${stderr.slice(-300)}`.trim());
    }
    const existing = sessionId && sessionExists(sessionId);
    if (existing) {
      // Continue the saved conversation under the same id.
      await rpc.request('session/resume', { sessionId, cwd: opts.cwd, mcpServers: [], _meta: { claudeCode: { options } } });
    } else {
      const s = await rpc.request<{ sessionId: string }>('session/new', { cwd: opts.cwd, mcpServers: [], _meta: { claudeCode: { options } } });
      sessionId = s.sessionId;
    }
    const res = await rpc.request<{ stopReason: string }>('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.prompt }] });
    if (stoppedBy) return { ok: false, sessionId, text: lastText, error: stoppedBy };
    if (res.stopReason !== 'end_turn') {
      const why =
        res.stopReason === 'max_tokens' ? 'The answer was cut off because it got too long.'
        : res.stopReason === 'refusal' ? 'Claude declined to do this step.'
        : res.stopReason === 'cancelled' ? 'The step was cancelled.'
        : `Claude stopped early (${res.stopReason}).`;
      return { ok: false, sessionId, text: lastText, error: why };
    }
    if (opts.schema && structured === undefined) return { ok: false, sessionId, text: lastText, error: 'Claude finished without giving squad-kit its answer.' };
    return { ok: true, sessionId, text: lastText, ...(structured !== undefined ? { structured } : {}) };
  } catch (err) {
    if (err instanceof AcpStartError) throw err;
    return { ok: false, sessionId, text: lastText, error: stoppedBy ?? plainError(`${(err as Error).message}\n${stderr}`) };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    // Give the adapter a moment to close Claude Code cleanly, then make sure nothing is left running.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

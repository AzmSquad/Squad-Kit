import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentResult, AgentUsage, ToolEvent } from '../modules/ai-tool/types.js';
import { OWN_GROUP, endGroup, track } from './process-group.js';

/**
 * The agent gateway: runs a role through the Agent Client Protocol (ACP). squad-kit is the ACP client and talks
 * JSON-RPC over stdio to the AI tool's adapter, which drives the person's own tool on their own login. Every update
 * the agent sends (messages, tool calls with diffs, plans) is saved as it arrives, so the board shows the
 * conversation natively. The AI tool module says how to start its adapter and what to send it (AcpLaunch).
 */

export interface AcpLaunch {
  /** The tool's name for people, such as "Claude Code". */
  label?: string;
  /** The command that starts the adapter, its arguments and its environment. */
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Session settings the adapter reads from `_meta` on session/new and session/resume. */
  meta: Record<string, unknown>;
  /** The session mode the run works in (session/set_mode), whatever the person's own settings start it in. */
  mode?: string;
  /** True when the tool already saved a conversation with this id, so it is resumed rather than started. */
  canResume(id: string): boolean;
  /** A failure in words a person can act on. */
  explain(raw: string): string;
  /** The tool's name for a tool call update, when the adapter says it. */
  toolName(update: Record<string, any>): string | undefined;
  /** The tool call that carries the structured answer, when the tool answers that way. */
  structuredTool?: string;
  /**
   * What a saved conversation had cost before this run, by the tool's own record. ACP reports the cost of a whole
   * session, so a run that continues one costs the difference. Without it, a continued run's cost stays unknown.
   */
  costSoFar?(sessionId: string): number | undefined;
}

/** The token counts ACP gives with the answer to session/prompt, for that turn. Cached tokens are counted apart. */
export interface AcpTokens {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * One run's usage from what the agent reported: the run's tokens, and the session's cost now and before the run (US
 * dollars). Whatever was not reported is left out. A session cost lower than before means the tool started counting
 * again, so it is this run's alone.
 */
export function usageFrom(tokens: AcpTokens | undefined, cost: number | undefined, before: number | undefined): AgentUsage | undefined {
  const u: AgentUsage = {};
  if (tokens && count(tokens.inputTokens)) {
    const read = count(tokens.cachedReadTokens) ? tokens.cachedReadTokens : 0;
    const write = count(tokens.cachedWriteTokens) ? tokens.cachedWriteTokens : 0;
    u.inputTokens = tokens.inputTokens + read + write;
    if (count(tokens.cachedReadTokens)) u.cachedTokens = read;
  }
  if (tokens && count(tokens.outputTokens)) u.outputTokens = tokens.outputTokens;
  if (count(cost) && count(before)) u.costUsd = cost >= before ? cost - before : cost;
  return Object.keys(u).length ? u : undefined;
}

export interface AcpRunOptions {
  cwd: string;
  prompt: string;
  sessionId?: string;
  resume?: string;
  /** The run must end with a structured answer. */
  expectStructured?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Folder for the ACP updates of each session, one `<sessionId>.jsonl` file per session, one JSON line per update. */
  logDir?: string;
  onTool?(event: ToolEvent): void;
  onText?(text: string): void;
  onActivity?(): void;
  onSpawn?(pid: number): void;
  /** How long the adapter may take to start, and then to open the session. Tests use less. */
  startLimits?: { initializeMs?: number; sessionMs?: number };
}

/** Raised when the adapter could not start, before any work began, so the caller can fall back safely. */
export class AcpStartError extends Error {}

/** A start step that took longer than its limit; its message is already plain. */
class TookTooLong extends Error {}

/** The promise, or a TookTooLong once `ms` pass without an answer. */
function deadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TookTooLong(message)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const STOPPED = 'You stopped the squad.';

/**
 * squad-kit gives each step its tools up front, so a permission question means the agent wants something it was not
 * given, such as writing files in a step that only reads, even when the person asked it to in a chat. The answer is no.
 */
export function answerPermission(params: Record<string, any>): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const options = (params.options ?? []) as { optionId: string; kind: string }[];
  const no = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind.startsWith('reject'));
  return no ? { outcome: { outcome: 'selected', optionId: no.optionId } } : { outcome: { outcome: 'cancelled' } };
}

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
    const gone = (err?: Error) => {
      for (const p of this.pending.values()) p.reject(new Error(err ? `The ACP adapter could not run: ${err.message}` : 'The ACP adapter stopped.'));
      this.pending.clear();
    };
    child.on('exit', () => gone());
    child.on('error', (err) => gone(err));
  }

  private write(msg: object): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
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

/** One step of one role, with the session saved for follow-ups. */
export async function runAcp(launch: AcpLaunch, opts: AcpRunOptions): Promise<AgentResult> {
  // Stopped before it began: nothing starts.
  if (opts.signal?.aborted) return { ok: false, sessionId: opts.resume ?? opts.sessionId ?? '', text: '', error: STOPPED };
  // Its own process group, so stopping it ends the tool it drives and the commands that tool runs too.
  const child = track(spawn(launch.command, launch.args, { cwd: opts.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], detached: OWN_GROUP }));
  // An adapter that cannot start, or dies while squad-kit writes to it, must never take the app down with it.
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  if (child.pid) opts.onSpawn?.(child.pid);
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-4000)));
  if (opts.logDir) fs.mkdirSync(opts.logDir, { recursive: true });

  // Tool calls arrive first as a stub, then their details (name, input, diff) in updates.
  const tools = new Map<string, { name?: string; input?: Record<string, unknown>; reported?: boolean; structured?: unknown }>();
  let lastText = '';
  let structured: unknown;
  let sessionId = opts.resume ?? opts.sessionId ?? '';
  // What the session has cost so far, in US dollars, as the agent last said, and what it had cost before this run.
  let cost: number | undefined;
  let costBefore: number | undefined = 0;
  let tokens: AcpTokens | undefined;
  const used = () => {
    const u = usageFrom(tokens, cost, costBefore);
    return u ? { usage: u } : {};
  };

  const rpc = new Rpc(
    child,
    (method, params) => {
      if (method !== 'session/update') return;
      const update = params.update as Record<string, any>;
      opts.onActivity?.();
      if (opts.logDir && sessionId) fs.appendFileSync(path.join(opts.logDir, `${sessionId}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), update })}\n`);
      if (update.sessionUpdate === 'usage_update' && update.cost?.currency === 'USD' && count(update.cost.amount)) cost = update.cost.amount;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        lastText = update.content.text;
        opts.onText?.(update.content.text);
      }
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const t = tools.get(update.toolCallId) ?? {};
        const name = launch.toolName(update) ?? (update.sessionUpdate === 'tool_call' ? undefined : t.name);
        if (name) t.name = name;
        if (update.rawInput && Object.keys(update.rawInput).length) t.input = update.rawInput;
        if (launch.structuredTool && t.name === launch.structuredTool && t.input) structured = t.input;
        // Report each tool once, when its name and input are known, the way the direct runner does.
        if (!t.reported && t.name && t.input && t.name !== launch.structuredTool) {
          t.reported = true;
          opts.onTool?.({ name: t.name, input: t.input });
        }
        tools.set(update.toolCallId, t);
      }
    },
    (method, params) => {
      if (method === 'session/request_permission') return answerPermission(params);
      throw new Error(`squad-kit does not offer ${method}`);
    },
  );

  let stoppedBy: string | null = null;
  // Ask the agent to stop, then end the whole group: the adapter, the tool and the commands it ran.
  const stop = (reason: string) => {
    if (stoppedBy) return;
    stoppedBy = reason;
    try {
      if (sessionId) rpc.notify('session/cancel', { sessionId });
    } catch {
      // Already gone.
    }
    setTimeout(() => endGroup(child), 1500);
  };
  const onStop = () => stop(STOPPED);
  opts.signal?.addEventListener('abort', onStop, { once: true });
  const timer = setTimeout(() => stop(`It took longer than ${Math.round((opts.timeoutMs ?? 20 * 60_000) / 60_000)} minutes, so squad-kit stopped it.`), opts.timeoutMs ?? 20 * 60_000);
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });

  const meta = launch.meta;
  // A start that hangs ends with a plain message instead of waiting for the whole step's time.
  const name = launch.label ?? 'The AI tool';
  const initializeMs = opts.startLimits?.initializeMs ?? 30_000;
  const sessionMs = opts.startLimits?.sessionMs ?? 60_000;
  const late = (ms: number, what: string) => {
    const s = Math.max(1, Math.round(ms / 1000));
    return `${name} did not ${what} in ${s} second${s === 1 ? '' : 's'}. Check that it opens in a terminal and is logged in, then press Try again.`;
  };

  try {
    try {
      await deadline(
        rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'squad-kit', version: '1' },
        }),
        initializeMs,
        late(initializeMs, 'start'),
      );
    } catch (err) {
      // A Stop is not a failed start: the caller must not try another way.
      if (stoppedBy) throw err;
      const why = err instanceof TookTooLong ? err.message : `The ACP adapter did not start: ${(err as Error).message}`;
      throw new AcpStartError(`${why} ${stderr.slice(-300)}`.trim());
    }
    const existing = sessionId && launch.canResume(sessionId);
    if (existing) {
      costBefore = launch.costSoFar?.(sessionId);
      // Continue the saved conversation under the same id.
      await deadline(rpc.request('session/resume', { sessionId, cwd: opts.cwd, mcpServers: [], _meta: meta }), sessionMs, late(sessionMs, 'open its session'));
    } else {
      const s = await deadline(rpc.request<{ sessionId: string }>('session/new', { cwd: opts.cwd, mcpServers: [], _meta: meta }), sessionMs, late(sessionMs, 'open a session'));
      sessionId = s.sessionId;
    }
    if (launch.mode) await rpc.request('session/set_mode', { sessionId, modeId: launch.mode });
    const res = await rpc.request<{ stopReason: string; usage?: AcpTokens | null }>('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.prompt }] });
    tokens = res.usage ?? undefined;
    if (stoppedBy) return { ok: false, sessionId, text: lastText, error: stoppedBy, ...used() };
    if (res.stopReason !== 'end_turn') {
      const why =
        res.stopReason === 'max_tokens' ? 'The answer was cut off because it got too long.'
        : res.stopReason === 'refusal' ? 'The agent declined to do this step.'
        : res.stopReason === 'cancelled' ? 'The step was cancelled.'
        : `The agent stopped early (${res.stopReason}).`;
      return { ok: false, sessionId, text: lastText, error: why, ...used() };
    }
    if (opts.expectStructured && structured === undefined) return { ok: false, sessionId, text: lastText, error: 'The agent finished without giving squad-kit its answer.', ...used() };
    return { ok: true, sessionId, text: lastText, ...(structured !== undefined ? { structured } : {}), ...used() };
  } catch (err) {
    if (err instanceof AcpStartError) throw err;
    const why = err instanceof TookTooLong ? err.message : launch.explain(`${(err as Error).message}\n${stderr}`);
    return { ok: false, sessionId, text: lastText, error: stoppedBy ?? why, ...used() };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onStop);
    child.stdin.end();
    // Give the adapter a moment to close its tool cleanly, then make sure nothing it started is left running.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    endGroup(child);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

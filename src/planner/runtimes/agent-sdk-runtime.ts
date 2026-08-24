import { z } from 'zod';
import type {
  PlannerRuntime,
  RunDraftInput,
  RunDraftOutput,
  RunScoutInput,
  RunScoutOutput,
} from './types.js';
import type { Usage } from '../types.js';
import { sdkEffortFromPlanner, thinkingConfigFromProviderSpecific } from './anthropic-options.js';
import { usageFromAgentSdkResult } from '../usage-map.js';
import type { PlannerApiKeySource, PlannerEvent, PlannerEventBus } from '../events.js';
import { describeAuth, type ResolvedPlannerAuth } from '../../core/planner-auth.js';
import {
  authErrorContextFrom,
  authErrorMessage,
  detectAuthShapedSdkError,
  type AuthShapedSdkError,
} from '../auth-errors.js';
import { buildSdkEnv } from './sdk-env.js';

/** Hard cap on the best-effort `accountInfo()` lookup so a wedged control channel cannot stall a run. */
const ACCOUNT_INFO_TIMEOUT_MS = 2000;

/** Matches the Vercel runtime's rate-limit retry cap so the console countdown renders identically. */
const MAX_RATE_LIMIT_RETRY_SEC = 90;

/**
 * Scout and draft build separate runtime instances from the same `ResolvedPlannerAuth`, but share
 * one bus per run. Keyed by bus so the enriched `auth_info` is emitted exactly once per run.
 */
const enrichedAuthInfoRuns = new WeakMap<PlannerEventBus, Set<string>>();

function markAuthInfoEmitted(bus: PlannerEventBus, runId: string): boolean {
  let seen = enrichedAuthInfoRuns.get(bus);
  if (!seen) {
    seen = new Set<string>();
    enrichedAuthInfoRuns.set(bus, seen);
  }
  if (seen.has(runId)) return false;
  seen.add(runId);
  return true;
}

const API_KEY_SOURCES: readonly PlannerApiKeySource[] = ['user', 'project', 'org', 'temporary', 'oauth'];

function asApiKeySource(v: unknown): PlannerApiKeySource | undefined {
  return API_KEY_SOURCES.find((s) => s === v);
}

const BUILTIN_TOOL_DENY = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
] as const;

export type DecodedStream =
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'content_block_start'; blockType: 'text' | 'thinking' | 'tool_use'; index: number }
  | { kind: 'content_block_stop'; index: number }
  | {
      kind: 'message_start';
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    }
  | {
      kind: 'message_delta';
      usage?: {
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    }
  | { kind: 'other' };

type ThinkingStreamState = {
  blockIndexCounter: number;
  inThinkingBlock: boolean;
  thinkingBlockIndex: number;
  thinkingBlockStartedAt: number;
  thinkingChars: number;
};

function initialThinkingState(): ThinkingStreamState {
  return {
    blockIndexCounter: 0,
    inThinkingBlock: false,
    thinkingBlockIndex: -1,
    thinkingBlockStartedAt: 0,
    thinkingChars: 0,
  };
}

export function decodeStreamEvent(ev: unknown): DecodedStream {
  if (!ev || typeof ev !== 'object') return { kind: 'other' };
  const o = ev as Record<string, unknown>;
  const t = o.type;

  if (t === 'message_start') {
    const msg = o.message as Record<string, unknown> | undefined;
    const u = (msg?.usage ?? o.usage) as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') return { kind: 'message_start' };
    return {
      kind: 'message_start',
      usage: {
        input_tokens: num(u.input_tokens),
        output_tokens: num(u.output_tokens),
        cache_creation_input_tokens: num(u.cache_creation_input_tokens),
        cache_read_input_tokens: num(u.cache_read_input_tokens),
      },
    };
  }

  if (t === 'message_delta') {
    const u = o.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') return { kind: 'message_delta' };
    return {
      kind: 'message_delta',
      usage: {
        output_tokens: num(u.output_tokens),
        cache_creation_input_tokens: num(u.cache_creation_input_tokens),
        cache_read_input_tokens: num(u.cache_read_input_tokens),
      },
    };
  }

  if (t === 'content_block_start') {
    const idx = typeof o.index === 'number' ? o.index : 0;
    const cb = o.content_block as Record<string, unknown> | undefined;
    const bt = cb?.type;
    if (bt === 'thinking' || bt === 'text' || bt === 'tool_use')
      return { kind: 'content_block_start', blockType: bt, index: idx };
    return { kind: 'other' };
  }

  if (t === 'content_block_stop') {
    return { kind: 'content_block_stop', index: typeof o.index === 'number' ? o.index : 0 };
  }

  if (t === 'content_block_delta') {
    const d = o.delta as Record<string, unknown> | undefined;
    if (!d) return { kind: 'other' };
    const dt = d.type;
    if (dt === 'text_delta' && typeof d.text === 'string') {
      return { kind: 'text_delta', text: d.text };
    }
    if (dt === 'thinking_delta') {
      const th =
        typeof d.thinking === 'string' ? d.thinking : typeof d.text === 'string' ? d.text : '';
      if (th) return { kind: 'thinking_delta', text: th };
    }
  }

  return { kind: 'other' };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
}

function handleDecodedStreamEvent(
  decoded: DecodedStream,
  input: {
    bus: PlannerEventBus;
    runId: string;
    assistantTurns: number;
    onAssistantText?: (delta: string) => void;
    think: ThinkingStreamState;
    textSink?: { append: (s: string) => void };
  },
): void {
  const { bus, runId, onAssistantText, think } = input;
  const turnUse = input.assistantTurns + 1;

  if (decoded.kind === 'message_start' && decoded.usage) {
    const u = decoded.usage;
    const partial: Usage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
    };
    bus.emit({ kind: 'usage', runId, turn: turnUse, usage: partial });
    return;
  }

  if (decoded.kind === 'message_delta' && decoded.usage) {
    const out = decoded.usage.output_tokens ?? 0;
    if (out > 0) {
      bus.emit({
        kind: 'usage',
        runId,
        turn: turnUse,
        usage: { inputTokens: 0, outputTokens: out },
      });
    }
    return;
  }

  if (decoded.kind === 'text_delta') {
    input.textSink?.append(decoded.text);
    onAssistantText?.(decoded.text);
    bus.emit({
      kind: 'assistant_text',
      runId,
      turn: input.assistantTurns,
      delta: decoded.text,
    });
    return;
  }

  if (decoded.kind === 'content_block_start') {
    if (decoded.blockType === 'thinking') {
      think.inThinkingBlock = true;
      think.thinkingBlockIndex = decoded.index;
      think.thinkingChars = 0;
      think.thinkingBlockStartedAt = Date.now();
      think.blockIndexCounter = Math.max(think.blockIndexCounter, decoded.index + 1);
      bus.emit({
        kind: 'thinking_block_started',
        runId,
        turn: input.assistantTurns,
        blockIndex: think.thinkingBlockIndex,
      });
    } else {
      think.inThinkingBlock = false;
    }
    return;
  }

  if (decoded.kind === 'thinking_delta') {
    if (!think.inThinkingBlock) {
      think.thinkingBlockIndex = think.blockIndexCounter++;
      think.thinkingChars = 0;
      think.thinkingBlockStartedAt = Date.now();
      think.inThinkingBlock = true;
      bus.emit({
        kind: 'thinking_block_started',
        runId,
        turn: input.assistantTurns,
        blockIndex: think.thinkingBlockIndex,
      });
    }
    think.thinkingChars += decoded.text.length;
    bus.emit({
      kind: 'thinking_delta',
      runId,
      turn: input.assistantTurns,
      blockIndex: think.thinkingBlockIndex,
      delta: decoded.text,
    });
    return;
  }

  if (decoded.kind === 'content_block_stop') {
    if (think.inThinkingBlock) {
      bus.emit({
        kind: 'thinking_block_stopped',
        runId,
        turn: input.assistantTurns,
        blockIndex: think.thinkingBlockIndex,
        durationMs: Date.now() - think.thinkingBlockStartedAt,
        chars: think.thinkingChars,
      });
      think.inThinkingBlock = false;
      think.thinkingBlockIndex = -1;
    }
  }
}

type SdkAccountInfo = { email?: string; organization?: string; subscriptionType?: string };

/**
 * Best-effort account lookup. `Query.accountInfo()` resolves from the `initialize` control-protocol
 * response the SDK issues when the subprocess starts — it does **not** consume a model turn — so by
 * the time the `system`/`init` message arrives it is already settled. The timeout only guards a
 * wedged control channel.
 */
async function readSdkAccountInfo(q: unknown): Promise<SdkAccountInfo | undefined> {
  const fn = (q as { accountInfo?: unknown } | null | undefined)?.accountInfo;
  if (typeof fn !== 'function') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = await Promise.race([
      (fn as () => Promise<unknown>).call(q),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ACCOUNT_INFO_TIMEOUT_MS);
      }),
    ]);
    if (!info || typeof info !== 'object') return undefined;
    const o = info as Record<string, unknown>;
    const out: SdkAccountInfo = {};
    if (typeof o.email === 'string') out.email = o.email;
    if (typeof o.organization === 'string') out.organization = o.organization;
    if (typeof o.subscriptionType === 'string') out.subscriptionType = o.subscriptionType;
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Anthropic-only runtime using `@anthropic-ai/claude-agent-sdk` `query()` and in-process MCP tools.
 */
export class AgentSdkRuntime implements PlannerRuntime {
  readonly kind = 'agent-sdk' as const;
  readonly providerName = 'anthropic' as const;

  constructor(
    readonly modelId: string,
    private readonly auth: ResolvedPlannerAuth,
  ) {}

  /** Safe-to-log auth projection — never carries the key or the token. */
  private authDescriptor(): Pick<
    Extract<PlannerEvent, { kind: 'auth_info' }>,
    'mode' | 'reason' | 'credentialHint'
  > {
    return describeAuth(this.auth);
  }

  /**
   * Handle a `system` message. On `init` this emits the enriched `auth_info` (once per run, even
   * though scout and draft are separate instances); on `api_retry` it forwards a rate limit through
   * the existing 0.8.0 rate-limit channel so the console countdown and CLI spinner keep working.
   */
  private async handleSystemMessage(
    m: { subtype?: string; apiKeySource?: unknown; error?: unknown; retry_delay_ms?: unknown },
    input: { bus: PlannerEventBus; runId: string },
    ctx: { query: unknown; withAccountInfo: boolean; turn: number },
  ): Promise<void> {
    if (m.subtype === 'init') {
      const apiKeySource = asApiKeySource(m.apiKeySource);
      if (!apiKeySource || !markAuthInfoEmitted(input.bus, input.runId)) return;
      const account =
        ctx.withAccountInfo && this.auth.mode === 'subscription'
          ? await readSdkAccountInfo(ctx.query)
          : undefined;
      input.bus.emit({
        kind: 'auth_info',
        runId: input.runId,
        ...this.authDescriptor(),
        apiKeySource,
        ...(account ? { account } : {}),
      });
      return;
    }
    if (m.subtype === 'api_retry' && detectAuthShapedSdkError(m.error) === 'rate_limit') {
      const delayMs = typeof m.retry_delay_ms === 'number' ? m.retry_delay_ms : 0;
      const waitSec = Math.max(1, Math.ceil(delayMs / 1000));
      input.bus.emit({
        kind: 'rate_limit',
        runId: input.runId,
        turn: ctx.turn,
        retryAfterSec: waitSec,
        waitSec,
        capSec: MAX_RATE_LIMIT_RETRY_SEC,
        phase: 'retrying',
        provider: 'anthropic',
      });
    }
  }

  /**
   * Turn an auth-shaped SDK failure into an actionable error. Rate limits also emit the terminal
   * `rate_limit` event so the UI closes its countdown before the throw.
   */
  private authError(
    signal: AuthShapedSdkError,
    input: { bus: PlannerEventBus; runId: string },
    turn: number,
  ): Error {
    if (signal === 'rate_limit') {
      input.bus.emit({
        kind: 'rate_limit',
        runId: input.runId,
        turn,
        retryAfterSec: undefined,
        waitSec: 0,
        capSec: MAX_RATE_LIMIT_RETRY_SEC,
        phase: 'aborted',
        provider: 'anthropic',
      });
    }
    return new Error(authErrorMessage(signal, authErrorContextFrom(this.auth)));
  }

  async runDraft(input: RunDraftInput): Promise<RunDraftOutput> {
    const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

    const sdkTools = input.tools.map((t) =>
      tool(t.name, t.description, this.zodToFieldsObject(t.parameters), async (args) => {
        const r = await t.execute(args as never);
        if (typeof r === 'string') return { content: [{ type: 'text' as const, text: r }] };
        return { content: [{ type: 'text' as const, text: r.content }], isError: r.isError };
      }),
    );

    const mcpServer = createSdkMcpServer({
      name: 'squad-kit-planner',
      version: '1.0.0',
      tools: sdkTools,
    });

    const ps = input.providerSpecific;
    const thinking = thinkingConfigFromProviderSpecific(ps);
    const effort = ps?.effort !== undefined ? sdkEffortFromPlanner(ps.effort) : sdkEffortFromPlanner('medium');

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (input.abort) {
      if (input.abort.aborted) ac.abort();
      else input.abort.addEventListener('abort', onAbort, { once: true });
    }

    const queryOptions = {
      model: this.modelId,
      tools: [] as string[],
      disallowedTools: [...BUILTIN_TOOL_DENY],
      mcpServers: { 'squad-kit-planner': mcpServer },
      systemPrompt: input.systemPrompt,
      maxTurns: input.maxSteps,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [] as [],
      abortController: ac,
      env: buildSdkEnv(this.auth),
      thinking,
      effort,
    };

    let text = '';
    let assistantTurns = 0;
    let finalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finishedNormally = false;
    let incompleteKind: RunDraftOutput['incompleteKind'];
    let userCancelled = false;
    let authSignal: AuthShapedSdkError | undefined;
    const think = initialThinkingState();

    try {
      const q = query({
        prompt: input.userMessage,
        options: queryOptions,
      });

      for await (const message of q) {
        const m = message as {
          type?: string;
          subtype?: string;
          event?: unknown;
          result?: string;
          usage?: unknown;
          error?: unknown;
          errors?: unknown;
        };
        switch (m.type) {
          case 'stream_event': {
            handleDecodedStreamEvent(decodeStreamEvent(m.event), {
              bus: input.bus,
              runId: input.runId,
              assistantTurns,
              onAssistantText: input.onAssistantText,
              think,
              textSink: { append: (s) => (text += s) },
            });
            break;
          }
          case 'assistant': {
            authSignal = detectAuthShapedSdkError(m.error) ?? authSignal;
            think.blockIndexCounter = 0;
            think.inThinkingBlock = false;
            think.thinkingBlockIndex = -1;
            think.thinkingChars = 0;
            assistantTurns += 1;
            input.bus.emit({
              kind: 'turn_complete',
              runId: input.runId,
              turn: assistantTurns,
              stopReason: 'tool_use_or_text',
            });
            break;
          }
          case 'result': {
            if (typeof m.result === 'string' && m.result && !text) text = m.result;
            finalUsage = usageFromAgentSdkResult(
              m.usage as {
                input_tokens?: number | null;
                output_tokens?: number | null;
                cache_creation_input_tokens?: number | null;
                cache_read_input_tokens?: number | null;
              },
            );
            const sub = m.subtype;
            if (sub === 'success') {
              finishedNormally = true;
            } else if (sub === 'error_max_turns') {
              incompleteKind = 'max_iterations';
              finishedNormally = false;
            } else if (typeof sub === 'string' && sub.startsWith('error')) {
              finishedNormally = false;
              const signal = authSignal ?? detectAuthShapedSdkError(m.errors);
              if (signal) throw this.authError(signal, input, assistantTurns);
            }
            break;
          }
          case 'system':
            await this.handleSystemMessage(m, input, {
              query: q,
              withAccountInfo: true,
              turn: assistantTurns,
            });
            break;
          default:
            break;
        }
      }
    } catch (e) {
      if (e instanceof Error && (e.name === 'AbortError' || ac.signal.aborted)) {
        userCancelled = true;
        input.bus.emit({ kind: 'cancelled', runId: input.runId });
      } else {
        throw e;
      }
    } finally {
      if (input.abort) input.abort.removeEventListener('abort', onAbort);
    }

    input.budget.recordUsage(finalUsage);
    input.onUsage?.(finalUsage);
    input.bus.emit({ kind: 'usage', runId: input.runId, turn: assistantTurns, usage: finalUsage });

    return {
      text,
      finishedNormally: userCancelled ? false : finishedNormally,
      iterations: assistantTurns,
      incompleteKind,
      finalUsage,
      userCancelled: userCancelled || undefined,
    };
  }

  async runScout<TSchema extends z.ZodType>(
    input: RunScoutInput<TSchema>,
  ): Promise<RunScoutOutput<z.infer<TSchema>> | null> {
    const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

    let scoutOutput: z.infer<TSchema> | null = null;
    const schemaFields = this.zodToFieldsObject(input.schema);

    const respondTool = tool(
      'respond_with_scout_result',
      'Respond with the scout selection by calling this tool exactly once. Do not call any other tool.',
      schemaFields,
      async (args) => {
        scoutOutput = args as z.infer<TSchema>;
        return { content: [{ type: 'text' as const, text: 'OK — scout result captured.' }] };
      },
    );

    const mcpServer = createSdkMcpServer({
      name: 'squad-kit-scout',
      version: '1.0.0',
      tools: [respondTool],
    });

    const ps = input.providerSpecific;
    const thinking = thinkingConfigFromProviderSpecific(ps);
    const effort = ps?.effort !== undefined ? sdkEffortFromPlanner(ps.effort) : sdkEffortFromPlanner('minimal');

    const queryOptions = {
      model: this.modelId,
      tools: [] as string[],
      disallowedTools: [...BUILTIN_TOOL_DENY],
      mcpServers: { 'squad-kit-scout': mcpServer },
      systemPrompt:
        input.systemPrompt +
        '\n\nIMPORTANT: respond by calling the `respond_with_scout_result` tool with the JSON object — do not write the JSON as text.',
      maxTurns: 2,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [] as [],
      env: buildSdkEnv(this.auth),
      thinking,
      effort,
    };

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let assistantTurns = 0;
    let authSignal: AuthShapedSdkError | undefined;
    const think = initialThinkingState();

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (input.abort) {
      if (input.abort.aborted) ac.abort();
      else input.abort.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const q = query({
        prompt: input.userMessage,
        options: { ...queryOptions, abortController: ac },
      });
      for await (const message of q) {
        const m = message as {
          type?: string;
          usage?: unknown;
          subtype?: string;
          event?: unknown;
          result?: string;
          error?: unknown;
          errors?: unknown;
        };
        switch (m.type) {
          case 'stream_event':
            handleDecodedStreamEvent(decodeStreamEvent(m.event), {
              bus: input.bus,
              runId: input.runId,
              assistantTurns,
              think,
            });
            break;
          case 'assistant':
            authSignal = detectAuthShapedSdkError(m.error) ?? authSignal;
            think.blockIndexCounter = 0;
            think.inThinkingBlock = false;
            think.thinkingBlockIndex = -1;
            think.thinkingChars = 0;
            assistantTurns += 1;
            break;
          case 'result':
            usage = usageFromAgentSdkResult(
              m.usage as {
                input_tokens?: number | null;
                output_tokens?: number | null;
                cache_creation_input_tokens?: number | null;
                cache_read_input_tokens?: number | null;
              },
            );
            if (typeof m.subtype === 'string' && m.subtype.startsWith('error')) {
              const signal = authSignal ?? detectAuthShapedSdkError(m.errors);
              if (signal) throw this.authError(signal, input, assistantTurns);
            }
            break;
          case 'system':
            // Scout never pays for the account lookup — draft covers it, on the same credential.
            await this.handleSystemMessage(m, input, {
              query: q,
              withAccountInfo: false,
              turn: assistantTurns,
            });
            break;
          default:
            break;
        }
      }
    } finally {
      if (input.abort) input.abort.removeEventListener('abort', onAbort);
    }

    if (!scoutOutput) return null;
    const parsed = input.schema.safeParse(scoutOutput);
    if (!parsed.success) return null;
    return { output: parsed.data as z.infer<TSchema>, usage };
  }

  private zodToFieldsObject(schema: z.ZodType): Record<string, z.ZodType> {
    if (schema instanceof z.ZodObject) {
      return schema.shape as Record<string, z.ZodType>;
    }
    return { payload: schema };
  }
}

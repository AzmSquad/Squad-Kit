export type PlannerPhase = 'plan' | 'execute';

export type ProviderName = 'anthropic' | 'openai' | 'google';

export interface PlannerModelOverride {
  anthropic?: string;
  openai?: string;
  google?: string;
}

export interface PlannerConfig {
  enabled: boolean;
  provider: ProviderName;
  mode: 'auto' | 'copy';
  budget: BudgetConfig;
  /**
   * Optional per-provider model override. When set, replaces the pinned MAP value
   * for the plan phase. Executors: used when providers deprecate a pinned snapshot
   * between squad-kit releases, or to trial a newer model ahead of pinning.
   */
  modelOverride?: PlannerModelOverride;
}

export interface BudgetConfig {
  maxFileReads: number;
  maxContextBytes: number;
  maxDurationSeconds: number;
  maxCostUsd?: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatTurn {
  role: ChatRole;
  text?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ProviderRequest {
  systemPrompt: string;
  model: string;
  tools: ToolSchema[];
  turns: ChatTurn[];
  maxOutputTokens?: number;
  apiKey: string;
}

export type ProviderErrorKind = 'rate_limit' | 'model_not_found' | 'unknown';

export interface ProviderResponse {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
  usage?: Usage;
  rawError?: string;
  /**
   * Structured error classification. Set by provider adapters when the shape of the error
   * is recognised; used by `runPlanner` to pick the right retry behaviour and the right
   * user-facing hint. Absent when the adapter did not classify the error.
   */
  errorKind?: ProviderErrorKind;
  /** For `errorKind === 'rate_limit'`: seconds the provider asked us to wait. */
  retryAfterSec?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface PlannerProvider {
  readonly name: ProviderName;
  send(req: ProviderRequest): Promise<ProviderResponse>;
}

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

export interface ProviderResponse {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
  usage?: Usage;
  rawError?: string;
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

/**
 * An AI tool: the agent that plays a role (Analyst, Architect, Builder, Reviewer, Tester). squad-kit starts it and
 * talks to it over ACP through its own gateway; each tool is one module that says how to start and set up its
 * agent (ADR-002). squad-kit never calls a model itself.
 */

/**
 * What a step lets its agent do. Roles ask for these sets, never for one tool's own permission names; each module
 * turns them into its tool's settings. squad-kit's own secret files and git that changes history are always off
 * limits, whatever the set.
 */
export type PermissionSet = 'read' | 'git-read' | 'edit';

export interface ToolEvent {
  name: string;
  input: Record<string, unknown>;
}

export interface AgentRun {
  cwd: string;
  prompt: string;
  /** Start a new saved conversation with this id. */
  sessionId?: string;
  /** Continue a saved conversation. */
  resume?: string;
  permissions: PermissionSet[];
  /** Files no agent may read or change, such as squad-kit's own secrets.yaml. */
  secretFiles?: string[];
  /** JSON Schema for the final answer; the answer comes back as `structured`. */
  schema?: object;
  /** Added to the tool's own instructions: the step's extras and the team's house rules. */
  instructions?: string;
  model?: string;
  addDirs?: string[];
  timeoutMs?: number;
  /** Stops the run when the person presses Stop. */
  signal?: AbortSignal;
  /** Where every update of the conversation is saved as it arrives. */
  logDir?: string;
  /** Run the tool its direct way instead of over ACP, when it has one. */
  direct?: boolean;
  onTool?(event: ToolEvent): void;
  onText?(text: string): void;
  /** Any sign of life, for the watchdog. */
  onActivity?(): void;
  /** The process id, so the watchdog can look at the commands it runs. */
  onSpawn?(pid: number): void;
  /** ACP could not start, so the step runs the tool's direct way. */
  onFallback?(why: string): void;
}

export interface AgentResult {
  ok: boolean;
  sessionId: string;
  text: string;
  structured?: unknown;
  error?: string;
}

export interface AiTool {
  /** The name in an agent file's `tool:` line. */
  readonly name: string;
  /** For people, for example "Claude Code". */
  readonly label: string;
  /** False for a tool squad-kit can find but cannot run yet. */
  readonly canRun: boolean;
  /** Installed and signed in, as far as squad-kit can tell without running it. */
  ready(): boolean;
  run(r: AgentRun): Promise<AgentResult>;
  /** One plain-words line for what a tool call is doing, or null to leave it out. */
  describe(e: ToolEvent, cwd: string): string | null;
}

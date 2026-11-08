/**
 * An AI tool: the agent that plays a role (Analyst, Architect, Builder, Reviewer, Tester). squad-kit starts it and
 * talks to it over ACP through its own gateway; each tool is one module that says how to start and set up its
 * agent (ADR-002). squad-kit never calls a model itself.
 */

/**
 * What a step lets its agent do. Roles ask for these sets, never for one tool's own permission names; each module
 * turns them into its tool's settings. squad-kit's own secret files and git that changes history are always off
 * limits, whatever the set. `run` may run any command (the app, a browser for screenshots) but has no file-editing
 * tools: what it changes in the code anyway, squad-kit puts back.
 */
export type PermissionSet = 'read' | 'git-read' | 'run' | 'edit';

/**
 * How strong a model a step needs (ADR-001): squad-kit speaks in levels, and each AI tool module maps them to its own
 * models, so the defaults work with any AI company.
 */
export type ModelLevel = 'strongest' | 'balanced' | 'fast';
export const MODEL_LEVELS: ModelLevel[] = ['strongest', 'balanced', 'fast'];

/** How hard the model thinks, where the tool supports it. "xhigh" is extra high, which not every tool has. */
export type Effort = 'xhigh' | 'high' | 'medium' | 'low';
/** Hardest first. */
export const EFFORTS: Effort[] = ['xhigh', 'high', 'medium', 'low'];

export interface ToolEvent {
  name: string;
  input: Record<string, unknown>;
}

/** One entry of the agent's own to-do list, as ACP's plan update sends the whole list each time it changes. */
export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * What a step's shell commands may reach, kept by the operating system where the AI tool has a sandbox. The engine
 * says which folders and hosts; each module turns that into its tool's own sandbox settings. The folder the run works
 * in is always writable.
 */
export interface SandboxAsk {
  /** Folders its commands may write in besides the one it works in: the proof folder, temp folders, package caches. */
  write: string[];
  /** Files and folders its commands may not read: keys, sign-ins, squad-kit's own files, the project's .env files. */
  noRead: string[];
  /** Folders inside those that the step still needs: the ticket's copy, its attachments. */
  read: string[];
  /** Files in a place it may write that it may never change: the copy's `.git`, which says where git's settings are. */
  noWrite: string[];
  /** The only hosts its commands may reach; "*.example.com" covers every subdomain. */
  hosts: string[];
}

/** Whether a tool can keep a step's commands in its sandbox on this computer, in words for people. */
export interface SandboxSupport {
  available: boolean;
  /** What keeps the commands in ("macOS Seatbelt"), or why there is no sandbox here. */
  why: string;
  /** What the person can do about it, when something can be done. */
  fix?: string;
}

/** The most one run may use before the tool stops it. Each tool keeps the caps it has and leaves out the others. */
export interface RunCaps {
  /** Agent turns: one model reply and the tool calls in it. */
  turns?: number;
  /** Spend in US dollars at the AI company's API prices, as the tool counts it. */
  spendUsd?: number;
}

/** Something a sandboxed command tried and was refused. */
export interface BlockedAction {
  kind: 'host' | 'read' | 'write';
  /** The host, or the file. */
  target: string;
}

/**
 * squad-kit's own tools for one run (the window), over MCP: where they answer, the run's key, the tool names, and the
 * command of the stdio bridge for an agent that cannot reach MCP over HTTP. The bridge reads the address and the key
 * from SQUAD_WINDOW_URL and SQUAD_WINDOW_KEY.
 */
export interface RunWindow {
  /** The server's name, as the agent sees its tools under it. */
  name: string;
  url: string;
  key: string;
  tools: string[];
  bridge: { command: string; args: string[] };
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
  /** Files and folders in the person's home no agent may read or change: keys and sign-ins. */
  privatePlaces?: string[];
  /**
   * Files and folders no agent may change, by name at any depth (a folder ends with a slash): the instructions and
   * settings later sessions load, and squad-kit's own folder.
   */
  protectedFiles?: string[];
  /** JSON Schema for the final answer; the answer comes back as `structured`. */
  schema?: object;
  /** Added to the tool's own instructions: the step's extras and the team's house rules. */
  instructions?: string;
  /** The level the step needs; the module picks its model for it. */
  level?: ModelLevel;
  effort?: Effort;
  /** An exact model someone picked; it wins over the level. */
  model?: string;
  addDirs?: string[];
  timeoutMs?: number;
  /** Stops the run when the person presses Stop. */
  signal?: AbortSignal;
  /** Where every update of the conversation is saved as it arrives. */
  logDir?: string;
  /** Run the tool its direct way instead of over ACP, when it has one. */
  direct?: boolean;
  /** Keep the run's shell commands in the tool's sandbox; left out, they run as the tool runs them. */
  sandbox?: SandboxAsk;
  /** More environment for the run's shell commands, such as where package managers keep their downloads. */
  env?: Record<string, string>;
  /** The most this run may use; reaching it stops the run with `capped`, not a failure. */
  caps?: RunCaps;
  /** squad-kit's own tools for this run, over MCP. */
  window?: RunWindow;
  onTool?(event: ToolEvent): void;
  /** A sandboxed command was refused something. */
  onBlocked?(action: BlockedAction): void;
  onText?(text: string): void;
  /** The agent's to-do list changed: all of it, in order, with where each entry stands. */
  onPlan?(entries: PlanEntry[]): void;
  /** Any sign of life, for the watchdog. */
  onActivity?(): void;
  /** The process id, so the watchdog can look at the commands it runs. */
  onSpawn?(pid: number): void;
  /** ACP could not start, so the step runs the tool's direct way. */
  onFallback?(why: string): void;
}

/**
 * What one run used, as the AI tool reports it, for the cost on the board (ADR-001). Each module fills in what its
 * tool says; anything it does not say is left out, because unknown is not zero.
 */
export interface AgentUsage {
  /** Tokens the model read, cached ones included. */
  inputTokens?: number;
  /** The part of inputTokens read back from the tool's cache, which costs less. */
  cachedTokens?: number;
  outputTokens?: number;
  /** What this run would cost at the AI company's API prices, in US dollars. Tools report it even on a subscription. */
  costUsd?: number;
}

/**
 * The AI account reached its usage limit. Nothing is wrong with the step: it can run again once the limit resets.
 * Each module reads its tool's own message; the engine only sees this.
 */
export interface UsageLimit {
  /** Whose limit, for people: "Claude". */
  name: string;
  /** When the limit resets (an ISO time), when the tool said. */
  resetsAt?: string;
}

/**
 * How the person pays for the tool's AI. A subscription has usage limits and no charge per run; per use (an API key, or
 * a cloud account) costs real money for every run. The Cost tab and the budgets follow it.
 */
export interface Billing {
  kind: 'subscription' | 'api-key';
  /** For people: "Claude Pro", "Anthropic API key", "AWS Bedrock". */
  label: string;
}

export interface AgentResult {
  ok: boolean;
  sessionId: string;
  text: string;
  structured?: unknown;
  /** What went wrong, in plain words. */
  error?: string;
  /** The tool's exact error, for engineers: the ticket's Developer tab and the app log. */
  detail?: string;
  /** Set when the run stopped on the account's usage limit. */
  limit?: UsageLimit;
  /** Set when the run stopped on one of its caps. The work so far is kept; the run can go on with more. */
  capped?: { by: 'turns' | 'spend' };
  /** What the run reported could not be saved (a full disk, a folder that moved), so it was stopped. The exact error. */
  saveError?: Error;
  /** Left out when the tool said nothing about what the run used. */
  usage?: AgentUsage;
}

export interface AiTool {
  /** The name in an agent file's `tool:` line. */
  readonly name: string;
  /** For people, for example "Claude Code". */
  readonly label: string;
  /** Whose plan pays for it, for people: "Claude" in "Included in your Claude plan". */
  readonly plan?: string;
  /** False for a tool squad-kit can find but cannot run yet. */
  readonly canRun: boolean;
  /** The tool's model for a level, as people know it ("Opus"), or empty when it has none. */
  modelFor(level: ModelLevel): string;
  readonly supportsEffort: boolean;
  /** The efforts the tool takes, when it has more than high, medium and low. A step asking for one it lacks gets the next one down. */
  readonly efforts?: readonly Effort[];
  /**
   * The files and folders the tool loads as instructions or settings from the folders it works in, by name at any
   * depth (a folder ends with a slash). No agent may change them: the next session would follow what it wrote.
   */
  readonly instructionFiles?: readonly string[];
  /**
   * The tool's own sign-in, history and settings with keys in them, under the person's home folder: the project's
   * own commands (tests, setup, the app) never read them, whatever an engineer allows.
   */
  privateFiles?(home: string): string[];
  /** The tool's keys and settings in the environment, by name, or by prefix with a trailing "*": kept out of the project's own commands. */
  readonly secretEnv?: readonly string[];
  /** Installed and signed in, as far as squad-kit can tell without running it. */
  ready(): boolean;
  /** The installed version, for Report a problem, or null when it is not installed. */
  version?(): string | null;
  /** Its sandbox on this computer. Left out, the tool has none and `sandbox` on a run is ignored. */
  sandbox?(): SandboxSupport;
  /** The caps it keeps on a run; any other cap in `caps` is ignored. */
  readonly caps?: { turns: boolean; spend: boolean };
  /** What its sandbox refused, from a command's output as the tool reports it. */
  blocked?(output: string): BlockedAction[];
  run(r: AgentRun): Promise<AgentResult>;
  /**
   * True when a run's `error` is one of the module's own plain sentences, not the tool's raw words: only those reach
   * the person's stop as they are (engine/plain-stop.ts).
   */
  ownWords?(said: string): boolean;
  /** True when these words are about a network or service problem that passes by itself, so the step just runs again later. */
  passing?(said: string): boolean;
  /** One plain-words line for what a tool call is doing, or null to leave it out. */
  describe(e: ToolEvent, cwd: string): string | null;
  /** How the person pays, as the tool says without running a model, or null when it cannot tell. */
  billing?(): Promise<Billing | null>;
  /** The terminal command that opens a saved conversation in the tool, to read it or carry on in it. */
  resumeCommand?(sessionId: string, cwd?: string): string;
}

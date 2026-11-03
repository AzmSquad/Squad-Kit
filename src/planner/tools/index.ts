import { randomUUID } from 'node:crypto';
import type { Budget } from '../budget.js';
import type { PlannerEventBus } from '../events.js';
import type { ToolCall } from '../types.js';
import type { ReadFileToolHooks, ReadFileToolOptions } from './read-file.js';
import {
  readFileTool,
  readFileToolFactory,
  READ_FILE_TOOL_DESCRIPTION,
  READ_FILE_TOOL_DESCRIPTION_WHOLE_ONLY,
  rangedReadFileSchema,
  fullReadFileSchema,
  readBudgetishError,
  PlannerUserCancelledError,
} from './read-file.js';
import { grepSchema, GREP_TOOL_DESCRIPTION, GREP_TOOL_NAME, grepToolFactory, runGrep } from './grep.js';
import {
  listDirSchema,
  LIST_DIR_TOOL_DESCRIPTION,
  LIST_DIR_TOOL_NAME,
  listDirToolFactory,
  runListDir,
} from './list-dir.js';
import { tool } from 'ai';
import type { PlannerToolDefinition } from '../runtimes/planner-tool-def.js';

export interface PlannerToolDefinitionsOpts {
  root: string;
  budget: Budget;
  enabled?: { rangedRead?: boolean; grep?: boolean; listDir?: boolean };
  getTurn: () => number;
  runId: string;
  bus: PlannerEventBus;
  onToolCall?: (tc: ToolCall, bytesLoaded: number, totalBytes: number) => void;
  decideOnLimit?: ReadFileToolHooks['decideOnLimit'];
  getLimitCtx: ReadFileToolHooks['getLimitCtx'];
  extendSessionLimits: ReadFileToolHooks['extendSessionLimits'];
  getAccumulatedText: ReadFileToolHooks['getAccumulatedText'];
  setBudgetExhausted: ReadFileToolHooks['setBudgetExhausted'];
}

export function buildPlannerToolDefinitions(opts: PlannerToolDefinitionsOpts): PlannerToolDefinition[] {
  const enabled = opts.enabled ?? { rangedRead: true, grep: true, listDir: true };
  const ranged = enabled.rangedRead ?? true;
  const defs: PlannerToolDefinition[] = [];

  const readParams = ranged ? rangedReadFileSchema : fullReadFileSchema;
  const readDesc = ranged ? READ_FILE_TOOL_DESCRIPTION : READ_FILE_TOOL_DESCRIPTION_WHOLE_ONLY;

  defs.push({
    name: 'read_file',
    description: readDesc,
    parameters: readParams,
    execute: async (args) => {
      const turn = opts.getTurn();
      const toolCallId = randomUUID();
      const startedAtMs = Date.now();
      const tc: ToolCall = {
        id: toolCallId,
        name: 'read_file',
        input: { path: args.path, offset: (args as { offset?: number }).offset, limit: (args as { limit?: number }).limit },
      };

      opts.bus.emit({
        kind: 'tool_call_started',
        runId: opts.runId,
        turn,
        toolCallId,
        name: 'read_file',
        input: tc.input,
      });

      try {
        const before = opts.budget.snapshot().bytes;
        let result = readFileTool(opts.root, opts.budget, args as { path?: unknown; offset?: unknown; limit?: unknown });
        let after = opts.budget.snapshot().bytes;
        let bytesLoaded = after - before;

        if (readBudgetishError(result)) {
          const decide = opts.decideOnLimit;
          if (decide) {
            const d = await decide(opts.getLimitCtx());
            if (d === 'cancel') {
              throw new PlannerUserCancelledError(opts.getAccumulatedText(), opts.runId, turn, 'budget_reads', tc, result);
            }
            opts.extendSessionLimits();
            result = readFileTool(opts.root, opts.budget, args as { path?: unknown; offset?: unknown; limit?: unknown });
            after = opts.budget.snapshot().bytes;
            bytesLoaded = after - before;
          } else {
            opts.setBudgetExhausted(true);
          }
        }

        opts.onToolCall?.(tc, bytesLoaded, after);
        opts.bus.emit({
          kind: 'tool_call',
          runId: opts.runId,
          turn,
          toolCall: tc,
          bytesLoaded,
          totalBytes: after,
        });

        const durationMs = Date.now() - startedAtMs;
        opts.bus.emit({
          kind: 'tool_call_completed',
          runId: opts.runId,
          turn,
          toolCallId,
          name: 'read_file',
          durationMs,
          bytesLoaded,
          totalBytes: after,
          isError: !!result.isError,
          errorSnippet: result.isError ? String(result.content).slice(0, 200) : undefined,
        });

        return { content: result.content, isError: result.isError };
      } catch (err) {
        const durationMs = Date.now() - startedAtMs;
        opts.bus.emit({
          kind: 'tool_call_completed',
          runId: opts.runId,
          turn,
          toolCallId,
          name: 'read_file',
          durationMs,
          bytesLoaded: 0,
          totalBytes: opts.budget.snapshot().bytes,
          isError: true,
          errorSnippet: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
        throw err;
      }
    },
  });

  if (enabled.grep) {
    defs.push({
      name: GREP_TOOL_NAME,
      description: GREP_TOOL_DESCRIPTION,
      parameters: grepSchema,
      execute: async (args) => {
        const turn = opts.getTurn();
        const toolCallId = randomUUID();
        const startedAtMs = Date.now();
        const tc: ToolCall = {
          id: toolCallId,
          name: GREP_TOOL_NAME,
          input: { ...args },
        };

        opts.bus.emit({
          kind: 'tool_call_started',
          runId: opts.runId,
          turn,
          toolCallId,
          name: GREP_TOOL_NAME,
          input: tc.input,
        });

        try {
          const before = opts.budget.snapshot().bytes;
          const out = runGrep(opts.root, opts.budget, {
            pattern: args.pattern,
            regex: args.regex ?? false,
            path: args.path,
            caseInsensitive: args.caseInsensitive ?? false,
          });
          const after = opts.budget.snapshot().bytes;
          const bytesLoaded = after - before;
          opts.onToolCall?.(tc, bytesLoaded, after);
          opts.bus.emit({
            kind: 'tool_call',
            runId: opts.runId,
            turn,
            toolCall: tc,
            bytesLoaded,
            totalBytes: after,
          });

          const durationMs = Date.now() - startedAtMs;
          opts.bus.emit({
            kind: 'tool_call_completed',
            runId: opts.runId,
            turn,
            toolCallId,
            name: GREP_TOOL_NAME,
            durationMs,
            bytesLoaded,
            totalBytes: after,
            isError: !!out.isError,
            errorSnippet: out.isError ? String(out.content).slice(0, 200) : undefined,
          });

          return { content: out.content, isError: out.isError };
        } catch (err) {
          const durationMs = Date.now() - startedAtMs;
          opts.bus.emit({
            kind: 'tool_call_completed',
            runId: opts.runId,
            turn,
            toolCallId,
            name: GREP_TOOL_NAME,
            durationMs,
            bytesLoaded: 0,
            totalBytes: opts.budget.snapshot().bytes,
            isError: true,
            errorSnippet: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          });
          throw err;
        }
      },
    });
  }

  if (enabled.listDir) {
    defs.push({
      name: LIST_DIR_TOOL_NAME,
      description: LIST_DIR_TOOL_DESCRIPTION,
      parameters: listDirSchema,
      execute: async (args) => {
        const turn = opts.getTurn();
        const toolCallId = randomUUID();
        const startedAtMs = Date.now();
        const tc: ToolCall = {
          id: toolCallId,
          name: LIST_DIR_TOOL_NAME,
          input: { path: args.path },
        };

        opts.bus.emit({
          kind: 'tool_call_started',
          runId: opts.runId,
          turn,
          toolCallId,
          name: LIST_DIR_TOOL_NAME,
          input: tc.input,
        });

        try {
          const before = opts.budget.snapshot().bytes;
          const out = runListDir(opts.root, opts.budget, args.path);
          const after = opts.budget.snapshot().bytes;
          const bytesLoaded = after - before;
          opts.onToolCall?.(tc, bytesLoaded, after);
          opts.bus.emit({
            kind: 'tool_call',
            runId: opts.runId,
            turn,
            toolCall: tc,
            bytesLoaded,
            totalBytes: after,
          });

          const durationMs = Date.now() - startedAtMs;
          opts.bus.emit({
            kind: 'tool_call_completed',
            runId: opts.runId,
            turn,
            toolCallId,
            name: LIST_DIR_TOOL_NAME,
            durationMs,
            bytesLoaded,
            totalBytes: after,
            isError: !!out.isError,
            errorSnippet: out.isError ? String(out.content).slice(0, 200) : undefined,
          });

          return { content: out.content, isError: out.isError };
        } catch (err) {
          const durationMs = Date.now() - startedAtMs;
          opts.bus.emit({
            kind: 'tool_call_completed',
            runId: opts.runId,
            turn,
            toolCallId,
            name: LIST_DIR_TOOL_NAME,
            durationMs,
            bytesLoaded: 0,
            totalBytes: opts.budget.snapshot().bytes,
            isError: true,
            errorSnippet: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          });
          throw err;
        }
      },
    });
  }

  return defs;
}

/** Map neutral definitions to Vercel AI `tool()` instances. */
export function vercelToolsFromDefinitions(defs: PlannerToolDefinition[]) {
  const out: Record<string, ReturnType<typeof tool>> = {};
  for (const def of defs) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.parameters,
      execute: async (args) => {
        const r = await def.execute(args);
        return typeof r === 'string' ? r : r;
      },
    }) as unknown as ReturnType<typeof tool>;
  }
  return out;
}

export {
  readFileTool,
  readFileToolFactory,
  READ_FILE_TOOL_NAME,
  PlannerUserCancelledError,
  looksBinary,
  MAX_BYTES_PER_FULL_READ,
} from './read-file.js';
export type { ReadFileResult, ReadFileToolHooks, ReadFileToolOptions } from './read-file.js';
export { grepToolFactory, GREP_TOOL_NAME } from './grep.js';
export { listDirToolFactory, LIST_DIR_TOOL_NAME } from './list-dir.js';

export interface ToolFactoryOptions {
  root: string;
  budget: Budget;
  enabled?: { rangedRead?: boolean; grep?: boolean; listDir?: boolean };
  readHooks: ReadFileToolHooks;
  grepHooks?: import('./grep.js').GrepToolHooks;
  listDirHooks?: import('./list-dir.js').ListDirToolHooks;
}

export function buildPlannerTools(opts: ToolFactoryOptions) {
  const enabled = opts.enabled ?? { rangedRead: true, grep: true, listDir: true };
  const gh =
    opts.grepHooks ??
    ({
      runId: opts.readHooks.runId,
      turn: opts.readHooks.turn,
      bus: opts.readHooks.bus,
      onToolCall: opts.readHooks.onToolCall,
    } satisfies import('./grep.js').GrepToolHooks);
  const lh =
    opts.listDirHooks ??
    ({
      runId: opts.readHooks.runId,
      turn: opts.readHooks.turn,
      bus: opts.readHooks.bus,
      onToolCall: opts.readHooks.onToolCall,
    } satisfies import('./list-dir.js').ListDirToolHooks);

  const readOpts: ReadFileToolOptions = { ranged: enabled.rangedRead ?? true };
  return {
    read_file: readFileToolFactory(opts.root, opts.budget, opts.readHooks, readOpts),
    ...(enabled.grep ? { grep: grepToolFactory(opts.root, opts.budget, gh) } : {}),
    ...(enabled.listDir ? { list_dir: listDirToolFactory(opts.root, opts.budget, lh) } : {}),
  };
}

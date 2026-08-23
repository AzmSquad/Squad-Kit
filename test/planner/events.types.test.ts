import { describe, it, expect } from 'vitest';
import type { PlannerEvent } from '../../src/planner/events.js';

function assertNever(x: never): never {
  throw new Error(`unexpected: ${JSON.stringify(x)}`);
}

describe('PlannerEvent taxonomy', () => {
  it('remains exhaustive for assertNever in switch (compile-time guard)', () => {
    const kindOf = (e: PlannerEvent): string => {
      switch (e.kind) {
        case 'started':
        case 'turn_started':
        case 'request_sent':
        case 'usage':
        case 'cache_summary':
        case 'tool_call':
        case 'assistant_text':
        case 'rate_limit':
        case 'turn_complete':
        case 'done':
        case 'error':
        case 'cancelled':
        case 'stage_started':
        case 'stage_complete':
        case 'scout_result':
        case 'runtime_info':
        case 'auth_info':
        case 'tool_call_started':
        case 'tool_call_completed':
        case 'thinking_delta':
        case 'thinking_block_started':
        case 'thinking_block_stopped':
        case 'validation_issue':
          return e.kind;
        default: {
          return assertNever(e);
        }
      }
    };

    expect(
      kindOf({ kind: 'runtime_info', runId: 'r', provider: 'anthropic', model: 'm', runtimeKind: 'agent-sdk', cacheEnabled: true, scoutEnabled: true, validationEnabled: true, budgetCaps: { maxFileReads: 1, maxContextBytes: 1, maxDurationSeconds: 1 } }),
    ).toBe('runtime_info');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
import { runPlanner } from '../src/planner/loop.js';
import { VercelRuntime } from '../src/planner/runtimes/vercel-runtime.js';
import { PlannerEventBus, type PlannerEvent } from '../src/planner/events.js';
import { Budget } from '../src/planner/budget.js';
import { textParts } from './support/model-stream.js';

/**
 * AI SDK 5 reports a failed tool, a bad tool input and a cancel as stream parts instead of failing the
 * stream, and prints errors and warnings by default. These pin that each one still stops the turn the
 * way the planner expects, quietly.
 */

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function queueModel(rounds: LanguageModelV2StreamPart[][]) {
  let i = 0;
  return new MockLanguageModelV2({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => {
      const chunks = rounds[i++];
      if (!chunks) throw new Error('mock stream queue exhausted');
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

function readCall(id: string, input: unknown): LanguageModelV2StreamPart {
  return { type: 'tool-call', toolCallId: id, toolName: 'read_file', input: JSON.stringify(input) };
}

let root: string;

function makeRoot() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-vercel-stops-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b', 'utf8');
  return root;
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function plan(model: MockLanguageModelV2, extra: Partial<Parameters<typeof runPlanner>[0]> = {}) {
  return runPlanner({
    root: makeRoot(),
    runtime: new VercelRuntime('anthropic', 'm', model, true),
    provider: 'anthropic',
    modelId: 'm',
    systemPrompt: 'sys',
    userPrompt: 'user',
    budget: new Budget({ maxFileReads: 25, maxContextBytes: 500_000, maxDurationSeconds: 120 }),
    validation: { enabled: false },
    ...extra,
  });
}

describe('VercelRuntime stops', () => {
  it('a cancel at the read limit ends the run as cancelled, keeping the text so far', async () => {
    const model = queueModel([
      [...textParts('Looking. '), readCall('t1', { path: 'a.txt' }), { type: 'finish', finishReason: 'tool-calls', usage }],
      [readCall('t2', { path: 'b.txt' }), { type: 'finish', finishReason: 'tool-calls', usage }],
    ]);
    const decideOnLimit = vi.fn().mockResolvedValue('cancel' as const);
    const result = await plan(model, {
      budget: new Budget({ maxFileReads: 1, maxContextBytes: 500_000, maxDurationSeconds: 120 }),
      decideOnLimit,
    });
    expect(decideOnLimit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file_or_context_reads' }));
    expect(result.userCancelled).toBe(true);
    expect(result.incompleteKind).toBe('budget_reads');
    expect(result.finishedNormally).toBe(false);
    expect(result.planText).toBe('Looking. ');
  });

  it('a tool input that breaks the schema stops the run with the validation error', async () => {
    const model = queueModel([
      [readCall('t1', { path: 'a.txt', offset: 2 }), { type: 'finish', finishReason: 'tool-calls', usage }],
    ]);
    const err = await plan(model).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AI_InvalidToolInputError', toolName: 'read_file' });
    expect((err as Error).message).toMatch(/Provide both offset and limit/);
  });

  it('a call to a tool the planner does not have stops the run', async () => {
    const model = queueModel([
      [
        { type: 'tool-call', toolCallId: 't1', toolName: 'write_file', input: '{"path":"x"}' },
        { type: 'finish', finishReason: 'tool-calls', usage },
      ],
    ]);
    const err = await plan(model).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AI_NoSuchToolError', toolName: 'write_file' });
  });

  it('a cancel during the stream ends the run as cancelled', async () => {
    const ac = new AbortController();
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const p of textParts('partial ')) controller.enqueue(p);
            abortSignal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
            ac.abort();
          },
        }),
      }),
    });
    const bus = new PlannerEventBus();
    const events: PlannerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const result = await plan(model, { abort: ac.signal, events: bus });
    expect(result.userCancelled).toBe(true);
    expect(result.finishedNormally).toBe(false);
    expect(events.some((e) => e.kind === 'cancelled')).toBe(true);
  });

  it('prints nothing of its own when the provider fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const model = new MockLanguageModelV2({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        throw new APICallError({
          message: 'boom',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode: 500,
          responseBody: '{"error":"boom"}',
        });
      },
    });
    await expect(plan(model)).rejects.toThrow(/anthropic 500/);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

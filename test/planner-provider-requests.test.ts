import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlanner } from '../src/planner/loop.js';
import { VercelRuntime } from '../src/planner/runtimes/vercel-runtime.js';
import { runScout } from '../src/planner/stages/scout.js';
import { Budget } from '../src/planner/budget.js';
import { PlannerEventBus } from '../src/planner/events.js';
import type { ProviderName } from '../src/planner/types.js';
import { fakeProviderHttp, type RecordedRequest } from './support/fake-provider-http.js';

/**
 * What the direct-API planner sends to each provider, through the real provider adapters and a fake
 * HTTP API. Pins the request shape kept across the AI SDK 5 / zod 4 move: endpoints, tools, sampling,
 * token caps, tool results and cache markers.
 */

const MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5',
  google: 'gemini-2.5-pro',
};

const SCOUT = { selectedFiles: ['hello.txt'], reasoning: 'only file', suggestedReadStrategy: 'read_full' };

const budgetCfg = { maxFileReads: 25, maxContextBytes: 500_000, maxDurationSeconds: 120 };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-provider-requests-'));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'world\n', 'utf8');
  // Other tools set these; the planner must still call the public APIs.
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://proxy.invalid');
  vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.invalid');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function planOnce(provider: ProviderName) {
  const fake = fakeProviderHttp(provider, {
    scoutObject: SCOUT,
    turns: [
      {
        text: 'Reading. ',
        calls: [
          { id: 'call_1', name: 'read_file', input: { path: 'hello.txt' } },
          { id: 'call_2', name: 'read_file', input: { path: 'missing.txt' } },
        ],
      },
      { text: '# Plan\n' },
    ],
  });
  vi.stubGlobal('fetch', fake.fetch);
  const modelId = MODEL[provider];
  const result = await runPlanner({
    root,
    runtime: new VercelRuntime(provider, modelId, 'test-key'),
    provider,
    modelId,
    systemPrompt: 'SYSTEM PROMPT',
    userPrompt: 'USER PROMPT',
    budget: new Budget(budgetCfg),
    events: new PlannerEventBus(),
    scoutSystemPrompt: 'SCOUT SYSTEM',
    stages: { scout: { enabled: true, runtime: new VercelRuntime(provider, modelId, 'test-key'), modelId } },
    validation: { enabled: false },
    maxOutputTokens: 4096,
  });
  const [scout, draft1, draft2] = fake.requests as [RecordedRequest, RecordedRequest, RecordedRequest];
  expect(fake.requests).toHaveLength(3);
  return { result, scout, draft1, draft2 };
}

/** Tool name → JSON schema, whatever the provider calls the wrapper. */
function toolSchemas(provider: ProviderName, body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  if (provider === 'anthropic') for (const t of body.tools) out[t.name] = t.input_schema;
  if (provider === 'openai') for (const t of body.tools) out[t.function.name] = t.function.parameters;
  if (provider === 'google') for (const t of body.tools[0].functionDeclarations) out[t.name] = t.parameters;
  return out;
}

describe.each(['anthropic', 'openai', 'google'] as const)('planner requests to %s', (provider) => {
  it('plans end to end: scout answer parsed, tool read, plan text kept', async () => {
    const { result } = await planOnce(provider);
    expect(result.scout?.selected).toEqual(['hello.txt']);
    expect(result.scout?.reasoning).toBe('only file');
    expect(result.planText).toBe('Reading. # Plan\n');
    expect(result.finishedNormally).toBe(true);
  });

  it('calls the public API endpoints', async () => {
    const { scout, draft1 } = await planOnce(provider);
    if (provider === 'anthropic') {
      expect(scout.url).toBe('https://api.anthropic.com/v1/messages');
      expect(draft1.url).toBe('https://api.anthropic.com/v1/messages');
    } else if (provider === 'openai') {
      // Chat Completions, not the Responses API the provider now defaults to.
      expect(scout.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(draft1.url).toBe('https://api.openai.com/v1/chat/completions');
    } else {
      expect(scout.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
      expect(draft1.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
      );
    }
  });

  it('sends the three planner tools with their fields; defaulted grep flags stay optional', async () => {
    const { draft1 } = await planOnce(provider);
    const tools = toolSchemas(provider, draft1.body);
    expect(Object.keys(tools)).toEqual(['read_file', 'grep', 'list_dir']);
    expect(Object.keys(tools.read_file.properties)).toEqual(['path', 'offset', 'limit']);
    expect(tools.read_file.required).toEqual(['path']);
    expect(Object.keys(tools.grep.properties)).toEqual(['pattern', 'regex', 'path', 'caseInsensitive']);
    expect(tools.grep.required).toEqual(['pattern']);
    expect(tools.list_dir.required).toEqual(['path']);
  });

  it('keeps the token caps and temperature 0', async () => {
    const { scout, draft1 } = await planOnce(provider);
    if (provider === 'anthropic') {
      expect(scout.body).toMatchObject({ max_tokens: 2048, temperature: 0 });
      expect(draft1.body).toMatchObject({ max_tokens: 4096, temperature: 0 });
    } else if (provider === 'openai') {
      // gpt-5 is a reasoning model: OpenAI takes no temperature for it, before and after.
      expect(scout.body.max_completion_tokens).toBe(2048);
      expect(draft1.body.max_completion_tokens).toBe(4096);
      expect(draft1.body).not.toHaveProperty('temperature');
    } else {
      expect(scout.body.generationConfig).toMatchObject({ maxOutputTokens: 2048, temperature: 0 });
      expect(draft1.body.generationConfig).toMatchObject({ maxOutputTokens: 4096, temperature: 0 });
    }
  });

  it('sends the scout schema as structured output', async () => {
    const { scout } = await planOnce(provider);
    let schema: Record<string, any>;
    if (provider === 'anthropic') {
      expect(scout.body.tool_choice).toMatchObject({ type: 'tool', name: 'json' });
      schema = scout.body.tools[0].input_schema;
    } else if (provider === 'openai') {
      expect(scout.body.response_format.type).toBe('json_schema');
      schema = scout.body.response_format.json_schema.schema;
    } else {
      expect(scout.body.generationConfig.responseMimeType).toBe('application/json');
      schema = scout.body.generationConfig.responseSchema;
    }
    expect(schema.required).toEqual(['selectedFiles', 'reasoning', 'suggestedReadStrategy']);
    expect(schema.properties.suggestedReadStrategy.enum).toEqual(['read_full', 'read_ranges', 'mixed']);
  });

  it('replays tool calls and tool results on the next turn', async () => {
    const { draft2 } = await planOnce(provider);
    // Anthropic and OpenAI get the tool output JSON-encoded, as the planner always sent it; Google takes it as is.
    const encoded = JSON.stringify('world\n');
    if (provider === 'anthropic') {
      const results = draft2.body.messages.at(-1).content;
      expect(results.map((r: { tool_use_id: string }) => r.tool_use_id)).toEqual(['call_1', 'call_2']);
      expect(results[0].content).toBe(encoded);
      expect(results[0].is_error).toBeUndefined();
      expect(results[1].is_error).toBe(true);
    } else if (provider === 'openai') {
      const assistant = draft2.body.messages.find((m: { role: string }) => m.role === 'assistant');
      expect(assistant.tool_calls[0].function).toEqual({ name: 'read_file', arguments: '{"path":"hello.txt"}' });
      const tool = draft2.body.messages.filter((m: { role: string }) => m.role === 'tool');
      expect(tool.map((m: { tool_call_id: string }) => m.tool_call_id)).toEqual(['call_1', 'call_2']);
      expect(tool[0].content).toBe(encoded);
    } else {
      const model = draft2.body.contents.find((c: { role: string }) => c.role === 'model');
      expect(model.parts[1].functionCall).toMatchObject({ name: 'read_file', args: { path: 'hello.txt' } });
      const answers = draft2.body.contents.at(-1).parts;
      expect(answers[0].functionResponse).toMatchObject({ name: 'read_file', response: { name: 'read_file', content: 'world\n' } });
    }
  });
});

describe('Anthropic cache markers on the wire', () => {
  it('marks the system prompt, the scouted context and the last tool result', async () => {
    const { draft2 } = await planOnce('anthropic');
    expect(draft2.body.system).toEqual([{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }]);
    const firstUser = draft2.body.messages[0].content;
    expect(firstUser[0]).toEqual({ type: 'text', text: 'USER PROMPT' });
    expect(firstUser[1].text).toMatch(/^I have already scouted the project/);
    expect(firstUser[1].cache_control).toEqual({ type: 'ephemeral' });
    const results = draft2.body.messages.at(-1).content;
    expect(results[0].cache_control).toBeUndefined();
    expect(results.at(-1).cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('scout structured output', () => {
  it.each(['anthropic', 'openai', 'google'] as const)('%s: an answer that breaks the schema gives no scout', async (provider) => {
    const fake = fakeProviderHttp(provider, { turns: [], scoutObject: { selectedFiles: [], reasoning: '' } });
    vi.stubGlobal('fetch', fake.fetch);
    const out = await runScout({
      runtime: new VercelRuntime(provider, MODEL[provider], 'test-key'),
      systemPrompt: 's',
      userPrompt: 'u',
      budget: new Budget(budgetCfg),
      bus: new PlannerEventBus(),
      runId: 'r',
    });
    expect(out).toBeNull();
  });

  it.each(['anthropic', 'openai', 'google'] as const)('%s: a valid answer is parsed with its usage', async (provider) => {
    const fake = fakeProviderHttp(provider, { turns: [], scoutObject: SCOUT });
    vi.stubGlobal('fetch', fake.fetch);
    const out = await runScout({
      runtime: new VercelRuntime(provider, MODEL[provider], 'test-key'),
      systemPrompt: 's',
      userPrompt: 'u',
      budget: new Budget(budgetCfg),
      bus: new PlannerEventBus(),
      runId: 'r',
    });
    expect(out).toEqual({ output: SCOUT, usage: { inputTokens: 11, outputTokens: 7 } });
  });
});

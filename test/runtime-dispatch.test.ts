import { describe, it, expect } from 'vitest';
import { resolveRuntime, PlannerAuthRuntimeMismatchError } from '../src/planner/runtimes/index.js';
import { AgentSdkRuntime } from '../src/planner/runtimes/agent-sdk-runtime.js';
import { VercelRuntime } from '../src/planner/runtimes/vercel-runtime.js';
import { apiKeyAuth, subscriptionAuth } from './support/planner-auth-fixtures.js';

describe('resolveRuntime', () => {
  it('returns AgentSdkRuntime for anthropic + agent-sdk', () => {
    const rt = resolveRuntime({
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
      auth: apiKeyAuth('sk-test'),
      anthropicRuntime: 'agent-sdk',
    });
    expect(rt).toBeInstanceOf(AgentSdkRuntime);
    expect(rt.kind).toBe('agent-sdk');
    expect(rt.providerName).toBe('anthropic');
    expect(rt.modelId).toBe('claude-opus-4-7');
  });

  it('returns VercelRuntime for anthropic + vercel', () => {
    const rt = resolveRuntime({
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
      auth: apiKeyAuth('sk-test'),
      anthropicRuntime: 'vercel',
    });
    expect(rt).toBeInstanceOf(VercelRuntime);
    expect(rt.kind).toBe('vercel');
    expect(rt.providerName).toBe('anthropic');
  });

  it('returns VercelRuntime for openai regardless of anthropicRuntime flag', () => {
    const rt = resolveRuntime({
      provider: 'openai',
      modelId: 'gpt-4o',
      auth: apiKeyAuth('sk-test'),
      anthropicRuntime: 'agent-sdk',
    });
    expect(rt).toBeInstanceOf(VercelRuntime);
    expect(rt.kind).toBe('vercel');
    expect(rt.providerName).toBe('openai');
  });

  it('returns VercelRuntime for google regardless of anthropicRuntime flag', () => {
    const rt = resolveRuntime({
      provider: 'google',
      modelId: 'gemini-2.0-flash',
      auth: apiKeyAuth('x'),
      anthropicRuntime: 'agent-sdk',
    });
    expect(rt).toBeInstanceOf(VercelRuntime);
    expect(rt.kind).toBe('vercel');
    expect(rt.providerName).toBe('google');
  });

  it('constructs the Agent SDK runtime for subscription + anthropic + agent-sdk', () => {
    const rt = resolveRuntime({
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
      auth: subscriptionAuth(),
      anthropicRuntime: 'agent-sdk',
    });
    expect(rt).toBeInstanceOf(AgentSdkRuntime);
  });

  it('throws before any network call for subscription + vercel runtime', () => {
    expect(() =>
      resolveRuntime({
        provider: 'anthropic',
        modelId: 'claude-opus-4-7',
        auth: subscriptionAuth(),
        anthropicRuntime: 'vercel',
      }),
    ).toThrow(PlannerAuthRuntimeMismatchError);
    try {
      resolveRuntime({
        provider: 'anthropic',
        modelId: 'claude-opus-4-7',
        auth: subscriptionAuth(),
        anthropicRuntime: 'vercel',
      });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('planner.runtime.anthropic: vercel');
      expect(msg).toContain('planner.auth.anthropic: api-key');
      expect(msg).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('throws for subscription + a non-anthropic provider', () => {
    expect(() =>
      resolveRuntime({ provider: 'openai', modelId: 'gpt-4o', auth: subscriptionAuth() }),
    ).toThrow(PlannerAuthRuntimeMismatchError);
  });

  it('defaults anthropic to agent-sdk when anthropicRuntime omitted', () => {
    const rt = resolveRuntime({
      provider: 'anthropic',
      modelId: 'm',
      auth: apiKeyAuth('sk-test'),
    });
    expect(rt).toBeInstanceOf(AgentSdkRuntime);
    expect(rt.kind).toBe('agent-sdk');
  });
});

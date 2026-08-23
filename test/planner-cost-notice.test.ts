import { describe, it, expect, vi, afterEach } from 'vitest';
import { printPlannerApiCostNotice } from '../src/planner/planner-limit-messages.js';

function capture(mode?: 'subscription' | 'api-key'): string {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((c: string | Uint8Array) => {
      chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
      return true;
    }) as typeof process.stderr.write);
  try {
    if (mode) printPlannerApiCostNotice(mode);
    else printPlannerApiCostNotice();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('printPlannerApiCostNotice', () => {
  it('tells subscription users about usage limits and never claims a per-token bill', () => {
    const out = capture('subscription');
    expect(out).toContain('usage limits');
    expect(out).toContain('no per-token API bill');
    expect(out).toContain('waiting for the reset');
    expect(out).not.toContain('billed');
    // Never promise "free" or "unlimited".
    expect(out).not.toMatch(/\bfree\b/i);
    expect(out).not.toMatch(/\bunlimited\b/i);
  });

  it('keeps the 0.11.0 api-key copy unchanged', () => {
    const out = capture('api-key');
    expect(out).toContain('Billing');
    expect(out).toContain('billed like any other API usage');
    expect(out).not.toContain('usage limits');
  });

  it('defaults to the api-key copy when no mode is given', () => {
    expect(capture()).toContain('billed like any other API usage');
  });
});

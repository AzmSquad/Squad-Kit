import { describe, it, expect } from 'vitest';
import { planFileParam } from './plan-route';

describe('planFileParam', () => {
  it('reduces a workspace-relative plan path to the route param', () => {
    expect(planFileParam('.squad/plans/tenancy/01-story-142.md')).toBe('01-story-142.md');
  });

  it('leaves an already-bare file name alone', () => {
    expect(planFileParam('01-story-142.md')).toBe('01-story-142.md');
  });

  it('handles windows separators', () => {
    expect(planFileParam('.squad\\plans\\tenancy\\01-story-142.md')).toBe('01-story-142.md');
  });

  it('falls back to the input rather than returning empty', () => {
    expect(planFileParam('')).toBe('');
    expect(planFileParam('plans/')).toBe('plans/');
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import yaml from 'js-yaml';

/**
 * GitHub's checks cannot run from a laptop, so their shape is checked here: Linux is the check that counts, under its
 * old name, and the Mac runs the same steps but reports only, so it can block nothing until its results are known.
 */

interface Job {
  'runs-on': string;
  'continue-on-error'?: boolean;
  needs?: unknown;
  strategy?: unknown;
  steps: { uses?: string; run?: string; with?: Record<string, unknown> }[];
}

const ci = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8')) as { on: unknown; jobs: Record<string, Job> };

describe('the GitHub checks', () => {
  it('has the Linux job under its old name, with nothing that lets it fail quietly', () => {
    const test = ci.jobs.test!;
    expect(test['runs-on']).toBe('ubuntu-latest');
    expect(test['continue-on-error']).toBeUndefined();
    // A matrix would rename the check to "test (ubuntu-latest)".
    expect(test.strategy).toBeUndefined();
    expect(test.steps.map((s) => s.run).filter(Boolean)).toEqual(['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm build', 'pnpm test']);
  });

  it('runs the same steps on a Mac, report only, and nothing waits for it', () => {
    const mac = ci.jobs['test-mac']!;
    expect(mac['runs-on']).toBe('macos-latest');
    expect(mac['continue-on-error']).toBe(true);
    expect(mac.steps).toEqual(ci.jobs.test!.steps);
    expect(Object.keys(ci.jobs).sort()).toEqual(['test', 'test-mac']);
    expect(ci.jobs.test!.needs).toBeUndefined();
    expect(mac.needs).toBeUndefined();
  });

  it('every step outside the repo stays pinned to one commit', () => {
    for (const job of Object.values(ci.jobs)) {
      for (const s of job.steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

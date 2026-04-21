import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPlans, formatSequence } from '../src/core/sequence.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-seq-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function touch(rel: string): void {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# plan\n');
}

describe('scanPlans', () => {
  it('returns 1 for an empty plans dir', () => {
    const out = scanPlans(tmp);
    expect(out.maxNumber).toBe(0);
    expect(out.nextGlobal).toBe(1);
    expect(out.duplicates).toEqual([]);
  });

  it('computes next global NN across features', () => {
    touch('feature-a/01-story-alpha.md');
    touch('feature-a/02-story-beta.md');
    touch('feature-b/03-story-gamma.md');
    const out = scanPlans(tmp);
    expect(out.maxNumber).toBe(3);
    expect(out.nextGlobal).toBe(4);
    expect(out.usedNumbers).toEqual([1, 2, 3]);
  });

  it('detects duplicate NN across features', () => {
    touch('feature-a/05-story-alpha.md');
    touch('feature-b/05-story-beta.md');
    const out = scanPlans(tmp);
    expect(out.duplicates).toEqual([5]);
    expect(out.nextGlobal).toBe(6);
  });

  it('ignores non-story files', () => {
    touch('feature-a/00-overview.md');
    touch('feature-a/README.md');
    touch('feature-a/01-story-alpha.md');
    const out = scanPlans(tmp);
    expect(out.usedNumbers).toEqual([1]);
  });

  it('handles 3-digit sequence numbers', () => {
    touch('feature-a/099-story-alpha.md');
    touch('feature-a/100-story-beta.md');
    const out = scanPlans(tmp);
    expect(out.nextGlobal).toBe(101);
  });
});

describe('formatSequence', () => {
  it('pads to 2 digits', () => {
    expect(formatSequence(1)).toBe('01');
    expect(formatSequence(15)).toBe('15');
  });
  it('does not truncate 3-digit numbers', () => {
    expect(formatSequence(100)).toBe('100');
  });
});

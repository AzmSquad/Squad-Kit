import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adfToPlainText } from '../src/tracker/adf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadComplexAdf(): unknown {
  const raw = readFileSync(path.join(__dirname, 'fixtures/jira/issue-adf-complex.json'), 'utf8');
  return JSON.parse(raw) as unknown;
}

describe('adfToPlainText', () => {
  it('returns empty string for null', () => {
    expect(adfToPlainText(null)).toBe('');
  });

  it('walks complex ADF in order with blank lines between blocks', () => {
    const result = adfToPlainText(loadComplexAdf());
    const chunks = ['Section title', 'Alpha bullet', 'Beta bullet', 'Inside unknown wrapper'];
    let lastIdx = -1;
    for (const chunk of chunks) {
      expect(result).toContain(chunk);
      const idx = result.indexOf(chunk);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    // Block separation: at least one double newline between first and second chunk regions
    const a = result.indexOf('Section title');
    const b = result.indexOf('Alpha bullet');
    expect(result.slice(a, b)).toMatch(/\n\n/);
  });

  it('does not throw on unknown node types; walks their content', () => {
    const node = {
      type: 'unknownExtension',
      content: [{ type: 'text', text: 'nested' }],
    };
    expect(() => adfToPlainText(node)).not.toThrow();
    expect(adfToPlainText(node)).toContain('nested');
  });
});

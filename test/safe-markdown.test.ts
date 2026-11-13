import { describe, expect, it } from 'vitest';
import { plainMarkdown } from '../src/core/safe-markdown.js';

/**
 * What an agent or a person wrote, put in Markdown a code host shows (ADR-007): it reads as written, and can never load
 * an address, look like squad-kit's own lines, or call anyone in.
 */
describe('plain text in Markdown', () => {
  it('reads as written: words, numbers, file paths and code names', () => {
    expect(plainMarkdown('Round once, after tax: 249.995 shows as 250.00.')).toBe('Round once, after tax: 249.995 shows as 250.00.');
    expect(plainMarkdown('src/payments/charge.ts line 42')).toBe('src/payments/charge.ts line 42');
    expect(plainMarkdown('المبلغ يتقرّب قبل إضافة الضريبة')).toBe('المبلغ يتقرّب قبل إضافة الضريبة');
  });

  it('is one paragraph, with no heading, list, quote, table or code fence of its own', () => {
    expect(plainMarkdown('# Approved\n\n- [x] done\n> quote\n| a | b |\n```js\nx\n```')).toBe('\\# Approved - \\[x\\] done &gt; quote \\| a \\| b \\| \\`\\`\\`js x \\`\\`\\`');
    expect(plainMarkdown('1. first')).toBe('1. first'.replace(/^1\./, '1\\.'));
    expect(plainMarkdown('- item')).toBe('\\- item');
  });

  it('never makes a link, a picture, HTML or a mention', () => {
    expect(plainMarkdown('see https://x.example/a?d=secret and ftp://y.example')).toBe('see x.example (link left out) and y.example (link left out)'.replace(/[()]/g, '\\$&'));
    expect(plainMarkdown('<script>alert(1)</script>')).toBe('&lt;script&gt;alert\\(1\\)&lt;/script&gt;');
    expect(plainMarkdown('ask @momen or sara@example.com')).toBe('ask ＠momen or sara＠example.com');
    expect(plainMarkdown('a'.repeat(30), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});

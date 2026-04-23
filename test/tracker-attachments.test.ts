import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeFilename, downloadAttachmentsWith } from '../src/tracker/attachments.js';
import type { AttachmentRef } from '../src/tracker/types.js';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fetch must be stubbed in this test'))) as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sanitizeFilename', () => {
  it('strips path separators and leading dots; preserves extension; truncates; never empty', () => {
    expect(sanitizeFilename('..\\..\\evil.txt')).toBe('evil.txt');
    expect(sanitizeFilename('/tmp/.././nice.png')).toBe('nice.png');
    expect(sanitizeFilename('...hidden')).toBe('hidden');
    expect(sanitizeFilename('a'.repeat(200) + '.md')).toHaveLength(180);
    expect(sanitizeFilename('   ')).toBe('attachment');
    expect(sanitizeFilename('..')).toBe('attachment');
  });
});

describe('downloadAttachmentsWith', () => {
  it('writes a small file and returns written outcome', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-att-'));
    const body = Buffer.from('hello');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch,
    );

    const refs: AttachmentRef[] = [{ filename: 'a.bin', url: 'https://x.test/file', size: body.length }];
    const out = await downloadAttachmentsWith(refs, dir, { authorization: 'Basic x' });

    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe('written');
    expect(out[0]!.bytesWritten).toBe(5);
    expect(out[0]!.absolutePath).toBeDefined();
    expect(fs.readFileSync(out[0]!.absolutePath!, 'utf8')).toBe('hello');
  });

  it('skips when declared size exceeds cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-att-'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const refs: AttachmentRef[] = [
      { filename: 'huge.bin', url: 'https://x.test/huge', size: 11 * 1024 * 1024 },
    ];
    const out = await downloadAttachmentsWith(refs, dir, { a: 'b' }, { maxMegabytes: 10 });

    expect(out[0]!.outcome).toBe('skipped-oversize');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('maps fetch throw to skipped-error with network in skipReason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-att-'));
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('boom'))));

    const out = await downloadAttachmentsWith(
      [{ filename: 'x', url: 'https://x', size: 1 }],
      dir,
      {},
    );
    expect(out[0]!.outcome).toBe('skipped-error');
    expect(out[0]!.skipReason).toMatch(/network/i);
  });

  it('maps non-ok HTTP to skipped-error with status in skipReason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-att-'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));

    const out = await downloadAttachmentsWith([{ filename: 'x', url: 'https://x', size: 0 }], dir, {});
    expect(out[0]!.outcome).toBe('skipped-error');
    expect(out[0]!.skipReason).toContain('HTTP 403');
  });

  it('uses name (1).ext on collision', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-att-'));
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return new Response(Buffer.from(`b${call}`), { status: 200 });
      }),
    );

    const refs: AttachmentRef[] = [
      { filename: 'same.txt', url: 'https://x/1', size: 2 },
      { filename: 'same.txt', url: 'https://x/2', size: 2 },
    ];
    const out = await downloadAttachmentsWith(refs, dir, {});

    expect(out[0]!.absolutePath).toBe(path.join(dir, 'same.txt'));
    expect(out[1]!.absolutePath).toBe(path.join(dir, 'same (1).txt'));
    expect(fs.readFileSync(out[0]!.absolutePath!, 'utf8')).toBe('b1');
    expect(fs.readFileSync(out[1]!.absolutePath!, 'utf8')).toBe('b2');
  });

  it('still downloads second file when first is oversize', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-att-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.from('ok'), { status: 200 })),
    );

    const refs: AttachmentRef[] = [
      { filename: 'big.bin', url: 'https://x/b', size: 20 * 1024 * 1024 },
      { filename: 'small.bin', url: 'https://x/s', size: 2 },
    ];
    const out = await downloadAttachmentsWith(refs, dir, {}, { maxMegabytes: 10 });

    expect(out[0]!.outcome).toBe('skipped-oversize');
    expect(out[1]!.outcome).toBe('written');
    expect(out[1]!.bytesWritten).toBe(2);
  });
});

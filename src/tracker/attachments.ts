import fs from 'node:fs';
import path from 'node:path';
import type { AttachmentRef, DownloadedAttachment, DownloadOptions } from './types.js';

const DEFAULT_MAX_MB = 10;

export async function downloadAttachmentsWith(
  refs: AttachmentRef[],
  targetDir: string,
  authHeaders: Record<string, string>,
  opts: DownloadOptions = {},
): Promise<DownloadedAttachment[]> {
  const maxMb = opts.maxMegabytes ?? DEFAULT_MAX_MB;
  const maxBytes = maxMb * 1024 * 1024;
  fs.mkdirSync(targetDir, { recursive: true });

  const out: DownloadedAttachment[] = [];
  for (const ref of refs) {
    out.push(await one(ref, targetDir, authHeaders, maxBytes, maxMb));
  }
  return out;
}

async function one(
  ref: AttachmentRef,
  targetDir: string,
  headers: Record<string, string>,
  maxBytes: number,
  maxMb: number,
): Promise<DownloadedAttachment> {
  if (ref.size > 0 && ref.size > maxBytes) {
    return {
      source: ref,
      outcome: 'skipped-oversize',
      bytesWritten: 0,
      skipReason: `${formatMb(ref.size)} exceeds cap (${maxMb} MB)`,
    };
  }

  const safeName = sanitizeFilename(ref.filename);
  const dest = uniqueDestination(targetDir, safeName);

  let res: Response;
  try {
    res = await fetch(ref.url, { headers });
  } catch (err) {
    return {
      source: ref,
      outcome: 'skipped-error',
      bytesWritten: 0,
      skipReason: `network error: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    return {
      source: ref,
      outcome: 'skipped-error',
      bytesWritten: 0,
      skipReason: `HTTP ${res.status}`,
    };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    return {
      source: ref,
      outcome: 'skipped-oversize',
      bytesWritten: 0,
      skipReason: `${formatMb(buf.byteLength)} after download exceeds cap (${maxMb} MB)`,
    };
  }

  fs.writeFileSync(dest, buf);
  return {
    source: ref,
    outcome: 'written',
    bytesWritten: buf.byteLength,
    absolutePath: dest,
  };
}

/**
 * Strips path separators, leading dots, and control characters.
 * Preserves a sensible extension. Never returns an empty string.
 */
export function sanitizeFilename(raw: string): string {
  const normalized = raw.replace(/\\/g, '/');
  const base = path.basename(normalized).replace(/[\\/]/g, '_');
  const cleaned = base
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '') // no leading dots
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return 'attachment';
  return cleaned.slice(0, 180); // keep filesystems happy
}

function uniqueDestination(dir: string, name: string): string {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = 1;
  while (fs.existsSync(candidate) && n < 1000) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

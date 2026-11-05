import fs from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * squad-kit checks each proof screenshot itself, so the Tester cannot hand in a picture that proves nothing: it must be
 * a real image of a sensible size that is not blank, saved during this step, and the "after" must differ from the
 * "before" where the change should show. PNG (what the Tester is asked for) is read pixel by pixel with Node's own zlib;
 * JPEG, WebP and GIF are only read as far as their size.
 */

export interface Picture {
  format: 'png' | 'jpeg' | 'webp' | 'gif';
  width: number;
  height: number;
  /** RGBA, one byte each, when squad-kit could read the pixels (PNG without interlacing). */
  pixels?: Uint8Array;
}

/** Smaller than this is no screenshot of a screen. */
export const MIN_SIZE = { width: 200, height: 100 };
const MAX_PIXELS = 40_000_000;
const MAX_BYTES = 30 * 1024 * 1024;
/** A file saved this long before the step started still counts as made in it (clocks and file systems round). */
const SLACK_MS = 2000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads an image's size, and a PNG's pixels. Null when the bytes are not an image squad-kit can read. */
export function readPicture(buf: Buffer): Picture | null {
  try {
    if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return readPng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return readJpeg(buf);
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return readWebp(buf);
    if (/^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  } catch {
    return null;
  }
  return null;
}

function readPng(buf: Buffer): Picture | null {
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let alpha: Buffer | null = null;
  const data: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length < len) return null;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      color = body[9]!;
      interlace = body[12]!;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height || !data.length) return null;
  const picture: Picture = { format: 'png', width, height };
  // Interlaced or very large: the size is enough.
  if (interlace || width * height > MAX_PIXELS) return picture;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null;
  const raw = inflateSync(Buffer.concat(data));
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (stride + 1) * height) return null;
  const rows = unfilter(raw, stride, height, bpp);
  const px = new Uint8Array(width * height * 4);
  const sample = (row: Buffer, i: number): number => {
    if (depth === 8) return row[i]!;
    if (depth === 16) return row[i * 2]!;
    const per = 8 / depth;
    const byte = row[Math.floor(i / per)]!;
    const shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (color === 3) {
        const k = sample(row, x);
        px[o] = palette?.[k * 3] ?? 0;
        px[o + 1] = palette?.[k * 3 + 1] ?? 0;
        px[o + 2] = palette?.[k * 3 + 2] ?? 0;
        px[o + 3] = alpha?.[k] ?? 255;
      } else if (color === 0 || color === 4) {
        const g = scale(sample(row, x * channels));
        px[o] = px[o + 1] = px[o + 2] = g;
        px[o + 3] = color === 4 ? sample(row, x * channels + 1) : 255;
      } else {
        px[o] = sample(row, x * channels);
        px[o + 1] = sample(row, x * channels + 1);
        px[o + 2] = sample(row, x * channels + 2);
        px[o + 3] = color === 6 ? sample(row, x * channels + 3) : 255;
      }
    }
  }
  return { ...picture, pixels: px };
}

/** PNG rows come with a filter each; this undoes them. */
function unfilter(raw: Buffer, stride: number, height: number, bpp: number): Buffer[] {
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at]!;
    const row = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = (row[i]! + add) & 0xff;
    }
    rows.push(row);
    prev = row;
  }
  return rows;
}

function readJpeg(buf: Buffer): Picture | null {
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1]!;
    // Start of frame (baseline, progressive and the rest), but not DHT, JPG or DAC.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { format: 'jpeg', height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + buf.readUInt16BE(pos + 2);
  }
  return null;
}

function readWebp(buf: Buffer): Picture | null {
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { format: 'webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return null;
}

/**
 * True when (nearly) every pixel has one color: a white page before it rendered, a black window. A page with even a
 * little text on it has far more than 1 in 10,000 pixels of another color.
 */
export function isBlank(p: Picture): boolean {
  if (!p.pixels) return false;
  const total = p.width * p.height;
  const counts = new Map<number, number>();
  // Colors rounded a little, so noise from scaling or compression is one color.
  for (let i = 0; i < p.pixels.length; i += 4) {
    const key = ((p.pixels[i]! >> 3) << 15) | ((p.pixels[i + 1]! >> 3) << 10) | ((p.pixels[i + 2]! >> 3) << 5) | (p.pixels[i + 3]! >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let most = 0;
  for (const n of counts.values()) most = Math.max(most, n);
  return total - most <= total / 10_000;
}

/** True when two pictures show the very same thing: the same bytes, or the same pixels. */
export function samePicture(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return true;
  const pa = readPicture(a);
  const pb = readPicture(b);
  if (!pa?.pixels || !pb?.pixels || pa.width !== pb.width || pa.height !== pb.height) return false;
  return Buffer.from(pa.pixels.buffer, pa.pixels.byteOffset, pa.pixels.byteLength).equals(Buffer.from(pb.pixels.buffer, pb.pixels.byteOffset, pb.pixels.byteLength));
}

/** The size a saved screenshot was taken at, from its width: 390 for a phone, 1280 for a desktop (engine/shots.ts). Null when it cannot be read. */
export function shotSizeOf(file: string): 'phone' | 'desktop' | null {
  try {
    const p = readPicture(fs.readFileSync(file));
    if (!p) return null;
    return p.width < 800 ? 'phone' : 'desktop';
  } catch {
    return null;
  }
}

/**
 * What is wrong with one screenshot, in plain words, or null when it is fine. `since` is when the step started: a file
 * saved before it was not taken in this step.
 */
export function shotProblem(file: string, since: number): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return 'the file is missing';
  }
  if (!st.isFile() || st.size === 0) return 'the file is empty';
  if (st.size > MAX_BYTES) return 'the file is too big to be a screenshot';
  if (st.mtimeMs < since - SLACK_MS) return 'it was saved before this step started, so it is not a new screenshot';
  const p = readPicture(fs.readFileSync(file));
  if (!p) return 'it is not a picture squad-kit can open';
  if (p.width < MIN_SIZE.width || p.height < MIN_SIZE.height) return `it is only ${p.width} by ${p.height} pixels`;
  if (isBlank(p)) return 'it is blank: one color and nothing on it';
  return null;
}

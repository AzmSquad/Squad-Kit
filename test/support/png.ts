import { crc32, deflateSync } from 'node:zlib';

/**
 * Real PNG files for tests: squad-kit checks each proof screenshot (src/engine/proof-check.ts), so a test that stands
 * in for the Tester saves a picture that opens. `paint` gives each pixel's RGB; the default draws a few dark bars on
 * white, like a page with text on it. `seed` changes the bars, so two pictures differ.
 */
export function pngBytes(width = 400, height = 240, paint?: (x: number, y: number) => [number, number, number], seed = 0): Buffer {
  const color = paint ?? ((x: number, y: number): [number, number, number] => ((y + seed * 7) % 40 < 8 && x > 20 + seed && x < width - 40 ? [30, 40, 35] : [255, 255, 255]));
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 3 + 1);
    raw[at] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = color(x, y);
      raw[at + 1 + x * 3] = r;
      raw[at + 2 + x * 3] = g;
      raw[at + 3 + x * 3] = b;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])));
    return Buffer.concat([len, Buffer.from(type, 'latin1'), body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bits per sample
  head[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

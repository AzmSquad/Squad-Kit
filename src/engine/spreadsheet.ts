import zlib from 'node:zlib';

/**
 * An Excel answer as plain rows, so the Tester, squad-kit's check and the person can read what a report says instead of
 * trusting that it is there. It reads only cell values, from a file the story's own product made, and has no package of
 * its own: the npm package has a size limit. Anything it cannot read gives null, and the file is still saved whole.
 */

export interface Sheet {
  name: string;
  rows: string[][];
  /** How many rows the sheet really has: `rows` stops at the limit below. */
  total: number;
}

const MAX_ROWS = 200;
const MAX_COLUMNS = 40;
const MAX_SHEETS = 12;
const MAX_ENTRIES = 2000;
/** One file inside the workbook, unpacked. A small file can unpack to a huge one. */
const MAX_UNPACKED = 32 * 1024 * 1024;

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;

/** The files in a zip that this reader needs, by name, unpacked. */
function unzip(zip: Buffer, wanted: (name: string) => boolean): Map<string, string> {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at -= 1) {
    if (zip.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip');
  const count = zip.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) throw new Error('too many files');
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error('a broken directory');
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (!wanted(name)) continue;
    if (zip.readUInt32LE(local) !== LOCAL_ENTRY) throw new Error('a broken entry');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: MAX_UNPACKED }) : method === 0 ? body : null;
    // Some libraries write every tag with a prefix, like <x:row>. The rest of this file reads them without one.
    if (data) files.set(name, data.toString('utf8').replace(/<(\/?)[\w.-]+:/g, '<$1'));
  }
  return files;
}

const WORDS: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    if (e[0] !== '#') return WORDS[e.toLowerCase()] ?? '';
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const textIn = (xml: string): string => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join('');

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = decode(m[2]!);
  return out;
}

function columnOf(ref: string | undefined, next: number): number {
  const letters = /^[A-Z]+/i.exec(ref ?? '')?.[0];
  if (!letters) return next;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function sheetRows(xml: string, shared: string[]): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let total = 0;
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    total += 1;
    if (rows.length >= MAX_ROWS) continue;
    const cells: string[] = [];
    let next = 0;
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const { r, t } = attributes(c[1]!);
      const column = columnOf(r, next);
      next = column + 1;
      if (column >= MAX_COLUMNS) continue;
      const inner = c[2] ?? '';
      const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const text = t === 's' ? (shared[Number(value)] ?? '') : t === 'inlineStr' ? textIn(inner) : decode(value ?? '');
      while (cells.length < column) cells.push('');
      cells[column] = text;
    }
    rows.push(cells);
  }
  return { rows, total };
}

/** The sheets of an .xlsx file, or null when it is not one this can read. */
export function readWorkbook(file: Buffer): Sheet[] | null {
  try {
    const parts = unzip(file, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
    const book = parts.get('xl/workbook.xml');
    const links = parts.get('xl/_rels/workbook.xml.rels');
    if (!book || !links) return null;
    const shared = [...(parts.get('xl/sharedStrings.xml') ?? '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textIn(m[1]!));
    const target = new Map([...links.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
      const a = attributes(m[0]);
      return [a.Id ?? '', a.Target ?? ''] as const;
    }));
    const sheets: Sheet[] = [];
    for (const m of [...book.matchAll(/<sheet\b[^>]*>/g)].slice(0, MAX_SHEETS)) {
      const a = attributes(m[0]);
      const to = target.get(a['r:id'] ?? '')?.replace(/^\/?(xl\/)?/, '');
      const xml = to ? parts.get(`xl/${to}`) : undefined;
      if (xml) sheets.push({ name: a.name ?? '', ...sheetRows(xml, shared) });
    }
    return sheets.length ? sheets : null;
  } catch {
    return null;
  }
}

/** The sheets in words, for an agent to read. */
export function sheetsText(sheets: Sheet[]): string {
  return sheets
    .map((s) => [`Sheet "${s.name}", ${s.total} ${s.total === 1 ? 'row' : 'rows'}${s.total > s.rows.length ? `, the first ${s.rows.length} shown` : ''}:`, ...s.rows.map((r) => r.join(' | '))].join('\n'))
    .join('\n\n');
}

import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { BreakdownSource } from './requirements-types.js';

/**
 * A requirements document turned into text the Analyst reads part by part. Word files are opened here, with no
 * library: a small unzip, then word/document.xml read for its headings, lists, tables, bold and italic, with its
 * pictures saved beside the text where they appear. Markdown and plain text are kept as they are; a PDF is kept for
 * the Analyst to read itself, with its pages counted. Long text is split at headings, so progress can say "part 3 of 8".
 *
 * The document is data from outside squad-kit. Nothing here runs or follows anything written in it.
 */

/** The parts a long text is split into: about this many words each. */
export const PART_WORDS = { min: 3000, max: 4000 };

/** The most a Word file may unpack to, counted in real bytes, so a broken or hostile file cannot fill the disk or the memory. */
const MAX_UNPACKED = 200 * 1024 * 1024;

/** The most files a Word file may hold. A long report with many pictures has a few hundred. */
const MAX_ENTRIES = 5000;

/** The most word/document.xml (or its styles, numbering and links) may be: a 1,000-page BRD is about 10 MB. */
export const MAX_XML = 20 * 1024 * 1024;

/** A document squad-kit cannot read, said in plain words. (Not a BoardActionError: this file loads before actions.ts.) */
export class DocumentError extends Error {}

const UNREADABLE_WORD = 'squad-kit cannot open this Word file. Save it again as .docx, or paste the text.';
const EMPTY_WORD = 'This Word file has no text squad-kit can read. Save it again as .docx or paste the text.';
const BIG_WORD = 'This Word file has more text than squad-kit reads in one go. Split it into smaller documents, or paste the text.';
const BAD_PDF = 'This PDF cannot be read. Save it again as a PDF, or paste the text.';
const LOCKED_PDF = 'This PDF has a password or is locked, so the Analyst cannot read it. Save a copy with no password and add that.';
const EMPTY_TEXT = 'This file has no text. Add a file with text in it, or paste the text.';

/** The kind of document a file name says, or null for one squad-kit does not read. */
export function kindOf(name: string): Exclude<BreakdownSource['kind'], 'pasted'> | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.txt' || ext === '.text') return 'text';
  return null;
}

/* ── Unzip ──────────────────────────────────────────────── */

interface ZipEntryAt {
  method: number;
  packedSize: number;
  size: number;
  /** Where its packed bytes start. */
  start: number;
}

/** An opened zip: the names in it, and one file at a time unpacked on request, its real bytes counted. */
export interface OpenZip {
  names: string[];
  /** The file's bytes, or undefined when the zip has no such file. `max`: the most it may be. */
  read(name: string, max?: number): Buffer | undefined;
}

/**
 * Opens a zip from its central directory, unpacking nothing yet. Only stored and deflated entries, no zip64, no
 * encryption: what Word writes. A file that lies about itself is turned down: too many entries, entries that share or
 * overlap their bytes, a stored entry whose size is not its packed size, or an unpacked size that is not the one it
 * declared. What is read is counted in real bytes against MAX_UNPACKED.
 */
export function openZip(buf: Buffer): OpenZip {
  const bad = (): never => {
    throw new DocumentError(UNREADABLE_WORD);
  };
  // The end record sits in the last 22 bytes, or before a comment of up to 64 KB.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) bad();
  const count = buf.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) bad();
  let at = buf.readUInt32LE(end + 16);
  const entries = new Map<string, ZipEntryAt>();
  const spans: [number, number][] = [];
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > end || buf.readUInt32LE(at) !== 0x02014b50) bad();
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const packedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    if (at + 46 + nameLength > end) bad();
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 1 || packedSize === 0xffffffff || size === 0xffffffff || entries.has(name)) bad();
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) bad();
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packedSize > buf.length || (method === 0 && size !== packedSize)) bad();
    spans.push([local, start + packedSize]);
    entries.set(name, { method, packedSize, size, start });
  }
  // Each entry has bytes of its own: many entries pointing at the same bytes is how a small zip unpacks to gigabytes.
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) if (spans[i]![0] < spans[i - 1]![1]) bad();
  let unpacked = 0;
  return {
    names: [...entries.keys()],
    read(name, max = MAX_UNPACKED) {
      const e = entries.get(name);
      if (!e) return undefined;
      if (e.size > max || unpacked + e.size > MAX_UNPACKED) throw new DocumentError(max === MAX_XML ? BIG_WORD : UNREADABLE_WORD);
      const packed = buf.subarray(e.start, e.start + e.packedSize);
      let out: Buffer;
      try {
        if (e.method === 0) out = Buffer.from(packed);
        else if (e.method === 8) out = inflateRawSync(packed, { maxOutputLength: Math.max(e.size, 1) });
        else return bad();
      } catch {
        return bad();
      }
      if (out.length !== e.size) bad();
      unpacked += out.length;
      return out;
    },
  };
}

/** The files inside a zip, by name. `want` picks the entries to unpack; the others are skipped. */
export function unzip(buf: Buffer, want: (name: string) => boolean = () => true): Map<string, Buffer> {
  const z = openZip(buf);
  const files = new Map<string, Buffer>();
  for (const name of z.names) if (want(name)) files.set(name, z.read(name)!);
  return files;
}

/* ── A small XML reader ─────────────────────────────────── */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  kids: (XmlNode | string)[];
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|\w{1,32});/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? all;
  });
}

/** Deeper than this, a tag's content stays with its parent: Word nests about 20 deep, and the reader stays fast. */
const MAX_DEPTH = 256;

const SPACE = /\s/;

/** The attributes in a tag's text after its name, read in one pass. */
function attrsOf(s: string, from: number): Record<string, string> {
  const out: Record<string, string> = {};
  let i = from;
  while (i < s.length) {
    const eq = s.indexOf('=', i);
    if (eq < 0) break;
    const name = s.slice(i, eq).trim().split(/\s+/).pop() ?? '';
    let q = eq + 1;
    while (q < s.length && SPACE.test(s[q]!)) q += 1;
    const quote = s[q];
    if (quote !== '"' && quote !== "'") {
      i = q;
      continue;
    }
    const close = s.indexOf(quote, q + 1);
    if (close < 0) break;
    if (name && name !== '__proto__' && name !== 'constructor' && name !== 'prototype') out[name] = decode(s.slice(q + 1, close));
    i = close + 1;
  }
  return out;
}

/**
 * Parses XML into a tree in one pass. Comments, declarations and processing instructions are dropped. Broken XML
 * never makes it slow: an unclosed comment, section or tag ends the document there, and a closing tag that matches
 * nothing open is skipped.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, kids: [] };
  const stack: XmlNode[] = [root];
  /** How many tags of each name are open, so a closing tag that matches nothing is skipped at once. */
  const open = new Map<string, number>();
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      top().kids.push(decode(xml.slice(i)));
      break;
    }
    if (lt > i) top().kids.push(decode(xml.slice(i, lt)));
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) break;
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) break;
      top().kids.push(xml.slice(lt + 9, e));
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) break;
      i = e + 2;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) break;
    i = gt + 1;
    // A declaration such as <!DOCTYPE …>.
    if (xml[lt + 1] === '!') continue;
    const closing = xml[lt + 1] === '/';
    const selfClosing = !closing && xml[gt - 1] === '/';
    const inner = xml.slice(lt + (closing ? 2 : 1), selfClosing ? gt - 1 : gt);
    let nameEnd = 0;
    while (nameEnd < inner.length && !SPACE.test(inner[nameEnd]!) && inner[nameEnd] !== '/') nameEnd += 1;
    const name = inner.slice(0, nameEnd);
    if (!name) continue;
    if (closing) {
      // Closes the nearest open tag of that name; anything left open inside it closes with it.
      if (!open.get(name)) continue;
      for (;;) {
        const n = stack.pop()!;
        open.set(n.name, open.get(n.name)! - 1);
        if (n.name === name) break;
      }
      continue;
    }
    const node: XmlNode = { name, attrs: attrsOf(inner, nameEnd), kids: [] };
    top().kids.push(node);
    if (!selfClosing && stack.length <= MAX_DEPTH) {
      stack.push(node);
      open.set(name, (open.get(name) ?? 0) + 1);
    }
  }
  return root;
}

function kidsNamed(n: XmlNode | undefined, name: string): XmlNode[] {
  return (n?.kids ?? []).filter((k): k is XmlNode => typeof k !== 'string' && k.name === name);
}

function kid(n: XmlNode | undefined, name: string): XmlNode | undefined {
  return kidsNamed(n, name)[0];
}

/** Every node of that name under `n`, at any depth, in document order. */
function findAll(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const k of n.kids) {
    if (typeof k === 'string') continue;
    if (k.name === name) out.push(k);
    findAll(k, name, out);
  }
  return out;
}

/** A Word on/off property: present means on, unless its value says off. */
function isOn(n: XmlNode | undefined): boolean {
  if (!n) return false;
  const v = n.attrs['w:val'];
  return v === undefined || !['0', 'false', 'off', 'none'].includes(v.toLowerCase());
}

/* ── Word to Markdown ───────────────────────────────────── */

export interface WordText {
  markdown: string;
  /** The pictures placed in the text, saved as media/<name>. */
  media: { name: string; data: Buffer }[];
  pictures: number;
}

interface Styles {
  /** Heading level by style id, 1 for the Title style. */
  heading: Map<string, number>;
  /** A list a style brings with it (List Bullet, List Number). */
  numbering: Map<string, { numId: string; ilvl: number }>;
  /** Styles that hide their text (Word's "Hidden" font setting). */
  hidden: Set<string>;
}

/** Text Word does not show: hidden, or shown only in a web layout. */
function hides(rPr: XmlNode | undefined): boolean | undefined {
  const v = kid(rPr, 'w:vanish') ?? kid(rPr, 'w:webHidden');
  return v ? isOn(v) : undefined;
}

function readStyles(xml: string | undefined): Styles {
  const heading = new Map<string, number>();
  const numbering = new Map<string, { numId: string; ilvl: number }>();
  const hidden = new Set<string>();
  if (!xml) return { heading, numbering, hidden };
  for (const s of findAll(parseXml(xml), 'w:style')) {
    const id = s.attrs['w:styleId'];
    if (!id) continue;
    const name = (kid(s, 'w:name')?.attrs['w:val'] ?? '').toLowerCase();
    const level = /^heading\s*(\d)$/.exec(name)?.[1] ?? /^heading(\d)$/i.exec(id)?.[1];
    const outline = kid(kid(s, 'w:pPr'), 'w:outlineLvl')?.attrs['w:val'];
    if (name === 'title' || id.toLowerCase() === 'title') heading.set(id, 1);
    else if (level) heading.set(id, Number(level));
    else if (outline !== undefined && Number(outline) < 9) heading.set(id, Number(outline) + 1);
    const num = kid(kid(s, 'w:pPr'), 'w:numPr');
    const numId = kid(num, 'w:numId')?.attrs['w:val'];
    if (numId && numId !== '0') numbering.set(id, { numId, ilvl: Number(kid(num, 'w:ilvl')?.attrs['w:val'] ?? 0) });
    if (hides(kid(s, 'w:rPr'))) hidden.add(id);
  }
  return { heading, numbering, hidden };
}

/** Whether each list level is bulleted or numbered, by list id and level. */
function readNumbering(xml: string | undefined): (numId: string, ilvl: number) => 'bullet' | 'number' {
  if (!xml) return () => 'bullet';
  const tree = parseXml(xml);
  const abstract = new Map<string, XmlNode>();
  for (const a of findAll(tree, 'w:abstractNum')) abstract.set(a.attrs['w:abstractNumId'] ?? '', a);
  const nums = new Map<string, string>();
  for (const n of findAll(tree, 'w:num')) nums.set(n.attrs['w:numId'] ?? '', kid(n, 'w:abstractNumId')?.attrs['w:val'] ?? '');
  return (numId, ilvl) => {
    const lvl = kidsNamed(abstract.get(nums.get(numId) ?? ''), 'w:lvl').find((l) => Number(l.attrs['w:ilvl'] ?? 0) === ilvl);
    const fmt = kid(lvl, 'w:numFmt')?.attrs['w:val'] ?? 'bullet';
    return fmt === 'bullet' || fmt === 'none' ? 'bullet' : 'number';
  };
}

/** A line break inside a paragraph, until the spaces around it are tidied. */
const BREAK = '\u0000';

interface Piece {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** Text with its emphasis, the spaces kept outside the marks so Markdown reads them. */
function emphasised(p: Piece): string {
  const mark = p.bold && p.italic ? '***' : p.bold ? '**' : p.italic ? '*' : '';
  const text = p.text.trim();
  if (!mark || !text) return p.text;
  const lead = p.text.slice(0, p.text.length - p.text.trimStart().length);
  const trail = p.text.slice(p.text.trimEnd().length);
  return `${lead}${mark}${text}${mark}${trail}`;
}

function escapeText(s: string): string {
  return s.replace(/([*`])/g, '\\$1');
}

/**
 * Turns a .docx into Markdown: headings from the Heading and Title styles, numbered and bulleted lists, tables as
 * Markdown tables, bold and italic, line breaks, and each picture as an image link where it appears. Hidden text is
 * left out, as Word leaves it out on the page. Only the document, its styles, lists and links, and the pictures it
 * shows are unpacked.
 */
export function wordToMarkdown(buf: Buffer): WordText {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new DocumentError(UNREADABLE_WORD);
  const zip = openZip(buf);
  const xml = (name: string) => zip.read(name, MAX_XML)?.toString('utf8');
  const doc = xml('word/document.xml');
  if (!doc) throw new DocumentError(UNREADABLE_WORD);
  const styles = readStyles(xml('word/styles.xml'));
  const listKind = readNumbering(xml('word/numbering.xml'));
  const rels = new Map<string, string>();
  const relsXml = xml('word/_rels/document.xml.rels');
  if (relsXml) {
    for (const r of findAll(parseXml(relsXml), 'Relationship')) {
      if (r.attrs.TargetMode === 'External' || !r.attrs.Id || !r.attrs.Target) continue;
      rels.set(r.attrs.Id, path.posix.normalize(path.posix.join('word', r.attrs.Target.replace(/^\/word\//, '').replace(/^\//, ''))));
    }
  }
  const media: WordText['media'] = [];
  const placed = new Map<string, string>();

  /** A picture by its relationship id: unpacked and saved once, linked each time it appears. */
  const picture = (rid: string | undefined, alt: string | undefined): string => {
    const target = rid ? rels.get(rid) : undefined;
    if (!target) return '';
    let name = placed.get(target);
    if (!name) {
      const data = zip.read(target);
      if (!data) return '';
      name = path.posix.basename(target).replace(/[^\w.-]+/g, '_') || `picture-${placed.size + 1}`;
      while (media.some((m) => m.name === name)) name = `${placed.size + 1}-${name}`;
      placed.set(target, name);
      media.push({ name, data });
    }
    const label = (alt?.trim() || `Picture ${[...placed.keys()].indexOf(target) + 1}`).replace(/[[\]\n]/g, ' ');
    return `![${label}](../media/${name})`;
  };

  /** Some text that is not a picture: a document of pictures only has nothing to read. */
  let wroteText = false;

  /** The text of the runs inside a node, with emphasis and pictures, in order. `hiddenStyle`: the paragraph's style hides it. */
  const inline = (n: XmlNode, lineBreak: string, hiddenStyle = false): string => {
    const pieces: Piece[] = [];
    const push = (text: string, bold = false, italic = false) => {
      const last = pieces[pieces.length - 1];
      if (last && last.bold === bold && last.italic === italic) last.text += text;
      else pieces.push({ text, bold, italic });
    };
    const walk = (x: XmlNode) => {
      for (const k of x.kids) {
        if (typeof k === 'string') continue;
        if (k.name === 'w:r') {
          const rPr = kid(k, 'w:rPr');
          // Hidden text stays out: on the run itself, or from its style or its paragraph's style.
          if (hides(rPr) ?? (styles.hidden.has(kid(rPr, 'w:rStyle')?.attrs['w:val'] ?? '') || hiddenStyle)) continue;
          const bold = isOn(kid(rPr, 'w:b'));
          const italic = isOn(kid(rPr, 'w:i'));
          for (const c of k.kids) {
            if (typeof c === 'string') continue;
            if (c.name === 'w:t') {
              const text = c.kids.filter((s): s is string => typeof s === 'string').join('').replace(/\s+/g, ' ');
              if (text.trim()) wroteText = true;
              push(escapeText(text), bold, italic);
            }
            else if (c.name === 'w:tab') push(' ', bold, italic);
            else if (c.name === 'w:br' || c.name === 'w:cr') push(c.attrs['w:type'] === 'page' ? ' ' : BREAK);
            else if (c.name === 'w:noBreakHyphen') push('-', bold, italic);
            else if (c.name === 'w:drawing') {
              const blip = findAll(c, 'a:blip')[0];
              const alt = findAll(c, 'wp:docPr')[0]?.attrs.descr;
              push(picture(blip?.attrs['r:embed'] ?? blip?.attrs['r:link'], alt));
            } else if (c.name === 'w:pict' || c.name === 'w:object') {
              const img = findAll(c, 'v:imagedata')[0];
              push(picture(img?.attrs['r:id'], img?.attrs['o:title']));
            } else if (c.name === 'mc:AlternateContent') {
              // A newer drawing with an older one as its fallback: the picture once, from whichever has it.
              const blip = findAll(c, 'a:blip')[0];
              const img = findAll(c, 'v:imagedata')[0];
              push(blip ? picture(blip.attrs['r:embed'], findAll(c, 'wp:docPr')[0]?.attrs.descr) : picture(img?.attrs['r:id'], img?.attrs['o:title']));
            }
          }
        } else if (['w:hyperlink', 'w:ins', 'w:smartTag', 'w:fldSimple', 'w:sdt', 'w:sdtContent', 'w:customXml', 'w:bdo', 'w:dir'].includes(k.name)) walk(k);
      }
    };
    walk(n);
    return pieces.map(emphasised).join('').replace(/ +/g, ' ').replace(/ ?\u0000 ?/g, lineBreak);
  };

  const blocks: { text: string; list?: boolean }[] = [];
  const paragraph = (p: XmlNode) => {
    const pPr = kid(p, 'w:pPr');
    const style = kid(pPr, 'w:pStyle')?.attrs['w:val'] ?? '';
    const text = inline(p, '  \n', styles.hidden.has(style)).trim();
    if (!text) return;
    const outline = kid(pPr, 'w:outlineLvl')?.attrs['w:val'];
    const level = styles.heading.get(style) ?? (outline !== undefined && Number(outline) < 9 ? Number(outline) + 1 : undefined);
    if (level) {
      blocks.push({ text: `${'#'.repeat(Math.min(6, level))} ${text.replace(/\s*\n\s*/g, ' ')}` });
      return;
    }
    const num = kid(pPr, 'w:numPr');
    const numId = kid(num, 'w:numId')?.attrs['w:val'] ?? styles.numbering.get(style)?.numId;
    if (numId && numId !== '0') {
      const ilvl = Number(kid(num, 'w:ilvl')?.attrs['w:val'] ?? styles.numbering.get(style)?.ilvl ?? 0);
      const mark = listKind(numId, ilvl) === 'bullet' ? '-' : '1.';
      blocks.push({ text: `${'   '.repeat(Math.min(ilvl, 6))}${mark} ${text.replace(/\n/g, ' ')}`, list: true });
      return;
    }
    blocks.push({ text });
  };

  const cellText = (tc: XmlNode): string =>
    findAll(tc, 'w:p')
      .map((p) => inline(p, '<br>', styles.hidden.has(kid(kid(p, 'w:pPr'), 'w:pStyle')?.attrs['w:val'] ?? '')).trim())
      .filter(Boolean)
      .join('<br>')
      .replace(/\|/g, '\\|');

  const table = (tbl: XmlNode) => {
    const rows = kidsNamed(tbl, 'w:tr').map((tr) =>
      kidsNamed(tr, 'w:tc').flatMap((tc) => {
        const tcPr = kid(tc, 'w:tcPr');
        const span = Math.max(1, Number(kid(tcPr, 'w:gridSpan')?.attrs['w:val'] ?? 1));
        const merged = kid(tcPr, 'w:vMerge');
        const text = merged && merged.attrs['w:val'] !== 'restart' ? '' : cellText(tc);
        return [text, ...Array<string>(span - 1).fill('')];
      }),
    );
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (!width || rows.every((r) => r.every((c) => !c))) return;
    const line = (cells: string[]) => `| ${[...cells, ...Array<string>(width - cells.length).fill('')].map((c) => c || ' ').join(' | ')} |`;
    blocks.push({ text: [line(rows[0]!), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n') });
  };

  const body = (n: XmlNode) => {
    for (const k of n.kids) {
      if (typeof k === 'string') continue;
      if (k.name === 'w:p') paragraph(k);
      else if (k.name === 'w:tbl') table(k);
      else if (['w:sdt', 'w:sdtContent', 'w:customXml', 'w:ins'].includes(k.name)) body(k);
    }
  };
  const tree = parseXml(doc);
  const docBody = findAll(tree, 'w:body')[0];
  if (!docBody) throw new DocumentError(UNREADABLE_WORD);
  body(docBody);

  let markdown = '';
  blocks.forEach((b, i) => {
    if (i > 0) markdown += b.list && blocks[i - 1]!.list ? '\n' : '\n\n';
    markdown += b.text;
  });
  if (!wroteText || !markdown.trim()) throw new DocumentError(EMPTY_WORD);
  return { markdown: `${markdown}\n`, media, pictures: media.length };
}

/* ── PDF ────────────────────────────────────────────────── */

/**
 * A PDF's pages, without a library: the page objects ("/Type /Page", never "/Pages"), or the page tree's own count
 * when the pages sit in compressed object streams. Good enough for "page 18 of 31".
 */
export function pdfPages(buf: Buffer): number {
  if (buf.subarray(0, 1024).toString('latin1').indexOf('%PDF') < 0) throw new DocumentError(BAD_PDF);
  const text = buf.toString('latin1');
  const pages = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  if (pages) return pages;
  let most = 0;
  // Each look stays near its own object, so a broken file cannot make it slow.
  for (const m of text.matchAll(/\/Type\s*\/Pages\b[^>]{0,2000}?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]{0,2000}?\/Type\s*\/Pages\b/g)) most = Math.max(most, Number(m[1] ?? m[2]));
  return most;
}

/** A PDF with a password, or with its text locked by its owner: its file names how it is locked. Nothing can read it, so it is refused before anything is paid. */
export function pdfLocked(buf: Buffer): boolean {
  return /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(buf.toString('latin1'));
}

/* ── Plain text and Markdown ────────────────────────────── */

/** A text file as Markdown: the byte order mark and Windows line ends gone. A file with NUL bytes is not text. */
export function plainText(buf: Buffer): string {
  if (buf.includes(0)) throw new DocumentError('This file is not plain text. Save it as PDF, Word (.docx), Markdown or text, or paste the text.');
  const text = buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new DocumentError(EMPTY_TEXT);
  return text.endsWith('\n') ? text : `${text}\n`;
}

/* ── Parts ──────────────────────────────────────────────── */

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

/** The text cut at its headings into sections, each with its heading. Text before the first heading is a section too. */
function sections(markdown: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^#{1,6}\s/.test(line) && cur.some((l) => l.trim())) {
      out.push(cur.join('\n'));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.some((l) => l.trim())) out.push(cur.join('\n'));
  return out;
}

/** A section too long for one part, cut between paragraphs. Words are counted as it goes, so a long text stays fast. */
function cutLong(section: string, max: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let words = 0;
  for (const para of section.split(/\n{2,}/)) {
    const n = wordCount(para);
    if (words && words + n > max) {
      out.push(cur.join('\n\n'));
      cur = [];
      words = 0;
    }
    cur.push(para);
    words += n;
  }
  const last = cur.join('\n\n');
  if (last.trim()) out.push(last);
  return out;
}

/** The text without the line ends before and after it. */
function trimLines(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '\n') a += 1;
  while (b > a && s[b - 1] === '\n') b -= 1;
  return s.slice(a, b);
}

/**
 * The text in parts of about 3,000 to 4,000 words, each cut at a heading where it can be. A short text is one part.
 */
export function splitParts(markdown: string, size = PART_WORDS): string[] {
  const parts: string[] = [];
  let cur: string[] = [];
  let words = 0;
  for (const s of sections(markdown).flatMap((x) => (wordCount(x) > size.max ? cutLong(x, size.max) : [x]))) {
    const n = wordCount(s);
    if (cur.length && (words >= size.min || words + n > size.max)) {
      parts.push(cur.join('\n\n'));
      cur = [];
      words = 0;
    }
    cur.push(trimLines(s));
    words += n;
  }
  if (cur.length) parts.push(cur.join('\n\n'));
  return parts.filter((p) => p.trim()).map((p) => `${p.trim()}\n`);
}

/* ── Into the breakdown's folder ────────────────────────── */

export interface PreparedText {
  /** The text parts written, part-01.md and on; none for a PDF. */
  parts: number;
  /** PDF pages. */
  pages?: number;
  pictures?: number;
  words?: number;
}

/**
 * Turns the document in the breakdown's folder into what the Analyst reads: text/part-01.md and on, with the Word
 * file's pictures in media/. A PDF stays as it is; only its pages are counted. Old parts are cleared first.
 */
export function prepareText(dir: string, source: Pick<BreakdownSource, 'file' | 'kind'>): PreparedText {
  const buf = fs.readFileSync(path.join(dir, source.file));
  const textDir = path.join(dir, 'text');
  const mediaDir = path.join(dir, 'media');
  if (source.kind === 'pdf') {
    const pages = pdfPages(buf);
    if (pdfLocked(buf)) throw new DocumentError(LOCKED_PDF);
    if (!pages) throw new DocumentError(BAD_PDF);
    return { parts: 0, pages };
  }
  let markdown: string;
  let pictures = 0;
  if (source.kind === 'docx') {
    const w = wordToMarkdown(buf);
    markdown = w.markdown;
    pictures = w.pictures;
    fs.rmSync(mediaDir, { recursive: true, force: true });
    if (w.media.length) {
      fs.mkdirSync(mediaDir, { recursive: true });
      for (const m of w.media) fs.writeFileSync(path.join(mediaDir, m.name), m.data);
    }
  } else markdown = plainText(buf);
  const parts = splitParts(markdown);
  fs.rmSync(textDir, { recursive: true, force: true });
  fs.mkdirSync(textDir, { recursive: true });
  parts.forEach((p, i) => fs.writeFileSync(path.join(textDir, partName(i + 1)), p));
  return { parts: parts.length, ...(source.kind === 'docx' ? { pictures } : {}), words: wordCount(markdown) };
}

/** "part-03.md". */
export function partName(n: number): string {
  return `part-${String(n).padStart(2, '0')}.md`;
}

/** The text parts in the breakdown's folder, in order, as paths inside it ("text/part-01.md"). */
export function textParts(dir: string): string[] {
  const textDir = path.join(dir, 'text');
  if (!fs.existsSync(textDir)) return [];
  return fs
    .readdirSync(textDir)
    .filter((f) => /^part-\d+\.md$/.test(f))
    .sort()
    .map((f) => `text/${f}`);
}

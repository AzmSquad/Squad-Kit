import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { readWorkbook, sheetsText } from '../src/engine/spreadsheet.js';
import { tinyWorkbook } from './support/xlsx.js';

/** A report the product answered with, as rows an agent and a person can read. */

describe('reading an Excel answer', () => {
  it('gives each sheet its name and its rows, in Arabic too, packed or not', () => {
    for (const method of [8, 0] as const) {
      const file = tinyWorkbook([['الملخص', [['العدد', 'الأول'], ['1', '2']]], ['التفاصيل', [['الرقم'], ['1234567']]]], method);
      expect(readWorkbook(file)).toEqual([
        { name: 'الملخص', rows: [['العدد', 'الأول'], ['1', '2']], total: 2 },
        { name: 'التفاصيل', rows: [['الرقم'], ['1234567']], total: 2 },
      ]);
    }
  });

  it('reads a file whose tags all have a prefix, as the real report from a real product did', () => {
    const file = tinyWorkbook([['الملخص', [['العدد'], ['1']]]], 8, 'x');
    expect(file.includes(Buffer.from('sheet'))).toBe(true);
    expect(readWorkbook(file)).toEqual([{ name: 'الملخص', rows: [['العدد'], ['1']], total: 2 }]);
  });

  it('keeps a cell in its column when the ones before it are empty, and reads special characters', () => {
    const file = tinyWorkbook([['A & B', [['a', '', 'b < c'], ['', '', '3']]]]);
    expect(readWorkbook(file)).toEqual([{ name: 'A & B', rows: [['a', '', 'b < c'], ['', '', '3']], total: 2 }]);
  });

  it('stops at a limit and says how many rows there really are', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [String(i)]);
    const [sheet] = readWorkbook(tinyWorkbook([['Big', rows]]))!;
    expect(sheet!.rows).toHaveLength(200);
    expect(sheet!.total).toBe(500);
    expect(sheetsText([sheet!])).toContain('Sheet "Big", 500 rows, the first 200 shown:');
  });

  it('gives nothing for what it cannot read, and never throws', () => {
    expect(readWorkbook(Buffer.from([0x50, 0x4b, 3, 4, 5, 6]))).toBeNull();
    expect(readWorkbook(Buffer.alloc(0))).toBeNull();
    expect(readWorkbook(Buffer.from('not a workbook at all, only some words here'))).toBeNull();
  });

  it('a small file that unpacks to something huge is not unpacked', () => {
    const huge = zlib.deflateRawSync(Buffer.alloc(64 * 1024 * 1024));
    const good = tinyWorkbook([['A', [['1']]]]);
    expect(huge.length).toBeLessThan(good.length + 100 * 1024);
    // In place of the sheet's own bytes: the reader gives up in place of filling the memory.
    const name = Buffer.from('xl/workbook.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(huge.length, 20);
    entry.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(30 + name.length + huge.length, 16);
    expect(readWorkbook(Buffer.concat([local, name, huge, entry, name, end]))).toBeNull();
  });
});

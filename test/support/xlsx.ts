import zlib from 'node:zlib';

/** A real .xlsx file, the way Excel lays one out: a zip of XML, with text in a shared list. */
export function tinyWorkbook(sheets: [string, string[][]][], method: 0 | 8 = 8, prefix = ''): Buffer {
  const shared: string[] = [];
  const at = (text: string) => {
    if (!shared.includes(text)) shared.push(text);
    return shared.indexOf(text);
  };
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const name = (i: number) => String.fromCharCode(65 + i);
  const pages = sheets.map(([, rows]) => {
    const body = rows
      .map((row, y) => `<row r="${y + 1}">${row.map((v, x) => (v === '' ? '' : /^-?\d+(\.\d+)?$/.test(v) ? `<c r="${name(x)}${y + 1}"><v>${v}</v></c>` : `<c r="${name(x)}${y + 1}" t="s"><v>${at(v)}</v></c>`)).join('')}</row>`)
      .join('');
    return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  });
  const files: [string, string][] = [
    ['xl/workbook.xml', `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(([n], i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`],
    ['xl/sharedStrings.xml', `<sst>${shared.map((t) => `<si><t>${esc(t)}</t></si>`).join('')}</sst>`],
    ...pages.map((p, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, p]),
  ];
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [file, text] of files) {
    // Some libraries write every tag with a prefix, like <x:row>.
    const raw = Buffer.from(prefix ? text.replace(/<(\/?)(?=[a-zA-Z])/g, `<$1${prefix}:`) : text);
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const label = Buffer.from(file);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(label.length, 26);
    locals.push(local, label, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(label.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, label);
    offset += local.length + label.length + data.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

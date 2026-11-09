import fs from 'node:fs';
import path from 'node:path';
import { isPersonsOwn, readAddress, realFile, refuseOwn, storyName } from './address.js';
import { dropFolder, finishFolder, readTemplate, startFolder, withDefaults } from './folder.js';
import { fits, makeFaker, personalKind, typeClass, type Faker, type Personal } from './hide.js';
import { dropMark, putMark, readMark } from './made.js';
import { countKept, describeTables, planRows, selectKept, type Dialect, type ForeignKey, type Table } from './sample.js';
import { missing, needTool, runTool } from './run.js';
import { DbError, type DbAdapter, type DbTemplate, type StoryDb, type StoryRef, type TemplateOptions } from './types.js';

/**
 * SQLite. The template is a new SQLite file made with sqlite3 itself: the source is attached read-only, the tables are
 * made from its own schema, the kept rows are copied in, then the indexes, triggers and views are added. A story's
 * database is a copy of that file in the story's own folder, named `<file>_<story>.db`. squad-kit's mark on this
 * computer is what says it made one.
 */

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const str = (text: string) => `'${text.replace(/'/g, "''")}'`;

const dialect: Dialect = {
  quote: q,
  text: (col) => `quote(${col})`,
  jsonArray: (values) => `json_array(${values.join(', ')})`,
  // quote() already gave a literal.
  literal: (text) => text,
  rowId: 'rowid',
  inTuples: (cols, tuples) => (cols.length === 1 ? `${cols[0]} IN (${tuples.map((t) => t[0]).join(', ')})` : `(${cols.join(', ')}) IN (VALUES ${tuples.map((t) => `(${t.join(', ')})`).join(', ')})`),
  nullsLast: '',
};

/** The source, attached read-only as `src`. */
function attach(file: string): string {
  const uri = `file:${file.replace(/\\/g, '/').replace(/%/g, '%25').replace(/\?/g, '%3f').replace(/#/g, '%23')}?mode=ro`;
  return `ATTACH ${str(uri)} AS src;\n`;
}

async function run(db: string, script: string, doing: string): Promise<string[]> {
  const out = await runTool(needTool('sqlite3', 'Copying a SQLite database'), ['-batch', '-bail', '-noheader', '-list', db], { input: script, secrets: [], doing });
  return out.split('\n').filter((l) => l.length);
}

const CATALOG = `SELECT json_object(
  'tables', json((SELECT json_group_array(json_object('name', m.name, 'sql', m.sql,
      'columns', json((SELECT json_group_array(json_object('name', c.name, 'type', c.type, 'pk', c.pk, 'hidden', c.hidden)) FROM pragma_table_xinfo(m.name, 'src') c)),
      'fks', json((SELECT json_group_array(json_object('id', f.id, 'seq', f.seq, 'parent', f."table", 'from', f."from", 'to', f."to")) FROM pragma_foreign_key_list(m.name, 'src') f))))
    FROM src.sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\')),
  'other', json((SELECT json_group_array(json_object('type', type, 'name', name, 'sql', sql)) FROM src.sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL)),
  'sequence', (SELECT count(*) FROM src.sqlite_master WHERE name = 'sqlite_sequence')
);`;

interface Catalog {
  tables: { name: string; sql: string; columns: { name: string; type: string; pk: number; hidden: number }[]; fks: { id: number; seq: number; parent: string; from: string; to: string | null }[] }[];
  other: { type: string; name: string; sql: string }[];
  sequence: number;
}

/** Tables a virtual table keeps for itself (full-text search, r-trees): made by it, never copied. */
async function shadowTables(source: string, cat: Catalog): Promise<Set<string>> {
  try {
    const rows = await run(':memory:', `${attach(source)}SELECT name FROM pragma_table_list WHERE schema = 'src' AND type = 'shadow';`, 'Reading the SQLite file');
    return new Set(rows);
  } catch {
    // An older sqlite3: by their names.
    const virtual = cat.tables.filter((t) => /^\s*create\s+virtual/i.test(t.sql)).map((t) => t.name);
    return new Set(cat.tables.filter((t) => virtual.some((v) => t.name.startsWith(`${v}_`))).map((t) => t.name));
  }
}

/** A literal from quote(), read back as text: null when it is not text or a number. */
function unquote(lit: string): string | null {
  if (lit.startsWith("'")) return lit.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(lit)) return lit;
  return null;
}

function fakeLiteral(lit: string, kind: Personal, faker: Faker): string {
  const v = unquote(lit);
  if (v === null) return lit;
  const fake = faker(kind, v);
  return lit.startsWith("'") || !/^-?\d+(\.\d+)?$/.test(fake) ? str(fake) : fake;
}

/** The story's file: `<file>_<story>.<ext>` in the story's folder. */
function storyFile(source: string, story: StoryRef): string {
  if (!story?.id?.trim()) throw new DbError('A story database needs the story id.', 'bad-address');
  if (!story.folder || !path.isAbsolute(story.folder)) throw new DbError('A SQLite story database needs the full path of the story’s folder.', 'bad-address');
  const ext = path.extname(source);
  return path.join(story.folder, `${storyName(path.basename(source, ext), story.id.trim())}${ext || '.db'}`);
}

const TEMPLATE_FILE = (source: string) => `template${path.extname(source) || '.db'}`;

export const sqlite: DbAdapter = {
  kind: 'sqlite',

  missingTools: () => missing(['sqlite3']),

  nameOf: (address) => readAddress('sqlite', address).name,

  storyAddress(sourceAddress, story) {
    const a = readAddress('sqlite', sourceAddress);
    return a.withName(storyFile(a.name, story));
  },

  isPersonsOwn: (address, personsAddress) => isPersonsOwn('sqlite', address, personsAddress),

  async makeTemplate(source: string, opts: TemplateOptions): Promise<DbTemplate> {
    const o = withDefaults(opts);
    const a = readAddress('sqlite', source);
    if (!fs.existsSync(a.name)) throw new DbError(`The SQLite file ${a.name} is not there.`, 'bad-address');
    const read = (text: string) => run(':memory:', `${attach(a.name)}PRAGMA query_only = ON;\n${text};`, `Reading ${path.basename(a.name)}`);
    const making = startFolder(o.folder);
    try {
      const cat = JSON.parse((await read(CATALOG.replace(/;$/, '')))[0]!) as Catalog;
      const shadow = await shadowTables(a.name, cat);
      const kept = cat.tables.filter((t) => !shadow.has(t.name));
      const tables: Table[] = kept.map((t) => ({
        name: t.name,
        ref: `src.${q(t.name)}`,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type, ...(c.hidden ? { generated: true } : {}) })),
        pk: t.columns
          .filter((c) => c.pk > 0)
          .sort((x, y) => x.pk - y.pk)
          .map((c) => c.name),
      }));
      const fks: ForeignKey[] = [];
      for (const t of kept) {
        const ids = [...new Set(t.fks.map((f) => f.id))];
        for (const id of ids) {
          const parts = t.fks.filter((f) => f.id === id).sort((x, y) => x.seq - y.seq);
          const parent = tables.find((x) => x.name === parts[0]!.parent);
          const refCols = parts.map((f, i) => f.to ?? parent?.pk[i] ?? '');
          if (!refCols.every(Boolean)) continue;
          fks.push({ child: t.name, cols: parts.map((f) => f.from), parent: parts[0]!.parent, refCols });
        }
      }
      const plan = await planRows(tables, fks, dialect, read, o);
      const counts = await countKept(plan, dialect, read);
      const faker = o.hidePersonal ? makeFaker() : null;
      const hidden: string[] = [];
      const lines: string[] = ['PRAGMA foreign_keys = OFF;', attach(a.name), 'BEGIN;'];
      // Virtual tables first: they make their own shadow tables.
      const ordered = [...kept].sort((x, y) => Number(/^\s*create\s+virtual/i.test(y.sql)) - Number(/^\s*create\s+virtual/i.test(x.sql)));
      for (const t of ordered) lines.push(`${t.sql.replace(/^\s*CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')};`);
      for (const t of tables) {
        const cols = t.columns.filter((c) => !c.generated);
        const list = cols.map((c) => q(c.name)).join(', ');
        const hide = new Map<number, Personal>();
        if (faker) {
          cols.forEach((c, i) => {
            const kind = personalKind(c.name, t.name);
            if (kind && fits(kind, typeClass(c.type))) {
              hide.set(i, kind);
              hidden.push(`${t.name}.${c.name}`);
            }
          });
        }
        if (!hide.size) {
          lines.push(`INSERT INTO main.${q(t.name)} (${list}) ${selectKept(plan, dialect, t, list)};`);
          continue;
        }
        // Rows with personal values come through squad-kit, which makes them fake, so the real ones are never written.
        const rows = await read(selectKept(plan, dialect, t, dialect.jsonArray(cols.map((c) => `quote(${q(c.name)})`))));
        for (const row of rows) {
          const lits = (JSON.parse(row) as string[]).map((l, i) => (hide.has(i) ? fakeLiteral(l, hide.get(i)!, faker!) : l));
          lines.push(`INSERT INTO main.${q(t.name)} (${list}) VALUES (${lits.join(', ')});`);
        }
      }
      if (cat.sequence) lines.push('DELETE FROM main.sqlite_sequence;', 'INSERT INTO main.sqlite_sequence SELECT * FROM src.sqlite_sequence;');
      for (const kind of ['index', 'view', 'trigger']) for (const x of cat.other.filter((y) => y.type === kind)) lines.push(`${x.sql};`);
      lines.push('COMMIT;', 'DETACH src;', 'VACUUM;');
      const file = path.join(making, TEMPLATE_FILE(a.name));
      await run(file, lines.join('\n') + '\n', `Making the template of ${path.basename(a.name)}`);
      const notes = [...plan.notes];
      if (shadow.size) notes.push('Search indexes kept by virtual tables are made again from the kept rows.');
      const info = finishFolder(making, o.folder, {
        kind: 'sqlite',
        source: a.safe,
        sourceName: path.basename(a.name),
        madeAt: new Date().toISOString(),
        smallRows: o.smallRows,
        sampleRows: o.sampleRows,
        hidePersonal: o.hidePersonal,
        tables: describeTables(plan, counts),
        hidden,
        linksComplete: plan.complete,
        notes,
      });
      return { kind: 'sqlite', folder: o.folder, source, info };
    } catch (e) {
      dropFolder(making);
      throw e;
    }
  },

  async createStoryDb(template: DbTemplate, story: StoryRef): Promise<StoryDb> {
    const a = readAddress('sqlite', template.source);
    const file = storyFile(a.name, story);
    const address = a.withName(file);
    refuseOwn('sqlite', address, template.source, 'makes or changes');
    const real = realFile(file);
    if (fs.existsSync(file)) {
      const mark = readMark('sqlite', 'sqlite', real);
      if (mark?.role === 'story' && mark.story === story.id.trim()) return { kind: 'sqlite', name: file, address, existed: true };
      throw new DbError(`A file named ${path.basename(file)} is already in the story’s folder, and squad-kit did not make it for this story. squad-kit leaves it alone.`, 'not-ours');
    }
    if (!readTemplate(template.folder, template.source, 'sqlite')) throw new DbError('The template’s files are not on this computer any more. Make the template again.', 'failed');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(template.folder, TEMPLATE_FILE(a.name)), file, fs.constants.COPYFILE_EXCL);
    putMark({ kind: 'sqlite', server: 'sqlite', name: realFile(file), role: 'story', story: story.id.trim(), sourceName: path.basename(a.name), madeAt: new Date().toISOString() });
    return { kind: 'sqlite', name: file, address, existed: false };
  },

  async dropStoryDb(address: string, personsAddress: string): Promise<boolean> {
    refuseOwn('sqlite', address, personsAddress, 'drops');
    const a = readAddress('sqlite', address);
    const p = readAddress('sqlite', personsAddress);
    const real = realFile(a.name);
    const mark = readMark('sqlite', 'sqlite', real);
    if (!fs.existsSync(a.name)) {
      if (mark?.role === 'story') dropMark('sqlite', 'sqlite', real);
      return false;
    }
    const ext = path.extname(p.name);
    if (mark?.role !== 'story' || !mark.story || path.basename(a.name) !== `${storyName(path.basename(p.name, ext), mark.story)}${ext || '.db'}`) {
      throw new DbError(`squad-kit did not make ${path.basename(a.name)} for a story of this project, so it leaves it alone.`, 'not-ours');
    }
    for (const f of [a.name, `${a.name}-wal`, `${a.name}-shm`, `${a.name}-journal`]) fs.rmSync(f, { force: true });
    dropMark('sqlite', 'sqlite', real);
    return true;
  },

  async removeTemplate(template: DbTemplate): Promise<void> {
    fs.rmSync(template.folder, { recursive: true, force: true });
  },
};

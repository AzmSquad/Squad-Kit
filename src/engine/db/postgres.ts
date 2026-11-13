import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { readAddress, refuseOwn, storyName, templateName, isPersonsOwn, type Address } from './address.js';
import { dropFolder, finishFolder, readTemplate, startFolder, withDefaults } from './folder.js';
import { fitLength, fits, makeFaker, personalKind, typeClass, type Faker, type Personal } from './hide.js';
import { dropMark, putMark, readMark } from './made.js';
import { countKept, describeTables, planRows, selectKept, type Dialect, type ForeignKey, type Plan, type Table } from './sample.js';
import { missing, needTool, runTool, secretsOf } from './run.js';
import { DbError, type DbAdapter, type DbTemplate, type StoryDb, type StoryRef, type TemplateOptions } from './types.js';

/**
 * Postgres. The template is made with Postgres's own tools, reading the source in read-only sessions: the schema with
 * `pg_dump --schema-only` (tables and types first, then keys, indexes and triggers after the rows), the rows with
 * `COPY (SELECT …) TO STDOUT`, all in one snapshot. squad-kit keeps it as files on this computer and as a template
 * database on the same server, `<name>_sk_template`, closed to connections; a story's database is
 * `CREATE DATABASE <name>_<story> TEMPLATE <name>_sk_template`, or made from the files when the template database is
 * gone. Each database squad-kit makes carries a comment that says so, and squad-kit's own mark on this computer.
 */

const TOOLS = ['psql', 'pg_dump'];
const TEMPLATE_NOTE = 'squad-kit template of ';
const STORY_NOTE = /^squad-kit story database for (.+), made from (.+)$/;

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (text: string) => `'${text.replace(/'/g, "''")}'`;

const dialect: Dialect = {
  quote: q,
  text: (col) => `${col}::text`,
  jsonArray: (values) => `json_build_array(${values.join(', ')})::text`,
  literal: (text) => lit(text),
  rowId: 'ctid',
  inTuples: (cols, tuples) => (cols.length === 1 ? `${cols[0]} IN (${tuples.map((t) => t[0]).join(', ')})` : `(${cols.join(', ')}) IN (${tuples.map((t) => `(${t.join(', ')})`).join(', ')})`),
  nullsLast: ' NULLS LAST',
};

function tools(): { psql: string; pgDump: string } {
  const pgDump = needTool('pg_dump', 'Making a Postgres template');
  // psql from the same place as pg_dump, so both read the same files the same way.
  return { pgDump, psql: needTool('psql', 'Making a Postgres database', pgDump) };
}

/** The environment that connects a tool to one database. The password goes here, never on a command line. */
function env(a: Address, database: string, readOnly = false): Record<string, string | undefined> {
  return {
    PGHOST: a.socket ?? a.host ?? 'localhost',
    PGPORT: String(a.port ?? 5432),
    PGUSER: a.user,
    PGPASSWORD: a.password,
    PGDATABASE: database,
    PGSSLMODE: a.params.sslmode,
    PGAPPNAME: 'squad-kit',
    PGCONNECT_TIMEOUT: '15',
    PGOPTIONS: readOnly ? '-c default_transaction_read_only=on' : undefined,
    PGSERVICE: undefined,
  };
}

/** Runs SQL through psql on one database and gives back one line per row. */
export async function sql(a: Address, database: string, text: string, doing: string, readOnly = false): Promise<string[]> {
  const out = await runTool(tools().psql, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { env: env(a, database, readOnly), input: text, secrets: secretsOf(a.password), doing });
  return out.split('\n').filter((l) => l.length);
}

const maintenance = new Map<string, string>();

/** SQL on the server itself (making and dropping databases), from its own maintenance database, never the person's. */
async function onServer(a: Address, text: string, doing: string): Promise<string[]> {
  const known = maintenance.get(a.server);
  const tries = known ? [known] : ['postgres', 'template1'];
  let last: unknown;
  for (const db of tries) {
    try {
      const rows = await sql(a, db, text, doing);
      maintenance.set(a.server, db);
      return rows;
    } catch (e) {
      last = e;
      // Only a database that does not take connections is worth trying the next one for.
      if (!(e instanceof DbError) || !/does not exist|not currently accepting connections|permission denied for database/i.test(e.message)) throw e;
    }
  }
  throw last;
}

interface DbRow {
  name: string;
  note: string | null;
}

async function findDb(a: Address, name: string): Promise<DbRow | null> {
  const rows = await onServer(a, `SELECT json_build_array(datname, shobj_description(oid, 'pg_database'))::text FROM pg_database WHERE datname = ${lit(name)}`, 'Looking for a database on the Postgres server');
  if (!rows.length) return null;
  const [n, note] = JSON.parse(rows[0]!) as [string, string | null];
  return { name: n, note };
}

const CATALOG = `
SELECT json_build_object(
  'tables', coalesce((SELECT json_agg(json_build_object('oid', c.oid, 'schema', n.nspname, 'name', c.relname) ORDER BY n.nspname, c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')), '[]'::json),
  'columns', coalesce((SELECT json_agg(json_build_object('t', a.attrelid, 'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'gen', a.attgenerated <> '', 'notnull', a.attnotnull) ORDER BY a.attrelid, a.attnum)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped), '[]'::json),
  'pks', coalesce((SELECT json_agg(json_build_object('t', k.conrelid, 'cols',
      (SELECT json_agg(a.attname ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(n, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.n)))
    FROM pg_constraint k WHERE k.contype = 'p'), '[]'::json),
  'fks', coalesce((SELECT json_agg(json_build_object('t', k.conrelid, 'p', k.confrelid, 'valid', k.convalidated,
      'cols', (SELECT json_agg(a.attname ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(n, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.n),
      'refs', (SELECT json_agg(a.attname ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY x(n, ord) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.n)))
    FROM pg_constraint k WHERE k.contype = 'f'), '[]'::json),
  'sequences', coalesce((SELECT json_agg(json_build_object('ref', quote_ident(schemaname) || '.' || quote_ident(sequencename), 'last', last_value::text))
    FROM pg_sequences WHERE last_value IS NOT NULL), '[]'::json),
  'version', current_setting('server_version_num')::int,
  'encoding', (SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()),
  'collate', (SELECT datcollate FROM pg_database WHERE datname = current_database()),
  'ctype', (SELECT datctype FROM pg_database WHERE datname = current_database())
)::text`;

interface Catalog {
  tables: { oid: number; schema: string; name: string }[];
  columns: { t: number; name: string; type: string; gen: boolean; notnull: boolean }[];
  pks: { t: number; cols: string[] }[];
  fks: { t: number; p: number; valid: boolean; cols: string[]; refs: string[] }[];
  sequences: { ref: string; last: string }[];
  version: number;
  encoding: string;
  collate: string;
  ctype: string;
}

/** The tables, keys and links, read from Postgres's own catalog. */
function readCatalog(cat: Catalog): { tables: Table[]; fks: (ForeignKey & { valid: boolean })[] } {
  const byOid = new Map<number, Table>();
  const tables = cat.tables.map((t) => {
    const table: Table = {
      name: t.schema === 'public' ? t.name : `${t.schema}.${t.name}`,
      ref: `${q(t.schema)}.${q(t.name)}`,
      columns: cat.columns.filter((c) => c.t === t.oid).map((c) => ({ name: c.name, type: c.type, ...(c.gen ? { generated: true } : {}), ...(c.notnull ? { notNull: true } : {}) })),
      pk: cat.pks.find((p) => p.t === t.oid)?.cols ?? [],
    };
    byOid.set(t.oid, table);
    return table;
  });
  const fks = cat.fks
    .filter((f) => byOid.has(f.t) && byOid.has(f.p))
    .map((f) => ({ child: byOid.get(f.t)!.name, cols: f.cols, parent: byOid.get(f.p)!.name, refCols: f.refs, valid: f.valid }));
  return { tables, fks };
}

/** One value in COPY's text form, read. */
function fromCopy(field: string): string {
  return field.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|(.))/g, (_m, oct: string, hex: string, ch: string) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[ch] ?? ch;
  });
}

/** One value written in COPY's text form. */
function toCopy(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

interface Out {
  ref: string;
  cols: string[];
  /** Column number to the kind of personal data in it, and the column's type. */
  hide: Map<number, { kind: Personal; type: string }>;
}

/**
 * Turns psql's output of every table's COPY, one after another with a `\.` line after each, into a file psql can load:
 * a `COPY … FROM stdin` block per table. Personal values are made fake on the way, so the real ones are never written.
 */
function copyBlocks(outs: Out[], faker: Faker | null): Transform {
  let i = 0;
  let rest = '';
  let started = false;
  // A letter can be cut between two chunks: the decoder holds the half until the rest comes.
  const text8 = new StringDecoder('utf8');
  const header = (o: Out) => `COPY ${o.ref} (${o.cols.map(q).join(', ')}) FROM stdin;\n`;
  const line = (l: string): string => {
    if (l === '\\.') {
      i++;
      return `\\.\n${i < outs.length ? header(outs[i]!) : ''}`;
    }
    const o = outs[i]!;
    if (!faker || !o.hide.size) return `${l}\n`;
    const fields = l.split('\t');
    for (const [n, h] of o.hide) {
      const f = fields[n];
      if (f === undefined || f === '\\N') continue;
      fields[n] = toCopy(fitLength(faker(h.kind, fromCopy(f)), h.type));
    }
    return `${fields.join('\t')}\n`;
  };
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      try {
        let out = '';
        if (!started) {
          started = true;
          if (outs.length) out += header(outs[0]!);
        }
        const lines = (rest + text8.write(chunk)).split('\n');
        rest = lines.pop() ?? '';
        for (const l of lines) out += line(l);
        cb(null, out);
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      try {
        rest += text8.end();
        cb(null, (!started && outs.length ? header(outs[0]!) : '') + (rest ? line(rest) : ''));
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

/** pg_dump's schema, ready to load: a setting older servers do not know is taken out. */
function cleanSchema(text: string): string {
  return text.replace(/^SET transaction_timeout = 0;\n/m, '');
}

/**
 * When not every linked row could be kept: a kept row that points at a row that was not kept has that link emptied
 * where the column may be empty, and is left out where it may not, so the foreign keys can be added. Only then.
 */
function orphanSql(plan: Plan, fks: (ForeignKey & { valid: boolean })[]): string {
  const table = (name: string) => plan.tables.find((t) => t.name === name)!;
  const fixes = fks
    .filter((f) => f.valid)
    .map((f) => {
      const child = table(f.child);
      const notNull = f.cols.map((c) => `c.${q(c)} IS NOT NULL`).join(' AND ');
      const match = f.cols.map((c, i) => `p.${q(f.refCols[i]!)} = c.${q(c)}`).join(' AND ');
      const dangling = `${notNull} AND NOT EXISTS (SELECT 1 FROM ${table(f.parent).ref} p WHERE ${match})`;
      const canEmpty = f.cols.every((c) => !child.columns.find((x) => x.name === c)?.notNull);
      const fix = canEmpty ? `UPDATE ${child.ref} c SET ${f.cols.map((x) => `${q(x)} = NULL`).join(', ')} WHERE ${dangling}` : `DELETE FROM ${child.ref} c WHERE ${dangling}`;
      return `    ${fix};\n    GET DIAGNOSTICS m = ROW_COUNT; n := n + m;`;
    });
  if (!fixes.length) return '';
  return `DO $sk$\nDECLARE n bigint; m bigint;\nBEGIN\n  LOOP\n    n := 0;\n${fixes.join('\n')}\n    EXIT WHEN n = 0;\n  END LOOP;\nEND\n$sk$;\n`;
}

const FILES = { pre: 'schema-pre.sql', data: 'data.sql', orphans: 'orphans.sql', post: 'schema-post.sql', sequences: 'sequences.sql', server: 'server.json' };

/** Loads a template's files into an empty database. */
async function loadFiles(a: Address, folder: string, database: string): Promise<void> {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'];
  for (const f of [FILES.pre, FILES.data, FILES.orphans, FILES.post, FILES.sequences]) {
    const file = path.join(folder, f);
    if (fs.existsSync(file) && fs.statSync(file).size) args.push('-f', file);
  }
  await runTool(tools().psql, args, { env: env(a, database), secrets: secretsOf(a.password), doing: `Loading the template into ${database}` });
}

/** Makes an empty database like the source: the same encoding and sort order, falling back to the server's own. */
async function createEmpty(a: Address, name: string, like: { encoding?: string; collate?: string; ctype?: string }): Promise<void> {
  const exact = like.encoding ? ` TEMPLATE template0 ENCODING ${lit(like.encoding)}${like.collate ? ` LC_COLLATE ${lit(like.collate)}` : ''}${like.ctype ? ` LC_CTYPE ${lit(like.ctype)}` : ''}` : '';
  try {
    await onServer(a, `CREATE DATABASE ${q(name)}${exact}`, `Making the database ${name}`);
  } catch (e) {
    if (!exact || !(e instanceof DbError) || /already exists/i.test(e.message)) throw e;
    await onServer(a, `CREATE DATABASE ${q(name)}`, `Making the database ${name}`);
  }
}

async function dropDb(a: Address, name: string, version: number): Promise<void> {
  if (version >= 130000) {
    await onServer(a, `DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`, `Dropping the database ${name}`);
    return;
  }
  await onServer(a, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${lit(name)} AND pid <> pg_backend_pid()`, `Closing connections to ${name}`);
  await onServer(a, `DROP DATABASE IF EXISTS ${q(name)}`, `Dropping the database ${name}`);
}

async function serverVersion(a: Address): Promise<number> {
  const rows = await onServer(a, `SELECT current_setting('server_version_num')`, 'Asking the Postgres server its version');
  return Number(rows[0] ?? 0);
}

function storyRef(story: StoryRef): string {
  if (!story?.id?.trim()) throw new DbError('A story database needs the story id.', 'bad-address');
  return story.id.trim();
}

export const postgres: DbAdapter = {
  kind: 'postgres',

  missingTools: () => missing(TOOLS),

  nameOf: (address) => readAddress('postgres', address).name,

  storyAddress(sourceAddress, story) {
    const a = readAddress('postgres', sourceAddress);
    return a.withName(storyName(a.name, storyRef(story)));
  },

  isPersonsOwn: (address, personsAddress) => isPersonsOwn('postgres', address, personsAddress),

  async makeTemplate(source: string, opts: TemplateOptions): Promise<DbTemplate> {
    const o = withDefaults(opts);
    const a = readAddress('postgres', source);
    const { pgDump } = tools();
    const secrets = secretsOf(a.password);
    const read = (text: string) => sql(a, a.name, text, `Reading ${a.name}`, true);
    const tmpl = templateName(a.name);
    refuseOwn('postgres', a.withName(tmpl), source, 'makes or changes');
    const making = startFolder(o.folder);
    let made = false;
    try {
      const cat = JSON.parse((await read(CATALOG))[0]!) as Catalog;
      const { tables, fks } = readCatalog(cat);
      const plan = await planRows(tables, fks, dialect, read, o);
      const counts = await countKept(plan, dialect, read);
      // The schema, in two parts: tables and types before the rows, keys, indexes and triggers after them.
      for (const [section, file] of [
        ['pre-data', FILES.pre],
        ['post-data', FILES.post],
      ] as const) {
        const text = await runTool(pgDump, ['--schema-only', '--no-owner', '--no-privileges', `--section=${section}`], { env: env(a, a.name, true), secrets, doing: `Reading the schema of ${a.name}` });
        fs.writeFileSync(path.join(making, file), cleanSchema(text));
      }
      // The rows: one read-only snapshot, every table's COPY in turn, faked on the way when asked.
      const faker = o.hidePersonal ? makeFaker() : null;
      const hidden: string[] = [];
      const outs: Out[] = tables.map((t) => {
        const cols = t.columns.filter((c) => !c.generated);
        const hide = new Map<number, { kind: Personal; type: string }>();
        if (faker) {
          cols.forEach((c, i) => {
            const kind = personalKind(c.name, t.name);
            if (kind && fits(kind, typeClass(c.type))) {
              hide.set(i, { kind, type: c.type });
              hidden.push(`${t.name}.${c.name}`);
            }
          });
        }
        return { ref: t.ref, cols: cols.map((c) => c.name), hide };
      });
      const script = [
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
        ...tables.map((t, i) => `COPY (${selectKept(plan, dialect, t, outs[i]!.cols.map(q).join(', ') || '*')}) TO STDOUT;\n\\echo '\\\\.'`),
        'COMMIT;',
      ].join('\n');
      await runTool(tools().psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
        env: env(a, a.name, true),
        input: script,
        outFile: path.join(making, FILES.data),
        through: copyBlocks(outs, faker),
        secrets,
        doing: `Copying rows from ${a.name}`,
      });
      fs.writeFileSync(path.join(making, FILES.orphans), plan.complete ? '' : orphanSql(plan, fks));
      fs.writeFileSync(path.join(making, FILES.sequences), cat.sequences.map((s) => `SELECT pg_catalog.setval(${lit(s.ref)}, ${s.last}, true);`).join('\n') + '\n');
      fs.writeFileSync(path.join(making, FILES.server), JSON.stringify({ version: cat.version, encoding: cat.encoding, collate: cat.collate, ctype: cat.ctype }, null, 2) + '\n');

      // The template database on the server: the last one goes, the new one is loaded from the files.
      const old = await findDb(a, tmpl);
      if (old) {
        if (!old.note?.startsWith(TEMPLATE_NOTE)) throw new DbError(`A database named ${tmpl} is already on the server, and squad-kit did not make it. squad-kit leaves it alone.`, 'not-ours');
        await dropDb(a, tmpl, cat.version);
      }
      await createEmpty(a, tmpl, cat);
      made = true;
      await onServer(a, `COMMENT ON DATABASE ${q(tmpl)} IS ${lit(TEMPLATE_NOTE + a.name)}`, `Marking ${tmpl}`);
      await loadFiles(a, making, tmpl);
      // Nobody connects to it, so making a story's database from it is never held up by a connection.
      await onServer(a, `ALTER DATABASE ${q(tmpl)} ALLOW_CONNECTIONS false`, `Closing ${tmpl} to connections`);
      putMark({ kind: 'postgres', server: a.server, name: tmpl, role: 'template', sourceName: a.name, madeAt: new Date().toISOString() });

      const notes = [...plan.notes];
      if (cat.sequences.length) notes.push('Sequences continue from where they are in your database, so new rows never take a kept row’s id.');
      const info = finishFolder(making, o.folder, {
        kind: 'postgres',
        source: a.safe,
        sourceName: a.name,
        madeAt: new Date().toISOString(),
        smallRows: o.smallRows,
        sampleRows: o.sampleRows,
        hidePersonal: o.hidePersonal,
        tables: describeTables(plan, counts),
        hidden,
        linksComplete: plan.complete,
        notes,
      });
      return { kind: 'postgres', folder: o.folder, source, info };
    } catch (e) {
      dropFolder(making);
      if (made) await dropDb(a, tmpl, await serverVersion(a).catch(() => 0)).catch(() => undefined);
      throw e;
    }
  },

  async createStoryDb(template: DbTemplate, story: StoryRef): Promise<StoryDb> {
    const a = readAddress('postgres', template.source);
    const id = storyRef(story);
    const name = storyName(a.name, id);
    const address = a.withName(name);
    refuseOwn('postgres', address, template.source, 'makes or changes');
    const there = await findDb(a, name);
    if (there) {
      const m = there.note ? STORY_NOTE.exec(there.note) : null;
      if (m && m[1] === id && readMark('postgres', a.server, name)) return { kind: 'postgres', name, address, existed: true };
      throw new DbError(`A database named ${name} is already on the server, and squad-kit did not make it for this story. squad-kit leaves it alone.`, 'not-ours');
    }
    const tmpl = templateName(a.name);
    const t = await findDb(a, tmpl);
    const note = `COMMENT ON DATABASE ${q(name)} IS ${lit(`squad-kit story database for ${id}, made from ${a.name}`)}`;
    // squad-kit's marks go on as soon as the database is there, so even one cut off half way is known as squad-kit's own.
    putMark({ kind: 'postgres', server: a.server, name, role: 'story', story: id, sourceName: a.name, madeAt: new Date().toISOString() });
    let made = false;
    try {
      if (t?.note?.startsWith(TEMPLATE_NOTE)) {
        try {
          await onServer(a, `CREATE DATABASE ${q(name)} TEMPLATE ${q(tmpl)}`, `Making ${name} from the template`);
          made = true;
          await onServer(a, note, `Marking ${name}`);
        } catch (e) {
          // Someone is connected to the template: make it from the files instead.
          if (made || !(e instanceof DbError) || !/being accessed by other users/i.test(e.message)) throw e;
        }
      }
      if (!made) {
        if (!readTemplate(template.folder, template.source, 'postgres')) throw new DbError('The template’s files are not on this computer any more. Make the template again.', 'failed');
        let like: { encoding?: string; collate?: string; ctype?: string } = {};
        try {
          like = JSON.parse(fs.readFileSync(path.join(template.folder, FILES.server), 'utf8')) as typeof like;
        } catch {
          // Made by the server's own defaults.
        }
        await createEmpty(a, name, like);
        made = true;
        await onServer(a, note, `Marking ${name}`);
        await loadFiles(a, template.folder, name);
      }
    } catch (e) {
      if (made) await dropDb(a, name, await serverVersion(a).catch(() => 0)).catch(() => undefined);
      dropMark('postgres', a.server, name);
      throw e;
    }
    return { kind: 'postgres', name, address, existed: false };
  },

  async dropStoryDb(address: string, personsAddress: string): Promise<boolean> {
    refuseOwn('postgres', address, personsAddress, 'drops');
    const a = readAddress('postgres', address);
    const p = readAddress('postgres', personsAddress);
    const there = await findDb(a, a.name);
    const mark = readMark('postgres', a.server, a.name);
    if (!there) {
      if (mark?.role === 'story') dropMark('postgres', a.server, a.name);
      return false;
    }
    const m = there.note ? STORY_NOTE.exec(there.note) : null;
    const story = m?.[1] ?? '';
    if (!m || mark?.role !== 'story' || mark.story !== story || a.name !== storyName(p.name, story)) {
      throw new DbError(`squad-kit did not make ${a.name} for a story of this project, so it leaves it alone.`, 'not-ours');
    }
    await dropDb(a, a.name, await serverVersion(a));
    dropMark('postgres', a.server, a.name);
    return true;
  },

  async removeTemplate(template: DbTemplate): Promise<void> {
    const a = readAddress('postgres', template.source);
    const tmpl = templateName(a.name);
    const t = await findDb(a, tmpl);
    if (t) {
      if (!t.note?.startsWith(TEMPLATE_NOTE)) throw new DbError(`squad-kit did not make ${tmpl}, so it leaves it alone.`, 'not-ours');
      refuseOwn('postgres', a.withName(tmpl), template.source, 'drops');
      await dropDb(a, tmpl, await serverVersion(a));
    }
    dropMark('postgres', a.server, tmpl);
    fs.rmSync(template.folder, { recursive: true, force: true });
  },
};

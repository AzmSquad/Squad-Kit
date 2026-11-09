import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isPersonsOwn, readAddress, refuseOwn, storyName, type Address } from './address.js';
import { dropFolder, finishFolder, readTemplate, startFolder, withDefaults } from './folder.js';
import { fitLength, fits, makeFaker, personalKind, typeClass, type Faker, type Personal } from './hide.js';
import { dropMark, putMark, readMark } from './made.js';
import { countKept, describeTables, planRows, chosen, type Column, type Dialect, type ForeignKey, type Table } from './sample.js';
import { lineByLine, missing, needTool, runTool, secretsOf, withPrivateDir, writePrivate } from './run.js';
import { DbError, type DbAdapter, type DbTemplate, type StoryDb, type StoryRef, type TemplateOptions } from './types.js';

/**
 * MySQL (and MariaDB). The template is files on this computer, made with MySQL's own tools reading the source in
 * read-only sessions: the schema with `mysqldump --no-data`, triggers and routines on their own so they are added after
 * the rows, and the rows a table at a time with `mysqldump --where`. A story's database is `CREATE DATABASE` and a load
 * of those files. MySQL has no place on the server to mark a database, so squad-kit's mark on this computer is what
 * says it made one. Scheduled events are not copied: in a story's database they would run on their own.
 */

const TOOLS = ['mysql', 'mysqldump'];

const q = (name: string) => `\`${name.replace(/`/g, '``')}\``;

/** A string for MySQL's SQL, with its own escapes (the session turns off NO_BACKSLASH_ESCAPES first). */
function lit(text: string): string {
  return `'${text.replace(/[\0\n\r\\'"\x1a]/g, (c) => ({ '\0': '\\0', '\n': '\\n', '\r': '\\r', '\\': '\\\\', "'": "\\'", '"': '\\"', '\x1a': '\\Z' })[c]!)}'`;
}

const dialect: Dialect = {
  quote: q,
  text: (col, c) => (c?.binary ? `HEX(${col})` : `CAST(${col} AS CHAR)`),
  jsonArray: (values) => `JSON_ARRAY(${values.join(', ')})`,
  literal: (text, c) => (c?.binary ? `X'${text.replace(/[^0-9a-fA-F]/g, '')}'` : lit(text)),
  inTuples: (cols, tuples) => (cols.length === 1 ? `${cols[0]} IN (${tuples.map((t) => t[0]).join(', ')})` : `(${cols.join(', ')}) IN (${tuples.map((t) => `(${t.join(', ')})`).join(', ')})`),
  nullsLast: '',
};

let flavour: { file: string; maria: boolean } | null = null;

function tools(): { mysql: string; mysqldump: string; maria: boolean } {
  const mysqldump = needTool('mysqldump', 'Making a MySQL template');
  const mysql = needTool('mysql', 'Making a MySQL database', mysqldump);
  if (flavour?.file !== mysqldump) {
    let v = '';
    try {
      v = execFileSync(mysqldump, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    } catch {
      // Read as MySQL's.
    }
    flavour = { file: mysqldump, maria: /mariadb/i.test(v) };
  }
  return { mysql, mysqldump, maria: flavour.maria };
}

/** MySQL's option file for one connection: the password goes in it, never on a command line. */
function optionFile(a: Address): string {
  const v = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = ['[client]'];
  if (a.user) lines.push(`user=${v(a.user)}`);
  if (a.password !== undefined) lines.push(`password=${v(a.password)}`);
  if (a.socket) lines.push(`socket=${v(a.socket)}`, 'protocol=SOCKET');
  else lines.push(`host=${v(a.host || '127.0.0.1')}`, `port=${a.port ?? 3306}`, 'protocol=TCP');
  const ssl = a.params['ssl-mode'] ?? a.params.sslmode ?? a.params.ssl;
  if (ssl && /^(required|require|true|verify_ca|verify_identity)$/i.test(ssl)) lines.push(`ssl-mode=${/verify/i.test(ssl) ? ssl.toUpperCase() : 'REQUIRED'}`);
  lines.push('default-character-set=utf8mb4');
  return lines.join('\n') + '\n';
}

/** Runs one or more tool calls with the connection's option file, removed right after. */
async function connected<T>(a: Address, work: (opt: string) => Promise<T>): Promise<T> {
  return withPrivateDir(async (dir) => {
    const opt = path.join(dir, 'client.cnf');
    writePrivate(opt, optionFile(a));
    return work(opt);
  });
}

/** Every read on the source starts so: read only, and with the escapes squad-kit writes. */
const READ_ONLY = "SET SESSION TRANSACTION READ ONLY; SET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '');";

async function sql(a: Address, database: string | null, text: string, doing: string, readOnly = false): Promise<string[]> {
  return connected(a, async (opt) => {
    const args = [`--defaults-extra-file=${opt}`, '--batch', '--raw', '--skip-column-names', ...(database ? [`--database=${database}`] : [])];
    const out = await runTool(tools().mysql, args, { input: (readOnly ? READ_ONLY : "SET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '');") + '\n' + text + ';\n', secrets: secretsOf(a.password), doing });
    return out.split('\n').filter((l) => l.length);
  });
}

const CATALOG = `SELECT JSON_OBJECT(
  'tables', (SELECT JSON_ARRAYAGG(TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'),
  'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT('t', TABLE_NAME, 'name', COLUMN_NAME, 'type', COLUMN_TYPE, 'data', DATA_TYPE, 'extra', EXTRA, 'pos', ORDINAL_POSITION))
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()),
  'keys', (SELECT JSON_ARRAYAGG(JSON_OBJECT('t', TABLE_NAME, 'c', CONSTRAINT_NAME, 'col', COLUMN_NAME, 'pos', ORDINAL_POSITION, 'rs', REFERENCED_TABLE_SCHEMA, 'rt', REFERENCED_TABLE_NAME, 'rc', REFERENCED_COLUMN_NAME))
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL)),
  'charset', (SELECT DEFAULT_CHARACTER_SET_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()),
  'collation', (SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()),
  'events', (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE())
)`;

interface Catalog {
  tables: string[] | null;
  columns: { t: string; name: string; type: string; data: string; extra: string; pos: number }[] | null;
  keys: { t: string; c: string; col: string; pos: number; rs: string | null; rt: string | null; rc: string | null }[] | null;
  charset: string;
  collation: string;
  events: number;
}

const BINARY = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit', 'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection']);

function readCatalog(cat: Catalog, database: string): { tables: Table[]; fks: ForeignKey[]; outside: boolean } {
  const cols = [...(cat.columns ?? [])].sort((x, y) => x.pos - y.pos);
  const keys = [...(cat.keys ?? [])].sort((x, y) => x.pos - y.pos);
  const tables = [...(cat.tables ?? [])].sort().map((t) => ({
    name: t,
    ref: q(t),
    columns: cols
      .filter((c) => c.t === t)
      .map((c): Column => ({ name: c.name, type: c.type, ...(/\b(VIRTUAL|STORED) GENERATED\b/i.test(c.extra) ? { generated: true } : {}), ...(BINARY.has(c.data.toLowerCase()) ? { binary: true } : {}) })),
    pk: keys.filter((k) => k.t === t && k.c === 'PRIMARY').map((k) => k.col),
  }));
  const fks = new Map<string, ForeignKey>();
  let outside = false;
  for (const k of keys) {
    if (k.c === 'PRIMARY' || !k.rt || !k.rc) continue;
    if (k.rs && k.rs !== database) {
      outside = true;
      continue;
    }
    const id = `${k.t}\0${k.c}`;
    const fk = fks.get(id) ?? { child: k.t, cols: [], parent: k.rt, refCols: [] };
    fk.cols.push(k.col);
    fk.refCols.push(k.rc);
    fks.set(id, fk);
  }
  return { tables, fks: [...fks.values()], outside };
}

/** Reads the values of one row in a mysqldump INSERT line: strings, numbers, NULL, 0x… hex, b'…' bits. */
export function readValues(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    if (text[i] === "'") {
      i++;
      while (i < text.length && text[i] !== "'") i += text[i] === '\\' ? 2 : 1;
      i++;
    } else if (/^_\w+\s*'/.test(text.slice(i, i + 20)) || /^[bxX]'/.test(text.slice(i, i + 2))) {
      i = text.indexOf("'", i) + 1;
      while (i < text.length && text[i] !== "'") i += text[i] === '\\' ? 2 : 1;
      i++;
    } else {
      while (i < text.length && text[i] !== ',') i++;
    }
    out.push(text.slice(start, i));
    if (text[i] === ',') i++;
  }
  return out;
}

/** A quoted string from mysqldump, read. */
function unquote(token: string): string | null {
  if (!token.startsWith("'")) return null;
  return token.slice(1, -1).replace(/\\(.)/g, (_m, c: string) => ({ '0': '\0', n: '\n', r: '\r', Z: '\x1a', t: '\t', b: '\b' })[c] ?? c);
}

/** The fake form of one value from a dump: a string stays a string, a number a number of the same length. */
function fakeToken(token: string, kind: Personal, type: string, faker: Faker): string {
  if (token === 'NULL') return token;
  const s = unquote(token);
  if (s !== null) return lit(fitLength(faker(kind, s), type));
  if (/^-?\d+$/.test(token)) return faker(kind, token);
  return token;
}

/** A mysqldump line with the personal values made fake. */
export function fakeLine(line: string, hide: Map<string, { kind: Personal; type: string }>, faker: Faker): string {
  const m = /^(INSERT INTO `(?:[^`]|``)+` \()(.*?)(\) VALUES \()(.*)(\);)$/.exec(line);
  if (!m) return line;
  const cols = m[2]!.split(/`,\s*`/).map((c) => c.replace(/^`|`$/g, '').replace(/``/g, '`'));
  const values = readValues(m[4]!);
  if (values.length !== cols.length) return line;
  const faked = values.map((v, i) => {
    const h = hide.get(cols[i]!);
    return h ? fakeToken(v, h.kind, h.type, faker) : v;
  });
  return `${m[1]}${m[2]}${m[3]}${faked.join(',')}${m[5]}`;
}

/** Definers name a user of the source's server; without them, what squad-kit makes belongs to whoever makes it. */
function noDefiners(text: string): string {
  return text.replace(/DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'[^']*'|\S+?)@(?:`(?:[^`]|``)*`|'[^']*'|[^\s*]+)\s*/g, '');
}

const FILES = { schema: 'schema.sql', data: 'data.sql', triggers: 'triggers.sql', routines: 'routines.sql', server: 'server.json' };

/** Loads a template's files into an empty database, with the source's name in them changed to the new one's. */
async function loadFiles(a: Address, folder: string, database: string, sourceName: string): Promise<void> {
  const rename = (text: string) => noDefiners(text).split(`${q(sourceName)}.`).join(`${q(database)}.`);
  const read = (f: string) => {
    try {
      return rename(fs.readFileSync(path.join(folder, f), 'utf8'));
    } catch {
      return '';
    }
  };
  const head = "SET NAMES utf8mb4; SET TIME_ZONE='+00:00'; SET FOREIGN_KEY_CHECKS=0; SET UNIQUE_CHECKS=0; SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO'; SET SQL_NOTES=0;\n";
  const dataFile = path.join(folder, FILES.data);
  async function* script() {
    yield head + read(FILES.schema) + '\n';
    if (fs.existsSync(dataFile)) yield* fs.createReadStream(dataFile);
    yield '\n' + read(FILES.triggers) + '\n' + read(FILES.routines) + '\nSET FOREIGN_KEY_CHECKS=1;\n';
  }
  await connected(a, (opt) =>
    runTool(tools().mysql, [`--defaults-extra-file=${opt}`, `--database=${database}`, '--batch'], { input: Readable.from(script()), secrets: secretsOf(a.password), doing: `Loading the template into ${database}` }),
  );
}

async function exists(a: Address, name: string): Promise<boolean> {
  const rows = await sql(a, null, `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${lit(name)}`, 'Looking for a database on the MySQL server');
  return rows.length > 0;
}

function storyRef(story: StoryRef): string {
  if (!story?.id?.trim()) throw new DbError('A story database needs the story id.', 'bad-address');
  return story.id.trim();
}

export const mysql: DbAdapter = {
  kind: 'mysql',

  missingTools: () => missing(TOOLS),

  nameOf: (address) => readAddress('mysql', address).name,

  storyAddress(sourceAddress, story) {
    const a = readAddress('mysql', sourceAddress);
    return a.withName(storyName(a.name, storyRef(story)));
  },

  isPersonsOwn: (address, personsAddress) => isPersonsOwn('mysql', address, personsAddress),

  async makeTemplate(source: string, opts: TemplateOptions): Promise<DbTemplate> {
    const o = withDefaults(opts);
    const a = readAddress('mysql', source);
    const t = tools();
    const secrets = secretsOf(a.password);
    const read = (text: string) => sql(a, a.name, text, `Reading ${a.name}`, true);
    const making = startFolder(o.folder);
    try {
      const cat = JSON.parse((await read(CATALOG))[0]!) as Catalog;
      const { tables, fks, outside } = readCatalog(cat, a.name);
      const plan = await planRows(tables, fks, dialect, read, o);
      const counts = await countKept(plan, dialect, read);
      const only8 = t.maria ? [] : ['--set-gtid-purged=OFF', '--column-statistics=0'];
      const common = ['--single-transaction', '--skip-comments', '--no-tablespaces', '--default-character-set=utf8mb4', ...only8];
      const hidden: string[] = [];
      await connected(a, async (opt) => {
        const dump = (args: string[], outFile: string, doing: string, through?: ReturnType<typeof lineByLine>) =>
          runTool(t.mysqldump, [`--defaults-extra-file=${opt}`, ...common, ...args], { outFile, secrets, doing, ...(through ? { through } : {}) });
        await dump(['--no-data', '--skip-triggers', '--skip-add-drop-table', a.name], path.join(making, FILES.schema), `Reading the schema of ${a.name}`);
        await dump(['--no-data', '--no-create-info', '--triggers', a.name], path.join(making, FILES.triggers), `Reading the triggers of ${a.name}`);
        await dump(['--no-data', '--no-create-info', '--skip-triggers', '--routines', a.name], path.join(making, FILES.routines), `Reading the routines of ${a.name}`);
        // The rows, a table at a time, faked on the way when asked.
        const faker = o.hidePersonal ? makeFaker() : null;
        const dataFile = path.join(making, FILES.data);
        fs.writeFileSync(dataFile, '');
        for (const table of tables) {
          const hide = new Map<string, { kind: Personal; type: string }>();
          if (faker) {
            for (const c of table.columns) {
              const kind = c.generated || c.binary ? null : personalKind(c.name, table.name);
              if (kind && fits(kind, typeClass(c.type))) {
                hide.set(c.name, { kind, type: c.type });
                hidden.push(`${table.name}.${c.name}`);
              }
            }
          }
          const c = chosen(plan, dialect, table);
          const part = path.join(making, `part-${tables.indexOf(table)}.sql`);
          await dump(
            ['--no-create-info', '--skip-triggers', '--compact', '--skip-extended-insert', '--complete-insert', '--hex-blob', `--where=${c.where}${c.tail}`, a.name, table.name],
            part,
            `Copying rows from ${a.name}.${table.name}`,
            faker && hide.size ? lineByLine((l) => fakeLine(l, hide, faker)) : undefined,
          );
          fs.appendFileSync(dataFile, fs.readFileSync(part));
          fs.rmSync(part);
        }
      });
      fs.writeFileSync(path.join(making, FILES.server), JSON.stringify({ charset: cat.charset, collation: cat.collation }, null, 2) + '\n');
      const notes = [...plan.notes];
      if (outside) notes.push('Some foreign keys point at tables in another database: those rows are not kept.');
      if (cat.events) notes.push(`Scheduled events (${cat.events}) are not copied: in a story’s database they would run on their own.`);
      const info = finishFolder(making, o.folder, {
        kind: 'mysql',
        source: a.safe,
        sourceName: a.name,
        madeAt: new Date().toISOString(),
        smallRows: o.smallRows,
        sampleRows: o.sampleRows,
        hidePersonal: o.hidePersonal,
        tables: describeTables(plan, counts),
        hidden,
        linksComplete: plan.complete && !outside,
        notes,
      });
      return { kind: 'mysql', folder: o.folder, source, info };
    } catch (e) {
      dropFolder(making);
      throw e;
    }
  },

  async createStoryDb(template: DbTemplate, story: StoryRef): Promise<StoryDb> {
    const a = readAddress('mysql', template.source);
    const id = storyRef(story);
    const name = storyName(a.name, id);
    const address = a.withName(name);
    refuseOwn('mysql', address, template.source, 'makes or changes');
    if (await exists(a, name)) {
      const mark = readMark('mysql', a.server, name);
      if (mark?.role === 'story' && mark.story === id) return { kind: 'mysql', name, address, existed: true };
      throw new DbError(`A database named ${name} is already on the server, and squad-kit did not make it for this story. squad-kit leaves it alone.`, 'not-ours');
    }
    if (!readTemplate(template.folder, template.source, 'mysql')) throw new DbError('The template’s files are not on this computer any more. Make the template again.', 'failed');
    let like: { charset?: string; collation?: string } = {};
    try {
      like = JSON.parse(fs.readFileSync(path.join(template.folder, FILES.server), 'utf8')) as typeof like;
    } catch {
      // The server's own defaults.
    }
    const charset = like.charset && /^\w+$/.test(like.charset) ? ` CHARACTER SET ${like.charset}${like.collation && /^\w+$/.test(like.collation) ? ` COLLATE ${like.collation}` : ''}` : '';
    // The mark goes on first, so a database cut off half way is still known as squad-kit's own.
    putMark({ kind: 'mysql', server: a.server, name, role: 'story', story: id, sourceName: a.name, madeAt: new Date().toISOString() });
    let made = false;
    try {
      await sql(a, null, `CREATE DATABASE ${q(name)}${charset}`, `Making the database ${name}`);
      made = true;
      await loadFiles(a, template.folder, name, template.info.sourceName || a.name);
    } catch (e) {
      if (made) await sql(a, null, `DROP DATABASE IF EXISTS ${q(name)}`, `Dropping the database ${name}`).catch(() => undefined);
      dropMark('mysql', a.server, name);
      throw e;
    }
    return { kind: 'mysql', name, address, existed: false };
  },

  async dropStoryDb(address: string, personsAddress: string): Promise<boolean> {
    refuseOwn('mysql', address, personsAddress, 'drops');
    const a = readAddress('mysql', address);
    const p = readAddress('mysql', personsAddress);
    const mark = readMark('mysql', a.server, a.name);
    const there = await exists(a, a.name);
    if (!there) {
      if (mark?.role === 'story') dropMark('mysql', a.server, a.name);
      return false;
    }
    if (mark?.role !== 'story' || !mark.story || a.name !== storyName(p.name, mark.story)) {
      throw new DbError(`squad-kit did not make ${a.name} for a story of this project, so it leaves it alone.`, 'not-ours');
    }
    await sql(a, null, `DROP DATABASE ${q(a.name)}`, `Dropping the database ${a.name}`);
    dropMark('mysql', a.server, a.name);
    return true;
  },

  async removeTemplate(template: DbTemplate): Promise<void> {
    fs.rmSync(template.folder, { recursive: true, force: true });
  },
};

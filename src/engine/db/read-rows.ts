import { readAddress } from './address.js';
import { shell } from './mongo.js';
import { lit as mysqlLit, sql as mysqlSql } from './mysql.js';
import { sql as postgresSql } from './postgres.js';
import { needTool, runTool } from './run.js';
import { DbError, type DbKind } from './types.js';

/**
 * Reading a few rows of a story's own database for its proof (engine/proof-kinds/rows.ts). squad-kit builds the one
 * query itself, from a table's name and the columns each row must equal: a name is only letters, digits and
 * underscores, and every value is a quoted literal. Nothing else reaches the database, and every kind reads in a
 * read-only way: SQLite opens the file read-only, Postgres and MySQL read in a read-only transaction, Mongo only finds.
 */

export type RowValue = string | number | boolean | null;

export interface RowsAsk {
  table: string;
  /** Each column and the value it equals. Empty: the newest rows. */
  where: Record<string, RowValue>;
  limit: number;
}

export interface RowsRead {
  /** The table's columns, in order. Empty when the table is not there. */
  columns: string[];
  rows: Record<string, unknown>[];
  /** The tables there are, to say when a name is wrong. */
  tables: string[];
}

/** A name squad-kit puts in a query: a table or a column, never anything more. */
export const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** How long one read may take: the database stops the query, and squad-kit stops the tool soon after. */
export const READ_MS = 20_000;
const TOOL_MS = 30_000;

/** Why a value is not sent: a backslash or a control character, which could change how a literal is read. */
export function valueProblem(v: RowValue): string | null {
  if (typeof v === 'number' && !Number.isFinite(v)) return 'a number in "where" is not a real number';
  return typeof v === 'string' && /[\\\u0000-\u001f\u007f]/.test(v) ? 'a value in "where" holds a backslash or a control character, which squad-kit does not send' : null;
}

type SqlKind = Exclude<DbKind, 'mongo'>;

function quoteName(kind: SqlKind, name: string): string {
  if (!SAFE_NAME.test(name)) throw new DbError(`"${name.slice(0, 40)}" is not a name squad-kit reads.`, 'failed');
  return kind === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

function literal(kind: SqlKind, v: RowValue): string {
  const wrong = valueProblem(v);
  if (wrong) throw new DbError(`${wrong.charAt(0).toUpperCase()}${wrong.slice(1)}.`, 'failed');
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return kind === 'sqlite' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE';
  return kind === 'mysql' ? mysqlLit(String(v)) : `'${String(v).replace(/'/g, "''")}'`;
}

/** The one query squad-kit runs: SELECT, from one table, where each column equals its value, newest first, a few rows. */
export function selectSql(kind: SqlKind, ask: RowsAsk): string {
  const where = Object.entries(ask.where).map(([col, v]) => (v === null ? `${quoteName(kind, col)} IS NULL` : `${quoteName(kind, col)} = ${literal(kind, v)}`));
  const limit = Math.max(1, Math.min(50, Math.floor(ask.limit)));
  // MySQL stops the query itself after READ_MS; MariaDB reads the hint as a comment, and the tool's own limit holds.
  const hint = kind === 'mysql' ? `/*+ MAX_EXECUTION_TIME(${READ_MS}) */ ` : '';
  return `SELECT ${hint}* FROM ${quoteName(kind, ask.table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY 1 DESC LIMIT ${limit}`;
}

function json<T>(text: string | undefined, fallback: T): T {
  try {
    return text?.trim() ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function sqlite(file: string, ask: RowsAsk): Promise<RowsRead> {
  const script = [
    '.mode list',
    "SELECT json_group_array(name) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\';",
    `SELECT json_group_array(name) FROM pragma_table_info(${literal('sqlite', ask.table)});`,
  ].join('\n');
  const head = await runTool(needTool('sqlite3', "Reading the story's database"), ['-readonly', '-batch', '-bail', file], { input: `${script}\n`, secrets: [], doing: "Reading the story's database", timeoutMs: TOOL_MS });
  const [tables, columns] = head.split('\n').map((l) => json<string[]>(l, []));
  if (!columns?.length) return { columns: [], rows: [], tables: tables ?? [] };
  const out = await runTool(needTool('sqlite3', "Reading the story's database"), ['-readonly', '-batch', '-bail', '-json', file], { input: `${selectSql('sqlite', ask)};\n`, secrets: [], doing: "Reading the story's database", timeoutMs: TOOL_MS });
  return { columns, rows: json<Record<string, unknown>[]>(out, []), tables: tables ?? [] };
}

async function postgres(address: string, ask: RowsAsk): Promise<RowsRead> {
  const a = readAddress('postgres', address);
  const doing = "Reading the story's database";
  const head = await postgresSql(
    a,
    a.name,
    `SET statement_timeout = ${READ_MS};\nSELECT json_build_object('tables', (SELECT coalesce(json_agg(table_name ORDER BY table_name), '[]') FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'), 'columns', (SELECT coalesce(json_agg(column_name ORDER BY ordinal_position), '[]') FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${literal('postgres', ask.table)}));`,
    doing,
    true,
    TOOL_MS,
  );
  const cat = json<{ tables?: string[]; columns?: string[] }>(head.at(-1), {});
  if (!cat.columns?.length) return { columns: [], rows: [], tables: cat.tables ?? [] };
  const out = await postgresSql(a, a.name, `SET statement_timeout = ${READ_MS};\nSELECT coalesce(json_agg(r), '[]') FROM (${selectSql('postgres', ask)}) r;`, doing, true, TOOL_MS);
  return { columns: cat.columns, rows: json<Record<string, unknown>[]>(out.at(-1), []), tables: cat.tables ?? [] };
}

async function mysql(address: string, ask: RowsAsk): Promise<RowsRead> {
  const a = readAddress('mysql', address);
  const doing = "Reading the story's database";
  const head = await mysqlSql(
    a,
    a.name,
    `SELECT JSON_OBJECT('tables', (SELECT JSON_ARRAYAGG(TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'), 'columns', (SELECT JSON_ARRAYAGG(COLUMN_NAME) FROM (SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${literal('mysql', ask.table)} ORDER BY ORDINAL_POSITION) c))`,
    doing,
    true,
    TOOL_MS,
  );
  const cat = json<{ tables?: string[] | null; columns?: string[] | null }>(head.at(-1), {});
  if (!cat.columns?.length) return { columns: [], rows: [], tables: cat.tables ?? [] };
  const pairs = cat.columns.map((c) => `${mysqlLit(c)}, r.${quoteName('mysql', c)}`).join(', ');
  const out = await mysqlSql(a, a.name, `SELECT JSON_ARRAYAGG(JSON_OBJECT(${pairs})) FROM (${selectSql('mysql', ask)}) r`, doing, true, TOOL_MS);
  return { columns: cat.columns, rows: json<Record<string, unknown>[] | null>(out.at(-1), []) ?? [], tables: cat.tables ?? [] };
}

/** Mongo: find only, by the fields given, newest first. The filter goes in as data, never as code. */
async function mongo(address: string, ask: RowsAsk): Promise<RowsRead> {
  const a = readAddress('mongo', address);
  const script = `const d = new Mongo(process.env.SK_DB_URI).getDB(process.env.SK_DB_NAME);
const names = d.getCollectionNames().filter((n) => !n.startsWith('system.')).sort();
const c = process.env.SK_COLL;
const rows = names.includes(c) ? d.getCollection(c).find(JSON.parse(process.env.SK_FILTER)).sort({ _id: -1 }).limit(Number(process.env.SK_LIMIT)).maxTimeMS(Number(process.env.SK_MS)).toArray() : [];
print(EJSON.stringify({ tables: names, has: names.includes(c), rows }, { relaxed: true }));`;
  const out = await shell(a, script, { SK_DB_NAME: a.name, SK_COLL: ask.table, SK_FILTER: JSON.stringify(ask.where), SK_LIMIT: String(Math.max(1, Math.min(50, ask.limit))), SK_MS: String(READ_MS) }, "Reading the story's database", TOOL_MS);
  const got = json<{ tables?: string[]; has?: boolean; rows?: Record<string, unknown>[] }>(out.trim().split('\n').at(-1), {});
  const rows = got.rows ?? [];
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { columns: got.has ? (columns.length ? columns : ['_id']) : [], rows, tables: got.tables ?? [] };
}

/** Reads the rows asked for, read only. `address` is the story's own database: for SQLite, its file. */
export async function readRows(kind: DbKind, address: string, ask: RowsAsk): Promise<RowsRead> {
  if (!SAFE_NAME.test(ask.table)) throw new DbError(`"${ask.table.slice(0, 40)}" is not a name squad-kit reads.`, 'failed');
  for (const [col, v] of Object.entries(ask.where)) {
    if (!SAFE_NAME.test(col)) throw new DbError(`"${col.slice(0, 40)}" is not a name squad-kit reads.`, 'failed');
    const wrong = valueProblem(v);
    if (wrong) throw new DbError(`${wrong.charAt(0).toUpperCase()}${wrong.slice(1)}.`, 'failed');
  }
  switch (kind) {
    case 'sqlite':
      return sqlite(address, ask);
    case 'postgres':
      return postgres(address, ask);
    case 'mysql':
      return mysql(address, ask);
    case 'mongo':
      return mongo(address, ask);
  }
}

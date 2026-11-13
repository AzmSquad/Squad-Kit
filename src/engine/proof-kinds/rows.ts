import fs from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from '../../core/scrub.js';
import { DbError } from '../db/types.js';
import { SAFE_NAME, valueProblem, type RowsAsk, type RowsRead, type RowValue } from '../db/read-rows.js';
import type { TakenPicture, ToolDef, ToolResult, WindowSetup } from '../window.js';
import { extraFields } from '../window-calls.js';
import { writeNew } from '../shots.js';
import { MAX_SHOWN_ROWS, changesWords, keyColumn, rowChanges, shownRows, type RowsChanges } from './rows-show.js';

/**
 * The Data proof: read_rows, a fixed tool of the Tester's window. squad-kit reads a few rows of one table of the
 * story's own database, before and after the Tester's action, and keeps both in one file for the proof. It never
 * writes, never runs a query of the agent's, reads at most MAX_ROWS rows, and never shows a secret or the database's
 * address: secret-looking columns are hidden, and so is any value shaped like a key or a connection.
 */

export const MAX_ROWS = MAX_SHOWN_ROWS;
export const MAX_ROWS_CALLS = 20;
const MAX_WHERE = 6;

/** What the window needs to read: the story's own database, through squad-kit (rows-db.ts). */
export interface RowsReader {
  read(ask: RowsAsk): Promise<RowsRead>;
}

/** A read the window cannot make, in words for the agent: there is no database of the story's own. */
export class NoRows extends Error {}

/** One saved read: the rows before and after, and what changed. */
export interface RowsRecord {
  table: string;
  where: Record<string, RowValue>;
  columns: string[];
  /** The column rows are matched by: id, else the first that is not a secret. */
  key: string;
  before: { rows: Record<string, string>[]; at: string } | null;
  after: { rows: Record<string, string>[]; at: string } | null;
  changes?: RowsChanges;
}

export const READ_ROWS_DEF: Omit<ToolDef, 'name'> = {
  description: `squad-kit reads rows of this story's own database for you, read only, and saves them for the proof. Call it with when "before" before you do the action that changes them, and again with when "after" after it, with the same table and where: squad-kit keeps both in one file and gives you its name. Name that file in shots for the "done when" it proves, like a picture. It reads at most ${MAX_ROWS} rows of one table, newest first, where each column you name equals its value. It never writes and takes no query. Secret columns (passwords, tokens) are hidden. At most ${MAX_ROWS_CALLS} calls in a step. Example: { "table": "bookings", "where": { "id": 1042 }, "when": "before" }`,
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', description: 'The table (or collection) as the database names it, like "bookings".' },
      where: { type: 'object', description: 'Which rows: each column and the value it equals, like { "id": 1042 }. Left out, the newest rows.', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
      when: { type: 'string', enum: ['before', 'after'], description: '"before" the action that changes the rows, or "after" it.' },
    },
    required: ['table', 'when'],
    additionalProperties: false,
  },
};

export const isRowsProof = (file: string): boolean => file.endsWith('.rows.json');

interface RowsWindow {
  readonly pictures: Map<string, TakenPicture>;
  refuse(tool: string, why: string, line: string): ToolResult;
  mistake(tool: string, why: string, help: string): ToolResult;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });
/** One read this window keeps: its file, the record as saved, and the rows before as read, never written anywhere. */
interface Kept {
  file: string;
  record: RowsRecord;
  before: Record<string, unknown>[] | null;
}
/** Calls made and reads kept, per window, so the window keeps no new fields of its own. */
const made = new WeakMap<object, { calls: number; reads: Map<string, Kept> }>();
const EXAMPLE = '{ "table": "bookings", "where": { "id": 1042 }, "when": "before" }';
/** A name with a character only a query would have: never a slip, always refused. */
const QUERY_LIKE = /[\s;'"`()=*/\\-]/;

/** read_rows, as the window takes it: the shape checked, the read made by squad-kit, the rows saved. */
export async function readRowsCall(win: RowsWindow, s: Pick<WindowSetup, 'rows' | 'prefix' | 'proofDir' | 'who' | 'say' | 'ticket'>, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = 'read_rows';
  const extra = extraFields(args, ['table', 'where', 'when']);
  if (extra.length) return win.refuse(tool, `read_rows has no field "${extra[0]!.slice(0, 40)}"`, `The ${s.who} asked to read the database in a way squad-kit does not offer. squad-kit refused.`);
  const table = typeof args.table === 'string' ? args.table.trim() : '';
  if (QUERY_LIKE.test(table)) return win.refuse(tool, `the table "${table.slice(0, 60)}" is not a name`, `The ${s.who} asked squad-kit to run its own query on the database. squad-kit refused.`);
  if (!SAFE_NAME.test(table)) return win.mistake(tool, table ? `"${table.slice(0, 40)}" is not a table's name` : 'table is missing', `Use: ${EXAMPLE}.`);
  if (args.when !== 'before' && args.when !== 'after') return win.mistake(tool, 'when is "before" or "after"', `Use: ${EXAMPLE}.`);
  const raw = args.where ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) return win.mistake(tool, 'where is an object of columns and values', `Use: ${EXAMPLE}.`);
  const where: Record<string, RowValue> = {};
  for (const [col, v] of Object.entries(raw as Record<string, unknown>)) {
    if (QUERY_LIKE.test(col)) return win.refuse(tool, `the column "${col.slice(0, 60)}" is not a name`, `The ${s.who} asked squad-kit to run its own query on the database. squad-kit refused.`);
    if (!SAFE_NAME.test(col)) return win.mistake(tool, `"${col.slice(0, 40)}" is not a column's name`, `Use: ${EXAMPLE}.`);
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) return win.mistake(tool, `the value of "${col}" is not a plain value`, 'Each value is text, a number, true, false or null.');
    const wrong = valueProblem(v as RowValue);
    if (wrong) return win.mistake(tool, wrong, 'Name the rows by their id or another plain value.');
    where[col] = v as RowValue;
  }
  if (Object.keys(where).length > MAX_WHERE) return win.mistake(tool, `where names more than ${MAX_WHERE} columns`, 'Name fewer: the id is usually enough.');
  if (!s.rows) return text("This step has no database of the story's own that squad-kit can read.");
  const mine = made.get(win) ?? { calls: 0, reads: new Map<string, Kept>() };
  made.set(win, mine);
  if (mine.calls >= MAX_ROWS_CALLS) return win.mistake(tool, `this step has made its ${MAX_ROWS_CALLS} reads`, 'Hand in what you have.');
  mine.calls += 1;
  let got: RowsRead;
  try {
    got = await s.rows.read({ table, where, limit: MAX_ROWS });
  } catch (err) {
    if (err instanceof NoRows) return text(err.message);
    const said = err instanceof DbError ? err.message : 'the database did not answer';
    return text(`squad-kit could not read ${table}: ${scrubSecrets(said, [])}. Call i_am_stuck if it keeps happening.`, true);
  }
  if (!got.columns.length) return win.mistake(tool, `there is no table "${table}" in the story's database`, got.tables.length ? `Its tables: ${got.tables.slice(0, 40).join(', ')}.` : 'It has no tables yet.');
  const stamp = JSON.stringify([table, Object.entries(where).sort(([a], [b]) => a.localeCompare(b))]);
  // Only a read of this window pairs with this one: a file from an earlier round is never read or written again.
  const had = mine.reads.get(stamp);
  const key = had?.record.key ?? keyColumn(got.columns);
  const at = new Date().toISOString();
  let kept: Kept;
  if (args.when === 'before' || !had?.before) {
    const record: RowsRecord = { table, where, columns: got.columns, key, before: null, after: null };
    if (args.when === 'before') record.before = { rows: shownRows(got.columns, got.rows, key), at };
    else record.after = { rows: shownRows(got.columns, got.rows, key), at };
    kept = { file: had?.file ?? newRowsFile(s.proofDir, s.prefix ?? s.ticket.toLowerCase()), record, before: args.when === 'before' ? got.rows : null };
  } else {
    const changes = rowChanges(key, had.before, got.rows);
    kept = { ...had, record: { ...had.record, columns: got.columns, after: { rows: shownRows(got.columns, got.rows, key, changes), at }, changes } };
  }
  mine.reads.set(stamp, kept);
  saveRecord(path.join(s.proofDir, kept.file), kept.record);
  const { file, record } = kept;
  const rows = (args.when === 'before' ? record.before : record.after)!.rows;
  win.pictures.set(file, { file, page: '', size: 'answer', call: `rows of ${table}, ${args.when}` });
  s.say(`squad-kit read ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} of ${table} for the ${s.who}, read only`);
  const next = args.when === 'before' ? 'Now do the action, then call read_rows again with when "after" and the same table and where.' : `Name ${file} in shots for the "done when" it proves.`;
  const changed = record.changes ? ` ${changesWords(record.changes)}.` : '';
  return text(`Read ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} of ${table} (${args.when}), saved as ${file}.${changed} ${next}\n\n${JSON.stringify(rows).slice(0, 8000)}`);
}

/** The next free name for a read in the proof folder, made new so no earlier round's file is ever taken. */
function newRowsFile(dir: string, prefix: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= 10_000; n += 1) {
    const name = `${prefix}-rows-${n}.rows.json`;
    if (writeNew(path.join(dir, name), Buffer.from('{}'))) return name;
  }
  throw new Error('squad-kit found no free name for the rows in the proof folder');
}

/** Writes this window's own file again: through a new file put in its place, never through a link. */
function saveRecord(full: string, record: RowsRecord): void {
  const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
  if (!writeNew(tmp, Buffer.from(JSON.stringify(record, null, 2)))) throw new Error('squad-kit could not save the rows');
  fs.renameSync(tmp, full);
}

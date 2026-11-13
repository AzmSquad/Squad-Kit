import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentWindow, ALL_TOOLS } from '../src/engine/window.js';
import type { RowsReader, RowsRecord } from '../src/engine/proof-kinds/rows.js';
import { HIDDEN, HIDDEN_CHANGED, changesWords, keyColumn, rowChanges, secretName, shownRows, shownValue } from '../src/engine/proof-kinds/rows-show.js';
import { readRows, selectSql, valueProblem, type RowsAsk } from '../src/engine/db/read-rows.js';
import { testerTools } from '../src/engine/proof-kinds/lines.js';

/**
 * The Data proof's tool, read_rows: squad-kit reads a few rows of the story's own database before and after the
 * Tester's action, and keeps both. It never writes and runs no query of the agent's: a query, a name with SQL in it, or
 * a field it does not take is refused. Secret columns and values shaped like an address are hidden.
 */

let tmp: string;
let lines: string[];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-rows-'));
  lines = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BEFORE = [{ id: 1042, slot: '10:30', status: 'waiting', amount: '250.00', paid_at: null, password_hash: 'x1' }];
const AFTER = [
  { id: 1043, slot: '11:00', status: 'waiting', amount: '90.00', paid_at: null, password_hash: 'x2' },
  { id: 1042, slot: '10:30', status: 'paid', amount: '250.00', paid_at: '10:31:07', password_hash: 'x1' },
];

/** A reader standing in for the story's own database, that records what it was asked. */
function fakeReader(asked: RowsAsk[]): RowsReader {
  let n = 0;
  return {
    read: async (ask) => {
      asked.push(ask);
      if (ask.table !== 'bookings') return { columns: [], rows: [], tables: ['bookings', 'payments'] };
      n += 1;
      return { columns: ['id', 'slot', 'status', 'amount', 'paid_at', 'password_hash'], rows: n === 1 ? BEFORE : AFTER, tables: ['bookings'] };
    },
  };
}

function win(rows?: RowsReader) {
  return new AgentWindow({ ticket: 'MA-21', step: 'proof', who: 'Tester', tools: [...ALL_TOOLS, 'read_rows'], proofDir: tmp, prefix: 'ma-21-after', say: (t) => lines.push(t), ...(rows ? { rows } : {}) });
}
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('');

describe('read_rows', () => {
  it('reads before and after into one file, with what changed, and names it like a picture', async () => {
    const asked: RowsAsk[] = [];
    const w = win(fakeReader(asked));
    const a = await w.call('read_rows', { table: 'bookings', where: { id: 1042 }, when: 'before' });
    expect(text(a)).toContain('saved as ma-21-after-rows-1.rows.json');
    expect(text(a)).toContain('Now do the action');
    const b = await w.call('read_rows', { table: 'bookings', where: { id: 1042 }, when: 'after' });
    expect(text(b)).toContain('1 row changed, 1 row added');
    expect(asked).toEqual([
      { table: 'bookings', where: { id: 1042 }, limit: 20 },
      { table: 'bookings', where: { id: 1042 }, limit: 20 },
    ]);
    const record = JSON.parse(fs.readFileSync(path.join(tmp, 'ma-21-after-rows-1.rows.json'), 'utf8')) as RowsRecord;
    expect(record.key).toBe('id');
    expect(record.changes).toEqual({ changed: [{ key: '1042', columns: ['status', 'paid_at'] }], added: ['1043'], removed: [] });
    // A secret column is never shown, not even to the agent.
    expect(record.after!.rows[1]!.password_hash).toBe(HIDDEN);
    expect(text(b)).not.toContain('x1');
    expect(w.pictures.has('ma-21-after-rows-1.rows.json')).toBe(true);
    expect(lines).toContain('squad-kit read 1 row of bookings for the Tester, read only');
    w.close();
  });

  it('refuses a query, SQL in a name, and fields it does not take', async () => {
    const asked: RowsAsk[] = [];
    const w = win(fakeReader(asked));
    for (const call of [
      { table: 'bookings', when: 'before', sql: 'DELETE FROM bookings' },
      { table: 'bookings; DROP TABLE bookings', when: 'before' },
      { table: 'bookings', where: { "id = 1 OR 1": 1 }, when: 'after' },
    ]) {
      const r = await w.call('read_rows', call);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('squad-kit refused this');
    }
    // Three refusals stop the agent, as with every tool; nothing reached the database.
    expect(asked).toEqual([]);
    expect(w.tooMany).toBe(true);
    w.close();
  });

  it('answers a wrong shape with the right one, and a missing table with the tables there are', async () => {
    const w = win(fakeReader([]));
    expect(text(await w.call('read_rows', { table: 'bookings' }))).toContain('when is "before" or "after"');
    expect(text(await w.call('read_rows', { table: 'bookings', where: { id: { $gt: 1 } }, when: 'before' }))).toContain('is not a plain value');
    expect(text(await w.call('read_rows', { table: 'bokings', when: 'before' }))).toContain('Its tables: bookings, payments');
    expect(w.refusals).toHaveLength(0);
    w.close();
  });

  it('says so when the story has no database of its own', async () => {
    const w = win();
    expect(text(await w.call('read_rows', { table: 'bookings', when: 'before' }))).toContain("no database of the story's own");
    w.close();
  });

  it('builds only a SELECT, with quoted names and values, and a limit', () => {
    expect(selectSql('sqlite', { table: 'bookings', where: { id: 1042, status: "pa'id", paid_at: null, gone: false }, limit: 20 })).toBe(
      `SELECT * FROM "bookings" WHERE "id" = 1042 AND "status" = 'pa''id' AND "paid_at" IS NULL AND "gone" = 0 ORDER BY 1 DESC LIMIT 20`,
    );
    expect(selectSql('mysql', { table: 'bookings', where: { note: "O'Brien" }, limit: 500 })).toBe("SELECT /*+ MAX_EXECUTION_TIME(20000) */ * FROM `bookings` WHERE `note` = 'O\\'Brien' ORDER BY 1 DESC LIMIT 50");
    expect(selectSql('postgres', { table: 'bookings', where: {}, limit: 5 })).toBe('SELECT * FROM "bookings" ORDER BY 1 DESC LIMIT 5');
    expect(() => selectSql('postgres', { table: 'x"; DROP TABLE y; --', where: {}, limit: 5 })).toThrow('not a name');
  });

  it('hides secrets and addresses, matches rows by id, and says what changed', () => {
    expect(shownValue('api_token', 'abc')).toBe(HIDDEN);
    expect(shownValue('note', 'postgres://sk:secret@localhost:5432/mawid')).toBe(HIDDEN);
    expect(shownValue('note', 'Server=db;Database=x;Password=hunter2;')).toBe(HIDDEN);
    expect(shownValue('note', 'x'.repeat(400)).length).toBe(200);
    expect(shownValue('paid_at', null)).toBe('–');
    expect(keyColumn(['slot', 'id'])).toBe('id');
    expect(keyColumn(['code', 'name'])).toBe('code');
    const c = rowChanges('id', [{ id: 1, s: 'a' }, { id: 2, s: 'b' }], [{ id: 1, s: 'c' }, { id: 3, s: 'd' }]);
    expect(c).toEqual({ changed: [{ key: '1', columns: ['s'] }], added: ['3'], removed: ['2'] });
    expect(changesWords(c)).toBe('1 row changed, 1 row added, 1 row removed');
    expect(changesWords({ changed: [], added: [], removed: [] })).toBe('No row changed');
  });

  it('is in the Tester window only when a line is Data, and a story with no Screen line gets no browser tool', () => {
    const t = (kinds: string[]) => ({ criteria: kinds.map((k) => ({ given: 'a', when: 'b', then: 'c', proof: { kind: k as 'screen' } })) });
    expect(testerTools(t(['screen', 'data']), [...ALL_TOOLS, 'ask_api'], false)).toEqual([...ALL_TOOLS, 'ask_api', 'read_rows']);
    expect(testerTools(t(['api', 'data']), [...ALL_TOOLS, 'ask_api'], false)).not.toContain('take_screenshots');
    expect(testerTools(t(['api', 'data']), [...ALL_TOOLS, 'ask_api'], false)).not.toContain('look_at_page');
    expect(testerTools({ criteria: [{ given: 'a', when: 'b', then: 'c' }] }, ALL_TOOLS, false)).toEqual(ALL_TOOLS);
    expect(testerTools(t(['data']), ALL_TOOLS, true)).toEqual(ALL_TOOLS);
  });
});

const sqlite3 = ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3'].find((f) => fs.existsSync(f));

describe('read_rows across rounds, and what it hides', () => {
  it("a retake's window never reads or writes an earlier round's file", async () => {
    const first = win(fakeReader([]));
    await first.call('read_rows', { table: 'bookings', where: { id: 1042 }, when: 'before' });
    await first.call('read_rows', { table: 'bookings', where: { id: 1042 }, when: 'after' });
    first.close();
    const was = fs.readFileSync(path.join(tmp, 'ma-21-after-rows-1.rows.json'), 'utf8');
    // Round 2: a new window, the same names. Its read is a file of its own, with no "before" from round 1.
    const second = win({ read: async () => ({ columns: ['id', 'status'], rows: [{ id: 1042, status: 'refunded' }], tables: ['bookings'] }) });
    const r = await second.call('read_rows', { table: 'bookings', where: { id: 1042 }, when: 'after' });
    expect(text(r)).toContain('saved as ma-21-after-rows-2.rows.json');
    const fresh = JSON.parse(fs.readFileSync(path.join(tmp, 'ma-21-after-rows-2.rows.json'), 'utf8')) as RowsRecord;
    expect(fresh.before).toBeNull();
    expect(fresh.changes).toBeUndefined();
    expect(fresh.columns).toEqual(['id', 'status']);
    expect(fs.readFileSync(path.join(tmp, 'ma-21-after-rows-1.rows.json'), 'utf8')).toBe(was);
    expect(second.pictures.has('ma-21-after-rows-1.rows.json')).toBe(false);
    second.close();
  });

  it('hides secrets by whole word parts, nested fields too, never the key, and says a secret changed', () => {
    for (const name of ['password', 'passwordHash', 'password_hash', 'api_key', 'apiKey', 'session_token', 'card_number', 'pinCode', 'otp']) expect(secretName(name)).toBe(true);
    for (const name of ['passenger', 'passport', 'bypass', 'compass', 'tokenizer_version', 'keyword', 'status']) expect(secretName(name)).toBe(false);
    expect(shownValue('profile', { name: 'Sara', auth: { passwordHash: 'x', apiKey: 'y' } })).toBe('{"name":"Sara","auth":{"passwordHash":"•••","apiKey":"•••"}}');
    // A table keyed by a token: its key is the first column that is not a secret.
    expect(keyColumn(['token', 'user_id'])).toBe('user_id');
    expect(shownValue('token', 'abc', 'token')).toBe('abc');
    const before = [{ id: 1, password_hash: 'old', name: 'Sara' }];
    const after = [{ id: 1, password_hash: 'new', name: 'Sara' }];
    const changes = rowChanges('id', before, after);
    expect(changes.changed).toEqual([{ key: '1', columns: ['password_hash'] }]);
    expect(shownRows(['id', 'password_hash', 'name'], after, 'id', changes)).toEqual([{ id: '1', password_hash: HIDDEN_CHANGED, name: 'Sara' }]);
    expect(shownRows(['id', 'password_hash', 'name'], before, 'id')).toEqual([{ id: '1', password_hash: HIDDEN, name: 'Sara' }]);
  });

  it('never sends a backslash or a control character, on any database', async () => {
    expect(valueProblem('a\\')).toContain('backslash');
    expect(valueProblem('a\nb')).toContain('control character');
    expect(valueProblem("O'Brien")).toBeNull();
    for (const kind of ['sqlite', 'postgres', 'mysql'] as const) expect(() => selectSql(kind, { table: 'bookings', where: { note: 'x\\' }, limit: 5 })).toThrow('backslash');
    await expect(readRows('mongo', 'mongodb://localhost/db', { table: 'bookings', where: { note: 'x\u0007' }, limit: 5 })).rejects.toThrow('control character');
    const asked: RowsAsk[] = [];
    const w = win(fakeReader(asked));
    expect(text(await w.call('read_rows', { table: 'bookings', where: { note: 'a\\' }, when: 'before' }))).toContain('backslash');
    expect(asked).toEqual([]);
    w.close();
  });

  it('Postgres reads with standard strings on, read only, and stops a slow query', async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const fake = `#!/bin/sh\necho "$PGOPTIONS" > "$SK_FAKE_OUT/options"\nIN=$(cat)\necho "$IN" >> "$SK_FAKE_OUT/sql"\ncase "$IN" in *json_agg\\(r\\)*) echo '[{"id":1}]';; *) echo '{"tables":["bookings"],"columns":["id"]}';; esac\n`;
    for (const tool of ['psql', 'pg_dump']) fs.writeFileSync(path.join(bin, tool), fake, { mode: 0o755 });
    const was = { dirs: process.env.SQUAD_DB_TOOL_DIRS, out: process.env.SK_FAKE_OUT };
    process.env.SQUAD_DB_TOOL_DIRS = bin;
    process.env.SK_FAKE_OUT = tmp;
    try {
      const got = await readRows('postgres', 'postgres://sk@localhost:5432/mawid_ma_21', { table: 'bookings', where: { id: 1 }, limit: 20 });
      expect(got.rows).toEqual([{ id: 1 }]);
    } finally {
      for (const [k, v] of [['SQUAD_DB_TOOL_DIRS', was.dirs], ['SK_FAKE_OUT', was.out]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const options = fs.readFileSync(path.join(tmp, 'options'), 'utf8');
    expect(options).toContain('default_transaction_read_only=on');
    expect(options).toContain('standard_conforming_strings=on');
    expect(fs.readFileSync(path.join(tmp, 'sql'), 'utf8')).toContain('SET statement_timeout = 20000;');
    expect(selectSql('mysql', { table: 'bookings', where: {}, limit: 5 })).toContain('MAX_EXECUTION_TIME(20000)');
  });
});

describe('read_rows on a real SQLite file', () => {
  it.skipIf(!sqlite3)('reads read only, and a value with SQL in it is only a value', async () => {
    const file = path.join(tmp, 'dev.db');
    execFileSync(sqlite3!, [file, "CREATE TABLE bookings (id INTEGER PRIMARY KEY, status TEXT, token TEXT); INSERT INTO bookings VALUES (1, 'waiting', 'sk-ant-xxxxxxxxxxxxxxxx'), (2, 'paid', NULL);"]);
    const was = process.env.SQUAD_DB_TOOL_DIRS;
    process.env.SQUAD_DB_TOOL_DIRS = path.dirname(sqlite3!);
    try {
      const got = await readRows('sqlite', file, { table: 'bookings', where: {}, limit: 20 });
      expect(got.columns).toEqual(['id', 'status', 'token']);
      expect(got.rows.map((r) => r.id)).toEqual([2, 1]);
      expect(got.tables).toEqual(['bookings']);
      const sneaky = await readRows('sqlite', file, { table: 'bookings', where: { status: "x'; DELETE FROM bookings; --" }, limit: 20 });
      expect(sneaky.rows).toEqual([]);
      expect((await readRows('sqlite', file, { table: 'nope', where: {}, limit: 20 })).columns).toEqual([]);
    } finally {
      if (was === undefined) delete process.env.SQUAD_DB_TOOL_DIRS;
      else process.env.SQUAD_DB_TOOL_DIRS = was;
    }
    expect(execFileSync(sqlite3!, [file, 'SELECT count(*) FROM bookings;']).toString().trim()).toBe('2');
  });
});

describe("which database read_rows reads: only the story's own", () => {
  it('a SQLite file through a link to outside the copy is refused; one inside is read by its real path', async () => {
    const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
    const { seedDemoBoard } = await import('../src/board/demo.js');
    const { storyDatabase } = await import('../src/engine/proof-kinds/rows-db.js');
    const bp = boardPaths(path.join(tmp, '.squad'));
    seedDemoBoard(bp, { speed: 50 });
    writeMeta(bp, { ...readMeta(bp), database: { kind: 'sqlite', repo: '.', name: './dev.db', setting: { env: 'DATABASE_URL', file: '.env' }, address: 'file:./dev.db' } as never });
    const copy = path.join(tmp, 'copy');
    fs.mkdirSync(copy);
    execFileSync('git', ['init', '-q'], { cwd: copy });
    fs.writeFileSync(path.join(copy, '.env'), 'DATABASE_URL="file:./dev.db"\n');
    const outside = path.join(tmp, 'persons-own.db');
    fs.writeFileSync(outside, '');
    fs.symlinkSync(outside, path.join(copy, 'dev.db'));
    expect(storyDatabase(bp, 'MA-21', copy)).toBeNull();
    fs.rmSync(path.join(copy, 'dev.db'));
    fs.writeFileSync(path.join(copy, 'dev.db'), '');
    expect(storyDatabase(bp, 'MA-21', copy)).toEqual({ kind: 'sqlite', address: fs.realpathSync(path.join(copy, 'dev.db')) });
  });
});

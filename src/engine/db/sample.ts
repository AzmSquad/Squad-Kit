import { words } from './hide.js';
import type { TemplateTable } from './types.js';

/**
 * Which rows a template keeps, for the SQL kinds (SQLite, Postgres, MySQL). Small tables are kept whole. A big one keeps
 * its newest rows, by a time column with a "created" kind of name, else another time column, else its id. Then the
 * rows the kept rows point at through foreign keys are added, a few passes over, until nothing is missing: a kept
 * visit's patient is kept, and that patient's doctor. Each kind says how to write a query; this file only builds them.
 */

export interface Column {
  name: string;
  /** The column's type as the database names it. */
  type: string;
  /** Not to be written: a generated column. */
  generated?: boolean;
  /** Binary data (MySQL), compared by its hex. */
  binary?: boolean;
  /** The column may not be empty (NULL). */
  notNull?: boolean;
}

export interface Table {
  /** Its name as people see it: `visits`, or `billing.invoices` outside Postgres's public schema. */
  name: string;
  /** The quoted name to write in SQL. */
  ref: string;
  columns: Column[];
  /** Primary key columns, in order. */
  pk: string[];
}

export interface ForeignKey {
  child: string;
  cols: string[];
  parent: string;
  refCols: string[];
}

/** How one kind writes SQL. */
export interface Dialect {
  quote(name: string): string;
  /** A column's value as text, the same on both sides of a link. */
  text(col: string, c: Column | undefined): string;
  /** A JSON array of the given values, as text. */
  jsonArray(values: string[]): string;
  /** A value read back as text, written as a literal for a query. */
  literal(text: string, c: Column | undefined): string;
  /** A row id for a table with no primary key, when the kind has one (ctid, rowid). */
  rowId?: string;
  /** `(a, b) IN (…)` for many columns: the forms differ a little. */
  inTuples(cols: string[], tuples: string[][]): string;
  /** NULLs last when sorting newest first (Postgres puts them first). */
  nullsLast: string;
}

/** Runs a read-only query on the source that gives one text value per row. */
export type Query = (sql: string) => Promise<string[]>;

const TIME = /\b(date|time|timestamp|timestamptz|datetime|datetime2|smalldatetime)\b/i;
const CREATED = new Set(['created', 'creation', 'inserted', 'added', 'registered', 'opened', 'submitted', 'issued', 'posted', 'recorded']);
const UPDATED = new Set(['updated', 'modified', 'changed', 'edited']);

/** The column the newest rows are picked by, or null when the table has none that says. */
export function newestColumn(t: Table): string | null {
  const times = t.columns.filter((c) => TIME.test(c.type) && !c.generated);
  const created = times.find((c) => words(c.name).some((w) => CREATED.has(w)));
  if (created) return created.name;
  // SQLite and some schemas keep times as text or numbers: a "created" name with a time word says it all the same.
  const named = t.columns.find((c) => !c.generated && !TIME.test(c.type) && /^(|text|varchar.*|char.*|integer|int|bigint|numeric|real)$/i.test(c.type.trim()) && words(c.name).some((w) => CREATED.has(w)) && words(c.name).some((w) => ['at', 'on', 'date', 'time', 'ts', 'timestamp', 'when'].includes(w)));
  if (named) return named.name;
  const plain = times.find((c) => !words(c.name).some((w) => UPDATED.has(w) || w === 'deleted' || w === 'birth' || w === 'dob' || w === 'expires' || w === 'expiry'));
  if (plain) return plain.name;
  if (t.pk.length === 1) return t.pk[0]!;
  return null;
}

interface Pick {
  whole: boolean;
  order: string | null;
  /** Rows added because rows elsewhere point at them: per set of columns, the values as JSON text. */
  extra: Map<string, { cols: string[]; values: Map<string, string[]> }>;
}

export interface Plan {
  tables: Table[];
  picks: Map<string, Pick>;
  fks: ForeignKey[];
  limit: number;
  complete: boolean;
  notes: string[];
}

/** The rows kept from a table, as a WHERE condition and what follows it (ORDER BY … LIMIT …), for `SELECT … FROM t`. */
export function chosen(plan: Plan, d: Dialect, t: Table): { where: string; tail: string } {
  const pick = plan.picks.get(t.name)!;
  if (pick.whole) return { where: '1=1', tail: '' };
  const order = pick.order ? `${d.quote(pick.order)} DESC${d.nullsLast}${t.pk.length && t.pk[0] !== pick.order ? `, ${t.pk.map((c) => `${d.quote(c)} DESC`).join(', ')}` : ''}` : '';
  const orderBy = order ? ` ORDER BY ${order}` : '';
  const extras = [...pick.extra.values()].filter((e) => e.values.size);
  if (!extras.length) return { where: '1=1', tail: `${orderBy} LIMIT ${plan.limit}` };
  // The newest rows by their key, so the rows they point at can be added beside them.
  const key = t.pk.length ? t.pk : d.rowId ? [d.rowId] : extras[0]!.cols;
  const keyList = key.map((c) => (c === d.rowId ? c : d.quote(c))).join(', ');
  const keyTuple = key.length > 1 ? `(${keyList})` : keyList;
  const base = `${keyTuple} IN (SELECT ${keyList} FROM (SELECT ${keyList} FROM ${t.ref}${orderBy} LIMIT ${plan.limit}) sk_newest)`;
  const more = extras.map((e) =>
    d.inTuples(
      e.cols.map((c) => d.quote(c)),
      [...e.values.values()].map((vals) => vals.map((v, i) => d.literal(v, t.columns.find((c) => c.name === e.cols[i])))),
    ),
  );
  return { where: `(${[base, ...more].join(' OR ')})`, tail: '' };
}

/** `SELECT cols FROM t WHERE … ORDER BY … LIMIT …` for the rows kept. */
export function selectKept(plan: Plan, d: Dialect, t: Table, cols: string): string {
  const c = chosen(plan, d, t);
  return `SELECT ${cols} FROM ${t.ref} WHERE ${c.where}${c.tail}`;
}

const keyOf = (vals: string[]) => JSON.stringify(vals);

/**
 * Plans the rows to keep: counts each table (only up to the small limit, so a huge table is never counted through),
 * picks newest rows, then follows the foreign keys from kept rows to the rows they point at.
 */
export async function planRows(
  tables: Table[],
  fks: ForeignKey[],
  d: Dialect,
  query: Query,
  o: { smallRows: number; sampleRows: number; maxPasses?: number },
): Promise<Plan> {
  const picks = new Map<string, Pick>();
  const plan: Plan = { tables, picks, fks, limit: o.sampleRows, complete: true, notes: [] };
  const byName = new Map(tables.map((t) => [t.name, t]));
  // How many rows each table has, up to the small limit plus one.
  if (tables.length) {
    const parts = tables.map((t, i) => `SELECT ${d.jsonArray([String(i), `(SELECT count(*) FROM (SELECT 1 FROM ${t.ref} LIMIT ${o.smallRows + 1}) sk_c)`])}`);
    for (const line of await query(parts.join(' UNION ALL '))) {
      const [i, n] = JSON.parse(line) as [string | number, string | number];
      const t = tables[Number(i)]!;
      picks.set(t.name, { whole: Number(n) <= o.smallRows, order: null, extra: new Map() });
    }
  }
  for (const t of tables) {
    const p = picks.get(t.name) ?? { whole: true, order: null, extra: new Map() };
    if (!p.whole) p.order = newestColumn(t);
    picks.set(t.name, p);
  }
  const links = fks.filter((f) => byName.has(f.child) && byName.has(f.parent));
  if (links.length < fks.length) plan.notes.push('Some foreign keys point outside the tables squad-kit copies, so the rows they point at are not kept.');
  const asked = new Map<string, Set<string>>();
  const maxPasses = o.maxPasses ?? 30;
  const maxExtra = Math.max(1000, o.sampleRows * 20);
  let pass = 0;
  for (; pass < maxPasses; pass++) {
    const open = links.filter((f) => !picks.get(f.parent)!.whole);
    if (!open.length) break;
    const parts: string[] = [];
    open.forEach((f, i) => {
      const child = byName.get(f.child)!;
      const parent = byName.get(f.parent)!;
      const needCols = f.cols.map((c) => d.text(`sk_s.${d.quote(c)}`, child.columns.find((x) => x.name === c)));
      const notNull = f.cols.map((c) => `sk_s.${d.quote(c)} IS NOT NULL`).join(' AND ');
      parts.push(`SELECT ${d.jsonArray([`'n${i}'`, ...needCols])} FROM (${selectKept(plan, d, child, f.cols.map((c) => d.quote(c)).join(', '))}) sk_s WHERE ${notNull}`);
      const haveCols = f.refCols.map((c) => d.text(`sk_s.${d.quote(c)}`, parent.columns.find((x) => x.name === c)));
      parts.push(`SELECT ${d.jsonArray([`'h${i}'`, ...haveCols])} FROM (${selectKept(plan, d, parent, f.refCols.map((c) => d.quote(c)).join(', '))}) sk_s`);
    });
    const need = open.map(() => new Map<string, string[]>());
    const have = open.map(() => new Set<string>());
    for (const line of await query(parts.join(' UNION ALL '))) {
      const [tag, ...vals] = JSON.parse(line) as string[];
      const i = Number(tag!.slice(1));
      const v = vals.map((x) => (x === null ? '' : String(x)));
      if (tag!.startsWith('n')) need[i]!.set(keyOf(v), v);
      else have[i]!.add(keyOf(v));
    }
    let added = false;
    open.forEach((f, i) => {
      const parent = picks.get(f.parent)!;
      const colsKey = f.refCols.join('\0');
      const seen = asked.get(`${f.parent}\0${colsKey}`) ?? new Set<string>();
      asked.set(`${f.parent}\0${colsKey}`, seen);
      const set = parent.extra.get(colsKey) ?? { cols: f.refCols, values: new Map<string, string[]>() };
      parent.extra.set(colsKey, set);
      for (const [k, v] of need[i]!) {
        if (have[i]!.has(k) || seen.has(k)) continue;
        if (set.values.size >= maxExtra) {
          plan.complete = false;
          continue;
        }
        seen.add(k);
        set.values.set(k, v);
        added = true;
      }
    });
    if (!added) break;
  }
  if (pass >= maxPasses) plan.complete = false;
  if (!plan.complete) plan.notes.push('Not every row that a kept row points at could be kept: the chain of links was too long. Where the database checks its links, a link to a row that was not kept is emptied, or the row is left out when the link may not be empty.');
  return plan;
}

/** What engineers see per table, from the plan and the counts the kind read back. */
export function describeTables(plan: Plan, counts: Map<string, { rows: number; base: number }>): TemplateTable[] {
  return plan.tables.map((t) => {
    const p = plan.picks.get(t.name)!;
    const c = counts.get(t.name) ?? { rows: 0, base: 0 };
    return {
      name: t.name,
      kept: p.whole ? 'whole' : 'sampled',
      rows: c.rows,
      ...(!p.whole && p.order ? { newestBy: p.order } : {}),
      ...(!p.whole && c.rows > c.base ? { linked: c.rows - c.base } : {}),
    };
  });
}

/** Counts the rows kept per table, and how many of those were the newest ones, in one query. */
export async function countKept(plan: Plan, d: Dialect, query: Query): Promise<Map<string, { rows: number; base: number }>> {
  const out = new Map<string, { rows: number; base: number }>();
  if (!plan.tables.length) return out;
  const parts = plan.tables.map((t, i) => {
    const p = plan.picks.get(t.name)!;
    const kept = `(SELECT count(*) FROM (${selectKept(plan, d, t, '1 AS sk_one')}) sk_k)`;
    const base = p.whole ? kept : `(SELECT count(*) FROM (SELECT 1 AS sk_one FROM ${t.ref} LIMIT ${plan.limit}) sk_b)`;
    return `SELECT ${d.jsonArray([String(i), kept, base])}`;
  });
  for (const line of await query(parts.join(' UNION ALL '))) {
    const [i, rows, base] = JSON.parse(line) as (string | number)[];
    out.set(plan.tables[Number(i)]!.name, { rows: Number(rows), base: Number(base) });
  }
  return out;
}

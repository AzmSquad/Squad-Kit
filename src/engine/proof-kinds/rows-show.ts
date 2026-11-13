import { scrubSecrets } from '../../core/scrub.js';

/**
 * How the rows of a Data proof are shown: each value as short text, with nothing secret in it, and what changed between
 * the two reads. squad-kit compares the values as they were read, so a secret column that changed still says so, with
 * no value.
 */

export const MAX_SHOWN_ROWS = 20;
const MAX_CELL = 200;
export const HIDDEN = '•••';
/** A secret value that changed between the two reads: it says so, and shows neither value. */
export const HIDDEN_CHANGED = '••• changed';

export interface RowsChanges {
  changed: { key: string; columns: string[] }[];
  added: string[];
  removed: string[];
}

/** Word parts of a name that make it a secret: `passwordHash`, `api_key` and `session_token` are, `passenger` is not. */
const SECRET_PARTS = new Set(['password', 'passwords', 'passwd', 'passphrase', 'pwd', 'pass', 'secret', 'secrets', 'token', 'tokens', 'hash', 'hashed', 'salt', 'otp', 'pin', 'cvv', 'cvc', 'iban', 'ssn', 'credential', 'credentials', 'session', 'apikey', 'cardnumber']);
const SECRET_PAIRS = new Set(['api key', 'private key', 'access key', 'secret key', 'card number', 'pin code']);

/** A name split into its word parts, in small letters: camelCase, snake_case, kebab-case and dots. */
function partsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/** True when a column's (or a field's) values are never shown. */
export function secretName(name: string): boolean {
  const parts = partsOf(name);
  return parts.some((p) => SECRET_PARTS.has(p)) || parts.some((p, i) => i > 0 && SECRET_PAIRS.has(`${parts[i - 1]} ${p}`));
}

/** A value shaped like a database address or a link with a sign-in. */
const CONNECTION = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|sqlserver|mssql|amqp|jdbc:[a-z]+):\/\/\S+|(?:server|host|data source)=[^;]+;[^\n]*(?:password|pwd)=/i;

/** A nested value (a Mongo document, a JSON column) with each secret field hidden, at any depth. */
function hiddenDeep(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => hiddenDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, secretName(k) ? HIDDEN : hiddenDeep(x, depth + 1)]));
}

/** One value as the proof shows it: text, cut short, with nothing secret in it. The key column is never hidden. */
export function shownValue(column: string, v: unknown, key?: string): string {
  if (v === null || v === undefined) return '–';
  if (column !== key && secretName(column)) return HIDDEN;
  const text = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(hiddenDeep(v)) : String(v);
  if (CONNECTION.test(text)) return HIDDEN;
  const clean = scrubSecrets(text, []);
  return clean.length > MAX_CELL ? `${clean.slice(0, MAX_CELL - 1)}…` : clean;
}

/** The column rows are matched by between the two reads: id, else the first column that is not a secret. */
export function keyColumn(columns: string[]): string {
  return columns.find((c) => /^(id|_id)$/i.test(c)) ?? columns.find((c) => !secretName(c)) ?? columns[0] ?? 'id';
}

/** A value as squad-kit compares it, never shown. */
const asRead = (v: unknown): string => (v === undefined ? '' : JSON.stringify(v));

/** A row's key, as the changes name it. */
export function rowId(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** What changed between the two reads, row by row, by the key column, from the values as they were read. */
export function rowChanges(key: string, before: Record<string, unknown>[], after: Record<string, unknown>[]): RowsChanges {
  const id = (r: Record<string, unknown>) => rowId(r, key);
  const had = new Map(before.map((r) => [id(r), r]));
  const now = new Set(after.map(id));
  const changed: RowsChanges['changed'] = [];
  const added: string[] = [];
  for (const r of after) {
    const old = had.get(id(r));
    if (!old) added.push(id(r));
    else {
      const cols = [...new Set([...Object.keys(r), ...Object.keys(old)])].filter((c) => asRead(r[c]) !== asRead(old[c]));
      if (cols.length) changed.push({ key: id(r), columns: cols });
    }
  }
  return { changed, added, removed: before.map(id).filter((k) => !now.has(k)) };
}

/** The rows as the proof keeps them. A secret column that changed in a row reads "••• changed". */
export function shownRows(columns: string[], rows: Record<string, unknown>[], key: string, changes?: RowsChanges): Record<string, string>[] {
  return rows.slice(0, MAX_SHOWN_ROWS).map((r) => {
    const changed = changes?.changed.find((c) => c.key === rowId(r, key))?.columns ?? [];
    return Object.fromEntries(columns.map((c) => [c, c !== key && secretName(c) && changed.includes(c) ? HIDDEN_CHANGED : shownValue(c, r[c], key)]));
  });
}

/** "1 row changed, 1 row added", or "No row changed". */
export function changesWords(c: RowsChanges | undefined): string {
  if (!c) return '';
  const n = (x: number, what: string) => (x ? `${x} ${x === 1 ? 'row' : 'rows'} ${what}` : '');
  return [n(c.changed.length, 'changed'), n(c.added.length, 'added'), n(c.removed.length, 'removed')].filter(Boolean).join(', ') || 'No row changed';
}

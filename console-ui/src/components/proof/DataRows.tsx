import { useQuery } from '@tanstack/react-query';
import { assetUrl } from '../../api/client';
import { langProps } from '../../lib/lang';

/**
 * A Data proof: the rows squad-kit read from the story's own database before and after, read only. Each row read before
 * sits over the same row after, and the cells that changed are marked; a row that is new is marked as added.
 */

interface RowsRecord {
  table: string;
  columns: string[];
  key: string;
  before: { rows: Record<string, string>[] } | null;
  after: { rows: Record<string, string>[] } | null;
  changes?: { changed: { key: string; columns: string[] }[]; added: string[]; removed: string[] };
}

/** "1 row changed, 1 row added", or "No row changed". */
export function changesWords(c: RowsRecord['changes']): string {
  if (!c) return '';
  const n = (x: number, what: string) => (x ? `${x} ${x === 1 ? 'row' : 'rows'} ${what}` : '');
  return [n(c.changed.length, 'changed'), n(c.added.length, 'added'), n(c.removed.length, 'removed')].filter(Boolean).join(', ') || 'No row changed';
}

/** The rows in the order they show: each key's before, then its after; new rows last. */
export function rowsInOrder(r: RowsRecord): { label: 'Before' | 'After' | 'Same' | '+' | '−'; row: Record<string, string>; changed: string[] }[] {
  const before = r.before?.rows ?? [];
  const after = r.after?.rows ?? [];
  const k = (x: Record<string, string>) => x[r.key] ?? '';
  const out: ReturnType<typeof rowsInOrder> = [];
  for (const b of before) {
    const a = after.find((x) => k(x) === k(b));
    if (!a) {
      out.push({ label: r.after ? '−' : 'Before', row: b, changed: [] });
      continue;
    }
    const changed = r.changes?.changed.find((c) => c.key === k(b))?.columns ?? [];
    if (!changed.length && r.after) {
      out.push({ label: 'Same', row: a, changed: [] });
      continue;
    }
    out.push({ label: 'Before', row: b, changed: [] }, { label: 'After', row: a, changed });
  }
  for (const a of after) if (!before.some((b) => k(b) === k(a))) out.push({ label: r.before ? '+' : 'After', row: a, changed: [] });
  return out;
}

export function DataRows({ file }: { file: string }) {
  const q = useQuery({ queryKey: ['rows-proof', file], queryFn: async () => (await fetch(assetUrl(`/api/v1/proof/${file}`))).json() as Promise<RowsRecord> });
  const r = q.data;
  // A record that did not load, or one written by hand, shows nothing rather than breaking the page.
  if (!r || !Array.isArray(r.columns)) return null;
  const rows = rowsInOrder(r);
  return (
    <div className="datarows" dir="ltr">
      <span className="tname">{r.table}</span>
      <div className="rowscroll">
        <table className="rows">
          <thead>
            <tr>
              <th />
              {r.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((x, i) => (
              <tr key={i} className={x.label === 'After' ? 'after' : x.label === '+' ? 'new' : x.label === '−' ? 'gone' : ''}>
                <td className="w">{x.label}</td>
                {r.columns.map((c) => (
                  <td key={c} className={x.changed.includes(c) ? 'ch' : undefined} {...langProps(x.row[c] ?? '')}>
                    {x.row[c] ?? '–'}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td className="w" colSpan={r.columns.length + 1}>
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The caption under a Data block: where the rows come from, and what changed. */
export function useRowsCaption(file: string): string {
  const q = useQuery({ queryKey: ['rows-proof', file], queryFn: async () => (await fetch(assetUrl(`/api/v1/proof/${file}`))).json() as Promise<RowsRecord> });
  const said = changesWords(q.data?.changes);
  return `Read from this story's own database, read only.${said ? ` ${said}.` : ''}`;
}

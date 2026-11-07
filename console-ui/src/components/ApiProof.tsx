import { useQuery } from '@tanstack/react-query';
import { assetUrl } from '../api/client';
import { langProps, tableDir } from '../lib/lang';
import { Written } from './ui';

/**
 * A "done when" no page shows, proved by asking the product's API: what was asked and what it answered, in place of a
 * picture. squad-kit made the call itself and saved it. The raw answer is for engineers.
 */

interface ApiRecord {
  part: string;
  method: string;
  path: string;
  body?: string;
  status: number;
  contentType?: string;
  answer?: string;
  cut?: boolean;
  file?: string;
  bytes?: number;
  sheets?: { name: string; rows: string[][]; total: number }[];
}

/** How much of each sheet the proof shows. The whole file is one click away. */
const SHEET_ROWS = 12;

export function ApiProof({ file, note }: { file: string; note?: string }) {
  const q = useQuery({ queryKey: ['api-proof', file], queryFn: async () => (await fetch(assetUrl(`/api/v1/proof/${file}`))).json() as Promise<ApiRecord> });
  const r = q.data;
  if (!r) return note ? <p className="note">{note}</p> : null;
  return (
    <div className="apiproof">
      {note && <Written as="p" text={note} />}
      <div className="maprow">
        <b>Asked</b>
        <span className="mono">{r.part}: {r.method} {r.path}</span>
      </div>
      <div className="maprow">
        <b>It answered</b>
        <span className="mono">
          {r.status}
          {r.file ? ' with a file' : ''}
        </span>
      </div>
      {r.sheets?.map((s, i) => (
        <div className="apiproof-sheet" key={i}>
          <Written as="b" text={s.name} />
          <div className="apiproof-table">
            <table dir={tableDir(s.rows)}>
              <tbody>
                {s.rows.slice(0, SHEET_ROWS).map((row, y) => (
                  <tr key={y}>{row.map((cell, x) => (y === 0 ? <th key={x} {...langProps(cell)}>{cell}</th> : <td key={x} {...langProps(cell)}>{cell}</td>))}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.total > SHEET_ROWS && <p className="note">The first {SHEET_ROWS} of {s.total} rows. The file has them all.</p>}
        </div>
      ))}
      {r.file && (
        <p>
          <a className="btn sm" href={assetUrl(`/api/v1/proof/${r.file}`)} download={r.file}>Open the file it answered with</a>
        </p>
      )}
      <details>
        <summary className="note">For engineers</summary>
        <pre className="mono apiproof-raw">
          {r.body ? `Sent: ${r.body}\n\n` : ''}
          {r.contentType ? `Type: ${r.contentType}\n\n` : ''}
          {r.answer ?? (r.file ? `A file of ${r.bytes ?? 0} bytes` : 'No answer')}
          {r.cut ? '\n\n(cut here: the rest is not kept)' : ''}
        </pre>
      </details>
    </div>
  );
}

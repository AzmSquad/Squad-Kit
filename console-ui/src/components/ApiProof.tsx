import { useQuery } from '@tanstack/react-query';
import { assetUrl } from '../api/client';

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
}

export function ApiProof({ file, note }: { file: string; note?: string }) {
  const q = useQuery({ queryKey: ['api-proof', file], queryFn: async () => (await fetch(assetUrl(`/api/v1/proof/${file}`))).json() as Promise<ApiRecord> });
  const r = q.data;
  if (!r) return note ? <p className="note">{note}</p> : null;
  return (
    <div className="apiproof">
      {note && <p>{note}</p>}
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

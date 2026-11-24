import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ConnectionRow } from '../../api/contribution-types';
import { CONNECT } from '../../lib/connect-words';
import { useAct } from '../../lib/data';
import type { Lang } from '../../lib/first-story';
import { Cmd } from '../ui';

/**
 * The token way on the tool's own row, so connecting never needs a second page: the place's address (filled in when it
 * is known), the token, and the steps to make one with real links. The engine checks the token before it saves it, and
 * it stays on this computer. Open at once when the token is the only way for this place.
 */
export function TokenForm({ row, lang }: { row: ConnectionRow; lang: Lang }) {
  const w = CONNECT[lang].token;
  const ask = row.token!;
  const act = useAct<{ line: string }>();
  const [address, setAddress] = useState(ask.address ?? '');
  const [token, setToken] = useState('');
  const save = () =>
    act.mutate(
      { path: `/api/v1/connections/${encodeURIComponent(row.name)}/token`, body: { address: address.trim(), token }, done: (r) => r.line },
      { onSuccess: () => setToken('') },
    );
  return (
    <details className="gh-guide gh-tokenway" open={ask.open}>
      <summary>
        <ChevronDown size={14} aria-hidden="true" />
        {row.state === 'connected' ? w.replace : w.open}
      </summary>
      {!ask.open && <p className="gh-small">{ask.why[lang]}</p>}
      <div className="gh-token">
        <label>
          {w.address}
          <input className="input mono" dir="ltr" value={address} placeholder={row.address?.example} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label>
          {w.token}
          <input className="input mono" dir="ltr" type="password" autoComplete="off" value={token} placeholder={w.paste} onChange={(e) => setToken(e.target.value)} />
        </label>
      </div>
      <ol className="gh-steps">
        {ask.steps.map((s, i) => (
          <li key={i}>
            <span className="gh-n" aria-hidden="true">{i + 1}</span>
            <div>
              <span>{s.text[lang]}</span>
              {s.link && (
                <a href={s.link} target="_blank" rel="noreferrer" className="gh-link gh-url" dir="ltr">
                  {s.link.replace(/^https:\/\//, '')}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="gh-row">
        <button className="btn pri sm" disabled={!token.trim() || act.isPending} onClick={save}>
          {act.isPending ? w.checking : w.save}
        </button>
        <Cmd text={ask.command} />
      </div>
    </details>
  );
}

import { useState } from 'react';
import type { ConnectionRow } from '../../api/contribution-types';
import { CONNECT } from '../../lib/connect-words';
import { useAct } from '../../lib/data';
import type { Lang } from '../../lib/first-story';
import { Cmd } from '../ui';

/**
 * The place's address, pasted from the browser while the person looks at it (their board on the tool), when the list
 * the sign-in reaches does not have it, or to change the one in use. The engine reads the place from it and checks it
 * is there. The same as `squad connect <tool> --site <address>`.
 */
export function AddressBox({ row, lang, onDone }: { row: ConnectionRow; lang: Lang; onDone?(): void }) {
  const w = CONNECT[lang].place;
  const act = useAct<{ line: string }>();
  const [text, setText] = useState('');
  const ask = row.address!;
  const use = () =>
    act.mutate(
      { path: `/api/v1/connections/${encodeURIComponent(row.name)}/site`, body: { site: text.trim() }, done: (r) => r.line },
      {
        onSuccess: () => {
          setText('');
          onDone?.();
        },
      },
    );
  return (
    <div className="gh-addr">
      <div className="gh-row">
        <input
          className="input mono"
          aria-label={w.paste}
          dir="ltr"
          value={text}
          placeholder={ask.example}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && text.trim() && !act.isPending && use()}
        />
        <button className="btn sm" disabled={!text.trim() || act.isPending} onClick={use}>
          {w.useIt}
        </button>
        {onDone && (
          <button className="btn sm" onClick={onDone}>
            {w.cancel}
          </button>
        )}
        <Cmd text={`squad connect ${row.name} --site ${text.trim() ? `'${text.trim().replace(/'/g, `'\\''`)}'` : '<address>'}`} />
      </div>
      <p className="gh-small">{ask.where[lang]}</p>
    </div>
  );
}

/** The place in use on a connected row, with Change: the address box in its place until it is used or cancelled. */
export function PlaceNow({ row, lang }: { row: ConnectionRow; lang: Lang }) {
  const w = CONNECT[lang].place;
  const [changing, setChanging] = useState(false);
  if (changing) return <AddressBox row={row} lang={lang} onDone={() => setChanging(false)} />;
  return (
    <div className="gh-place">
      <span className="gh-muted">{w.from}</span>
      <b dir="auto">{row.address!.now}</b>
      <span className="grow" />
      <button className="gh-link gh-plain" onClick={() => setChanging(true)}>
        {w.change}
      </button>
    </div>
  );
}

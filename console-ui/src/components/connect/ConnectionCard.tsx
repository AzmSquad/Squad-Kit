import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import type { ConnectionRow } from '../../api/contribution-types';
import { CONNECT } from '../../lib/connect-words';
import { useAct } from '../../lib/data';
import type { Lang } from '../../lib/first-story';
import { Cmd } from '../ui';
import { AddressBox, PlaceNow } from './AddressBox';
import { SitePick } from './SitePick';
import { TokenForm } from './TokenForm';

/** A tool's tile: its initials on a color of its own, by its place on the page. */
const TONES = ['ink', 'blue', 'sky'] as const;
export const initials = (label: string) => (label.includes(' ') ? label.slice(0, 2) : label.replace(/[^A-Z]/g, '').slice(0, 2) || label.slice(0, 2));

function Tile({ label, at }: { label: string; at: number }) {
  return (
    <span className={`gh-tile ${TONES[at % TONES.length]}`} aria-hidden="true" dir="ltr">
      {initials(label)}
    </span>
  );
}

/** The step-by-step guide, folded under the button. */
function Guide({ row, lang, open, onCheck, checking }: { row: ConnectionRow; lang: Lang; open: boolean; onCheck(): void; checking: boolean }) {
  const w = CONNECT[lang];
  return (
    <details className="gh-guide" open={open}>
      <summary>
        <ChevronDown size={14} aria-hidden="true" />
        {w.guide}
      </summary>
      <ol className="gh-steps">
        {row.steps.map((s, i) => (
          <li key={i}>
            <span className="gh-n" aria-hidden="true">{i + 1}</span>
            <div>
              <span>{s.text[lang]}</span>
              {s.link && (
                <a href={s.link} target="_blank" rel="noreferrer" className="gh-link gh-url" dir="ltr">
                  {s.link.replace(/^https:\/\//, '')}
                </a>
              )}
              {s.command && <Cmd text={s.command} always />}
              {s.done ? (
                <span className="gh-done">
                  <Check size={13} strokeWidth={2.6} aria-hidden="true" />
                  {s.done[lang]}
                </span>
              ) : (
                s.page && (
                  <Link to={s.page.split('#')[0]!} hash={s.page.split('#')[1]} className="gh-link">
                    {w.toolPage}
                  </Link>
                )
              )}
            </div>
          </li>
        ))}
      </ol>
      {row.how === 'sign-in' && (
        <>
          <div className="gh-row">
            <button className="btn sm" disabled={checking} onClick={onCheck}>
              <RefreshCw size={13} /> {w.check}
            </button>
            <Cmd text="squad connect --status" />
          </div>
          {row.by !== 'token' && <p className="gh-small">{row.ownSignIn ? w.ownFoot(row.codePage?.name ?? row.label) : w.stepFoot(row.codePage?.name ?? row.label, row.label)}</p>}
        </>
      )}
    </details>
  );
}

/** A token is pasted where the tracker is chosen, in Settings: one place for it, never a second form here. */
function InSettings({ line, lang }: { line?: string; lang: Lang }) {
  return (
    <div className="gh-row">
      {line && <span className="gh-muted">{line}</span>}
      <Link to="/settings" hash="tracker" className="btn sm">
        {CONNECT[lang].openSettings}
      </Link>
    </div>
  );
}

/** The other way for a sign-in that also takes a token: a quiet link to the token form in Settings. */
function TokenInstead({ lang }: { lang: Lang }) {
  const w = CONNECT[lang];
  return (
    <div className="gh-row">
      <Link to="/settings" hash="tracker" className="gh-link" title={w.tokenOther}>
        {w.useToken}
      </Link>
    </div>
  );
}

function Disconnect({ row, lang, onClose }: { row: ConnectionRow; lang: Lang; onClose(): void }) {
  const w = CONNECT[lang].off;
  const act = useAct<{ line: string }>();
  const a = row.actions.find((x) => x.id === 'disconnect')!;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal gh-code" role="alertdialog" aria-modal="true" aria-label={w.head(row.label)} dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
        <h2>{w.head(row.label)}</h2>
        <p className="gh-muted">{row.ownSignIn ? w.own(row.label, row.signedIn?.as) : w.body(row.label, row.account ?? '')}</p>
        {row.revokeAt && (
          <p className="gh-small">
            {row.revokeAt.words[lang]}{' '}
            <a href={row.revokeAt.link} target="_blank" rel="noreferrer" className="gh-link gh-url" dir="ltr">
              {row.revokeAt.link.replace(/^https:\/\//, '')}
            </a>
          </p>
        )}
        <div className="gh-row">
          <button
            className="btn sm danger"
            disabled={act.isPending}
            onClick={() => act.mutate({ path: `/api/v1/connections/${row.name}/disconnect`, done: (r) => r.line }, { onSuccess: onClose })}
          >
            {w.yes}
          </button>
          <button className="btn sm" autoFocus onClick={onClose}>{w.no}</button>
          <Cmd text={a.command} />
        </div>
      </div>
    </div>
  );
}

export function ConnectionCard({ row, at, lang, onSignIn, onCheck, checking }: { row: ConnectionRow; at: number; lang: Lang; onSignIn(): void; onCheck(): void; checking: boolean }) {
  const w = CONNECT[lang];
  const [off, setOff] = useState(false);
  const connected = row.state === 'connected';
  const signIn = row.actions.find((a) => a.id === 'sign-in');
  const tone = connected ? 'ok' : row.state === 'soon' ? 'soon' : 'no';
  // What is left here is the person's to do now: sign in to the tool the project uses, or pick its place.
  const focus = !connected && (Boolean(row.pick?.length) || (row.for && row.how === 'sign-in'));
  return (
    <section className={`gh-conn ${focus ? 'focus' : ''}`} aria-label={row.label}>
      <div className="gh-hd">
        <Tile label={row.label} at={at} />
        <div>
          <b>{row.label}</b>
          <small>{row.what[lang]}</small>
        </div>
        <span className={`gh-state ${tone}`}>{w.state[row.state]}</span>
      </div>
      {connected ? (
        <>
          <div className="gh-who">
            <span className="gh-av" aria-hidden="true" dir="ltr">{(row.account ?? '?').slice(0, 2).toUpperCase()}</span>
            <div>
              <small>{w.signedInAs}</small>
              <b dir="ltr">{row.account}</b>
            </div>
            {row.actions.some((a) => a.id === 'disconnect') && (
              <button className="btn sm" onClick={() => setOff(true)}>{w.disconnect}</button>
            )}
          </div>
          {row.address?.now && <PlaceNow row={row} lang={lang} />}
          <ul className="gh-can">
            {row.can.map((c) => (
              <li key={c.en}>
                <Check size={13} strokeWidth={2.6} aria-hidden="true" />
                {c[lang]}
              </li>
            ))}
          </ul>
          {row.token ? (
            <>
              {row.by === 'token' && <p className="gh-small">{w.byTokenHere}</p>}
              <TokenForm key={row.token.address ?? ''} row={row} lang={lang} />
            </>
          ) : (
            (row.how === 'token' || row.by === 'token') && <InSettings line={row.by === 'token' ? w.byToken : w.tokenInSettings(row.label)} lang={lang} />
          )}
        </>
      ) : row.how === 'soon' ? (
        <>
          <p>{w.soonLine}</p>
          <div className="gh-row">
            <button className="btn pri" disabled title={w.soonLine}>{row.next?.[lang]}</button>
          </div>
        </>
      ) : row.how === 'token' ? (
        <>
          <p>{w.tokenLine(row.next?.[lang])}</p>
          {row.next && (
            <div className="gh-row">
              <button className="btn pri" disabled>{row.next[lang]}</button>
              <span className="gh-next">{w.nextTag}</span>
            </div>
          )}
          <InSettings line={w.tokenInSettings(row.label)} lang={lang} />
          <Guide row={row} lang={lang} open={false} onCheck={onCheck} checking={checking} />
        </>
      ) : (
        <>
          {row.line ? (
            <p>{row.line[lang]}</p>
          ) : row.state === 'unknown' ? (
            <p>{w.unknownLine(row.codePage?.name ?? row.label)}</p>
          ) : (
            row.for && <p>{w.forWhat(row.for)}</p>
          )}
          {row.pick && <SitePick row={row} lang={lang} />}
          {signIn && (
            <div className="gh-row">
              <button className="btn pri" onClick={onSignIn}>{w.code.head(row.codePage?.name ?? row.label)}</button>
              <Cmd text={signIn.command} />
            </div>
          )}
          {/* The place's address, pasted: open when it is what is left to do here, folded under a sign-in button. When the
              token is the way here, the token form holds the address: no second box. */}
          {row.address && row.by !== 'token' && (
            <details className="gh-guide" open={!signIn}>
              <summary>
                <ChevronDown size={14} aria-hidden="true" />
                {row.pick?.length ? w.place.notInList : w.place.paste}
              </summary>
              <AddressBox row={row} lang={lang} />
            </details>
          )}
          {/* A sign-in that also takes a token: on this row when the tool takes it here, else in Settings. */}
          {row.token ? <TokenForm key={row.token.address ?? ''} row={row} lang={lang} /> : row.tracker && (row.by === 'token' ? <InSettings lang={lang} /> : <TokenInstead lang={lang} />)}
          {/* A sign-in left behind that does not work here (no access, its tool gone) can still be ended. */}
          {row.actions.some((a) => a.id === 'disconnect') && (
            <div className="gh-row">
              <button className="btn sm" onClick={() => setOff(true)}>{w.disconnect}</button>
            </div>
          )}
          {/* The token form already holds the steps when the token is the way here: no second list of them, but Check again. */}
          {row.token && row.by === 'token' ? (
            <div className="gh-row">
              <button className="btn sm" disabled={checking} onClick={onCheck}>
                <RefreshCw size={13} /> {w.check}
              </button>
              <Cmd text="squad connect --status" />
            </div>
          ) : (
            <Guide row={row} lang={lang} open={row.state === 'missing' || row.state === 'unknown' || row.by === 'token'} onCheck={onCheck} checking={checking} />
          )}
        </>
      )}
      {off && <Disconnect row={row} lang={lang} onClose={() => setOff(false)} />}
    </section>
  );
}

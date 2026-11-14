import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { api, send } from '../../api/client';
import type { CodePage, SignInFlow } from '../../api/contribution-types';
import { CONNECT } from '../../lib/connect-words';
import { readLang } from '../../lib/first-story';
import { usePrefs } from '../../lib/prefs';
import { Cmd } from '../ui';

/**
 * Sign in with an outside tool, through its own sign-in: squad-kit runs the tool, which gives a one-time code; the
 * person opens the tool's page (a normal link: squad-kit opens no window), types the code and approves. The window
 * follows the sign-in until it is done. Cancel and Esc stop the tool's sign-in, even before its code arrives; a click
 * beside the window does nothing, so it never stops a sign-in the person is approving. `page`: the code goes on another
 * company's page (Microsoft's, for Azure DevOps), with its own words.
 */
export function SignInCode({ name, label: tool, page, onClose }: { name: string; label: string; page?: CodePage; onClose(): void }) {
  const lang = readLang();
  const w = CONNECT[lang];
  const label = page?.name ?? tool;
  const qc = useQueryClient();
  const { toast } = usePrefs();
  const [flow, setFlow] = useState<SignInFlow | null>(null);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  const closed = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const base = `/api/v1/connections/${encodeURIComponent(name)}/sign-in`;
  const stopIt = () => void send(`${base}/cancel`, 'POST').catch(() => undefined);

  useEffect(() => box.current?.focus(), []);

  // Start (or pick up the one already waiting), then follow it every second and a half until it ends.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = async () => {
      if (stop) return;
      try {
        const f = await api<SignInFlow>(base);
        if (stop) return;
        setFlow(f);
        if (f.state === 'waiting') timer = setTimeout(() => void follow(), 1500);
        else if (f.state === 'done') {
          void qc.invalidateQueries();
          toast(CONNECT[lang].connectedNow(tool));
          onClose();
        } else if (f.state === 'cancelled') onClose();
        // `none`: the board lost the sign-in (squad-kit restarted). Said as a failure, with Try again.
        else if (f.state === 'none') setError(w.code.lost);
      } catch {
        // The board did not answer this once: ask again a little later.
        if (!stop) timer = setTimeout(() => void follow(), 3000);
      }
    };
    setFlow(null);
    setError('');
    send<SignInFlow>(base, 'POST')
      .then((f) => {
        // Closed while the tool was starting: its sign-in stops too.
        if (closed.current) return stopIt();
        if (stop) return;
        setFlow(f);
        if (f.state === 'waiting') timer = setTimeout(() => void follow(), 1500);
      })
      .catch((err: unknown) => !stop && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [round]);

  const cancel = () => {
    if (closed.current) return;
    closed.current = true;
    stopIt();
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const copy = () =>
    void navigator.clipboard?.writeText(flow?.code ?? '').then(
      () => toast(w.code.copied),
      () => toast('Could not copy. Select the code instead.', 'err'),
    );
  const failed = error || (flow?.state === 'failed' ? (flow.line ?? w.code.lost) : '');
  return (
    <div className="modal-veil">
      <div ref={box} tabIndex={-1} className="modal gh-code" role="dialog" aria-modal="true" aria-label={w.code.head(label)} dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
        <h2>{w.code.head(label)}</h2>
        {failed ? (
          <>
            <p className="gh-bad">{failed}</p>
            <div className="gh-row">
              <button className="btn pri sm" onClick={() => setRound((n) => n + 1)}>{w.code.again}</button>
              <button className="btn sm" onClick={cancel}>{w.code.close}</button>
            </div>
          </>
        ) : !flow?.code ? (
          <>
            <p className="gh-wait">
              <span className="gh-spin" aria-hidden="true" />
              {w.code.starting(label)}
            </p>
            <div className="gh-row">
              <button className="btn sm" onClick={cancel}>{w.code.cancel}</button>
            </div>
          </>
        ) : (
          <>
            <p className="gh-muted">{w.code.sub(label, page?.then[lang])}</p>
            <div className="gh-bigcode" dir="ltr">
              <span aria-label="One-time code">{flow.code}</span>
              <button className="btn sm" onClick={copy}>
                <Copy size={14} /> {w.code.copy}
              </button>
            </div>
            <p className="gh-wait" aria-live="polite">
              <span className="gh-spin" aria-hidden="true" />
              {w.code.wait(label)}
            </p>
            <div className="gh-row">
              <a className="btn sm" href={flow.url} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> {w.code.open(label)}
              </a>
              <button className="btn sm" onClick={cancel}>{w.code.cancel}</button>
              <Cmd text={`squad connect ${name}`} />
            </div>
            <p className="gh-foot">{page ? page.foot[lang] : w.code.foot(label)}</p>
          </>
        )}
      </div>
    </div>
  );
}

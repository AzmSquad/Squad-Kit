import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Loader2, Play, Square } from 'lucide-react';
import { api } from '../api/client';
import type { Ticket, TryStatus } from '../api/types';
import { useAct } from '../lib/data';
import { pagesOf, proofPages } from '../lib/review';
import { AGENT_TITLE } from './Chat';
import { useAskAgent } from './AskQuestion';
import { Cmd, Written } from './ui';
import { LookYourself } from './Verdict';
import '../styles/check.css';

/**
 * Your check at review, under the proof and on a ticket stopped at a gate: where to look in the app, what could not be
 * shown on a screen, and Try it yourself (the ticket's own copy of the app, nothing merged). Ask a question (questions only, the ticket keeps
 * waiting) is at the top of the story, as in every state. With no page in the proof, Try it yourself and Ask a
 * question still show, so the person is never stuck. Each button is one call with its terminal command: `squad try`.
 */

const bare = (url?: string) => (url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');

/** How Try it yourself stands for a ticket; often while it starts. */
export function useTry(id: string) {
  return useQuery({
    queryKey: ['try', id],
    queryFn: () => api<TryStatus>(`/api/v1/tickets/${encodeURIComponent(id)}/try`),
    refetchInterval: (q) => (q.state.data?.state === 'starting' ? 1000 : 4000),
  });
}

export function YourCheck({ t }: { t: Ticket }) {
  const s = useTry(t.id).data;
  return (
    <div className="yourcheck">
      <WhereToLook t={t} s={s} />
      <LookYourself t={t} />
      <TryItYourself t={t} s={s} />
    </div>
  );
}

/** The pages the proof names, each with the "done when" it shows; Open goes to the page in the running copy. */
export function WhereToLook({ t, s }: { t: Ticket; s?: TryStatus }) {
  const pages = proofPages(t);
  const who = AGENT_TITLE[useAskAgent(t)];
  return (
    <>
      <div className="lbl">Where to look</div>
      {pages.length ? (
        <ul className="lookpages">
          {pages.map((p) => {
            const open = s?.state === 'running' ? s.pages?.find((x) => x.page === p)?.url : undefined;
            const shows = (t.proof ?? []).filter((x) => pagesOf(x).includes(p)).map((x) => x.criterion);
            return (
              <li key={p}>
                <code>{p}</code>
                <Written className="what" text={shows.join(' · ')} />
                {open && (
                  <a className="btn sm" href={open} target="_blank" rel="noreferrer" title={`Open ${open}`}>
                    <ExternalLink size={13} /> Open
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="note lookpages-none">No page is saved for this story. Ask a question and the {who} tells you where to look, or try it yourself.</p>
      )}
    </>
  );
}

/** Try it yourself: Starting…, then Running with Open and Stop. If it cannot start, it says so with Try again. */
function TryItYourself({ t, s }: { t: Ticket; s?: TryStatus }) {
  const act = useAct();
  const state = s?.state ?? 'off';
  const start = () => act.mutate({ path: `/api/v1/tickets/${t.id}/try`, done: "Starting this story's own copy of the app" });
  const stop = () => act.mutate({ path: `/api/v1/tickets/${t.id}/try/stop`, done: 'Stopped it.' });
  const runs = state === 'running' || state === 'starting';
  return (
    <div className={`trybox ${state}`}>
      <div className="trybox-row">
        <span className="ring" aria-hidden="true">
          {state === 'starting' ? <Loader2 size={15} className="spin" /> : <Play size={14} />}
        </span>
        <div className="trybox-t">
          <b>{state === 'running' ? 'Running' : state === 'starting' ? 'Starting…' : 'Try it yourself'}</b>
          <span>
            Runs this story&apos;s own copy of the app, with the change in it. Nothing is merged.
            {state === 'running' && s?.url ? (
              <>
                {' '}
                At <span className="mono">{bare(s.url)}</span>.
              </>
            ) : null}
          </span>
        </div>
        <span className="grow" />
        <div className="trybox-acts">
          {state === 'running' && s?.url && (
            <a className="btn sm pri" href={s.url} target="_blank" rel="noreferrer" title={`Open ${s.url}`}>
              <ExternalLink size={13} /> Open
            </a>
          )}
          {runs && (
            <button className="btn sm" disabled={act.isPending} onClick={stop}>
              <Square size={11} /> Stop
            </button>
          )}
          {!runs && s?.can && (
            <button className="btn sm" disabled={act.isPending} onClick={start}>
              {state === 'failed' ? 'Try again' : 'Try it yourself'}
            </button>
          )}
        </div>
      </div>
      {state === 'failed' && <p className="trybox-why">{s?.error ?? 'The app did not start.'}</p>}
      {state === 'failed' && s?.detail && (
        <details className="costdetails">
          <summary>See what failed</summary>
          <pre className="app-out">{s.detail}</pre>
        </details>
      )}
      {!runs && s && !s.can && s.why && <p className="trybox-why quiet">{s.why}</p>}
      {!runs && s?.other && s.can && <p className="trybox-why quiet">{s.other}&apos;s copy runs now. Trying this one stops it.</p>}
      {(runs || s?.can) && <Cmd text={runs ? `squad try ${t.id} --stop` : `squad try ${t.id}`} />}
    </div>
  );
}

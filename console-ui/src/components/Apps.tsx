import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api } from '../api/client';
import type { AppOutput, ProjectApp } from '../api/types';
import { useAct, useApps, useBoard } from '../lib/data';
import { shellArg, shellQuote } from '../lib/text';
import { Cmd, Modal, Written } from './ui';
import { LanguagePick, PhoneLine, PhoneNotReady } from './PhoneStart';
import { AskLeadButton } from './LeadAsk';
import { appPath } from '../lib/lead';

/**
 * Your apps, in the sidebar: each app of the project with Start, Open, Restart and Stop. squad-kit runs it from its
 * own copy of main, with every ticket the person approved, so no terminal is needed. Each button is one call, with
 * its terminal command (`squad app start`).
 */
export function Apps() {
  const q = useApps();
  const apps = q.data?.apps ?? [];
  if (!apps.length) return null;
  const idle = apps.some((a) => (a.start || a.phone?.ready) && (a.state === 'not-running' || a.state === 'stopped') && !a.up && !a.fresh);
  return (
    <div className="apps">
      <div className="apps-h">Your apps</div>
      {apps.map((a) => (
        <AppItem key={a.repo} a={a} together={apps.filter((x) => x.start && x.fresh && x.fresh.id === a.fresh?.id)} named={apps.length > 1} live={q.data?.live ?? false} reading={q.data?.reading ?? false} readError={q.data?.readError} />
      ))}
      {idle && <p className="apps-note">Starts the newest code, with every ticket you approved. No terminal needed.</p>}
    </div>
  );
}

const bare = (url?: string | null) => (url ?? '').replace(/^https?:\/\//, '');

/** "RO-3 Login screen and RO-5 Sign in". */
function both(items: { id: string; title: string }[]): string {
  const all = items.map((t) => `${t.id} ${t.title}`);
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : (all[0] ?? '');
}

function statusLine(a: ProjectApp): string {
  switch (a.state) {
    case 'running':
      return a.phone?.run?.state === 'running' ? `On ${a.phone.run.device ?? `the ${a.phone.word}`}` : runningFor(a.since);
    case 'starting':
      return 'Starting…';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'Failed';
    default:
      return 'Not running';
  }
}

function stepLine(a: ProjectApp): string {
  if (a.step === 'phone') return a.phone?.run?.line ?? `Getting the app onto squad-kit's ${a.phone?.word ?? 'phone'}`;
  if (a.step === 'copy') return 'Making a copy of the code. On a big project this takes a while.';
  if (a.step === 'setup') return 'Setting it up first';
  if (a.step === 'start') return 'Starting it';
  return `Getting the newest ${a.base}`;
}

function runningFor(iso?: string): string {
  const m = iso ? Math.round((Date.now() - Date.parse(iso)) / 60_000) : 0;
  return m < 1 ? 'Running' : `Running for ${m} min`;
}

function AppItem({ a, together, named, live, reading, readError }: { a: ProjectApp; together: ProjectApp[]; named: boolean; live: boolean; reading: boolean; readError?: string }) {
  const act = useAct();
  // squad-kit's own code: a story goes on as a pull request, never in a release from here.
  const board = useBoard();
  const self = board.data?.ready ? Boolean(board.data.self) : false;
  const [typing, setTyping] = useState(false);
  const [output, setOutput] = useState(false);
  // The terminal names the app only when the project has more than one.
  const ref = named ? ` ${shellArg(a.name)}` : '';
  const call = (verb: string, done: string, body?: object) => act.mutate({ path: `/api/v1/apps/${encodeURIComponent(a.name)}/${verb}`, body, done });
  const start = (body?: object) => call('start', `Starting ${a.name}`, body);
  // A phone app opens on squad-kit's iPhone or Android phone, in the language picked next to Start.
  const phone = a.phone;
  const [lang, setLang] = useState(phone?.languages[0] ?? 'en');
  const canStart = Boolean(a.start || phone?.ready);
  const langFlag = phone?.ready && phone.languages.length > 1 && lang !== 'en' ? ` --lang ${lang}` : '';
  const startHere = () => start(phone?.ready ? { phone: true, ...(phone.languages.length > 1 ? { language: lang } : {}) } : phone ? { web: true } : undefined);
  const useWeb = () => call('start', `Starting the web version of ${a.name}`, { web: true });
  const onPhone = Boolean(phone?.on || phone?.run?.state === 'running');
  const busy = a.state === 'failed' ? a.busy : undefined;
  // One story can change several parts of a product: one box for it, and its buttons take them all.
  const forAll = async (verb: string, done: string, body?: object) => {
    try {
      for (const [i, x] of together.entries()) await act.mutateAsync({ path: `/api/v1/apps/${encodeURIComponent(x.name)}/${verb}`, body, ...(i === together.length - 1 ? { done } : {}) });
    } catch {
      // The action's own error message already said what happened.
    }
  };

  return (
    <div className={`app-item ${a.state}`}>
      {a.fresh && a.start && together[0] === a && (
        <div className="app-new" role="status">
          <div className="hd">
            <span className="ok">
              <Check size={13} strokeWidth={3} />
            </span>
            <b title={a.fresh.title}>
              {a.fresh.id} is in the newest version
            </b>
          </div>
          <p>Try the new version yourself.</p>
          <div className="app-acts">
            <button className="btn sm go" disabled={act.isPending} onClick={() => void forAll('restart', together.length > 1 ? 'Starting the new version' : `Starting the new version of ${a.name}`)}>
              Run the new version
            </button>
            <button className="btn sm" disabled={act.isPending} onClick={() => void forAll('not-now', 'Fine. It stays as it is.', { ticket: a.fresh!.id })}>
              Not now
            </button>
          </div>
          {self ? <small>It goes on as a pull request: its story says how to send it.</small> : a.fresh.release && <small>It also goes out in release {a.fresh.release}.</small>}
          <Cmd text={`squad app restart${ref}`} />
        </div>
      )}

      <div className="app-row">
        <i aria-hidden="true" />
        <span className="nm">
          <b>{a.name}</b>
          <small title={a.state === 'running' ? `Running at ${a.address}` : statusLine(a)}>{statusLine(a)}</small>
        </span>
        {a.state === 'running' && !onPhone ? (
          <a className="btn sm pri" href={a.address} target="_blank" rel="noreferrer" title={`Open ${a.address}`}>
            Open
          </a>
        ) : a.state === 'running' ? null : a.state === 'starting' ? (
          <button className="btn sm" disabled={act.isPending} onClick={() => call('stop', `Stopped ${a.name}`)}>
            Stop
          </button>
        ) : canStart ? (
          <button className="btn sm go" disabled={act.isPending} onClick={startHere}>
            {a.state === 'failed' ? 'Try again' : 'Start'}
          </button>
        ) : null}
      </div>

      <AppLead a={a} />

      {a.state === 'starting' && (phone && onPhone ? <PhoneLine phone={phone} starting /> : <p className="app-more">{stepLine(a)}</p>)}
      {phone && a.state !== 'starting' && <PhoneLine phone={phone} starting={false} />}
      {phone && a.state !== 'running' && a.state !== 'starting' && <PhoneNotReady phone={phone} />}
      {/* The sidebar is narrow: the language sits under Start, not beside it. */}
      {phone?.ready && a.state !== 'running' && a.state !== 'starting' && (
        <p className="app-more phone-pick">
          Opens on squad-kit&apos;s {phone.word}{phone.languages.length > 1 ? ', in' : '.'}
          <LanguagePick languages={phone.languages} value={lang} onChange={setLang} />
        </p>
      )}

      {phone?.web && onPhone && (a.state === 'starting' || a.state === 'running') && (
        <div className="app-acts">
          <button className="btn sm" disabled={act.isPending} onClick={useWeb}>
            Use the web version now
          </button>
          <Cmd text={`squad app start${ref} --web`} />
        </div>
      )}

      {a.state === 'running' && (
        <div className="app-more">
          {!onPhone && <span className="addr">{bare(a.address)}</span>}
          {a.includes.length > 0 && <Written lead="Includes" text={both(a.includes)} />}
          {a.elsewhere && <span>Started outside the board, from a terminal or an earlier squad-kit.</span>}
          <div className="app-acts">
            <button className="btn sm" disabled={act.isPending} onClick={() => call('restart', `Restarting ${a.name}`)}>
              Restart
            </button>
            <button className="btn sm" disabled={act.isPending} onClick={() => call('stop', `Stopped ${a.name}`)}>
              Stop
            </button>
          </div>
          <Cmd text={`squad app stop${ref}`} />
        </div>
      )}

      {a.state === 'failed' && !busy && <p className="app-more why">{a.error}</p>}

      {a.state !== 'running' && a.state !== 'starting' && canStart && !busy && <Cmd text={`squad app start${ref}${langFlag}`} />}

      {a.state !== 'running' && a.state !== 'starting' && a.start && a.up && !busy && (
        <p className="app-more">
          It looks like this app is already open on this computer.{' '}
          <a href={a.url} target="_blank" rel="noreferrer">
            Open it
          </a>
        </p>
      )}

      {busy && (
        <div className="app-warn">
          <b>{a.error}</b>
          <span>{busy.ours ? 'squad-kit started it, so it can stop it for you.' : 'squad-kit leaves it alone. Close that program, then press Try again, or ask an engineer to look at what failed.'}</span>
          {busy.ours && (
            <div className="app-acts">
              <button className="btn sm" disabled={act.isPending} onClick={() => start({ stopOther: true })}>
                Stop it and start
              </button>
            </div>
          )}
          <Cmd text={busy.ours ? `squad app start${ref} --stop-other` : `squad app start${ref}`} />
        </div>
      )}

      {!a.start && !phone && !typing && (
        <div className="app-warn">
          <b>Start command unknown</b>
          <span>squad-kit could not tell how to start this app yet.</span>
          {readError && !reading && <span className="bad">The Architect could not read the project: {readError}</span>}
          <div className="app-acts">
            {live && (
              <button className="btn sm" disabled={reading || act.isPending} onClick={() => act.mutate({ path: '/api/v1/scan', done: 'The Architect is reading the project to find how to start it' })}>
                {reading ? 'The Architect is looking…' : 'Ask the Architect to find it'}
              </button>
            )}
            <button className="btn sm" onClick={() => setTyping(true)}>
              Type it
            </button>
          </div>
          {!live && <span>You can also set it in Settings, under How the squad checks and runs this project.</span>}
          <Cmd text={live ? 'squad app find' : `squad app set${ref} --start "npm run dev"`} />
        </div>
      )}

      {typing && <TypeIt a={a} cmdRef={ref} onDone={() => setTyping(false)} />}

      {a.start && (
        <button className="app-link" onClick={() => setOutput(true)}>
          {a.state === 'failed' ? 'See what failed' : 'Show output'}
        </button>
      )}
      {output && (
        <AppOutputView
          a={a}
          cmdRef={ref}
          onClose={() => setOutput(false)}
          onChange={() => {
            setOutput(false);
            setTyping(true);
          }}
        />
      )}
    </div>
  );
}

/**
 * The Squad lead beside each app: "How to sign in", once it learned it (a press shows all of it), and Ask about it,
 * from the app's page. The lead answers from its own copy of the app, never this one.
 */
function AppLead({ a }: { a: ProjectApp }) {
  const [all, setAll] = useState(false);
  return (
    <div className="app-lead">
      {a.signIn && (
        <button className={`app-signin ${all ? 'all' : ''}`} onClick={() => setAll(!all)} aria-expanded={all} title={all ? undefined : a.signIn}>
          <b>How to sign in</b>
          <Written className="txt" text={a.signIn} />
        </button>
      )}
      <AskLeadButton className="btn sm app-ask" label="Ask about it" context={{ from: 'app', app: a.name, path: appPath(a.address ?? a.url) }} />
    </div>
  );
}

/** "Type it": the start command and the address, saved in the project's settings. */
function TypeIt({ a, cmdRef, onDone }: { a: ProjectApp; cmdRef: string; onDone(): void }) {
  const act = useAct();
  const [start, setStart] = useState(a.start ?? '');
  const [url, setUrl] = useState(a.url ?? '');
  const save = () =>
    act.mutate(
      { path: `/api/v1/apps/${encodeURIComponent(a.name)}/commands`, method: 'PUT', body: { start, url }, done: `Saved how ${a.name} starts` },
      { onSuccess: onDone },
    );
  return (
    <form
      className="app-type"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label>
        Start command
        <input className="input" value={start} onChange={(e) => setStart(e.target.value)} placeholder="npm run dev" autoFocus spellCheck={false} />
      </label>
      <label>
        Address
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000" spellCheck={false} />
      </label>
      <div className="app-acts">
        <button className="btn sm pri" type="submit" disabled={!start.trim() || act.isPending}>
          Save
        </button>
        <button className="btn sm" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      <Cmd text={`squad app set${cmdRef} --start ${shellQuote(start.trim() || 'npm run dev')}${url.trim() ? ` --url ${shellArg(url.trim())}` : ''}`} />
    </form>
  );
}

/** For engineers: what failed, how the app starts, and the last lines it and its setup printed. */
function AppOutputView({ a, cmdRef, onClose, onChange }: { a: ProjectApp; cmdRef: string; onClose(): void; onChange(): void }) {
  const q = useQuery({
    queryKey: ['apps', a.name, 'output'],
    queryFn: () => api<AppOutput>(`/api/v1/apps/${encodeURIComponent(a.name)}/output`),
    refetchInterval: 2000,
  });
  const text = (q.data?.lines ?? []).join('\n').trim();
  return (
    <Modal
      title={a.state === 'failed' ? `${a.name}: what failed` : `${a.name}: how it starts`}
      wide
      onClose={onClose}
      footer={
        <>
          <Cmd text={`squad app start${cmdRef}`} />
          <span className="grow" />
          <button className="btn sm" onClick={onChange}>
            Change
          </button>
          <button className="btn sm pri" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {a.state === 'failed' && a.detail && (
        <pre className="app-out" style={{ marginBottom: 12 }}>
          {a.detail}
        </pre>
      )}
      <div className="app-how">
        <div>
          <span>Start command</span>
          <code>{a.start}</code>
        </div>
        <div>
          <span>Address</span>
          <code>{a.address ?? a.url ?? 'The one it prints when it starts'}</code>
        </div>
        {a.setup && (
          <div>
            <span>Setup, in a new copy and when its packages change</span>
            <code>{a.setup}</code>
          </div>
        )}
        <div>
          <span>squad-kit's copy of {a.base}</span>
          <code>
            {a.dir}
            {a.commit ? ` at ${a.commit.slice(0, 8)}` : ''}
          </code>
        </div>
      </div>
      <pre className="app-out">{text || 'Nothing yet. Press Start, and what the app prints shows here.'}</pre>
    </Modal>
  );
}

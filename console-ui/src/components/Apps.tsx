import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api } from '../api/client';
import type { AppOutput, ProjectApp } from '../api/types';
import { useAct, useApps } from '../lib/data';
import { shellArg, shellQuote } from '../lib/text';
import { Cmd, Modal } from './ui';

/**
 * Your apps, in the sidebar: each app of the project with Start, Open, Restart and Stop. squad-kit runs it from its
 * own copy of main, with every ticket the person approved, so no terminal is needed. Each button is one call, with
 * its terminal command (`squad app start`).
 */
export function Apps() {
  const q = useApps();
  const apps = q.data?.apps ?? [];
  if (!apps.length) return null;
  const idle = apps.some((a) => a.start && (a.state === 'not-running' || a.state === 'stopped') && !a.up && !a.fresh);
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
      return runningFor(a.since);
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
  const [typing, setTyping] = useState(false);
  const [output, setOutput] = useState(false);
  // The terminal names the app only when the project has more than one.
  const ref = named ? ` ${shellArg(a.name)}` : '';
  const call = (verb: string, done: string, body?: object) => act.mutate({ path: `/api/v1/apps/${encodeURIComponent(a.name)}/${verb}`, body, done });
  const start = (body?: object) => call('start', `Starting ${a.name}`, body);
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
          {a.fresh.release && <small>It also goes out in release {a.fresh.release}.</small>}
          <Cmd text={`squad app restart${ref}`} />
        </div>
      )}

      <div className="app-row">
        <i aria-hidden="true" />
        <span className="nm">
          <b>{a.name}</b>
          <small title={a.state === 'running' ? `Running at ${a.address}` : statusLine(a)}>{statusLine(a)}</small>
        </span>
        {a.state === 'running' ? (
          <a className="btn sm pri" href={a.address} target="_blank" rel="noreferrer" title={`Open ${a.address}`}>
            Open
          </a>
        ) : a.state === 'starting' ? (
          <button className="btn sm" disabled={act.isPending} onClick={() => call('stop', `Stopped ${a.name}`)}>
            Stop
          </button>
        ) : a.start ? (
          <button className="btn sm go" disabled={act.isPending} onClick={() => start()}>
            {a.state === 'failed' ? 'Try again' : 'Start'}
          </button>
        ) : null}
      </div>

      {a.state === 'starting' && <p className="app-more">{stepLine(a)}</p>}

      {a.state === 'running' && (
        <div className="app-more">
          <span className="addr">{bare(a.address)}</span>
          {a.includes.length > 0 && <span>Includes {both(a.includes)}</span>}
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

      {a.state !== 'running' && a.state !== 'starting' && a.start && !busy && <Cmd text={`squad app start${ref}`} />}

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

      {!a.start && !typing && (
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

import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { Check, CircleAlert, CircleArrowUp, Download, ExternalLink, FileText, Loader2, Minus, Pause, RefreshCw, TriangleAlert } from 'lucide-react';
import { api } from '../api/client';
import type { LicenseView, ToolGetting, ToolLine, ToolsView } from '../api/types';
import { useAct } from '../lib/data';
import { Cmd, CouldNotLoad, Modal, ago } from '../components/ui';
import { ToolLogo, brandOf } from '../components/ToolLogo';
import '../styles/tools.css';

/**
 * "What this project needs": every tool for a smooth experience on this computer, Required first. Each line says what
 * it gives, whether it is here, what it is used for, and who installs it: a Get it button when squad-kit can (after
 * you accept its maker's license, read in full, when it has one: Google's for the Android phone tools), the official
 * steps and Check again when only you can. A copy of yours that is too old gets an Update button when
 * squad-kit can update it safely, with a warning to OK first, and the steps stay below. A Ready copy older than its makers
 * recommend says so, with the steps to update it, and stops nothing. A story stopped by a tool links to its line here.
 */

const ACTION_WORDS: Record<string, string> = { build: 'Building', checks: 'Checks', pictures: 'Phone pictures', 'start-app': 'Start', 'try-it': 'Try it yourself' };
/** What squad-kit can't do while a tool is missing, as the end of "squad-kit can't …". */
const CANT_WORDS: Record<string, string> = {
  build: 'build stories',
  checks: 'run the checks',
  pictures: 'take phone pictures',
  'start-app': 'start the app on the phone',
  'try-it': 'let you try the app on the phone',
};
const GROUPS = [
  { priority: 'required', title: 'Required', sub: 'Without these, some steps cannot run. squad-kit stops only those steps.' },
  { priority: 'recommended', title: 'Recommended', sub: 'Things work without these, in a simpler way. With them, the experience is better.' },
  { priority: 'optional', title: 'Optional', sub: 'Nice to have.' },
] as const;

/** This project's tools. While a download or a check runs, it follows it every second. */
export function useTools(every = 30_000) {
  return useQuery({
    queryKey: ['tools'],
    queryFn: () => api<ToolsView>('/api/v1/tools'),
    refetchInterval: (s) => (s.state.data?.getting || s.state.data?.checking ? 1000 : every),
  });
}

function stateText(l: ToolLine): string {
  switch (l.state) {
    case 'ready':
      return l.version ? `Ready · ${l.version}` : 'Ready';
    case 'too-old':
      return `Too old: found ${l.version ?? 'an old one'}, needs ${l.needs} or newer`;
    case 'getting':
      return 'Getting it now';
    case 'updating':
      return 'Updating now';
    case 'not-here':
      return 'Not on this computer';
    default:
      return 'Missing';
  }
}

const toneOf = (l: ToolLine) => (l.state === 'ready' ? 'ok' : l.state === 'getting' || l.state === 'updating' ? 'get' : l.state === 'not-here' ? 'off' : 'needs');

function Mark({ l, size = 13 }: { l: ToolLine; size?: number }) {
  if (l.state === 'ready') return <Check size={size} strokeWidth={3} aria-hidden="true" />;
  if (l.state === 'getting' || l.state === 'updating') return <Loader2 size={size} className="spin" aria-hidden="true" />;
  if (l.state === 'not-here') return <Minus size={size} strokeWidth={3} aria-hidden="true" />;
  return <CircleAlert size={size} strokeWidth={2.5} aria-hidden="true" />;
}

const SHORT: Record<ToolLine['state'], string> = { ready: 'Ready', 'too-old': 'Too old', missing: 'Missing', getting: 'Getting it', updating: 'Updating', 'not-here': 'Not here' };

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

/** "Until Flutter is updated, squad-kit can't take phone pictures, … . Everything else works." */
function cantText(l: ToolLine): string {
  const cant = list(l.blocks.map((a) => CANT_WORDS[a] ?? ACTION_WORDS[a] ?? a));
  const older = l.state === 'too-old' || l.state === 'updating';
  if (!older && l.installer === 'squad-kit') return `Until squad-kit gets ${l.name}, it can't ${cant}. Everything else works.`;
  return `Until ${l.name} is ${older ? 'updated' : 'installed'}, squad-kit can't ${cant}. Everything else works.`;
}

/** Every tool at a glance, as logos with their state; each one opens its line below. */
function Shelf({ lines }: { lines: ToolLine[] }) {
  return (
    <nav className="tl-shelf" aria-label="This project's tools">
      {lines.map((l) => (
        <Link key={l.id} to="/tools" hash={l.id} className={`tl-chip ${toneOf(l)}`}>
          <span className="tl-chip-art">
            <ToolLogo id={l.id} name={l.name} size={46} />
            <span className="tl-badge">
              <Mark l={l} size={11} />
            </span>
          </span>
          <b>{l.name}</b>
          <span>{SHORT[l.state]}</span>
        </Link>
      ))}
    </nav>
  );
}

/** "about 40 s left", or "about 4 min left" for longer. */
const left = (s: number) => (s >= 90 ? `about ${Math.round(s / 60)} min left` : `about ${s} s left`);

function Progress({ g }: { g: ToolGetting }) {
  const pct = g.total ? Math.min(99, Math.floor((g.done / g.total) * 100)) : null;
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  return (
    <div className="tl-get" aria-live="polite">
      <div className="tl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <i style={{ width: `${g.step === 'unpack' ? 100 : (pct ?? 5)}%` }} />
      </div>
      {g.step === 'update' ? (
        <span>
          {g.words ?? 'Updating'}, {left(g.secondsLeft)}. Steps that need {g.name} wait until it is done; everything else keeps working.
        </span>
      ) : (
        <span>
          {g.step === 'unpack' ? 'Unpacking' : `${g.step === 'install' ? (g.words ?? 'Installing') : 'Downloading'}${g.total ? `: ${mb(g.done)} of ${mb(g.total)} MB` : ''}`}, {left(g.secondsLeft)}. You can keep working meanwhile.
        </span>
      )}
    </div>
  );
}

/** Update: the button and its command, then the warning inside the line, with the OK and Not now. */
function UpdateIt({ l, busy }: { l: ToolLine; busy: boolean }) {
  const act = useAct<ToolsView>();
  const [asking, setAsking] = useState(false);
  const u = l.update!;
  if (!asking) {
    return (
      <div className="tl-act">
        <span>squad-kit can update it for you.</span>
        <span className="tl-row">
          <button className="btn pri sm" disabled={busy || act.isPending} onClick={() => setAsking(true)}>
            <CircleArrowUp size={14} /> Update {l.name}
          </button>
          <Cmd text={u.command} />
        </span>
      </div>
    );
  }
  return (
    <div className="tl-act">
      <div className="tl-ask" role="group" aria-label={`Update ${l.name} for all projects?`}>
        <p>
          <TriangleAlert size={15} strokeWidth={2.4} aria-hidden="true" />
          <span>{u.warning}</span>
        </p>
        <span className="tl-row">
          <button
            className="btn pri sm"
            disabled={busy || act.isPending}
            onClick={() => act.mutate({ path: `/api/v1/tools/${encodeURIComponent(l.id)}/update`, body: { ok: true }, done: `Updating ${l.name}`, after: () => setAsking(false) })}
          >
            {act.isPending ? <Loader2 size={14} className="spin" /> : <CircleArrowUp size={14} />} Update {l.name} for all projects
          </button>
          <button className="btn sm" autoFocus disabled={act.isPending} onClick={() => setAsking(false)}>
            Not now
          </button>
        </span>
      </div>
    </div>
  );
}

/** "about 12 minutes", for the first time a tool takes to get. */
const aboutMin = (s: number) => (s >= 90 ? `about ${Math.round(s / 60)} minutes` : `about ${Math.max(10, Math.round(s / 10) * 10)} seconds`);

/** The license a tool's maker asks you to accept, in full, read from the maker's own site, with Accept and Not now. */
function LicenseRead({ l, onClose }: { l: ToolLine; onClose(): void }) {
  const q = useQuery({ queryKey: ['tool-license', l.id], queryFn: () => api<LicenseView>(`/api/v1/tools/${encodeURIComponent(l.id)}/license`), staleTime: 60 * 60_000 });
  const act = useAct<ToolsView>();
  const v = q.data;
  return (
    <Modal
      title={`Google's license for the ${l.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button
            className="btn pri"
            disabled={!v || act.isPending}
            onClick={() => act.mutate({ path: `/api/v1/tools/${encodeURIComponent(l.id)}/accept`, body: { licenses: v!.licenses.map((x) => x.id) }, done: "You accepted Google's license. Now press Get it.", after: onClose })}
          >
            {act.isPending ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Accept
          </button>
          <button className="btn" autoFocus onClick={onClose}>
            Not now
          </button>
          <span className="grow" />
          <Cmd text={l.license!.command} />
        </>
      }
    >
      {!v ? (
        q.isError ? (
          <CouldNotLoad what="the license" error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <p className="tl-wait">
            <Loader2 size={15} className="spin" /> Reading the license from Google's site…
          </p>
        )
      ) : (
        <>
          <p>
            Google asks everyone who gets these tools to accept {v.licenses.length === 1 ? 'this license' : `these ${v.licenses.length} licenses`}. squad-kit
            never accepts {v.licenses.length === 1 ? 'it' : 'them'} for you: read {v.licenses.length === 1 ? 'it' : 'them'}, then press Accept or Not now.
          </p>
          {v.licenses.map((x) => (
            <section key={x.id} className="tl-license">
              <h4 className="mono">{x.id}</h4>
              <pre>{x.text}</pre>
            </section>
          ))}
        </>
      )}
    </Modal>
  );
}

function Line({ l, hit, busy, onCheck }: { l: ToolLine; hit: boolean; busy: boolean; onCheck(): void }) {
  const act = useAct<ToolsView>();
  const [reading, setReading] = useState(false);
  const needsYou = l.state !== 'ready' && l.state !== 'not-here' && l.state !== 'getting' && l.state !== 'updating';
  const mustAccept = Boolean(l.license && !l.license.accepted);
  return (
    <section id={l.id} className={`tl-line ${toneOf(l)} ${l.blocks.length ? 'stops' : ''} ${hit ? 'tl-hit' : ''}`} style={{ '--brand': brandOf(l.id, l.name) } as CSSProperties}>
      <div className="tl-head">
        <ToolLogo id={l.id} name={l.name} />
        <div className="tl-name">
          <b>{l.name}</b>
          <span>{l.gives}</span>
        </div>
        <span className={`tl-state ${toneOf(l)}`}>
          <Mark l={l} /> {stateText(l)}
        </span>
      </div>
      <div className="tl-body">
        {l.why && l.state === 'too-old' && <p>{l.why}.</p>}
        {l.blocks.length > 0 && (
          <p className="tl-stops">
            <Pause size={14} strokeWidth={2.6} aria-hidden="true" />
            <span>{cantText(l)}</span>
          </p>
        )}
        {l.state === 'not-here' && l.notHere && <p>It {l.notHere}.</p>}
        <p className="tl-uses">
          <span>Used for</span>
          {l.actions.map((a) => (
            <i key={a} className={l.blocks.includes(a) ? 'stopped' : ''} title={l.blocks.includes(a) ? 'Waits for this tool' : undefined}>
              {ACTION_WORDS[a]}
            </i>
          ))}
        </p>
        {l.note && <p>{l.note}</p>}
        {l.trouble && <p className="tl-trouble" role="alert">{l.trouble}</p>}
        {l.getting && <Progress g={l.getting} />}
        {needsYou && l.installer === 'squad-kit' && (
          <div className="tl-act">
            <span>
              squad-kit gets it itself, into its own folder, with no password asked.
              {l.size ? ` It takes ${l.size} on this computer${l.seconds ? `, and ${aboutMin(l.seconds)} the first time` : ''}.` : ''}
              {mustAccept ? " Google's license comes first: read it and accept it." : ''}
            </span>
            {mustAccept ? (
              <span className="tl-row">
                <button className="btn pri sm" disabled={busy} onClick={() => setReading(true)}>
                  <FileText size={14} /> Read and accept Google's license
                </button>
                <Cmd text={l.license!.command} />
              </span>
            ) : (
              <span className="tl-row">
                <button className="btn pri sm" disabled={busy || act.isPending} onClick={() => act.mutate({ path: `/api/v1/tools/${encodeURIComponent(l.id)}/get`, done: `Getting ${l.name}` })}>
                  <Download size={14} /> Get it
                </button>
                <Cmd text={l.command} />
              </span>
            )}
            {reading && <LicenseRead l={l} onClose={() => setReading(false)} />}
          </div>
        )}
        {needsYou && l.update && <UpdateIt l={l} busy={busy} />}
        {(needsYou || l.recommended) && l.installer === 'you' && (
          <div className="tl-act">
            {l.update ? (
              <span className="tl-or">Or do it yourself:</span>
            ) : l.cantUpdate ? (
              <span>{l.cantUpdate}</span>
            ) : (
              l.reason && (
                <span>
                  You {l.recommended ? 'update' : 'install'} it: squad-kit can't, as {l.reason}.
                </span>
              )
            )}
            {l.steps.length > 0 && (
              <ol>
                {l.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            )}
            <span className="tl-row">
              <a className="btn sm" href={l.link} target="_blank" rel="noreferrer">
                Official page <ExternalLink size={13} />
              </a>
              <button className="btn sm" disabled={busy} onClick={onCheck}>
                <RefreshCw size={13} /> Check again
              </button>
              <Cmd text="squad tools check" />
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

export function ToolsPage() {
  const q = useTools();
  const check = useAct<ToolsView>();
  const hash = useRouterState({ select: (s) => s.location.hash.replace(/^#/, '') });
  const v = q.data;
  // A link from a stopped story opens the page at its tool's line.
  useEffect(() => {
    if (v && hash) document.getElementById(hash)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [Boolean(v), hash]);
  const busy = check.isPending || Boolean(v?.checking);
  const checkAgain = () => check.mutate({ path: '/api/v1/tools/check', done: 'Checked this computer again' });
  return (
    <>
      <div className="top">
        <h1>Tools</h1>
        <span className="grow" />
        <button className="btn" disabled={busy} onClick={checkAgain}>
          {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Check again
        </button>
        <Cmd text="squad tools check" />
      </div>
      <div className="scroll">
        {!v ? (
          q.isError ? (
            <CouldNotLoad what="the tools" error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <div className="center">
              <span className="tl-wait">
                <Loader2 size={16} className="spin" /> Checking this computer's tools…
              </span>
            </div>
          )
        ) : (
          <div className="page tl-page">
            <h2>What this project needs</h2>
            <p className="tl-sub">
              {v.summary} squad-kit checks this {v.system === 'mac' ? 'Mac' : 'computer'} by itself{v.checkedAt ? `, last ${ago(v.checkedAt)}` : ''}. After you install something, press Check again.
            </p>
            <Shelf lines={v.lines} />
            {GROUPS.map((g) => {
              const lines = v.lines.filter((l) => l.priority === g.priority);
              if (!lines.length) return null;
              return (
                <div key={g.priority} className="tl-group">
                  <h3>{g.title}</h3>
                  <p className="tl-gsub">{g.sub}</p>
                  {lines.map((l) => (
                    <Line key={l.id} l={l} hit={hash === l.id} busy={busy} onCheck={checkAgain} />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, Copy, Info, RefreshCw } from 'lucide-react';
import { api, send } from '../api/client';
import type { UpdateState, UpdateStatus, UpdateWork } from '../api/types';
import { usePrefs } from '../lib/prefs';
import { Cmd, Modal, clock } from './ui';

/**
 * The Update button: a banner on Home and every project page when a new squad-kit is ready, the update's steps while
 * it runs (the app keeps them, so they survive a page reload and the restart), the note after it, and Settings ›
 * About. Terminal: `squad upgrade`.
 */

const KEY = ['app', 'update'];
const RUNNING: UpdateState[] = ['waiting', 'installing', 'restarting'];

export function useUpdate() {
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api<UpdateStatus>('/api/v1/app/update'),
    refetchInterval: (query) => (RUNNING.includes(query.state.data?.progress.state ?? 'idle') ? 1000 : 60_000),
  });
  // A fresh app after a restart: load the page again, so it runs the new version's board too.
  const first = useRef<string | null>(null);
  const started = q.data?.startedAt;
  useEffect(() => {
    if (!started) return;
    if (first.current && first.current !== started) window.location.reload();
    first.current ??= started;
  }, [started]);
  return q;
}

/** Every update call answers with the whole status, so the page shows it at once. */
function useUpdateCall() {
  const qc = useQueryClient();
  const { toast } = usePrefs();
  const [pending, setPending] = useState(false);
  const call = async (path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown = {}): Promise<UpdateStatus | null> => {
    setPending(true);
    try {
      const s = await send<UpdateStatus>(path, method, body);
      qc.setQueryData(KEY, s);
      return s;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
      return null;
    } finally {
      setPending(false);
    }
  };
  return { pending, call };
}

/** "RO-7", "RO-7 and the Architect in roomflow", "RO-7, RO-9 and 2 more". */
function names(items: UpdateWork[] = []): string {
  const all = [...new Set(items.map((w) => w.ticket ?? `the Architect in ${w.project}`))];
  if (all.length <= 1) return all[0] ?? '';
  if (all.length <= 3) return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
  return `${all.slice(0, 2).join(', ')} and ${all.length - 2} more`;
}

/** "Today at 09:12", "Yesterday at 18:40", "3 Nov at 09:12". */
function when(iso: string): string {
  const d = new Date(iso);
  const day = (x: Date) => x.toDateString();
  const yesterday = new Date(Date.now() - 86_400_000);
  const date = day(d) === day(new Date()) ? 'Today' : day(d) === day(yesterday) ? 'Yesterday' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `${date} at ${clock(iso)}`;
}

/** The one command to copy, always shown: it is the way out when squad-kit cannot update itself. */
function CopyCommand({ text }: { text: string }) {
  const { toast } = usePrefs();
  const copy = () => {
    const done = navigator.clipboard?.writeText(text);
    if (!done) return toast('Could not copy. Select the text instead.', 'err');
    void done.then(
      () => toast('Command copied'),
      () => toast('Could not copy. Select the text instead.', 'err'),
    );
  };
  return (
    <div className="upd-cmd">
      <span className="term">
        <b>&gt;_</b>
        <span>{text}</span>
      </span>
      <button className="btn sm" onClick={copy}>
        <Copy size={13} /> Copy
      </button>
    </div>
  );
}

/** Releases shown in the banner; older ones are behind the release notes link. */
const RELEASES_SHOWN = 3;

/**
 * What is new: a few lines of each release since the person's version, newest first, so someone skipping a release
 * still reads it. One release reads as a plain list, as before.
 */
function Notes({ s }: { s: UpdateStatus }) {
  const releases = s.releases?.length ? s.releases : s.notes?.length ? [{ version: s.latest ?? s.current, lines: s.notes, url: s.notesUrl }] : [];
  if (!releases.length) return null;
  if (releases.length === 1) {
    return (
      <ul className="upd-notes" aria-label="What is new">
        {releases[0]!.lines.slice(0, 3).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    );
  }
  const shown = releases.slice(0, RELEASES_SHOWN);
  const more = releases.length - shown.length;
  return (
    <div className="upd-rels" aria-label="What is new">
      {shown.map((r) => (
        <div key={r.version} className="upd-rel">
          <a className="upd-ver" href={r.url} target="_blank" rel="noreferrer" title={`What is new in ${r.version}`}>
            {r.version}
          </a>
          <ul className="upd-notes">
            {r.lines.slice(0, 3).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ))}
      {more > 0 && (
        <a className="upd-more" href={s.notesUrl} target="_blank" rel="noreferrer">
          And {more} older {more === 1 ? 'release' : 'releases'}
        </a>
      )}
    </div>
  );
}

/** The banner's message in a few words, when it shows: for the folded banners over an open ticket on a phone. */
export function updateLine(s: UpdateStatus): string | null {
  const state = s.progress.state;
  if (RUNNING.includes(state)) return `Updating to ${s.progress.to}`;
  if (state === 'done') return `On ${s.current} now`;
  if (state === 'failed') return 'Update needs you';
  if (!s.newer || !s.latest || s.later === s.latest) return null;
  return `${s.latest} is ready`;
}

/** The slot at the top of Home and of every project page. */
export function AppUpdate() {
  const { data: s } = useUpdate();
  if (!s) return null;
  const state = s.progress.state;
  if (RUNNING.includes(state)) return <Updating s={s} />;
  if (state === 'done') return <Updated s={s} />;
  if (state === 'failed') return <UpdateFailed s={s} />;
  if (!s.newer || !s.latest || s.later === s.latest) return null;
  return <UpdateReady s={s} />;
}

function UpdateReady({ s }: { s: UpdateStatus }) {
  const { pending, call } = useUpdateCall();
  // A source checkout, or a big new version: the person runs the command; squad-kit never installs it by itself.
  const byHand = s.devInstall || s.major;
  return (
    <section className="upd" aria-label="A new squad-kit">
      <span className="upd-ic">
        <ArrowUp size={16} />
      </span>
      <div className="upd-main">
        <b className="upd-title">squad-kit {s.latest} is ready</b>
        <Notes s={s} />
        <span className="upd-sub">
          {s.devInstall
            ? 'This squad-kit runs from its source folder, so it does not update itself. To use the new version, run:'
            : s.major
              ? `A big change from ${s.current}. Read what is new first, then run this in a terminal:`
              : `You have ${s.current}. Takes about a minute. Your tickets and work are kept.`}
        </span>
        {byHand && <CopyCommand text={s.command} />}
      </div>
      <div className="upd-acts">
        {!byHand && (
          <button className="btn sm pri" disabled={pending} onClick={() => void call('/api/v1/app/update', 'POST')}>
            <ArrowUp size={14} /> Update now
          </button>
        )}
        {(!(s.notes?.length || s.releases?.length) || byHand) && (
          <a className="btn sm" href={s.notesUrl} target="_blank" rel="noreferrer">
            What is new
          </a>
        )}
        <button className="btn sm" disabled={pending} onClick={() => void call('/api/v1/app/update', 'PUT', { later: s.latest })}>
          Later
        </button>
        {!byHand && <Cmd text="squad upgrade" />}
      </div>
    </section>
  );
}

/** The update's steps. They come from the app, so a reload, or the restart itself, shows the same place. */
function Updating({ s }: { s: UpdateStatus }) {
  const p = s.progress;
  const { pending, call } = useUpdateCall();
  const at = RUNNING.indexOf(p.state);
  const mark = (i: number) => (i < at ? 'done' : i === at ? 'now' : 'todo');
  const waited = p.now
    ? 'Stopped the running steps'
    : p.waitedFor?.length
      ? `Waited for ${names(p.waitedFor)} to finish ${p.waitedFor.length === 1 ? 'its step' : 'their steps'}`
      : 'No work was in the middle of a step';
  const busy = p.busy?.length ? `${names(p.busy)} ${p.busy.length === 1 ? 'is' : 'are'} in the middle of a step` : 'Almost there';
  const steps = [
    { label: at > 0 ? waited : 'Waiting for running work to reach a safe point', note: at === 0 ? busy : p.now ? 'They pick up again after the restart' : 'Nothing was cut off' },
    { label: at > 1 ? `Installed squad-kit ${p.to}` : `Installing squad-kit ${p.to}`, note: at === 1 ? 'Takes about a minute' : at > 1 ? 'Done' : 'Next' },
    { label: 'Restarting the app', note: at === 2 ? 'This page reloads on its own' : 'Same link, same tickets' },
    { label: 'Picking up where each ticket was', note: 'Nothing is lost' },
  ];
  return (
    <section className="upd steps" aria-label={`Updating to squad-kit ${p.to}`} aria-live="polite">
      <div className="upd-head">
        <b className="upd-title">Updating to squad-kit {p.to}</b>
        <span className="upd-sub">
          {p.state === 'waiting' ? 'squad-kit waits until no agent is in the middle of a step, so no work is cut off.' : 'Takes about a minute. Your tickets and work are kept.'}
        </span>
        {p.state === 'waiting' && (
          <span className="upd-acts">
            <button className="btn sm pri" disabled={pending} onClick={() => void call('/api/v1/app/update', 'POST', { now: true })} title="Running steps stop now and pick up again after the restart">
              Update now anyway
            </button>
            <button className="btn sm" disabled={pending} onClick={() => void call('/api/v1/app/update', 'DELETE')}>
              Not now
            </button>
          </span>
        )}
      </div>
      <ol className="setup-steps">
        {steps.map((st, i) => (
          <li key={st.label} className={mark(i)}>
            <span className="mark">{mark(i) === 'done' ? <Check size={12} strokeWidth={3} /> : mark(i) === 'now' ? <span className="live" /> : null}</span>
            <span className="txt">
              <b>{st.label}</b>
              <small title={st.note}>{st.note}</small>
            </span>
          </li>
        ))}
      </ol>
      <div className="setup-bar" aria-hidden>
        <i />
      </div>
    </section>
  );
}

/** After the restart: the new version, what carried on, and what is new. */
function Updated({ s }: { s: UpdateStatus }) {
  const { pending, call } = useUpdateCall();
  const carried = s.progress.carried ?? [];
  return (
    <section className="upd" aria-label={`You are on squad-kit ${s.current}`}>
      <span className="upd-ic ok">
        <Check size={16} strokeWidth={2.6} />
      </span>
      <div className="upd-main">
        <b className="upd-title">You are on squad-kit {s.current}</b>
        <span className="upd-sub">
          {carried.length ? `${names(carried)} carried on where ${carried.length === 1 ? 'it was' : 'they were'}. Nothing was lost.` : 'Your tickets and work are kept.'}
        </span>
        <Notes s={s} />
      </div>
      <div className="upd-acts">
        <a className="btn sm" href={s.notesUrl} target="_blank" rel="noreferrer">
          Read what is new
        </a>
        <button className="btn sm" disabled={pending} onClick={() => void call('/api/v1/app/update', 'DELETE')}>
          Close
        </button>
      </div>
    </section>
  );
}

/** The install needs permission or failed: the one command to copy, and Restart once it ran. */
function UpdateFailed({ s }: { s: UpdateStatus }) {
  const p = s.progress;
  const { pending, call } = useUpdateCall();
  return (
    <section className="upd failed" role="alert" aria-label="squad-kit could not update by itself">
      <span className="upd-ic">
        <Info size={16} />
      </span>
      <div className="upd-main">
        <b className="upd-title">Could not update by itself</b>
        <span className="upd-sub">
          {p.reason} {p.permission ? 'Run this once in a terminal, then press Restart:' : 'Try again, or run this in a terminal, then press Restart:'}
        </span>
        <CopyCommand text={s.command} />
        {p.output && (
          <details className="upd-out">
            <summary>What the installer said</summary>
            <pre>{p.output}</pre>
          </details>
        )}
      </div>
      <div className="upd-acts">
        <button className="btn sm pri" disabled={pending} onClick={() => void call('/api/v1/app/update/restart', 'POST')}>
          <RefreshCw size={14} /> Restart
        </button>
        {!p.permission && (
          <button className="btn sm" disabled={pending} onClick={() => void call('/api/v1/app/update', 'POST')}>
            Try again
          </button>
        )}
        <button className="btn sm" disabled={pending} onClick={() => void call('/api/v1/app/update', 'DELETE')}>
          Not now
        </button>
      </div>
    </section>
  );
}

/** Settings › About: the version, the last check, the daily check, and the ways to update. */
export function AboutUpdates() {
  const { data: s } = useUpdate();
  const { pending, call } = useUpdateCall();
  const { toast } = usePrefs();
  if (!s) return null;
  const check = async () => {
    const r = await call('/api/v1/app/update/check', 'POST');
    if (!r) return;
    if (r.checkError) toast(r.checkError, 'err');
    else toast(r.newer ? `squad-kit ${r.latest} is ready` : `You are on the latest version (${r.current})`);
  };
  const canUpdate = s.newer && !s.devInstall && !s.major && s.progress.state === 'idle';
  return (
    <div className="about">
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Version</b>
        <span className="about-row">
          <b>{s.current}</b>
          {s.newer ? <span className="pill you">{s.latest} is ready</span> : s.checkedAt && !s.checkError ? <span className="pill ok">Up to date</span> : null}
          {s.devInstall && <span className="pill">Source folder</span>}
        </span>
      </div>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Last checked</b>
        <span className="about-row">
          {s.checkedAt ? when(s.checkedAt) : 'Not yet'}
          {s.checkError && <span className="note bad">{s.checkError}</span>}
        </span>
      </div>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Updates</b>
        <span className="about-row">
          <label className="about-daily">
            <input type="checkbox" checked={s.daily} disabled={pending} onChange={(e) => void call('/api/v1/app/update', 'PUT', { daily: e.target.checked })} />
            Check for updates every day
          </label>
          <span className="note">Turn it off on a network without internet.</span>
        </span>
      </div>
      <div className="about-acts">
        <button className="btn sm" disabled={pending} onClick={() => void check()}>
          {pending ? 'Checking…' : 'Check for updates'}
        </button>
        <a className="btn sm" href={s.notesUrl} target="_blank" rel="noreferrer">
          Release notes
        </a>
        {canUpdate && (
          <button className="btn sm pri" disabled={pending} onClick={() => void call('/api/v1/app/update', 'POST')}>
            <ArrowUp size={14} /> Update to {s.latest}
          </button>
        )}
        <span className="grow" />
        <Cmd text="squad upgrade" />
      </div>
      {s.newer && (s.devInstall || s.major) && <CopyCommand text={s.command} />}
    </div>
  );
}

/** Home has no Settings page: its About opens here. */
export function AboutButton() {
  const { data: s } = useUpdate();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title="Version and updates">
        {s ? `squad-kit ${s.current}` : 'About'}
        {s?.newer && <span className="about-dot" aria-label={`${s.latest} is ready`} />}
      </button>
      {open && (
        <Modal title="About squad-kit" onClose={() => setOpen(false)}>
          <AboutUpdates />
        </Modal>
      )}
    </>
  );
}

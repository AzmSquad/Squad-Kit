import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, CornerLeftUp, Folder, FolderCheck, FolderGit2, FolderPlus, Moon, Plus, Sun } from 'lucide-react';
import { api, send } from '../api/client';
import type { AppProject, AppProjects, AppSettings, AppWaiting, FolderListing } from '../api/types';
import { usePrefs } from '../lib/prefs';
import { shellArg, shellQuote } from '../lib/text';
import { Cmd, Modal, STAGE_NAME, actionLabel, ago, commandFor, outdatedLine } from '../components/ui';
import { AboutButton, AppUpdate } from '../components/Update';
import { LimitBanner } from '../components/UsageLimit';
import { SaveTroubleBanner } from '../components/SaveTrouble';
import { HomeWaiting } from '../components/Waiting';
import { BreakdownWaitCard, useAllBreakdownWaits } from '../components/BreakdownWaits';
import { changeWaits, openChange, testChangeLine, testChangeWaits } from '../lib/waiting';

/**
 * Home of the one app (ADR-001): one Waiting for you list across every project, then the projects, and Add project
 * with a folder browser. A project's board opens at its own address, /p/<project id>/board.
 */

const LIVE_MS = 2000;

/** The app's paths for one project's pages. Another project is another page load, so its board starts fresh. */
const boardOf = (id: string) => `/p/${encodeURIComponent(id)}`;

/** The same command a project's board shows, naming the project, for a terminal in any folder. */
function forProject(command: string, name: string): string {
  const ref = shellArg(name);
  return command.replace(/\bsquad ([a-z-]+) (\S+)/g, (_m, verb: string, arg: string) => `squad ${verb} ${arg} --project ${ref}`);
}

function tilde(p: string, home?: string): string {
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function HomePage() {
  const { theme, toggleTheme } = usePrefs();
  const projects = useQuery({ queryKey: ['app', 'projects'], queryFn: () => api<AppProjects>('/api/v1/app/projects'), refetchInterval: LIVE_MS });
  const waiting = useQuery({ queryKey: ['app', 'waiting'], queryFn: () => api<AppWaiting>('/api/v1/app/waiting'), refetchInterval: LIVE_MS });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AppProject | null>(null);
  const list = projects.data?.projects ?? [];
  const items = waiting.data?.items ?? [];
  // Breakdowns whose Analyst has questions, in every project: the same cards a project's Waiting for you shows.
  const breakdowns = useAllBreakdownWaits();
  const count = items.length + breakdowns.length;

  return (
    <div className="home">
      <header className="home-top">
        <img src="/logo.svg" alt="" />
        <b>squad-kit</b>
        <span className="grow" />
        {projects.data && <Shared s={projects.data} />}
        <AboutButton />
        <button className="theme" onClick={toggleTheme} aria-label={theme === 'light' ? 'Switch to dark' : 'Switch to light'}>
          {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
        </button>
      </header>
      <AppUpdate />
      <SaveTroubleBanner />
      <LimitBanner />
      <HomeWaiting />
      <div className="scroll">
        <div className="page home-page">
          <section className="home-projects">
            <div className="home-h">
              <h2>Projects</h2>
              <span className="grow" />
              <Cmd text="squad projects" />
              <button className="btn pri" onClick={() => setAdding(true)}>
                <Plus size={15} /> Add project
              </button>
            </div>
            {projects.isLoading ? null : list.length === 0 ? (
              <button className="home-empty" onClick={() => setAdding(true)}>
                <FolderPlus size={22} />
                <b>Add your first project</b>
                <span>Pick its folder: one repo, a folder with several repos, or a new, empty folder for a new project.</span>
              </button>
            ) : (
              <div className="pcards">
                {list.map((p) => (
                  <ProjectCard key={p.id} p={p} onRemove={() => setRemoving(p)} />
                ))}
              </div>
            )}
          </section>
          <section className="home-inbox" id="waiting">
            <div className="home-h">
              <h2>Waiting for you</h2>
              {count > 0 && <span className="badge you">{count}</span>}
              <span className="grow" />
              <Cmd text="squad inbox" />
            </div>
            {count === 0 ? (
              <div className="calm">
                <span className="ring"><Check size={18} strokeWidth={2.5} /></span>
                <div>
                  <b>Nothing needs you right now</b>
                  <span>{list.length ? 'The squads are working. Questions, plans, proof and decisions from every project land here.' : 'Add a project to start.'}</span>
                </div>
              </div>
            ) : (
              <div className="home-waiting">
                {breakdowns.map((w) => (
                  <BreakdownWaitCard key={`${w.project?.id ?? ''}/${w.id}`} w={w} />
                ))}
                {items.map(({ project, ticket: t }) => (
                  <div key={`${project.id}/${t.id}`} className="wcard">
                    <div className="grow">
                      <div className="meta">
                        <span className="pill sm">{project.name}</span>
                        <span className="id">{t.id}</span>
                        <span>{STAGE_NAME[t.stage]}</span>
                        <span>{ago(t.activity[0]?.at ?? t.createdAt)}</span>
                      </div>
                      <h3>{t.title}</h3>
                      <p>{t.waiting?.summary ?? (changeWaits(t) ? `Change ${openChange(t)!.id} to the spec waits for you` : testChangeWaits(t) ? testChangeLine(t) : t.outdated?.length ? outdatedLine(t) : `Looks stuck: ${t.quiet?.detail ?? ''}`)}</p>
                    </div>
                    <Cmd text={forProject(commandFor(t), project.name)} />
                    <a
                      className="btn pri sm"
                      href={t.waiting?.kind === 'proof' ? `${boardOf(project.id)}/tickets/${encodeURIComponent(t.id)}/proof` : `${boardOf(project.id)}/board?ticket=${encodeURIComponent(t.id)}`}
                    >
                      {t.waiting ? actionLabel(t) : 'Check it'}
                    </a>
                  </div>
                ))}
              </div>
            )}
          </section>

        </div>
      </div>
      {adding && <AddProject onClose={() => setAdding(false)} />}
      {removing && <RemoveProject p={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

/** The tickets running at once are shared by every project, because they use the same AI accounts. */
function Shared({ s }: { s: AppSettings }) {
  const qc = useQueryClient();
  const { toast } = usePrefs();
  const pick = async (n: number) => {
    try {
      await send('/api/v1/app/settings', 'PUT', { parallel: n });
      void qc.invalidateQueries({ queryKey: ['app'] });
      toast(`Up to ${n} tickets at once, across all projects`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  };
  return (
    <label className="shared" title="Shared by all your projects, because they use the same AI accounts">
      <span>
        Tickets at once: <b>{s.running}</b> of
      </span>
      <select className="select sm" value={s.parallel} onChange={(e) => void pick(Number(e.target.value))} aria-label="Tickets at once, across all projects">
        {Array.from({ length: s.max }, (_, i) => i + 1).map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProjectCard({ p, onRemove }: { p: AppProject; onRemove(): void }) {
  const qc = useQueryClient();
  const { toast } = usePrefs();
  const [busy, setBusy] = useState(false);
  const setup = p.setup && p.setup.status !== 'done' ? p.setup : null;
  // A project that could not open: open it again once what stopped it is fixed.
  const retry = async () => {
    setBusy(true);
    try {
      await send('/api/v1/app/projects', 'POST', { folder: p.root });
      toast(`${p.name} is open`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['app'] });
    }
  };
  const state = !p.open ? (
    <span className="bad">Could not open: {p.why}</span>
  ) : p.setup?.ready && !p.setup.approved ? (
    <span className="you">{p.setup.line ?? 'Your project overview is ready to check'}</span>
  ) : p.setup?.line && !p.setup.approved ? (
    <span className={p.setup.status === 'failed' ? 'bad' : 'you'}>{p.setup.line}</span>
  ) : setup?.status === 'failed' ? (
    <span className="bad">The Architect could not read the project</span>
  ) : setup ? (
    <span className="you">Setting up: {setup.status === 'running' ? (setup.now ?? 'the Architect reads the project') : 'the Architect reads the project next'}</span>
  ) : (
    <span>
      {p.tickets} open
      {p.working > 0 && <> · {p.working} working</>}
      {p.waiting > 0 && <span className="you"> · {p.waiting} waiting for you</span>}
    </span>
  );
  return (
    <div className={`pcard ${p.open ? '' : 'off'}`}>
      <span className="pm">{p.name.charAt(0).toUpperCase()}</span>
      <div className="grow">
        <b>
          {p.name}
          {p.engine === 'demo' && <small className="demo">Demo</small>}
        </b>
        <span className="mono path" title={p.root}>{p.root}</span>
        <span className="state">{state}</span>
      </div>
      <div className="acts">
        {p.open ? (
          <a className="btn sm pri" href={p.setup?.line && !p.setup.approved ? p.url.replace(/\/board$/, p.setup.ready ? '/overview' : '/setup') : p.url}>
            {p.setup?.line && !p.setup.approved ? (p.setup.ready ? 'Check it' : 'See the setup') : 'Open board'}
          </a>
        ) : (
          <button className="btn sm" disabled={busy} onClick={() => void retry()}>
            Try again
          </button>
        )}
        <button className="btn sm quiet" onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

/** The other kinds of folder, said in a line each under what squad-kit found here. */
const ALSO: { kind: FolderListing['kind']; name: string; text: string }[] = [
  { kind: 'empty', name: 'An empty folder', text: 'Start from an idea: squad-kit asks what you want to build.' },
  { kind: 'older', name: 'An older squad-kit', text: 'Your specs, plans and decisions stay where they are. squad-kit adds its own files beside them.' },
  { kind: 'repos', name: 'Several repos', text: 'squad-kit reads each one and shows you how they fit together.' },
];

/** What squad-kit found in the folder, and what happens once the person adds it. */
function Found({ l }: { l: FolderListing }) {
  const look = l.look;
  if (!look) return null;
  return (
    <div className="ob-found" aria-live="polite">
      <div className="ob-found-c">
        <b>{look.title}</b>
        <div>{look.found}</div>
        <div>{look.next}</div>
        <div className="note">{look.safe}</div>
      </div>
      <div className="ob-also">
        <div className="ob-k">squad-kit also handles</div>
        {ALSO.filter((a) => a.kind !== look.kind)
          .slice(0, 2)
          .map((a) => (
            <div key={a.kind} className="ob-also-r">
              <b>{a.name}</b>
              <span>{a.text}</span>
            </div>
          ))}
      </div>
      <div className="note">{look.takes}</div>
    </div>
  );
}

/** Add project: the app lists folders itself, because a page cannot read a real folder path. Starts at home. */
function AddProject({ onClose }: { onClose(): void }) {
  const [at, setAt] = useState<string>('');
  const [newName, setNewName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listing = useQuery({
    queryKey: ['app', 'folders', at],
    queryFn: () => api<FolderListing>(`/api/v1/app/folders${at ? `?path=${encodeURIComponent(at)}` : ''}`),
  });
  const l = listing.data;
  // After a folder that cannot be read, Up still leads somewhere: the folder above the one asked for.
  const parentOf = (p: string) => p.replace(/[/\\][^/\\]+[/\\]?$/, '') || '/';
  const up = l?.parent ?? (listing.isError && at ? parentOf(at) : null);
  const go = (p: string) => {
    setError(null);
    setNewName(null);
    setAt(p);
  };

  const add = async () => {
    if (!l) return;
    setBusy(true);
    setError(null);
    try {
      const res = await send<AppProject & { did: string[] }>('/api/v1/app/projects', 'POST', { folder: l.path });
      // A new project lands on its setup page, where squad-kit gets to know it step by step.
      const setup = res.setup && !res.setup.ready && !res.setup.approved && res.setup.line;
      window.location.assign(setup ? res.url.replace(/\/board$/, '/setup') : res.url);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const makeFolder = async () => {
    if (!l || !newName?.trim()) return;
    try {
      const made = await send<FolderListing>('/api/v1/app/folders', 'POST', { parent: l.path, name: newName.trim() });
      go(made.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const crumbs = l ? crumbsOf(l.path) : [];
  return (
    <Modal
      title="Add a project"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn pri" disabled={!l?.canAdd || busy || listing.isFetching} onClick={() => void add()}>
            {busy ? 'Adding…' : l?.kind === 'project' ? 'Open it' : 'Add and get to know it'}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          {l && <Cmd text={`cd ${shellQuote(l.path)} && squad console`} />}
        </>
      }
    >
      <p className="note">Pick the project's folder: one repo, a folder with several repos, or a new, empty folder for a new project.</p>
      {l && (
        <div className="places">
          {l.places.map((p) => (
            <button key={p.path} className={`btn sm ${p.path === l.path ? 'pri' : ''}`} onClick={() => go(p.path)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="fb">
        <div className="fb-bar">
          <button className="iconbtn" disabled={!up} onClick={() => up && go(up)} aria-label="Up one folder" title="Up one folder">
            <CornerLeftUp size={15} />
          </button>
          <span className="crumbs mono">
            {crumbs.map((c, i) => (
              <span key={c.path}>
                {i > 0 && <ChevronRight size={12} />}
                <button onClick={() => go(c.path)}>{c.name}</button>
              </span>
            ))}
          </span>
        </div>
        <div className="fb-list" role="list">
          {listing.isError && <p className="note bad">{(listing.error as Error).message}</p>}
          {l && l.folders.length === 0 && <p className="note">No folders inside.</p>}
          {l?.folders.map((f) => (
            <button key={f.path} role="listitem" className="fb-row" onClick={() => go(f.path)}>
              {f.kind === 'project' ? <FolderCheck size={16} /> : f.kind === 'repo' ? <FolderGit2 size={16} /> : <Folder size={16} />}
              <span className="nm">{f.name}</span>
              {f.kind === 'project' && <span className="pill ok sm">squad-kit project</span>}
              {f.kind === 'repo' && <span className="pill sm">code repo</span>}
            </button>
          ))}
        </div>
        <div className="fb-new">
          {newName === null ? (
            <button className="btn sm" disabled={!l} onClick={() => setNewName('')}>
              <FolderPlus size={14} /> New folder here
            </button>
          ) : (
            <>
              <input
                className="input"
                autoFocus
                placeholder="Name of the new folder"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void makeFolder()}
              />
              <button className="btn sm pri" disabled={!newName.trim()} onClick={() => void makeFolder()}>
                Make it
              </button>
              <button className="btn sm" onClick={() => setNewName(null)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
      {l && (
        <p className="fb-kind">
          <b>{tilde(l.path, l.home)}</b>
          {!l.canAdd && <span>This folder can't be a project. Open a folder inside it, or make a new one here.</span>}
        </p>
      )}
      {l?.canAdd && <Found l={l} />}
      {error && <p className="fb-error">{error}</p>}
    </Modal>
  );
}

function crumbsOf(p: string): { name: string; path: string }[] {
  const parts = p.split('/').filter(Boolean);
  return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))];
}

function RemoveProject({ p, onClose }: { p: AppProject; onClose(): void }) {
  const qc = useQueryClient();
  const { toast } = usePrefs();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await send(`/api/v1/app/projects/${encodeURIComponent(p.id)}`, 'DELETE');
      void qc.invalidateQueries({ queryKey: ['app'] });
      toast(`${p.name} is out of squad-kit. Its files stay in its folder.`);
      onClose();
    } catch (err) {
      setBusy(false);
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  };
  const ref = /\s/.test(p.name) ? `"${p.name}"` : p.name;
  return (
    <Modal
      title={`Take ${p.name} out of squad-kit?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" disabled={busy} onClick={() => void remove()}>
            Take it out
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <Cmd text={`squad projects --remove ${ref}`} />
        </>
      }
    >
      <p>Its squad stops. Nothing is deleted: its files stay in <span className="mono">{p.root}</span>. Add it again any time.</p>
    </Modal>
  );
}

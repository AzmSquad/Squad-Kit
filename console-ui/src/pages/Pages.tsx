import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Bug, Check, RotateCcw } from 'lucide-react';
import type { ProjectCommands, RepoInfo } from '../api/types';
import { useAct, useAppSettings, useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { BugDialog } from '../components/dialogs';
import { useRestart } from '../components/Restart';
import { AboutUpdates } from '../components/Update';
import { HelpRow } from '../components/Report';
import { PaymentSettings } from '../components/Usage';
import { GuardAllows } from '../components/Sandbox';
import { PartsSettings } from '../components/Parts';
import { ProjectFiles } from '../components/ProjectFiles';
import { DatabaseSettings } from '../components/Database';
import { TrackerSettings } from '../components/TrackerSettings';
import { Cmd, CouldNotLoad, Modal, Runs, STAGE_NAME, Written, actionLabel, ago, commandFor, outdatedLine } from '../components/ui';
import { changeWaits, openChange } from '../components/ChangeCard';
import { NoticeSetting } from '../components/Waiting';
import { needsYou, testChangeLine, testChangeWaits } from '../lib/waiting';
import { BreakdownWaitCard, WaitStopTag, useBreakdownWaits } from '../components/BreakdownWaits';
import { stopKind } from '../lib/auto';
import { langProps } from '../lib/lang';
import { AskLeadAbout } from '../components/LeadAsk';

/* ── Waiting for you ───────────────────────────────────── */

export function InboxPage() {
  const board = useBoard();
  const tickets = board.data?.ready ? board.data.tickets.filter(needsYou) : [];
  const breakdowns = useBreakdownWaits();
  return (
    <>
      <div className="top">
        <h1>Waiting for you</h1>
        <span className="grow" />
        <Cmd text="squad inbox" />
      </div>
      <div className="scroll">
        <div className="page">
          {board.isError && !board.data ? (
            <CouldNotLoad what="what waits for you" error={board.error} onRetry={() => void board.refetch()} />
          ) : tickets.length + breakdowns.length === 0 ? (
            <div className="calm">
              <span className="ring"><Check size={18} strokeWidth={2.5} /></span>
              <div>
                <b>Nothing needs you right now</b>
                <span>The squad is working. Questions, plans, proof and decisions land here.</span>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {breakdowns.map((w) => (
                <BreakdownWaitCard key={w.id} w={w} />
              ))}
              {tickets.map((t) => (
                <div key={t.id} className="wcard" style={{ padding: '16px 18px 16px 22px' }}>
                  <div className="grow">
                    <div className="meta">
                      <span className="id">{t.id}</span>
                      <WaitStopTag t={t} />
                      <span>{STAGE_NAME[t.stage]}</span>
                      <span>{ago(t.activity[0]?.at ?? t.createdAt)}</span>
                    </div>
                    <Written as="h3" text={t.title} />
                    <Written as="p" text={stopKind(t) && t.agentQuestion ? `“${t.agentQuestion.text}”` : t.waiting?.summary ?? (changeWaits(t) ? `Change ${openChange(t)!.id} to the spec waits for you` : testChangeWaits(t) ? testChangeLine(t) : t.outdated?.length ? outdatedLine(t) : `Looks stuck: ${t.quiet?.detail ?? 'no progress'}`)} />
                  </div>
                  <Cmd text={!t.waiting && changeWaits(t) ? `squad propose ${t.id} --approve` : !t.waiting && testChangeWaits(t) ? `squad test-command ${t.id} --use` : commandFor(t)} />
                  <AskLeadAbout t={t} problem={t.waiting?.kind === 'stuck' ? 'error' : !t.waiting && t.quiet ? (t.quiet.kind === 'long' ? 'slow' : 'stuck') : 'waiting'} className="btn sm" />
                  {t.waiting?.kind === 'proof' ? (
                    <Link to="/tickets/$id/proof" params={{ id: t.id }} className="btn pri sm">{actionLabel(t)}</Link>
                  ) : (
                    <Link to="/board" search={{ ticket: t.id }} className="btn pri sm">{t.waiting ? actionLabel(t) : changeWaits(t) ? 'Check the change' : 'Check it'}</Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ── Bugs ──────────────────────────────────────────────── */

export function BugsPage() {
  const board = useBoard();
  const [open, setOpen] = useState(false);
  const bugs = board.data?.ready ? board.data.tickets.filter((t) => t.kind === 'bug') : [];
  return (
    <>
      <div className="top">
        <h1>Bugs</h1>
        <span className="grow" />
        <Cmd text='squad bug "What happened"' />
        <button className="btn pri" onClick={() => setOpen(true)}>
          <Bug size={15} /> Report a bug
        </button>
      </div>
      <div className="scroll">
        <div className="page">
          <p className="note" style={{ marginBottom: 12 }}>Each bug is a ticket linked to the release it was found in. It goes around the same loop, and the Tester adds a check so it can't come back.</p>
          {bugs.length === 0 ? (
            <p className="note">No open bugs.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>ID</th>
                  <th>What happened</th>
                  <th style={{ width: 120 }}>Found in</th>
                  <th style={{ width: 120 }}>Stage</th>
                  <th style={{ width: 240 }}>Now</th>
                </tr>
              </thead>
              <tbody>
                {bugs.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{t.id}</td>
                    <td {...langProps(t.title)}>
                      <Link to="/board" search={{ ticket: t.id }} style={{ fontWeight: 600 }}><Runs text={t.title} dir={langProps(t.title).dir} /></Link>
                    </td>
                    <td>{t.foundIn ?? ''}</td>
                    <td>{STAGE_NAME[t.stage]}</td>
                    <td style={{ color: t.waiting ? 'var(--you-ink)' : 'var(--muted)' }} {...langProps(t.waiting?.summary ?? t.status)}><Runs text={t.waiting?.summary ?? t.status} dir={langProps(t.waiting?.summary ?? t.status).dir} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {open && <BugDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/* ── Settings ──────────────────────────────────────────── */

const COMMAND_FIELDS: { key: keyof ProjectCommands; label: string; hint: string }[] = [
  { key: 'setup', label: 'Set up', hint: 'Installs what the project needs, e.g. npm install' },
  { key: 'test', label: 'Test', hint: 'Runs the tests, e.g. npm test' },
  { key: 'lint', label: 'Lint', hint: 'Checks code style, e.g. npm run lint' },
  { key: 'build', label: 'Build', hint: 'Builds the project, e.g. npm run build' },
  { key: 'start', label: 'Start', hint: 'Runs the app for screenshots, e.g. npm start' },
  { key: 'url', label: 'App address', hint: 'Where the app opens, e.g. http://localhost:3000' },
  { key: 'envFile', label: 'Env file', hint: 'Settings the app reads on this computer, e.g. .env.dev' },
  { key: 'deploy', label: 'After a release', hint: 'Runs after a release, e.g. az pipelines run …' },
];

function ProjectSettings() {
  const board = useBoard();
  const meta = board.data?.ready ? board.data.meta : undefined;
  if (!meta) return null;
  const repos = meta.repos?.length
    ? meta.repos
    : [{ path: '.', base: meta.git?.base ?? 'main', remote: meta.git?.remote ?? '', commands: meta.commands ?? {} }];
  const multi = Boolean(meta.repos?.length);
  return (
    <>
      <PartsSettings />
      <ProjectFiles />
      {meta.engine === 'live' && <DatabaseSettings />}
      <h2 style={{ marginTop: 6 }}>How the squad checks and runs this project</h2>
      <p className="note" style={{ margin: '2px 0 10px' }}>
        The Architect filled these in when it read the project. squad-kit runs Test, Lint and Build itself before anything ships.
        {multi && ' This project has several code folders; each ticket works in one of them.'}
      </p>
      <NewTestsSetting always={Boolean(meta.alwaysNewTests)} />
      <PhoneSetting phone={meta.phone} />
      {repos.map((r) => (
        <RepoSettings key={r.path} repo={r} multi={multi} />
      ))}
      <ScanAgain />
    </>
  );
}

function RepoSettings({ repo, multi }: { repo: RepoInfo; multi: boolean }) {
  const act = useAct();
  const [commands, setCommands] = useState<ProjectCommands | null>(null);
  const [git, setGit] = useState<{ base: string; remote: string } | null>(null);
  const current = commands ?? repo.commands;
  const gitNow = git ?? { base: repo.base, remote: repo.remote };
  const save = () => {
    const body = multi ? { repos: [{ path: repo.path, ...gitNow, commands: current }] } : { commands: current, git: gitNow };
    act.mutate(
      { path: '/api/v1/settings', method: 'PUT', body, done: 'Settings saved' },
      {
        onSuccess: () => {
          setCommands(null);
          setGit(null);
        },
      },
    );
  };
  return (
    <div style={{ marginBottom: 24 }}>
      {multi && (
        <h3 className="mono" style={{ fontSize: 14, margin: '18px 0 2px' }}>
          {repo.path}
          {repo.summary && <Written className="note" style={{ fontFamily: 'inherit', marginLeft: 8 }} text={repo.summary} />}
        </h3>
      )}
      {COMMAND_FIELDS.map((f) => {
        const input = (
          <input
            className="input mono"
            style={{ fontSize: 13 }}
            value={current[f.key] ?? ''}
            placeholder={f.hint}
            onChange={(e) => setCommands({ ...current, [f.key]: e.target.value })}
          />
        );
        return (
          <div className="maprow" key={f.key} style={{ alignItems: 'center' }}>
            <b>{f.label}</b>
            {f.key === 'start' ? (
              <div>
                {input}
                <StartNote repo={repo.path} command={current.start} />
              </div>
            ) : f.key === 'envFile' ? (
              <div>
                {input}
                <EnvFileNote repo={multi ? repo.path : undefined} file={current.envFile} />
              </div>
            ) : (
              input
            )}
          </div>
        );
      })}
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Release branch</b>
        <input className="input mono" style={{ fontSize: 13 }} value={gitNow.base} onChange={(e) => setGit({ ...gitNow, base: e.target.value })} />
      </div>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Push to</b>
        <input className="input mono" style={{ fontSize: 13 }} value={gitNow.remote} placeholder="origin (empty: no push)" onChange={(e) => setGit({ ...gitNow, remote: e.target.value })} />
      </div>
      <div style={{ marginTop: 12 }}>
        <button className="btn pri sm" disabled={!commands && !git} onClick={save}>
          Save{multi ? ` ${repo.path}` : ''}
        </button>
      </div>
    </div>
  );
}

/**
 * Beside the env file: what squad-kit does with it, and its terminal command. Only the path is shown; the values never
 * pass through the board.
 */
function EnvFileNote({ repo, file }: { repo?: string; file?: string }) {
  return (
    <p className="note" style={{ margin: '6px 0 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>
        squad-kit gives its values to every command it runs for this part on this computer, then its own database, Redis and port on top. A file git
        does not carry needs values for stories: add it under Local files.
      </span>
      <Cmd text={`squad config set env-file ${file?.trim() || '.env.dev'}${repo ? ` --repo ${repo}` : ''}`} />
    </p>
  );
}

/**
 * Beside a start command that opens a window, as typed: the start squad-kit runs instead, without one. The engine says
 * which (GET /api/v1/settings/start); asked a moment after the typing stops.
 */
function StartNote({ repo, command }: { repo: string; command?: string }) {
  const typed = command?.trim() ?? '';
  const [asked, setAsked] = useState(typed);
  useEffect(() => {
    const t = setTimeout(() => setAsked(typed), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const q = useQuery({
    queryKey: ['start-note', repo, asked],
    queryFn: () => api<{ note: string | null }>(`/api/v1/settings/start?repo=${encodeURIComponent(repo)}&command=${encodeURIComponent(asked)}`),
    enabled: Boolean(asked),
    placeholderData: (before) => before,
  });
  const note = typed && asked ? q.data?.note : null;
  return note ? (
    <p className="note" style={{ margin: '6px 0 0' }}>
      {note}
    </p>
  ) : null;
}

/** Voice and video notes need speech to text. The key stays in .squad/secrets.yaml on this computer. */
export function SpeechSettings() {
  const act = useAct<{ unchecked?: boolean }>();
  const status = useQuery({ queryKey: ['speech'], queryFn: () => api<{ hasKey: boolean; video?: boolean }>('/api/v1/speech') });
  const [key, setKey] = useState('');
  const hasKey = status.data?.hasKey;
  // This computer: a video's sound and pictures can only be taken out on a Mac for now.
  const video = status.data?.video !== false;
  const save = (body: { munsit?: string; remove?: boolean }, done: string) =>
    act.mutate(
      { path: '/api/v1/speech', method: 'PUT', body, done: (r) => (r.unchecked ? 'Saved. squad-kit could not reach Munsit to check the key, so it finds out with the first note.' : done) },
      { onSuccess: () => { setKey(''); void status.refetch(); } },
    );
  return (
    <div style={{ marginBottom: 26 }}>
      <h2 style={{ marginTop: 6 }}>Speech to text</h2>
      <p className="note" style={{ margin: '2px 0 10px' }}>
        {video
          ? 'Agents cannot listen. With a Munsit key, squad-kit writes out every voice and video note you attach, in Arabic or English, and takes pictures of the screen in videos.'
          : 'Agents cannot listen. With a Munsit key, squad-kit writes out every voice note you attach, in Arabic or English. Video notes need a Mac: on this computer they stay attached, and nobody hears them.'}{' '}
        Without a key, notes stay attached but nobody hears them. Your key stays on this computer.
      </p>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Status</b>
        <span>{hasKey ? <span className="pill ok">Munsit is set up</span> : <span className="pill wait">Not set up</span>}</span>
      </div>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Munsit key</b>
        <input
          className="input mono"
          style={{ fontSize: 13 }}
          type="password"
          autoComplete="off"
          value={key}
          placeholder={hasKey ? 'Saved. Paste a new one to replace it' : 'API key from munsit.com'}
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn pri sm" disabled={!key.trim() || act.isPending} onClick={() => save({ munsit: key }, 'Munsit is set up')}>
          Save
        </button>
        {hasKey && (
          <button className="btn sm" disabled={act.isPending} onClick={() => save({ remove: true }, 'Munsit key removed')}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function RestartRow() {
  const { restarting, restart } = useRestart();
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>Board</b>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn sm" disabled={restarting} onClick={() => void restart()}>
          {restarting ? 'Restarting…' : 'Restart the board'}
        </button>
        <span className="note">Same link. Running work picks up where it stopped.</span>
        <Cmd text="squad console --restart" />
      </span>
    </div>
  );
}

export function RunnerSetting() {
  const board = useBoard();
  const act = useAct();
  const meta = board.data?.ready ? board.data.meta : undefined;
  if (!meta) return null;
  const runner = meta.runner ?? 'acp';
  const pick = (r: 'acp' | 'direct', done: string) => act.mutate({ path: '/api/v1/settings', method: 'PUT', body: { runner: r }, done });
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>Talk to Claude</b>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className={`btn sm ${runner === 'acp' ? 'pri' : ''}`} onClick={() => pick('acp', 'The squad talks to Claude the usual way')}>
          The usual way
        </button>
        <button className={`btn sm ${runner === 'direct' ? 'pri' : ''}`} onClick={() => pick('direct', 'The squad runs Claude Code directly')}>
          Directly
        </button>
        <span className="note" style={{ marginLeft: 6 }}>Leave this on The usual way. If that cannot start, a step runs Claude Code directly by itself.</span>
      </span>
    </div>
  );
}

/** One number for every project in the app: they all use the same AI accounts. */
function ParallelSetting() {
  const shared = useAppSettings();
  const act = useAct();
  const s = shared.data;
  if (!s) return null;
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>Tickets at once</b>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {Array.from({ length: s.max }, (_, i) => i + 1).map((k) => (
          <button key={k} className={`btn sm ${k === s.parallel ? 'pri' : ''}`} onClick={() => act.mutate({ path: '/api/v1/app/settings', method: 'PUT', body: { parallel: k }, done: `Up to ${k} tickets at once, across all your projects` })}>
            {k}
          </button>
        ))}
        <span className="note" style={{ marginLeft: 6 }}>How many tickets the squads work on at the same time, across all your projects. They share your AI accounts.</span>
      </span>
    </div>
  );
}

/** Whether squad-kit commits the project's documents with each ticket's code, so they travel with the branch. */
function DocsInGitSetting({ on, locked }: { on: boolean; locked?: string }) {
  const act = useAct();
  // squad-kit's own code keeps them off: the switch says why instead of changing nothing.
  if (locked) {
    return (
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Project documents in git</b>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn sm" disabled>
            Off
          </button>
          <span className="note">{locked}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>Project documents in git</b>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn sm"
          onClick={() =>
            act.mutate({
              path: '/api/v1/settings',
              method: 'PUT',
              body: { documentsInGit: !on },
              done: on ? 'Project documents stay out of git' : 'Project documents go into git with each ticket',
            })
          }
        >
          {on ? 'On: turn it off' : 'Off: turn it on'}
        </button>
        <span className="note">
          On: each ticket's spec, design and decisions are committed with its code, so they reach the team through the pull request. Hand over
          needs it on.
        </span>
      </span>
    </div>
  );
}

/** Whether a new story may be built without new tests, or every story writes them. Shared with the team through git. */
function NewTestsSetting({ always }: { always: boolean }) {
  const act = useAct();
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>New tests</b>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn sm"
          onClick={() =>
            act.mutate({
              path: '/api/v1/settings',
              method: 'PUT',
              body: { alwaysNewTests: !always },
              done: always ? 'Each new story can be built without new tests again' : 'Every new story writes new tests now',
            })
          }
        >
          {always ? 'Always: let each story choose' : 'Each story chooses: make it always'}
        </button>
        <span className="note">
          {always
            ? 'Every story writes new tests, so the new story form has no "Write new tests" switch.'
            : 'The new story form has a "Write new tests" switch, on by default. Turned off, the Builder writes no new tests; the checks, the review and the proof still run.'}{' '}
          Saved in the project's settings, for the whole team.
        </span>
        <Cmd text={`squad config set new-tests ${always ? 'switch' : 'always'}`} />
      </span>
    </div>
  );
}

/** The phone an app for both iPhone and Android uses for its pictures, Start and Try it yourself. */
function PhoneSetting({ phone }: { phone?: 'iphone' | 'android' }) {
  const act = useAct();
  const now = phone ?? 'auto';
  const choices = [
    { id: 'auto', label: 'Automatic' },
    { id: 'iphone', label: 'iPhone' },
    { id: 'android', label: 'Android' },
  ] as const;
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>Phone for pictures</b>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="seg" role="radiogroup" aria-label="Phone for pictures">
          {choices.map((c) => (
            <button
              key={c.id}
              role="radio"
              aria-checked={now === c.id}
              className={now === c.id ? 'on' : ''}
              onClick={() => now !== c.id && act.mutate({ path: '/api/v1/settings', method: 'PUT', body: { phone: c.id }, done: `Phone for pictures: ${c.label}` })}
            >
              {c.label}
            </button>
          ))}
        </span>
        <span className="note">
          For an app that builds for both iPhone and Android. Automatic uses the iPhone on a Mac when its tools are ready, else Android; a computer that is not a Mac
          always uses Android. Saved in the project's settings, for the whole team.
        </span>
        <Cmd text={`squad config set phone ${now === 'auto' ? 'android' : now === 'android' ? 'iphone' : 'auto'}`} />
      </span>
    </div>
  );
}

function ScanAgain() {
  const act = useAct();
  return (
    <div style={{ margin: '4px 0 26px' }}>
      <button className="btn sm" onClick={() => act.mutate({ path: '/api/v1/scan', done: 'The Architect is reading the project again' })}>
        Read the project again
      </button>
    </div>
  );
}

export function SettingsPage() {
  const board = useBoard();
  const { theme, toggleTheme, showCommands, toggleCommands } = usePrefs();
  const act = useAct();
  const [resetting, setResetting] = useState(false);
  const meta = board.data?.ready ? board.data.meta : undefined;
  const self = board.data?.ready ? board.data.self : undefined;
  return (
    <>
      <div className="top">
        <h1>Settings</h1>
      </div>
      <div className="scroll">
        <div className="page" style={{ maxWidth: 760 }}>
          <div className="maprow">
            <b>Theme</b>
            <span>
              <button className="btn sm" onClick={toggleTheme}>{theme === 'light' ? 'Switch to dark' : 'Switch to light'}</button>
            </span>
          </div>
          <div className="maprow">
            <b>Terminal commands</b>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn sm" onClick={toggleCommands}>{showCommands ? 'Hide them' : 'Show them'}</button>
              <span className="note">Every button shows the command that does the same thing.</span>
            </span>
          </div>
          <NoticeSetting />
          <div className="maprow">
            <b>Project files</b>
            <span className="note">
              <span className="mono" style={{ fontSize: 13 }}>.squad/</span> in the project folder: specs, decisions and releases, shared with the team. Live
              progress, chats and sign-ins stay on this computer.
            </span>
          </div>
          {meta?.engine === 'live' && <DocsInGitSetting on={meta.documentsInGit !== false} {...(self?.docs ? { locked: self.docs } : {})} />}
          <RestartRow />
          {meta?.engine === 'live' && <ParallelSetting />}
          {meta?.engine === 'live' && <RunnerSetting />}
          {meta?.engine === 'live' && <GuardAllows />}
          {meta?.engine === 'live' && <TrackerSettings />}
          {meta?.engine === 'live' && <SpeechSettings />}
          {meta?.engine === 'live' && <ProjectSettings />}
          {meta?.engine === 'demo' && (
            <div className="maprow">
              <b>Demo board</b>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn sm danger" onClick={() => setResetting(true)}>
                  <RotateCcw size={13} /> Start the demo over
                </button>
                <span className="note">The squad plays back a recorded run at {meta.speed}x speed.</span>
              </span>
            </div>
          )}
          {meta && <PaymentSettings />}
          <h2 style={{ marginTop: 26 }}>About squad-kit</h2>
          <AboutUpdates />
          <HelpRow />
        </div>
      </div>
      {resetting && (
        <Modal
          title="Start the demo over?"
          onClose={() => setResetting(false)}
          footer={
            <>
              <button className="btn pri" onClick={() => act.mutate({ path: '/api/v1/demo/reset', done: 'The demo board is fresh again.' }, { onSuccess: () => setResetting(false) })}>
                <RotateCcw size={15} /> Start over
              </button>
              <button className="btn" onClick={() => setResetting(false)}>Cancel</button>
              <span className="grow" />
              <Cmd text="squad demo" />
            </>
          }
        >
          <p>Every ticket, release and decision goes back to how the demo starts.</p>
        </Modal>
      )}
    </>
  );
}

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AgentInfo, CorePrompts, TrackerStatus } from '../api/types';
import { Bug, Check, RotateCcw, Terminal } from 'lucide-react';
import type { ProjectCommands, RepoInfo } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { BugDialog } from '../components/dialogs';
import { useRestart } from '../components/Restart';
import { Cmd, Glyph, Modal, STAGE_NAME, actionLabel, ago, commandFor } from '../components/ui';

/* ── Waiting for you ───────────────────────────────────── */

export function InboxPage() {
  const board = useBoard();
  const tickets = board.data?.ready ? board.data.tickets.filter((t) => t.waiting) : [];
  return (
    <>
      <div className="top">
        <h1>Waiting for you</h1>
        <span className="grow" />
        <Cmd text="squad inbox" />
      </div>
      <div className="scroll">
        <div className="page">
          {tickets.length === 0 ? (
            <div className="calm">
              <span className="ring"><Check size={18} strokeWidth={2.5} /></span>
              <div>
                <b>Nothing needs you right now</b>
                <span>The squad is working. Questions, plans, proof and decisions land here.</span>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {tickets.map((t) => (
                <div key={t.id} className="wcard" style={{ padding: '16px 18px 16px 22px' }}>
                  <div className="grow">
                    <div className="meta">
                      <span className="id">{t.id}</span>
                      <span>{STAGE_NAME[t.stage]}</span>
                      <span>{ago(t.activity[0]?.at ?? t.createdAt)}</span>
                    </div>
                    <h3>{t.title}</h3>
                    <p>{t.waiting!.summary}</p>
                  </div>
                  <Cmd text={commandFor(t)} />
                  {t.waiting!.kind === 'proof' ? (
                    <Link to="/tickets/$id/proof" params={{ id: t.id }} className="btn pri sm">{actionLabel(t)}</Link>
                  ) : (
                    <Link to="/board" search={{ ticket: t.id }} className="btn pri sm">{actionLabel(t)}</Link>
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
                    <td>
                      <Link to="/board" search={{ ticket: t.id }} style={{ fontWeight: 600 }}>{t.title}</Link>
                    </td>
                    <td>{t.foundIn ?? ''}</td>
                    <td>{STAGE_NAME[t.stage]}</td>
                    <td style={{ color: t.waiting ? 'var(--you-ink)' : 'var(--muted)' }}>{t.waiting?.summary ?? t.status}</td>
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

/* ── Squad and AI ──────────────────────────────────────── */

const TOOL_NAME: Record<AgentInfo['tool'], string> = { claude: 'Claude Code', codex: 'Codex' };

export function SquadPage() {
  const board = useBoard();
  const meta = board.data?.ready ? board.data.meta : undefined;
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentInfo[]>('/api/v1/agents'), refetchInterval: 2000 });
  const [editing, setEditing] = useState<AgentInfo | null>(null);
  return (
    <>
      <div className="top">
        <h1>Squad and AI</h1>
      </div>
      <div className="scroll">
        <div className="page" style={{ maxWidth: 900 }}>
          <h2>The squad</h2>
          <p className="note" style={{ marginTop: 2 }}>
            squad-kit is the lead. Each role is its own agent with its own session and tools, and the Reviewer always starts fresh, so every change
            gets a real second opinion. Edit an agent to give it house rules or a different model.
          </p>
          <div style={{ marginTop: 10 }}>
            {(agents.data ?? []).map((a) => (
              <div className="maprow" key={a.role} style={{ gridTemplateColumns: '34px 120px 1fr 200px 70px', alignItems: 'center' }}>
                <Glyph role={a.role} />
                <b>{a.name}</b>
                <span style={{ fontSize: 13 }}>
                  <span className="note">{a.job}</span>
                  {a.working.length > 0 && (
                    <span style={{ display: 'block', marginTop: 3 }}>
                      {a.working.map((w) => (
                        <Link key={w.id} to="/board" search={{ ticket: w.id }} style={{ display: 'block', color: 'var(--accent)' }}>
                          <b className="mono">{w.id}</b> {w.status}
                        </Link>
                      ))}
                    </span>
                  )}
                </span>
                <span className="pills">
                  <span className="pill">{TOOL_NAME[a.tool]}</span>
                  {a.model && <span className="pill wait mono">{a.model}</span>}
                  {a.instructions.replace(/<!--[\s\S]*?-->/g, '').trim() && <span className="pill ok">House rules</span>}
                </span>
                <button className="btn sm" onClick={() => setEditing(a)}>Edit</button>
              </div>
            ))}
          </div>
          <div className="maprow" style={{ marginTop: 4 }}>
            <b>Tickets at once</b>
            <span className="note">Up to {meta?.parallel ?? 2}. Change it in Settings.</span>
          </div>
          <h2 style={{ marginTop: 30 }}>Your AI tools</h2>
          <p className="note" style={{ marginTop: 2 }}>squad-kit uses the logins you already have. Nothing new to buy.</p>
          {(meta?.tools ?? []).map((t) => (
            <div className="toolrow" key={t.name}>
              <span className="logo"><Terminal size={18} /></span>
              <span>
                <b>{t.name}</b>
                <br />
                <span className="note">{t.name === 'Codex' ? 'Your ChatGPT subscription' : 'Your Claude subscription'}</span>
              </span>
              <span className={`pill ${t.ready ? 'ok' : 'wait'}`}>{t.ready ? 'Ready' : 'Not found'}</span>
            </div>
          ))}
          <div className="toolrow off">
            <span className="logo"><Terminal size={18} /></span>
            <span>
              <b>Gemini CLI, Copilot CLI, Cursor</b>
              <br />
              <span className="note">Coming next</span>
            </span>
            <span />
          </div>
        </div>
      </div>
      {editing && <AgentDialog agent={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/**
 * An agent: its tool and model, the team's house rules for every step and for each step, and the core prompt of each
 * step, read only. Team instructions are added to the core prompt; they never replace it.
 */
function AgentDialog({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
  const act = useAct();
  const clean = (x: string | undefined) => (x ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const [tool, setTool] = useState(agent.tool);
  const [model, setModel] = useState(agent.model);
  const [instructions, setInstructions] = useState(clean(agent.instructions));
  const [steps, setSteps] = useState<Record<string, string>>(() => Object.fromEntries(agent.stepList.map((s) => [s.id, clean(agent.steps?.[s.id])])));
  const core = useQuery({ queryKey: ['core-prompts', agent.role], queryFn: () => api<CorePrompts>(`/api/v1/agents/${agent.role}/prompts`) });
  const save = () =>
    act.mutate(
      { path: `/api/v1/agents/${agent.role}`, method: 'PUT', body: { tool, model, instructions, steps }, done: `${agent.name} saved. It uses this from its next step.` },
      { onSuccess: onClose },
    );
  return (
    <Modal
      title={`Edit the ${agent.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn pri" disabled={act.isPending} onClick={save}>Save</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <span className="note mono" style={{ fontSize: 12 }}>{agent.file}</span>
        </>
      }
    >
      <p className="note" style={{ marginTop: 0 }}>{agent.job}.</p>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>AI tool</b>
        <select className="input" value={tool} onChange={(e) => setTool(e.target.value as AgentInfo['tool'])}>
          <option value="claude">Claude Code</option>
          <option value="codex" disabled>Codex (coming soon)</option>
        </select>
      </div>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Model</b>
        <input className="input mono" style={{ fontSize: 13 }} value={model} placeholder="Your default. Or: sonnet, opus" onChange={(e) => setModel(e.target.value)} />
      </div>
      <div style={{ marginTop: 12 }}>
        <b style={{ display: 'block', marginBottom: 6 }}>House rules for every step</b>
        <textarea
          className="input"
          rows={4}
          style={{ width: '100%', resize: 'vertical' }}
          value={instructions}
          placeholder={`Extra instructions the ${agent.name} reads in every step, in plain words.`}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      <p className="note" style={{ fontSize: 12.5 }}>
        Each step has a core prompt that squad-kit keeps and improves with every release. Your instructions are added to it, never instead of it.
        {core.data && ` The prompts below are filled in from ${core.data.ticket.id} "${core.data.ticket.title}".`}
      </p>
      {agent.stepList.map((s) => {
        const p = core.data?.prompts.find((x) => x.step === s.id);
        return (
          <div className="agentstep" key={s.id}>
            <b>{s.name}</b>
            <textarea
              className="input"
              rows={2}
              style={{ width: '100%', resize: 'vertical' }}
              value={steps[s.id] ?? ''}
              placeholder={`Only for the ${s.name} step. For example: ${STEP_EXAMPLE[s.id] ?? 'keep it short'}.`}
              onChange={(e) => setSteps({ ...steps, [s.id]: e.target.value })}
            />
            <details>
              <summary>Core prompt for {s.name}, read only</summary>
              <pre className="coreprompt">{p ? p.prompt : core.isLoading ? 'Loading…' : 'Not available.'}</pre>
            </details>
          </div>
        );
      })}
    </Modal>
  );
}

const STEP_EXAMPLE: Record<string, string> = {
  questions: 'always ask who will use it',
  spec: 'write "done when" items a clerk can check by hand',
  scan: 'the old /legacy folder is not used',
  design: 'prefer the existing service layer over new packages',
  build: 'use our logger, never console.log',
  fix: 'never turn a failing test off',
  review: 'check every query for missing tenant filters',
  proof: 'take screenshots in Arabic too',
};

/* ── Settings ──────────────────────────────────────────── */

const COMMAND_FIELDS: { key: keyof ProjectCommands; label: string; hint: string }[] = [
  { key: 'setup', label: 'Set up', hint: 'Installs what the project needs, e.g. npm install' },
  { key: 'test', label: 'Test', hint: 'Runs the tests, e.g. npm test' },
  { key: 'lint', label: 'Lint', hint: 'Checks code style, e.g. npm run lint' },
  { key: 'build', label: 'Build', hint: 'Builds the project, e.g. npm run build' },
  { key: 'start', label: 'Start', hint: 'Runs the app for screenshots, e.g. npm start' },
  { key: 'url', label: 'App address', hint: 'Where the app opens, e.g. http://localhost:3000' },
  { key: 'deploy', label: 'Pipeline', hint: 'Runs after a release, e.g. az pipelines run …' },
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
      <h2 style={{ marginTop: 6 }}>How the squad checks and runs this project</h2>
      <p className="note" style={{ margin: '2px 0 10px' }}>
        The Architect filled these in when it read the project. squad-kit runs Test, Lint and Build itself before anything ships.
        {multi && ' This workspace has several code repos; each ticket works in one of them.'}
      </p>
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
          {repo.summary && <span className="note" style={{ fontFamily: 'inherit', marginLeft: 8 }}>{repo.summary}</span>}
        </h3>
      )}
      {COMMAND_FIELDS.map((f) => (
        <div className="maprow" key={f.key} style={{ alignItems: 'center' }}>
          <b>{f.label}</b>
          <input
            className="input mono"
            style={{ fontSize: 13 }}
            value={current[f.key] ?? ''}
            placeholder={f.hint}
            onChange={(e) => setCommands({ ...current, [f.key]: e.target.value })}
          />
        </div>
      ))}
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

/** Where stories come from and where PRs go. The token stays in .squad/secrets.yaml on this computer. */
function AzureSettings() {
  const act = useAct();
  const status = useQuery({ queryKey: ['tracker'], queryFn: () => api<TrackerStatus>('/api/v1/tracker'), refetchInterval: 60_000 });
  const [form, setForm] = useState<{ organization: string; project: string; token: string } | null>(null);
  const s = status.data;
  const current = form ?? { organization: s?.organization ?? '', project: s?.project ?? '', token: '' };
  const connected = s?.type === 'azure' && s.user;
  return (
    <div style={{ marginBottom: 26 }}>
      <h2 style={{ marginTop: 6 }}>Azure DevOps</h2>
      <p className="note" style={{ margin: '2px 0 10px' }}>
        Stories and bugs come from Azure Boards. squad-kit moves them along as the squad works, opens a pull request for each finished ticket, and
        merges it when you release. Your token stays on this computer.
      </p>
      {s && (
        <div className="maprow" style={{ alignItems: 'center' }}>
          <b>Status</b>
          <span>
            {connected ? (
              <span className="pill ok">Connected as {s.user}</span>
            ) : s.type === 'azure' ? (
              <span className="pill bug">{s.error ?? (s.hasToken ? 'Not connected' : 'Needs a token')}</span>
            ) : (
              <span className="pill wait">Not set up</span>
            )}
          </span>
        </div>
      )}
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Organization</b>
        <input className="input mono" style={{ fontSize: 13 }} value={current.organization} placeholder="e.g. momenysr" onChange={(e) => setForm({ ...current, organization: e.target.value })} />
      </div>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Project</b>
        <input className="input mono" style={{ fontSize: 13 }} value={current.project} placeholder="e.g. Mawid" onChange={(e) => setForm({ ...current, project: e.target.value })} />
      </div>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Token</b>
        <input
          className="input mono"
          style={{ fontSize: 13 }}
          type="password"
          autoComplete="off"
          value={current.token}
          placeholder={s?.hasToken ? 'Saved. Paste a new one to replace it' : 'Personal access token from Azure DevOps'}
          onChange={(e) => setForm({ ...current, token: e.target.value })}
        />
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          className="btn pri sm"
          disabled={!form || act.isPending}
          onClick={() =>
            act.mutate(
              { path: '/api/v1/tracker', method: 'PUT', body: current, done: 'Azure DevOps is connected' },
              { onSuccess: () => { setForm(null); void status.refetch(); } },
            )
          }
        >
          {act.isPending ? 'Checking…' : 'Save and check'}
        </button>
        <span className="note">Token scopes: Work Items and Code (read, write and manage).</span>
        <span className="grow" />
        <Cmd text="squad config set tracker" />
      </div>
    </div>
  );
}

/** Voice and video notes need speech to text. The key stays in .squad/secrets.yaml on this computer. */
function SpeechSettings() {
  const act = useAct();
  const status = useQuery({ queryKey: ['speech'], queryFn: () => api<{ hasKey: boolean }>('/api/v1/speech') });
  const [key, setKey] = useState('');
  const hasKey = status.data?.hasKey;
  const save = (body: { munsit?: string; remove?: boolean }, done: string) =>
    act.mutate({ path: '/api/v1/speech', method: 'PUT', body, done }, { onSuccess: () => { setKey(''); void status.refetch(); } });
  return (
    <div style={{ marginBottom: 26 }}>
      <h2 style={{ marginTop: 6 }}>Speech to text</h2>
      <p className="note" style={{ margin: '2px 0 10px' }}>
        Agents cannot listen. With a Munsit key, squad-kit writes out every voice and video note you attach, in Arabic or English, and takes pictures of
        the screen in videos. Without a key, notes stay attached but nobody hears them. Your key stays on this computer.
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

function RunnerSetting() {
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
        <button className={`btn sm ${runner === 'acp' ? 'pri' : ''}`} onClick={() => pick('acp', 'The squad talks to Claude through ACP')}>
          Agent Client Protocol
        </button>
        <button className={`btn sm ${runner === 'direct' ? 'pri' : ''}`} onClick={() => pick('direct', 'The squad runs Claude Code directly')}>
          Directly
        </button>
        <span className="note" style={{ marginLeft: 6 }}>ACP is the open standard for agents. If it cannot start, a step runs Claude Code directly.</span>
      </span>
    </div>
  );
}

function ParallelSetting() {
  const board = useBoard();
  const act = useAct();
  const meta = board.data?.ready ? board.data.meta : undefined;
  if (!meta) return null;
  const n = meta.parallel ?? 2;
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>Tickets at once</b>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {[1, 2, 3, 4, 5].map((k) => (
          <button key={k} className={`btn sm ${k === n ? 'pri' : ''}`} onClick={() => act.mutate({ path: '/api/v1/settings', method: 'PUT', body: { parallel: k }, done: `The squad works on up to ${k} tickets at once` })}>
            {k}
          </button>
        ))}
        <span className="note" style={{ marginLeft: 6 }}>How many tickets the squad works on at the same time.</span>
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
          <div className="maprow">
            <b>Board files</b>
            <span className="mono" style={{ fontSize: 13 }}>.squad/board/</span>
          </div>
          <RestartRow />
          {meta?.engine === 'live' && <ParallelSetting />}
          {meta?.engine === 'live' && <RunnerSetting />}
          {meta?.engine === 'live' && <AzureSettings />}
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

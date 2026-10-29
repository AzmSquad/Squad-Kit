import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Bug, Check, Lightbulb, Map as MapIcon, RotateCcw, Terminal } from 'lucide-react';
import type { Decision } from '../api/types';
import { useAct, useBoard, useDecisions } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { BugDialog } from '../components/dialogs';
import { Cmd, Glyph, Modal, STAGE_NAME, actionLabel, ago, commandFor, dateShort } from '../components/ui';

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
                    <Link to="/board" search={{ t: t.id }} className="btn pri sm">{actionLabel(t)}</Link>
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

/* ── Decisions and memory ──────────────────────────────── */

export function DecisionsPage() {
  const data = useDecisions();
  const [tab, setTab] = useState<'decisions' | 'map' | 'lessons'>('decisions');
  const [selected, setSelected] = useState<string | null>(null);
  const decisions = data.data?.decisions ?? [];
  const current = decisions.find((d) => d.id === selected) ?? decisions[0];
  return (
    <>
      <div className="top">
        <h1>Decisions and memory</h1>
        <span className="note">What your squad knows. Every new ticket follows it.</span>
      </div>
      <div className="ptabs" role="tablist">
        <button className={tab === 'decisions' ? 'on' : ''} onClick={() => setTab('decisions')}>
          Decisions <span className="n">{decisions.length}</span>
        </button>
        <button className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>
          Project map
        </button>
        <button className={tab === 'lessons' ? 'on' : ''} onClick={() => setTab('lessons')}>
          Lessons <span className="n">{data.data?.lessons.length ?? 0}</span>
        </button>
      </div>
      {tab === 'decisions' && (
        <div className="split">
          <div className="scroll" style={{ padding: '8px 20px' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>ID</th>
                  <th>Decision</th>
                  <th style={{ width: 150 }}>From</th>
                  <th style={{ width: 150 }}>Checked by</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <tr key={d.id} className={`click ${current?.id === d.id ? 'on' : ''}`} onClick={() => setSelected(d.id)}>
                    <td className="mono">{d.id}</td>
                    <td style={{ fontWeight: current?.id === d.id ? 600 : 500 }}>{d.title}</td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>{d.from}</td>
                    <td><CheckedBy d={d} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {current && <DecisionDetail d={current} />}
        </div>
      )}
      {tab === 'map' && (
        <div className="scroll">
          <div className="page" style={{ maxWidth: 820 }}>
            <p className="note" style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
              <MapIcon size={15} /> The Architect wrote this when it first read the project. Every agent reads it first, then opens only the files it needs.
            </p>
            {data.data?.map.map((m) => (
              <div className="maprow" key={m.area}>
                <b>{m.area}</b>
                <span>{m.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === 'lessons' && (
        <div className="scroll">
          <div className="page" style={{ maxWidth: 820 }}>
            <p className="note" style={{ marginBottom: 8 }}>Learned from bugs and reviews. Each lesson makes the next ticket better.</p>
            {data.data?.lessons.map((l) => (
              <div className="lesson" key={l.id}>
                <span className="glyph sm"><Lightbulb size={12} /></span>
                <span>
                  {l.text} <span className="note">From {l.from}</span>
                </span>
                <span className="mono">{dateShort(l.date)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function CheckedBy({ d }: { d: Decision }) {
  if (!d.checkedBy) return <span className="pill wait">Not checkable</span>;
  return d.checkedBy.passing ? (
    <span className="pill ok">
      <Check size={13} strokeWidth={2.5} /> A {d.checkedBy.kind}
    </span>
  ) : (
    <span className="pill you">Test being written</span>
  );
}

function DecisionDetail({ d }: { d: Decision }) {
  return (
    <aside className="sidepanel">
      <span className="note mono">
        {d.id} · approved by {d.approvedBy} · {dateShort(d.date)}
      </span>
      <h3>{d.title}</h3>
      <div className="lbl">Why</div>
      <p style={{ fontSize: 13.5 }}>{d.why}</p>
      <div className="lbl">Options looked at</div>
      {d.options.map((o) => (
        <p key={o} style={{ fontSize: 13.5, display: 'flex', gap: 7, alignItems: 'center' }}>
          {o === d.chosen ? <Check size={14} strokeWidth={2.5} color="var(--accent)" /> : <span style={{ width: 14 }} />} {o}
        </p>
      ))}
      <div className="lbl">Checked by</div>
      {d.checkedBy ? (
        <div className="box">
          <b style={{ color: d.checkedBy.passing ? 'var(--accent)' : 'var(--you-ink)' }}>{d.checkedBy.passing ? 'Passing' : 'Being written'}</b>{' '}
          <span className="mono" style={{ fontSize: 12 }}>{d.checkedBy.name}</span>
          <p className="note" style={{ marginTop: 4 }}>If someone breaks this decision, the checks fail and nothing ships.</p>
        </div>
      ) : (
        <p className="note">A fact about the project, nothing to test.</p>
      )}
      {d.tickets.length > 0 && (
        <>
          <div className="lbl">Tickets that used it</div>
          <div className="pills">
            {d.tickets.map((t) => (
              <span key={t} className="pill">{t}</span>
            ))}
          </div>
        </>
      )}
    </aside>
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
                      <Link to="/board" search={{ t: t.id }} style={{ fontWeight: 600 }}>{t.title}</Link>
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

const ROLES = [
  { key: 'analyst', role: 'analyst', name: 'Analyst', job: 'Turns your words into a user story and "done when"' },
  { key: 'architect', role: 'architect', name: 'Architect', job: 'Chooses how to build it and explains why' },
  { key: 'builder', role: 'builder', name: 'Builder', job: 'Writes the code in small steps, never commits' },
  { key: 'tester', role: 'tester', name: 'Tester', job: 'Runs every check and records before and after' },
  { key: 'reviewer', role: 'reviewer', name: 'Reviewer', job: "Reviews the Builder's work, up to 2 rounds" },
] as const;

export function SquadPage() {
  const board = useBoard();
  const meta = board.data?.ready ? board.data.meta : undefined;
  return (
    <>
      <div className="top">
        <h1>Squad and AI</h1>
      </div>
      <div className="scroll">
        <div className="page" style={{ maxWidth: 860 }}>
          <h2>Your AI tools</h2>
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
          <h2 style={{ marginTop: 30 }}>Who does what</h2>
          <p className="note" style={{ marginTop: 2 }}>A different AI reviews the Builder's work, so every change gets a real second opinion.</p>
          <div style={{ marginTop: 10 }}>
            {ROLES.map((r) => (
              <div className="maprow" key={r.key} style={{ gridTemplateColumns: '34px 140px 1fr 110px', alignItems: 'center' }}>
                <Glyph role={r.role} />
                <b>{r.name}</b>
                <span className="note" style={{ fontSize: 13 }}>{r.job}</span>
                <span className="pill">{meta?.roles[r.key] ?? '—'}</span>
              </div>
            ))}
          </div>
          <p className="note" style={{ marginTop: 14 }}>If one tool hits its limit, the work moves to the other.</p>
        </div>
      </div>
    </>
  );
}

/* ── Settings ──────────────────────────────────────────── */

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

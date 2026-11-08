import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Check, Lock, ShieldAlert, ShieldCheck, Terminal, X } from 'lucide-react';
import { api, send } from '../api/client';
import type { AgentInfo, CorePrompts, Effort, HarnessRow, HarnessStage, HarnessView, LevelChoice, LevelRow, ModelLevel, Quality, Track } from '../api/types';
import { useAct, useAppSettings, useBoard } from '../lib/data';
import { QualityMetrics, SquadUsage } from '../components/Usage';
import { AllowedHosts, NetworkSetting, SandboxRows, useSandbox } from '../components/Sandbox';
import { Cmd, Glyph, Modal, ago } from '../components/ui';
import { usePrefs } from '../lib/prefs';
import { withoutComments } from '../lib/text';
import { useDraft } from '../lib/drafts';
import { typedDir } from '../lib/lang';
import { AdditionsTab } from './HarnessAdd';
import '../styles/harness.css';

/**
 * The Harness page: everything the engine does, read only, with its real values from /api/v1/harness. The Agents tab
 * keeps what can be changed: Quality, each agent's tool and models, and the team's own instructions.
 */

export type HarnessTab = 'line' | 'compare' | 'limits' | 'safety' | 'agents' | 'additions';

const TABS: [HarnessTab, string][] = [['line', 'The line'], ['compare', 'Compare tracks'], ['limits', 'Limits'], ['safety', 'Safety'], ['agents', 'Agents'], ['additions', 'Your additions']];
type Chip = 'all' | 'you' | 'stopped' | 'needs' | 'team';
const CHIPS: [Chip, string][] = [['all', 'All'], ['you', 'You decide'], ['stopped', 'Stopped something'], ['needs', 'Needs you'], ['team', 'Added by your team']];
const NOTHING = 'Nothing matches that. Try another word, or clear the search.';

export function HarnessPage() {
  const search = useSearch({ from: '/harness' });
  const navigate = useNavigate();
  const tab: HarnessTab = search.tab ?? 'line';
  const board = useBoard();
  const quality = board.data?.ready ? board.data.meta.quality : undefined;
  const view = useQuery({ queryKey: ['harness', quality], queryFn: () => api<HarnessView>('/api/v1/harness'), refetchInterval: 15_000 }).data;
  const [track, setTrack] = useState<Track>('full');
  const [stageId, setStageId] = useState('checks');
  const [chip, setChip] = useState<Chip>('all');
  const [q, setQ] = useState('');
  const [spot, setSpot] = useState('');
  const go = (t: HarnessTab) => void navigate({ to: '/harness', search: t === 'line' ? {} : { tab: t }, replace: true });
  const filter = (c: Chip) => {
    setChip(c);
    setQ('');
  };
  const pick = (id: string) => {
    setStageId(id);
    filter('all');
    setSpot('');
    // On a phone the panel stands above the page: bring the stage's gates into sight.
    if (matchMedia('(max-width: 760px)').matches) requestAnimationFrame(() => document.querySelector('.hn-body')?.scrollIntoView());
  };
  const needs = view?.tiles.needs ?? [];
  const ready = Boolean(view);
  // A gate's own link opens the line at its stage, with the gate in view.
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      const stage = view?.stages.find((s) => s.gates.some((g) => g.id === id));
      if (!stage && !view?.alwaysOn.some((r) => r.id === id)) return;
      if (stage) setStageId(stage.id);
      filter('all');
      setSpot(id);
      if (tab !== 'line') go('line');
      setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'center' }), 60);
    };
    open();
    addEventListener('hashchange', open);
    return () => removeEventListener('hashchange', open);
    // Once the words are here; later answers must not jump back to the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const status = view && (
    <>
      <b className="ok">{view.tiles.working}</b> gates working, <b>{view.tiles.stopped}</b> stopped something this week, <b className="you">{needs.length}</b> needs you
    </>
  );
  return (
    <div className="scroll">
      {tab === 'line' ? (
        <header className="hn-hero">
          <div className="hn-head">
            <div>
              <h1>Your harness</h1>
              <p>Every gate, rule and limit, exactly as the engine runs them. They are locked, so nothing can weaken them.</p>
            </div>
            <div className="hn-seg" role="group" aria-label="Track">
              {view?.tracks.map((t) => (
                <button key={t.id} className={t.id === track ? 'on' : ''} aria-pressed={t.id === track} onClick={() => setTrack(t.id)}>{t.name}</button>
              ))}
            </div>
          </div>
          {view && (
            <div className="hn-count">
              <button onClick={() => filter('all')}><b className="ok">{view.tiles.working}</b>gates working</button>
              <button onClick={() => filter('stopped')}><b>{view.tiles.stopped}</b>stopped something this week</button>
              <button
                className="you"
                onClick={() => {
                  const only = needs.length === 1 ? needs[0]! : null;
                  if (!only) filter('needs');
                  else if (only.proof) void navigate({ to: '/tickets/$id/proof', params: { id: only.id } });
                  else void navigate({ to: '/board', search: { ticket: only.id } });
                }}
              >
                <b>{needs.length}</b>needs you now
              </button>
            </div>
          )}
          {view && <StageRow stages={view.stages} track={track} on={chip === 'all' && !q.trim() ? stageId : ''} pick={pick} />}
        </header>
      ) : (
        <header className="hn-hero slim">
          <h1>Your harness</h1>
          <p>{status}</p>
        </header>
      )}
      <nav className="hn-tabs" aria-label="Harness">
        {TABS.map(([t, name]) => (
          <button key={t} className={t === tab ? 'on' : ''} aria-current={t === tab ? 'page' : undefined} onClick={() => go(t)}>{name}</button>
        ))}
      </nav>
      <div className="hn-body">
        {view && tab === 'line' && <LineTab view={view} stageId={stageId} track={track} chip={chip} setChip={setChip} q={q} setQ={setQ} spot={spot} />}
        {view && tab === 'compare' && <CompareTab view={view} />}
        {view && tab === 'limits' && <LimitsTab view={view} />}
        {view && tab === 'safety' && <SafetyTab view={view} />}
        {view && tab === 'agents' && <AgentsTab view={view} />}
        {view && tab === 'additions' && <AdditionsTab view={view} />}
      </div>
    </div>
  );
}

/** The stages in a row: green the squad runs it, amber you decide, dashed on its own, a red number when it stopped something. */
function StageRow({ stages, track, on, pick }: { stages: HarnessStage[]; track: Track; on: string; pick: (id: string) => void }) {
  const row = useRef<HTMLDivElement>(null);
  // Where the row scrolls, on a phone, the stage picked stays in sight.
  useEffect(() => {
    const stop = row.current?.querySelector<HTMLElement>('.on');
    if (stop) row.current!.scrollLeft = stop.offsetLeft - row.current!.clientWidth / 2;
  }, [on]);
  return (
    <>
      <div className="hn-wrap" ref={row}>
        <div className="hn-line">
          {stages.map((s, i) => (
            <button key={s.id} className={`hn-stop ${s.on[track].kind} ${s.id === on ? 'on' : ''}`} aria-pressed={s.id === on} onClick={() => pick(s.id)}>
              <i>
                {i + 1}
                {Boolean(s.stopped) && <u aria-label={`Stopped ${s.stopped} this week`}>{s.stopped}</u>}
              </i>
              <b>{s.name}</b>
              <small>{s.on[track].sub}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="hn-legend">
        <span>Green: squad-kit runs it, locked</span>
        <span>Amber: you decide</span>
        <span>Dashed: happens on its own on this track</span>
        <span>Red number: stopped something this week</span>
      </div>
    </>
  );
}

/** The switch that opens what really runs, remembered in this browser. */
function EngSwitch() {
  const { engineers, toggleEngineers } = usePrefs();
  return <Switch on={engineers} flip={toggleEngineers} name="For engineers" />;
}

function Switch({ on, flip, name }: { on: boolean; flip: () => void; name: string }) {
  return (
    <button className="hn-sw" aria-pressed={on} onClick={flip}>
      <span className={`tog ${on ? 'on' : ''}`} />
      {name}
    </button>
  );
}

/** A link that opens a story. A story deleted since then says so on its own page. */
function Story({ s }: { s: { id: string; title: string } }) {
  return <Link to="/board" search={{ ticket: s.id }} title={s.title}>{s.id}</Link>;
}

/* ── The line ─────────────────────────────────────────── */

export function Result({ s }: { s: NonNullable<HarnessRow['seen']> }) {
  const counted = s.passed !== undefined;
  const all = (s.passed ?? 0) + (s.stopped ?? 0);
  return (
    <div className="hn-res">
      {counted && all > 0 && <div className="bar"><i style={{ width: `${((s.passed ?? 0) / all) * 100}%` }} /></div>}
      {counted && all > 0 && <div><b>{s.passed}</b> passed, <b>{s.stopped}</b> stopped{s.week ? `, ${s.week} this week` : ''}</div>}
      {!counted && Boolean(s.stopped) && <div>Stopped <b>{s.stopped}</b>{s.stopped === 1 ? ' story' : ' stories'}{s.week ? `, ${s.week} this week` : ''}</div>}
      {s.last && <div>Last stopped <Story s={s.last} />, {ago(s.last.at)}</div>}
      {s.did && <div>{s.did}</div>}
    </div>
  );
}

function Row({ r, track, view, tag, spot }: { r: HarnessRow; track: Track; view: HarnessView; tag?: string; spot: boolean }) {
  const { engineers } = usePrefs();
  const [open, setOpen] = useState(false);
  const shown = engineers || open;
  const off = r.skip?.includes(track);
  const skipped = r.skip?.map((s) => view.tracks.find((t) => t.id === s)?.name).join(' and ');
  return (
    <article id={r.id} className={`hn-row ${off ? 'off' : ''} ${spot ? 'spot' : ''}`}>
      <div className="hn-top">
        <div>
          <h3 dir={r.team ? 'auto' : undefined}>
            {r.name}
            {r.you && <em>You decide</em>}
            {r.team && <small className="hn-team">Added by your team{r.team.state === 'try' ? ', on Try first' : ''}</small>}
            {tag && <small>{tag}</small>}
            <a href={`#${r.id}`} aria-label={`A link to ${r.name}`}>#</a>
          </h3>
          <p dir={r.team ? 'auto' : undefined}>{r.note?.[track] ? `${r.note[track]} ` : ''}{r.what}</p>
          {r.fail && <p className="if"><b>If it fails:</b> {r.fail}</p>}
          {r.then && <p className="if">{r.then}</p>}
          {skipped && <p className="if">Skipped on {skipped}.</p>}
        </div>
        {r.seen && <Result s={r.seen} />}
      </div>
      {r.needs?.map((n) => (
        <div className="hn-need" key={n.id}>
          <span><b>{n.id}</b> {n.summary}</span>
          {n.proof ? <Link className="btn pri sm" to="/tickets/$id/proof" params={{ id: n.id }}>Open the story</Link> : <Link className="btn pri sm" to="/board" search={{ ticket: n.id }}>Open the story</Link>}
        </div>
      ))}
      <button className="hn-more" aria-expanded={shown} onClick={() => setOpen(!open)}>{shown ? 'Hide the details' : 'Details'}</button>
      {shown && (
        <dl>
          {r.d?.map(([k, v]) => (
            <Fragment key={k}><dt>{k}</dt><dd className="mono">{v}</dd></Fragment>
          ))}
        </dl>
      )}
    </article>
  );
}

function LineTab({ view, stageId, track, chip, setChip, q, setQ, spot }: { view: HarnessView; stageId: string; track: Track; chip: Chip; setChip: (c: Chip) => void; q: string; setQ: (s: string) => void; spot: string }) {
  const word = q.trim().toLowerCase();
  const searching = Boolean(word) || chip !== 'all';
  const fits = (r: HarnessRow, stage = '') => {
    if (word && !`${r.name} ${r.what} ${r.fail ?? ''} ${r.then ?? ''} ${stage} ${r.d?.flat().join(' ')}`.toLowerCase().includes(word)) return false;
    if (chip === 'you') return Boolean(r.you);
    if (chip === 'team') return Boolean(r.team);
    if (chip === 'stopped') return Boolean(r.seen?.week);
    return chip !== 'needs' || Boolean(r.needs?.length);
  };
  const stage = view.stages.find((s) => s.id === stageId)!;
  const rows = view.stages.filter((s) => searching || s === stage).flatMap((s) => s.gates.filter((g) => fits(g, s.name)).map((g) => ({ g, s })));
  const always = view.alwaysOn.filter((r) => fits(r));
  const { days, weekDays, stories } = view.range;
  const title = word ? `${rows.length + always.length} found` : chip === 'all' ? stage.name : { you: 'You decide', stopped: 'Stopped something this week', needs: 'Needs you now', team: 'Added by your team' }[chip];
  return (
    <>
      <div className="hn-tools">
        <label>
          Search every gate and rule
          <input className="input" dir={typedDir(q)} value={q} placeholder="Try tests, Docker, picture, refused" onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="hn-chips" role="group" aria-label="Show">
          {CHIPS.map(([c, name]) => (
            <button key={c} className={c === chip ? 'on' : ''} aria-pressed={c === chip} onClick={() => setChip(c)}>{name}</button>
          ))}
        </div>
        <EngSwitch />
      </div>
      <p className="note hn-range">
        {stories ? `Counted from this project's ${stories} ${stories === 1 ? 'story' : 'stories'} on this computer, last ${days} days. This week: the last ${weekDays} days. No record, no number.` : `No stories on this computer in the last ${days} days, so no numbers yet.`}
      </p>
      <h2 className="hn-title hn-gap">{title}</h2>
      <p className="note hn-lead">{searching ? 'From every stage of the line.' : stage.about}</p>
      {!rows.length && !always.length && <div className="hn-none">{NOTHING}</div>}
      {rows.length > 0 && (
        <div className="hn-card">
          {rows.map(({ g, s }) => <Row key={g.id} r={g} track={track} view={view} tag={searching ? s.name : undefined} spot={spot === g.id} />)}
        </div>
      )}
      {always.length > 0 && (
        <>
          <h2 className="hn-title hn-gap">Working in every step</h2>
          <p className="note hn-lead">These belong to no stage. They watch the whole line, on every track.</p>
          <div className="hn-card">{always.map((r) => <Row key={r.id} r={r} track={track} view={view} spot={spot === r.id} />)}</div>
        </>
      )}
    </>
  );
}

/* ── Compare tracks ───────────────────────────────────── */

const CELL: Record<string, string> = { You: 'you', Runs: 'runs', 'By itself': 'self', 'Not used': 'none' };

function CompareTab({ view }: { view: HarnessView }) {
  const [only, setOnly] = useState(false);
  const differs = (g: HarnessRow) => new Set(view.tracks.map((t) => JSON.stringify(g.cells?.[t.id]))).size > 1;
  return (
    <>
      <div className="hn-tools">
        <div>
          <h2 className="hn-title">What each track does for you</h2>
          <p className="note">The quality gates run on every track. The tracks differ only in how much you are asked.</p>
        </div>
        <Switch on={only} flip={() => setOnly(!only)} name="Only what differs" />
      </div>
      <p className="note hn-lead">
        <b>Runs</b>: squad-kit does it, locked. <b>You</b>: it waits for you. <b>By itself</b>: decided for you, and logged. <b>Not used</b>: not part of this track.
      </p>
      <div className="hn-card hn-cmp" role="table" aria-label="Gates on each track">
        <div className="hn-cr head" role="row">
          <span role="columnheader">Gate</span>
          {view.tracks.map((t) => <span key={t.id} role="columnheader">{t.name}</span>)}
        </div>
        {view.stages.map((s) => {
          const keep = s.gates.filter((g) => !only || differs(g));
          if (!keep.length) return null;
          return (
            <Fragment key={s.id}>
              <div className="hn-cs">{s.name}</div>
              {keep.map((g) => (
                <div className="hn-cr" role="row" key={g.id}>
                  <span role="rowheader" dir={g.team ? 'auto' : undefined}>{g.name}{g.team && <small className="hn-team">Added by your team</small>}</span>
                  {view.tracks.map((t) => (
                    <span key={t.id} role="cell" className={CELL[g.cells?.[t.id].word ?? '']} data-t={t.name}>
                      {g.cells?.[t.id].word}
                      {g.cells?.[t.id].note && <small>{g.cells[t.id].note}</small>}
                    </span>
                  ))}
                </div>
              ))}
            </Fragment>
          );
        })}
      </div>
    </>
  );
}

/* ── Limits ───────────────────────────────────────────── */

const LIMIT_GROUPS = [
  ['tries', 'Tries and rounds'],
  ['pictures', 'Pictures and proof'],
  ['asks', 'Asks and refusals'],
  ['time', 'Time limits'],
  ['sizes', 'Sizes and places'],
] as const;

function LimitsTab({ view }: { view: HarnessView }) {
  const { engineers } = usePrefs();
  const [q, setQ] = useState('');
  const [reached, setReached] = useState(false);
  const word = q.trim().toLowerCase();
  const rows = view.limits.filter((l) => (!word || `${l.n} ${l.name} ${l.what} ${l.id}`.toLowerCase().includes(word)) && (!reached || l.hit));
  return (
    <>
      <h2 className="hn-title">Your squad can't go round in circles</h2>
      <p className="note hn-lead">Every loop has an end. When one is reached, the work is kept and you decide what happens next.</p>
      <div className="hn-tools">
        <label>
          Search the limits
          <input className="input" dir={typedDir(q)} value={q} placeholder="Try picture, Docker, rounds" onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="hn-chips">
          <button className={reached ? 'on' : ''} aria-pressed={reached} onClick={() => setReached(!reached)}>Reached in {view.range.days} days</button>
        </div>
        <EngSwitch />
      </div>
      {!rows.length && <div className="hn-none hn-gap">{NOTHING}</div>}
      {LIMIT_GROUPS.map(([id, name]) => {
        const here = rows.filter((l) => l.group === id);
        return (
          here.length > 0 && (
            <section key={id}>
              <h3 className="hn-sub">{name}</h3>
              <div className="hn-ledger">
                {here.map((l) => (
                  <div className="hn-lim" key={l.id}>
                    <b>{l.n}</b>
                    <span>
                      <strong>{l.name}</strong>
                      {l.what}
                      {l.hit && <em>Reached on <Story s={l.hit} />, {ago(l.hit.at)}</em>}
                      {engineers && <code className="mono">{l.id}</code>}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )
        );
      })}
      {!word && !reached && (
        <>
          <h3 className="hn-sub">The most one run can use, on {QUALITY.find((x) => x.id === view.quality)?.name}</h3>
          <p className="note hn-lead">Reaching one pauses the step with its work kept. Give it more doubles it.</p>
          <table className="table">
            <thead>
              <tr><th>Step</th><th>Agent turns</th><th>Spend at API prices</th></tr>
            </thead>
            <tbody>
              {view.caps.map((c) => (
                <tr key={c.key}><td>{c.name}</td><td>{c.turns}</td><td>${c.spendUsd}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

/* ── Safety ───────────────────────────────────────────── */

function Block({ title, what, items, mine = [], children }: { title: string; what: string; items: string[]; mine?: string[]; children?: ReactNode }) {
  return (
    <div className="hn-block">
      <div>
        <h3>{title}</h3>
        <p className="note">{what}</p>
      </div>
      <div>
        <div className="pills">
          {items.map((i) => <span className="pill wait" key={i}><Lock size={13} aria-label="Locked" />{i}</span>)}
          {mine.map((i) => <span className="pill you mono" key={i}>{i}</span>)}
        </div>
        {children}
      </div>
    </div>
  );
}

function SafetyTab({ view }: { view: HarnessView }) {
  const board = useBoard();
  const meta = board.data?.ready ? board.data.meta : undefined;
  const sandbox = useSandbox().data;
  const s = view.safety;
  const guarded = Boolean(sandbox && sandbox.tools.some((t) => t.available) && sandbox.guard?.on);
  const allowed = [...(sandbox?.guard?.allowRead ?? []), ...(sandbox?.guard?.allowWrite ?? [])];
  return (
    <>
      <h2 className="hn-title">What your squad can never touch.</h2>
      {sandbox && (
        <div className="hn-lead">
          <span className={`pill ${guarded ? 'ok' : 'you'}`}>
            {guarded ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
            {guarded ? 'Guard on, on this computer' : 'Less protected on this computer'}
          </span>
          {!guarded && <SandboxRows />}
        </div>
      )}
      <Block title="Hidden from the squad" what="The Builder, the Tester and your project's own commands can't read these. No agent can read squad-kit's keys or a local file." items={s.hidden} mine={s.local}>
        {allowed.length > 0 && (
          <p className="note hn-lead">
            An engineer let your project's own commands use <span className="mono">{allowed.join(', ')}</span>. See Settings.
          </p>
        )}
      </Block>
      <Block title="No agent can change" what="A change goes back by itself, with a line saying so." items={s.locked} mine={s.lockedByYou} />
      <Block title="Where agents can go" what="The Builder only. The others have no internet, and the Tester's pictures stay on this story's app." items={s.sites} mine={meta?.engine === 'live' ? [] : (meta?.allowedHosts ?? [])}>
        <NetworkSetting net={s.network} live={meta?.engine === 'live'} />
        {meta?.engine === 'live' && <AllowedHosts hosts={meta.allowedHosts ?? []} />}
      </Block>
      <Block title="Closed on every level" what="Sites with no use in building software, but common for taking data out. A site refused stops nothing: the work goes on without it." items={s.network.closed} />
      <Block title="Questions that never reach you" what="They are refused and logged, and the agent gets on with it." items={s.refused} />
      <Block title="What agents can ask squad-kit to do" what="There is no free command. squad-kit checks every field and does the job itself." items={s.tools} />
    </>
  );
}

/* ── Agents ───────────────────────────────────────────── */

const TOOL_NAME: Record<AgentInfo['tool'], string> = { claude: 'Claude Code', codex: 'Codex' };

function AgentsTab({ view }: { view: HarnessView }) {
  const board = useBoard();
  const shared = useAppSettings();
  const meta = board.data?.ready ? board.data.meta : undefined;
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentInfo[]>('/api/v1/agents'), refetchInterval: 2000 }).data ?? [];
  const [role, setRole] = useState<AgentInfo['role']>('builder');
  const [editing, setEditing] = useState<AgentInfo | null>(null);
  const a = agents.find((x) => x.role === role);
  return (
    <>
      <QualitySetting notes={view.qualityNote} />
      <QualityMetrics />
      <div className="maprow">
        <b>Stories at once</b>
        <span className="note">Up to {shared.data?.parallel ?? meta?.parallel ?? 2}, shared by all your projects. Change it in Settings.</span>
      </div>
      <div className="hn-tiles">
        {agents.map((x) => (
          <button key={x.role} className={`hn-tile ${x.role === role ? 'on' : ''}`} aria-pressed={x.role === role} onClick={() => setRole(x.role)}>
            <Glyph role={x.role} />
            <b>{x.name}</b>
            <small>{x.working.length ? `Working on ${x.working.map((w) => w.id).join(', ')}` : levelText(x.levels.find((r) => r.step === 'design')?.now ?? x.levels[0]!.now)}</small>
          </button>
        ))}
      </div>
      {a && <AgentPanel a={a} view={view} edit={() => setEditing(a)} />}
      <SquadUsage />
      <h2 className="hn-gap">Your AI tools</h2>
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
      <SandboxRows />
      <div className="toolrow off">
        <span className="logo"><Terminal size={18} /></span>
        <span>
          <b>Gemini CLI, Copilot CLI, Cursor</b>
          <br />
          <span className="note">Coming next</span>
        </span>
        <span />
      </div>
      {editing && <AgentDialog agent={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** One agent: what it can do, how it runs and what it reads. Edit changes its tool, its models and the team's instructions. */
function AgentPanel({ a, view, edit }: { a: AgentInfo; view: HarnessView; edit: () => void }) {
  const core = useQuery({ queryKey: ['core-prompts', a.role], queryFn: () => api<CorePrompts>(`/api/v1/agents/${a.role}/prompts`) });
  const clean = (x: string | undefined) => withoutComments(x ?? '').trim();
  const rules = [{ id: 'all', name: 'Every step', text: clean(a.instructions) }, ...a.stepList.map((s) => ({ id: s.id, name: s.name, text: clean(a.steps?.[s.id]) }))].filter((r) => r.text);
  const caps = view.caps.filter((c) => c.key.split('.')[0] === a.role);
  const added = view.additions.items.filter((x) => x.kind === 'rule' && x.state === 'on' && (x.agents?.includes('all') || x.agents?.includes(a.role)));
  return (
    <div className="hn-two even">
      <div>
        <h2 className="hn-title">{a.name}</h2>
        <p className="note">{a.job}.</p>
        {a.working.map((w) => (
          <Link key={w.id} className="hn-now" to="/board" search={{ ticket: w.id }}>
            <b className="mono">{w.id}</b> {w.status}
          </Link>
        ))}
        <h3 className="hn-sub">What it can do</h3>
        <ul className="hn-can">
          {view.agents[a.role]?.can.map(([label, yes]) => (
            <li key={label} className={yes ? '' : 'no'}>{yes ? <Check size={16} aria-label="Yes" /> : <X size={16} aria-label="No" />}{label}</li>
          ))}
        </ul>
        <h3 className="hn-sub">Your rules for the {a.name}</h3>
        {rules.map((r) => <p className="hn-rule" key={r.id}><b>{r.name}.</b> {r.text}</p>)}
        {added.map((r) => <p className="hn-rule" dir="auto" key={r.id}><b>{r.name}.</b> {r.text} <small className="hn-team">Added by your team</small></p>)}
        {!rules.length && !added.length && <p className="note">Nothing added yet.</p>}
        <button className="btn sm hn-edit" onClick={edit}>Edit the {a.name}</button>
      </div>
      <div>
        <h3 className="hn-sub">How it runs</h3>
        <div className="maprow"><b>AI tool</b><span className="note">{TOOL_NAME[a.tool]}</span></div>
        {a.levels.map((r) => <div className="maprow" key={r.step}><b>{r.name}</b><span className="note">{levelText(r.now)}</span></div>)}
        {caps.map((c) => <div className="maprow" key={c.key}><b>{c.name}</b><span className="note">Up to {c.turns} turns and ${c.spendUsd} for one run.</span></div>)}
        <h3 className="hn-sub">What it reads before it starts</h3>
        <p className="note">Read only, and improved with every release. Your rules are added to these words and never replace them.{core.data && ` Filled in from ${core.data.ticket.title}.`}</p>
        <div className="hn-card hn-reads">
          {a.stepList.map((s) => (
            <details key={s.id}>
              <summary><Lock size={14} aria-label="Locked" />{s.name}</summary>
              <pre className="coreprompt">{core.data?.prompts.find((x) => x.step === s.id)?.prompt ?? (core.isLoading ? 'Loading…' : 'Not available.')}</pre>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

const QUALITY: { id: Quality; name: string }[] = [
  { id: 'best', name: 'Best' },
  { id: 'balanced', name: 'Balanced' },
  { id: 'thrifty', name: 'Thrifty' },
];

/** The project's Quality setting: the level each role starts from, for the whole team. Edit on a role changes single steps. */
function QualitySetting({ notes }: { notes: HarnessView['qualityNote'] }) {
  const board = useBoard();
  const act = useAct();
  const meta = board.data?.ready ? board.data.meta : undefined;
  if (!meta) return null;
  const now = meta.quality ?? 'best';
  return (
    <div className="maprow" style={{ marginTop: 6 }}>
      <b style={{ paddingTop: 4 }}>Quality</b>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {QUALITY.map((q) => (
            <button
              key={q.id}
              className={`btn sm ${q.id === now ? 'pri' : ''}`}
              aria-pressed={q.id === now}
              onClick={() => act.mutate({ path: '/api/v1/settings', method: 'PUT', body: { quality: q.id }, done: `Quality is ${q.name} now. The squad uses it from its next step.` })}
            >
              {q.name}
            </button>
          ))}
          <span className="grow" />
          <Cmd text={`squad config set quality ${now}`} />
        </span>
        {QUALITY.map((q) => (
          <span key={q.id} className="note" style={{ fontSize: 12.5, ...(q.id === now ? { color: 'var(--text)' } : {}) }}>
            <b>{q.name}:</b> {notes[q.id]}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * An agent: its tool and model, and the team's house rules for every step and for each step. Team instructions are added
 * to the core prompt, shown read only on the page behind; they never replace it.
 */
function AgentDialog({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
  const act = useAct();
  const clean = (x: string | undefined) => withoutComments(x ?? '').trim();
  const [tool, setTool] = useState(agent.tool);
  const [model, setModel] = useState(agent.model);
  const [myModel, setMyModel] = useState(agent.youRole?.model ?? '');
  const [team, setTeam] = useState<Record<string, LevelChoice>>(() => Object.fromEntries(agent.levels.map((r) => [r.step, r.team ?? {}])));
  const [you, setYou] = useState<Record<string, LevelChoice>>(() => Object.fromEntries(agent.levels.map((r) => [r.step, r.you ?? {}])));
  const [instructions, setInstructions, clearInstructions] = useDraft(`agent-${agent.role}`, 'instructions', clean(agent.instructions));
  const [steps, setSteps] = useState<Record<string, string>>(() => Object.fromEntries(agent.stepList.map((s) => [s.id, clean(agent.steps?.[s.id])])));
  const save = async () => {
    // Your own choices stay on this computer; the team's go in the agent file.
    const same = (a: LevelChoice | null | undefined, b: LevelChoice) => (a?.level ?? '') === (b.level ?? '') && (a?.effort ?? '') === (b.effort ?? '');
    try {
      for (const r of agent.levels) if (!same(r.you, you[r.step]!)) await send('/api/v1/me/levels', 'PUT', { key: `${agent.role}.${r.step}`, ...you[r.step] });
      if ((agent.youRole?.model ?? '') !== myModel.trim()) await send('/api/v1/me/levels', 'PUT', { key: agent.role, ...agent.youRole, model: myModel.trim() });
    } catch (err) {
      act.reset();
      return alert(err instanceof Error ? err.message : String(err));
    }
    const levels: Record<string, LevelChoice> = {};
    if (agent.teamRole?.level || agent.teamRole?.effort) levels[agent.role] = { level: agent.teamRole.level, effort: agent.teamRole.effort };
    for (const [step, c] of Object.entries(team)) if (c.level || c.effort) levels[`${agent.role}.${step}`] = c;
    act.mutate(
      { path: `/api/v1/agents/${agent.role}`, method: 'PUT', body: { tool, model, instructions, steps, levels }, done: `${agent.name} saved. It uses this from its next step.` },
      {
        onSuccess: () => {
          clearInstructions();
          onClose();
        },
      },
    );
  };
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
      <ModelLevels agent={agent} team={team} setTeam={setTeam} you={you} setYou={setYou} />
      <details style={{ marginTop: 8 }}>
        <summary className="note">Pin exact models (advanced)</summary>
        <div className="maprow" style={{ alignItems: 'center' }}>
          <b>For the team</b>
          <input className="input mono" style={{ fontSize: 13 }} value={model} placeholder="Empty: use the levels above" onChange={(e) => setModel(e.target.value)} />
        </div>
        <div className="maprow" style={{ alignItems: 'center' }}>
          <b>Just for me</b>
          <input className="input mono" style={{ fontSize: 13 }} value={myModel} placeholder="Empty: use the levels above" onChange={(e) => setMyModel(e.target.value)} />
        </div>
        <p className="note" style={{ fontSize: 12.5 }}>A pinned model wins over every level. Levels are better for the team: they work whatever AI tool each person uses.</p>
      </details>
      <div style={{ marginTop: 12 }}>
        <b style={{ display: 'block', marginBottom: 6 }}>House rules for every step</b>
        <textarea
          className="input"
          rows={4}
          style={{ width: '100%', resize: 'vertical' }}
          dir={typedDir(instructions)}
          value={instructions}
          placeholder={`Extra instructions the ${agent.name} reads in every step, in plain words.`}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      {agent.stepList.map((s) => (
        <div className="agentstep" key={s.id}>
          <b>{s.name}</b>
          <textarea
            className="input"
            rows={2}
            style={{ width: '100%', resize: 'vertical' }}
            dir={typedDir(steps[s.id] ?? '')}
            value={steps[s.id] ?? ''}
            placeholder={`Only for the ${s.name} step. For example: ${STEP_EXAMPLE[s.id] ?? 'keep it short'}.`}
            onChange={(e) => setSteps({ ...steps, [s.id]: e.target.value })}
          />
        </div>
      ))}
    </Modal>
  );
}

function levelText(n: LevelRow['now']): string {
  const who = n.from === 'project' ? 'set by the team' : n.from === 'you' ? 'set by you' : "squad-kit's default";
  return `${n.modelName || n.level} (${n.model ? 'pinned' : n.level}${n.effort ? `, ${EFFORT_NAME[n.effort]} effort` : ''}), ${who}${n.why ? `, ${n.why}` : ''}`;
}

const LEVEL_NAME: Record<ModelLevel, string> = { strongest: 'Strongest', balanced: 'Balanced', fast: 'Fast' };
const EFFORT_NAME: Record<Effort, string> = { xhigh: 'extra high', high: 'high', medium: 'medium', low: 'low' };

/** Pick a level and an effort, or leave either on the layer below. */
function LevelPick({ value, onChange, below, agent }: { value: LevelChoice; onChange: (c: LevelChoice) => void; below: LevelChoice; agent: AgentInfo }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <select className="input" style={{ fontSize: 12.5, padding: '4px 6px', width: '100%' }} value={value.level ?? ''} onChange={(e) => onChange({ ...value, level: (e.target.value || undefined) as ModelLevel | undefined })} aria-label="Level">
        <option value="">Default{below.level ? ` (${below.level})` : ''}</option>
        {(['strongest', 'balanced', 'fast'] as ModelLevel[]).map((l) => (
          <option key={l} value={l}>{LEVEL_NAME[l]}{agent.modelOf[l] ? ` · ${agent.modelOf[l]}` : ''}</option>
        ))}
      </select>
      {agent.supportsEffort && (
        <select className="input" style={{ fontSize: 12.5, padding: '4px 6px', width: '100%' }} value={value.effort ?? ''} onChange={(e) => onChange({ ...value, effort: (e.target.value || undefined) as Effort | undefined })} aria-label="Effort">
          <option value="">Default{below.effort ? ` (${EFFORT_NAME[below.effort]} effort)` : ''}</option>
          {agent.efforts.map((e) => (
            <option key={e} value={e}>{EFFORT_NAME[e].charAt(0).toUpperCase()}{EFFORT_NAME[e].slice(1)} effort</option>
          ))}
        </select>
      )}
    </span>
  );
}

/**
 * The model level of each step, in three layers: squad-kit's default, the team's choice (saved in the agent file)
 * and your own (saved on this computer). The last one set wins.
 */
function ModelLevels({ agent, team, setTeam, you, setYou }: { agent: AgentInfo; team: Record<string, LevelChoice>; setTeam: (t: Record<string, LevelChoice>) => void; you: Record<string, LevelChoice>; setYou: (t: Record<string, LevelChoice>) => void }) {
  return (
    <div style={{ marginTop: 12 }}>
      <b style={{ display: 'block', marginBottom: 2 }}>Models</b>
      <p className="note" style={{ marginTop: 0, fontSize: 12.5 }}>
        squad-kit picks a level for each step from the Quality setting: strongest where a mistake is expensive, cheaper where the work is clear. Change it
        for the whole team, or just for you. After a failed try, the Builder moves up a level on its own.
      </p>
      <div className="levels" role="table">
        <div className="levrow head" role="row"><span>Step</span><span>For the team</span><span>Just for me</span><span>Now</span></div>
        {agent.levels.map((r) => (
          <div className="levrow" role="row" key={r.step}>
            <span>{r.name}</span>
            <LevelPick agent={agent} value={team[r.step] ?? {}} below={r.standard} onChange={(c) => setTeam({ ...team, [r.step]: c })} />
            <LevelPick agent={agent} value={you[r.step] ?? {}} below={{ ...r.standard, ...(team[r.step] ?? {}) }} onChange={(c) => setYou({ ...you, [r.step]: c })} />
            <span className="note" style={{ fontSize: 12.5 }}>{levelText(r.now)}</span>
          </div>
        ))}
      </div>
    </div>
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

import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Lightbulb, Loader2, Map as MapIcon, Pause, Play, RefreshCw, Shapes } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DECISION_AREAS, type ArchitectureResponse, type Decision, type ImpactCheck, type DecisionArea, type StackItem, type TechRole, type TimelineState, type TimelineTicket } from '../api/types';
import { useAct, useArchitecture } from '../lib/data';
import { LOGOS } from '../lib/logos';
import { ago, dateShort } from '../components/ui';

/* ── Architecture: every saved decision, how they build on each other, and the tickets they shaped ──
   Map: decisions as cards, left to right from the starting points to what was built on them.
   Timeline: each decision is a track from the ticket that made it; a dot is a later ticket that followed it.
   All decisions, Project map and Lessons are the plain lists the squad reads before every ticket. */

export type ArchView = 'map' | 'timeline' | 'stack' | 'list' | 'project' | 'lessons';

const STATE_NAME: Record<TimelineState, string> = {
  shipped: 'Released',
  merged: 'Merged, not released yet',
  building: 'Being built',
  designed: 'Designed, not built yet',
  coming: 'Coming',
};

type Pick = { kind: 'adr'; id: string } | { kind: 'ticket'; id: string } | null;

export function ArchitecturePage() {
  const data = useArchitecture();
  const search = useSearch({ from: '/architecture' });
  const navigate = useNavigate();
  const view: ArchView = search.view ?? 'map';
  const [areas, setAreas] = useState<Set<DecisionArea | 'Other'>>(new Set());
  const [until, setUntil] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const pick: Pick = search.adr ? (search.adr.startsWith('ADR-') ? { kind: 'adr', id: search.adr } : { kind: 'ticket', id: search.adr }) : null;
  const go = (next: { view?: ArchView; pick?: Pick }) =>
    void navigate({
      to: '/architecture',
      search: {
        ...(next.view ?? view) !== 'map' ? { view: next.view ?? view } : {},
        ...('pick' in next ? (next.pick ? { adr: next.pick.id } : {}) : search.adr ? { adr: search.adr } : {}),
      },
      replace: true,
    });
  const setPick = (p: Pick) => go({ pick: pick?.id === p?.id ? null : p });

  const decisions = data.data?.decisions ?? [];
  const tickets = data.data?.tickets ?? [];
  const g = useMemo(() => columns(decisions, tickets), [decisions, tickets]);
  const last = g.cols.length;
  const shown = until ?? last;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setUntil((u) => {
        const next = (u ?? 0) + 1;
        if (next >= last) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, 700);
    return () => clearInterval(timer);
  }, [playing, last]);

  if (!data.data) return <div className="top"><h1>Architecture</h1></div>;

  const asOf = decisions.filter((d) => g.colOf(d.from) < shown);
  const rules = asOf.filter((d) => !d.replacedBy || g.colOf(ticketOfAdr(decisions, d.replacedBy)) >= shown);
  const follows = g.cols.slice(0, shown).reduce((n, c) => n + (c.t?.follows.length ?? 0), 0);
  const focus: Pick = hover ? (hover.startsWith('ADR-') ? { kind: 'adr', id: hover } : { kind: 'ticket', id: hover }) : pick;
  const related = relatedTo(focus, decisions, tickets);
  const visual = view === 'map' || view === 'timeline';
  const lessons = data.data.lessons ?? [];

  return (
    <>
      <div className="top">
        <h1>Architecture</h1>
        <span className="note">Every technical choice the squad made, why, and what it shaped. Every new ticket follows the rules in force.</span>
      </div>
      <div className="ptabs" role="tablist">
        {(
          [
            ['map', 'Map'],
            ['timeline', 'Timeline'],
            ['stack', 'Stack', data.data.stack.length],
            ['list', 'All decisions', decisions.length],
            ['project', 'Project map'],
            ['lessons', 'Lessons', lessons.length],
          ] as [ArchView, string, number?][]
        ).map(([v, label, n]) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => go({ view: v })}>
            {label} {n !== undefined && <span className="n">{n}</span>}
          </button>
        ))}
      </div>
      <div className="split">
        <div className="scroll">
          <div className="arch">
            {visual && (
              <>
                <div className="arch-stats">
                  <Stat n={rules.length} label="Rules in force" hint="Every new design must follow these" />
                  <Stat n={asOf.length - rules.length} label="Replaced" hint="Changed by a newer decision" />
                  <Stat n={rules.filter((d) => d.checkedBy?.passing).length} label="Checked by a test" hint="Break one and nothing ships" />
                  <Stat n={follows} label="Times a design followed one" hint="Past choices shaping new work" />
                </div>
                <div className="arch-bar">
                  <button className="btn" onClick={() => (playing ? setPlaying(false) : (setUntil(until === null || until >= last ? 1 : until), setPlaying(true)))}>
                    {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play the history'}
                  </button>
                  <input
                    type="range"
                    min={1}
                    max={last}
                    value={shown}
                    aria-label="Show the project up to this ticket"
                    onChange={(e) => {
                      setPlaying(false);
                      const v = Number(e.target.value);
                      setUntil(v >= last ? null : v);
                    }}
                  />
                  <span className="note mono" style={{ minWidth: 110 }}>
                    {shown >= last ? 'Today' : `Up to ${g.cols[shown - 1]?.label ?? ''}`}
                  </span>
                  <span className="grow" />
                  {[...DECISION_AREAS, 'Other' as const].filter((a) => decisions.some((d) => (d.area ?? 'Other') === a)).map((a) => (
                    <button
                      key={a}
                      className={`chip area-${a.toLowerCase()} ${areas.has(a) ? 'on' : ''}`}
                      onClick={() => setAreas((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; })}
                    >
                      <i /> {a}
                    </button>
                  ))}
                </div>
              </>
            )}

            {view === 'map' && (
              <DecisionMap
                decisions={decisions.filter((d) => areas.size === 0 || areas.has(d.area ?? 'Other'))}
                tickets={tickets}
                visible={(d) => g.colOf(d.from) < shown}
                related={related}
                picked={pick?.id ?? null}
                onPick={setPick}
                onHover={setHover}
              />
            )}
            {view === 'timeline' && (
              <Timeline decisions={decisions} tickets={tickets} areas={areas} shown={shown} related={related} picked={pick?.id ?? null} onPick={setPick} g={g} />
            )}
            {visual && <Legend view={view} />}
            {view === 'map' && <Inherit decisions={decisions} tickets={tickets} onPick={setPick} />}

            {view === 'stack' && <StackView data={data.data} picked={pick?.id ?? null} onPick={setPick} />}
            {view === 'list' && <DecisionTable decisions={decisions} picked={pick?.id ?? null} onPick={setPick} />}
            {view === 'project' && (
              <div style={{ maxWidth: 820 }}>
                <p className="note" style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <MapIcon size={15} /> The Architect writes this from the code and reads it again after every merge. Every agent reads it first, then opens only the files it needs.
                </p>
                <ReadingBar reading={data.data.reading} />
                {data.data.map.map((m) => (
                  <div className="maprow" key={m.area}>
                    <b>{m.area}</b>
                    <span>{m.detail}</span>
                  </div>
                ))}
              </div>
            )}
            {view === 'lessons' && (
              <div style={{ maxWidth: 820 }}>
                <p className="note" style={{ marginBottom: 8 }}>Learned from bugs and reviews. Each lesson makes the next ticket better.</p>
                {lessons.length === 0 && <p className="note">No lessons yet.</p>}
                {lessons.map((l) => (
                  <div className="lesson" key={l.id}>
                    <span className="glyph sm"><Lightbulb size={12} /></span>
                    <span>
                      {l.text} <span className="note">From {l.from}</span>
                    </span>
                    <span className="mono">{dateShort(l.date)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {view !== 'project' && view !== 'lessons' && <Detail pick={pick} decisions={decisions} tickets={tickets} impact={data.data.impact ?? []} onPick={setPick} />}
      </div>
    </>
  );
}

/* ── Stack: the technologies in the code, why each is there, and the patterns the code follows ── */

const ROLES: { role: TechRole; label: string }[] = [
  { role: 'Language', label: 'Language and runtime' },
  { role: 'Framework', label: 'App framework' },
  { role: 'Interface', label: 'Screens' },
  { role: 'Data', label: 'Data' },
  { role: 'Services', label: 'Outside services' },
  { role: 'Testing', label: 'Testing' },
  { role: 'Tooling', label: 'Tooling' },
];

function StackView({ data, picked, onPick }: { data: ArchitectureResponse; picked: string | null; onPick(p: Pick): void }) {
  const unchosen = data.stack.filter((t) => !t.decisions.length && !t.via).length;
  const came = data.stack.filter((t) => !t.decisions.length && t.via).length;
  return (
    <div className="stackv">
      <ReadingBar reading={data.reading} />
      <div className="stack-sum">
        <span>
          <b>{data.stack.length}</b> technologies in the code
        </span>
        <span>
          <b>{data.stack.length - unchosen - came}</b> chosen by a saved decision
        </span>
        {came > 0 && (
          <span>
            <b>{came}</b> came with one of those
          </span>
        )}
        {unchosen > 0 && (
          <span className="ahead">
            <b>{unchosen}</b> picked while building, no decision yet
          </span>
        )}
        <span>
          <b>{data.patterns.length}</b> design patterns
        </span>
      </div>
      {data.stack.length === 0 && <p className="note">None found yet. The Architect lists them when it reads the code.</p>}
      <section className="stack-group">
        <h3>Technologies</h3>
        <div className="techs">
          {ROLES.flatMap((r) => data.stack.filter((t) => t.role === r.role)).map((t) => (
            <TechCard key={t.name} t={t} picked={picked} onPick={onPick} />
          ))}
        </div>
      </section>

      <section className="stack-group">
        <h3>Design patterns the code follows</h3>
        {data.patterns.length === 0 && <p className="note">Not read yet. Press Read the code again, and the Architect lists the patterns a new developer must keep.</p>}
        <div className="patterns">
          {data.patterns.map((p) => (
            <div key={p.name} className="pattern">
              <span className="glyph sm"><Shapes size={13} /></span>
              <div>
                <b>{p.name}</b>
                <p>{p.what}</p>
                <div className="where">
                  {p.where.map((w) => (
                    <code key={w}>{w}</code>
                  ))}
                  {p.decision && (
                    <button className={`pill click ${picked === p.decision ? 'on' : ''}`} onClick={() => onPick({ kind: 'adr', id: p.decision! })}>
                      From {p.decision}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function TechCard({ t, picked, onPick }: { t: StackItem; picked: string | null; onPick(p: Pick): void }) {
  const logo = t.icon ? LOGOS[t.icon] : undefined;
  return (
    <div className={`tech ${t.decisions.some((d) => d === picked) ? 'picked' : ''}`}>
      <div className="tech-head">
        <span className="logo" style={logo ? ({ '--brand': `#${logo.hex}` } as React.CSSProperties) : undefined}>
          {logo ? (
            <svg viewBox="0 0 24 24" aria-hidden="true" className={dark(logo.hex) ? 'ink' : ''}>
              <path d={logo.path} />
            </svg>
          ) : (
            <span className="mono">{t.name.slice(0, 2)}</span>
          )}
        </span>
        <span className="tech-name">
          <b>{t.name}</b>
          {t.version && <span className="mono">v{t.version}</span>}
        </span>
        <span className="tech-role">{ROLES.find((r) => r.role === t.role)?.label}</span>
      </div>
      <p className={t.why ? '' : 'note'}>{t.why ?? 'Not explained yet. The Architect fills this in when it reads the code.'}</p>
      <div className="tech-foot">
        {t.decisions.length ? (
          t.decisions.map((d) => (
            <button key={d} className={`pill click ${picked === d ? 'on' : ''}`} onClick={() => onPick({ kind: 'adr', id: d })}>
              Chosen in {d}
            </button>
          ))
        ) : t.via ? (
          t.via.decisions.map((d) => (
            <button key={d} className={`pill click ${picked === d ? 'on' : ''}`} onClick={() => onPick({ kind: 'adr', id: d })} title={`Choosing ${t.via!.name} chose ${t.name} too`}>
              Comes with {t.via!.name} · {d}
            </button>
          ))
        ) : (
          <TechDecision t={t} />
        )}
      </div>
    </div>
  );
}

/** A technology picked while building: the Architect can write its decision, for the person to approve. */
function TechDecision({ t }: { t: StackItem }) {
  const act = useAct();
  const send = (what: 'write' | 'approve' | 'discard', done?: string) => act.mutate({ path: '/api/v1/architecture/decide', body: { tech: t.name, do: what }, done });
  const d = t.draft;
  if (d?.status === 'writing' || (act.isPending && !d)) {
    return (
      <span className="pill nodecision">
        <Loader2 size={12} className="spin" /> The Architect is writing it
      </span>
    );
  }
  if (d?.status === 'ready' && d.decision) {
    const x = d.decision;
    return (
      <div className="techdraft">
        <span className="lbl">Decision for you to approve</span>
        <b>{x.title}</b>
        <p>
          <span className="note">Chosen:</span> {x.chosen}
        </p>
        <p>{x.why}</p>
        {x.options.filter((o) => o !== x.chosen).length > 0 && (
          <p className="note">Also looked at: {x.options.filter((o) => o !== x.chosen).join('; ')}</p>
        )}
        <div className="row">
          <button className="btn sm pri" disabled={act.isPending} onClick={() => send('approve', 'Saved as a decision. Every new ticket follows it now.')}>
            <Check size={13} /> Approve
          </button>
          <button className="btn sm" disabled={act.isPending} onClick={() => send('discard')}>
            Discard
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <span className="pill nodecision" title={d?.status === 'failed' ? `The last try stopped: ${d.error ?? ''}` : 'The Builder added it while building; nobody wrote down why.'}>
        {d?.status === 'failed' ? 'Writing stopped, try again' : 'Picked while building'}
      </span>
      <button className="btn sm" onClick={() => send('write', `The Architect is writing a decision for ${t.name}.`)}>
        Save as a decision
      </button>
    </>
  );
}

/** Near-black brand colours (Next.js, Prisma) take the text colour, so they show in the dark theme too. */
function dark(hex: string): boolean {
  const n = parseInt(hex, 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 60;
}

function ReadingBar({ reading }: { reading?: ArchitectureResponse['reading'] }) {
  const act = useAct();
  const busy = reading?.status === 'pending' || reading?.status === 'running' || act.isPending;
  return (
    <div className={`reading ${reading?.status === 'failed' ? 'bad' : ''}`}>
      {busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
      <span>
        {busy
          ? 'The Architect is reading the code. This takes a minute or two.'
          : reading?.status === 'failed'
            ? `The last read stopped: ${reading.error ?? 'unknown error'}`
            : reading?.at
              ? `Read from the code ${ago(reading.at)}. It is read again after every merge.`
              : 'Not read from the code yet.'}
      </span>
      <span className="grow" />
      <button className="btn sm" disabled={busy} onClick={() => act.mutate({ path: '/api/v1/architecture/read', done: 'The Architect is reading the code.' })}>
        <RefreshCw size={13} /> Read the code again
      </button>
    </div>
  );
}

function Stat({ n, label, hint }: { n: number; label: string; hint: string }) {
  return (
    <div className="arch-stat" title={hint}>
      <b>{n}</b>
      <span>{label}</span>
      <small>{hint}</small>
    </div>
  );
}

function Legend({ view }: { view: ArchView }) {
  return view === 'map' ? (
    <div className="arch-legend note">
      <span><i className="lg arrow" /> Built on</span>
      <span><i className="lg arrow replaces" /> Replaces</span>
      <span><i className="lg chip made" /> Ticket that made it</span>
      <span><i className="lg chip" /> Ticket that followed it</span>
      <span><i className="lg chip ahead" /> Will follow it, not built yet</span>
      <span><Check size={12} strokeWidth={3} /> Checked by a test</span>
    </div>
  ) : (
    <div className="arch-legend note">
      <span><i className="lg node" /> Made the decision</span>
      <span><i className="lg dot" /> Its design followed it</span>
      <span><i className="lg dot open" /> Will follow it, not built yet</span>
      <span><i className="lg link" /> Built on an older one</span>
      <span><i className="lg link replaces" /> Replaces an older one</span>
    </div>
  );
}

/* ── Map: decisions flow left to right, from starting points to what was built on them ── */

const CARD_H = 112;
const GAP_Y = 18;
const PAD = 16;
const TOP = 34;

function DecisionMap({
  decisions,
  tickets,
  visible,
  related,
  picked,
  onPick,
  onHover,
}: {
  decisions: Decision[];
  tickets: TimelineTicket[];
  visible: (d: Decision) => boolean;
  related: Set<string> | null;
  picked: string | null;
  onPick: (p: Pick) => void;
  onHover: (id: string | null) => void;
}) {
  const [box, setBox] = useState(1100);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ids = new Set(decisions.map((d) => d.id));
  const parents = (d: Decision) => [...(d.buildsOn ?? []), ...(d.replaces ? [d.replaces] : [])].filter((p) => ids.has(p));
  const depth = new Map<string, number>();
  const depthOf = (d: Decision, seen = new Set<string>()): number => {
    if (depth.has(d.id)) return depth.get(d.id)!;
    if (seen.has(d.id)) return 0;
    seen.add(d.id);
    const ps = parents(d).map((p) => decisions.find((x) => x.id === p)!);
    const n = ps.length ? 1 + Math.max(...ps.map((p) => depthOf(p, seen))) : 0;
    depth.set(d.id, n);
    return n;
  };
  const order = [...DECISION_AREAS, 'Other'];
  const cols: Decision[][] = [];
  for (const d of decisions) (cols[depthOf(d)] ??= []).push(d);
  // Cards share the width so every level fits on screen; a very deep history scrolls sideways.
  // More levels: tighter gaps and narrower cards, so the newest decisions stay in view.
  const GAP_X = cols.length > 4 ? 30 : 46;
  const CARD_W = Math.max(150, Math.min(270, (box - PAD * 2 - Math.max(0, cols.length - 1) * GAP_X) / Math.max(1, cols.length)));
  for (const c of cols) c?.sort((a, b) => order.indexOf(a.area ?? 'Other') - order.indexOf(b.area ?? 'Other') || num(a.id) - num(b.id));
  const tallest = Math.max(1, ...cols.map((c) => c?.length ?? 0));
  const height = TOP + tallest * (CARD_H + GAP_Y) + PAD;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((c, i) => {
    const offset = ((tallest - (c?.length ?? 0)) * (CARD_H + GAP_Y)) / 2;
    c?.forEach((d, j) => pos.set(d.id, { x: PAD + i * (CARD_W + GAP_X), y: TOP + offset + j * (CARD_H + GAP_Y) }));
  });
  const width = PAD * 2 + cols.length * CARD_W + Math.max(0, cols.length - 1) * GAP_X;
  const off = (key: string) => related !== null && !related.has(key);
  const LAYER = ['Starting points', 'Built on them', 'One more level', 'And on those', 'And further'];

  return (
    <div className="dmap" ref={ref} onMouseLeave={() => onHover(null)}>
      <div className="dmap-canvas" style={{ width, height }}>
        {cols.map((_, i) => (
          <span key={i} className="dmap-layer" style={{ left: PAD + i * (CARD_W + GAP_X), width: CARD_W }}>
            {LAYER[i] ?? `Level ${i + 1}`}
          </span>
        ))}
        <svg width={width} height={height} className="dmap-edges">
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 1 L9 5 L0 9 z" className="arrhead" />
            </marker>
            <marker id="arr-r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 1 L9 5 L0 9 z" className="arrhead replaces" />
            </marker>
          </defs>
          {decisions.flatMap((d) => {
            const to = pos.get(d.id);
            if (!to || !visible(d)) return [];
            const links = [...(d.buildsOn ?? []).map((p) => ({ p, kind: 'built' })), ...(d.replaces ? [{ p: d.replaces, kind: 'replaces' }] : [])];
            return links.map(({ p, kind }) => {
              const from = pos.get(p);
              const pd = decisions.find((x) => x.id === p);
              if (!from || !pd || !visible(pd)) return null;
              const x1 = from.x + CARD_W;
              const y1 = from.y + CARD_H / 2;
              const x2 = to.x - 2;
              const y2 = to.y + CARD_H / 2;
              const dx = Math.max(40, (x2 - x1) / 2);
              const lit = related !== null && related.has(d.id) && related.has(p);
              return (
                <path
                  key={`${p}-${d.id}-${kind}`}
                  className={`edge ${kind} ${off(d.id) || off(p) ? 'off' : ''} ${lit ? 'lit' : ''}`}
                  d={`M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                  markerEnd={`url(#${kind === 'replaces' ? 'arr-r' : 'arr'})`}
                />
              );
            });
          })}
        </svg>
        {decisions.map((d) => {
          const p = pos.get(d.id)!;
          const followers = d.tickets.filter((t) => t !== d.from);
          const ahead = tickets.filter((t) => (t.state === 'designed' || t.state === 'coming') && t.follows.includes(d.id) && !followers.includes(t.id));
          const chips = [d.from === 'Project scan' ? 'Scan' : d.from, ...followers];
          const extra = chips.length + ahead.length - 6;
          return (
            <button
              key={d.id}
              className={`dcard area-${(d.area ?? 'Other').toLowerCase()} ${visible(d) ? '' : 'later'} ${off(d.id) ? 'off' : ''} ${picked === d.id ? 'picked' : ''} ${d.replacedBy ? 'old' : ''}`}
              style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H }}
              onClick={() => onPick({ kind: 'adr', id: d.id })}
              onMouseEnter={() => onHover(d.id)}
            >
              <span className="dhead">
                <i />
                <span className="mono">{d.id}</span>
                <span className="darea">{d.area ?? 'Other'}</span>
                {d.checkedBy?.passing && <Check size={13} strokeWidth={3} className="dtest" aria-label="Checked by a test" />}
              </span>
              <b className="dtitle">{d.title}</b>
              <span className="dchips">
                {d.replacedBy ? (
                  <span className="dchip ahead">Replaced by {d.replacedBy}</span>
                ) : (
                  <>
                    {chips.slice(0, 6).map((c, i) => (
                      <span key={c} className={`dchip ${i === 0 ? 'made' : ''}`} title={i === 0 ? 'Made this decision' : 'Its design followed it'}>{c}</span>
                    ))}
                    {ahead.slice(0, Math.max(0, 6 - chips.length)).map((t) => (
                      <span key={t.id} className="dchip ahead" title="Designed, not built yet: will follow it">{t.id}</span>
                    ))}
                    {extra > 0 && <span className="dchip">+{extra}</span>}
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Timeline: one track per decision, one column per ticket ── */

const ROW = 30;
const LANE_GAP = 26;
const LEFT = 250;
const HEAD = 62;

function Timeline({
  decisions,
  areas,
  shown,
  related,
  picked,
  onPick,
  g,
}: {
  decisions: Decision[];
  tickets: TimelineTicket[];
  areas: Set<DecisionArea | 'Other'>;
  shown: number;
  related: Set<string> | null;
  picked: string | null;
  onPick: (p: Pick) => void;
  g: ReturnType<typeof columns>;
}) {
  const [box, setBox] = useState(1000);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const last = g.cols.length;
  // Columns share the width so every ticket shows; a long history scrolls sideways.
  const COL = Math.max(40, Math.min(64, (box - LEFT - 24) / Math.max(1, last)));
  const visible = g.rows.filter((r) => areas.size === 0 || areas.has(r.area));
  const rowY = new Map<string, number>();
  let y = HEAD + 8;
  let lane = '';
  const laneTops: { area: string; y: number }[] = [];
  for (const r of visible) {
    if (r.area !== lane) {
      lane = r.area;
      y += LANE_GAP;
      laneTops.push({ area: r.area, y: y - 18 });
    }
    rowY.set(r.d.id, y);
    y += ROW;
  }
  const height = y + 12;
  const width = LEFT + last * COL + 16;
  const x = (col: number) => LEFT + col * COL + COL / 2;
  const on = (col: number) => col < shown;
  const dim = (key: string) => related !== null && !related.has(key);

  return (
    <div className="arch-graph" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="Decisions over time, and the tickets that followed them">
        {g.cols.map((c, i) => (
          <g key={c.key} className={`col state-${c.t?.state ?? 'scan'} ${on(i) ? '' : 'later'} ${dim(c.key) ? 'dim' : ''}`} onClick={() => c.t && onPick({ kind: 'ticket', id: c.key })}>
            <rect className="colbg" x={LEFT + i * COL + 2} y={6} width={COL - 4} height={height - 12} rx={10} />
            <text className="colid" x={x(i)} y={26} textAnchor="middle">{c.label}</text>
            <circle className="colstate" cx={x(i)} cy={42} r={4} />
            <title>{c.t ? `${c.t.id} · ${c.t.title}\n${STATE_NAME[c.t.state]}` : 'What the Architect found when it first read the project'}</title>
          </g>
        ))}
        {laneTops.map((l) => (
          <text key={l.area} className={`lane area-${l.area.toLowerCase()}`} x={14} y={l.y}>{l.area.toUpperCase()}</text>
        ))}
        {visible.map((r) => {
          const yy = rowY.get(r.d.id)!;
          const start = g.colOf(r.d.from);
          if (!on(start)) return null;
          const endCol = r.d.replacedBy ? g.colOf(ticketOfAdr(decisions, r.d.replacedBy)) : last - 1;
          const end = Math.min(endCol, shown - 1);
          const cls = `track area-${r.area.toLowerCase()} ${dim(r.d.id) ? 'dim' : ''} ${picked === r.d.id ? 'picked' : ''}`;
          return (
            <g key={r.d.id} className={cls} onClick={() => onPick({ kind: 'adr', id: r.d.id })}>
              <rect className="hit" x={0} y={yy - ROW / 2} width={width} height={ROW} />
              <text className="name" x={14} y={yy + 4}>
                <tspan className="rid">{r.d.id}</tspan> {short(r.d.title, 28)}
              </text>
              <line className={`rail ${r.d.replacedBy && endCol < shown ? 'gone' : ''}`} x1={x(start)} x2={x(end) + (r.d.replacedBy ? 0 : COL / 2)} y1={yy} y2={yy} />
              {g.cols.map((c, i) =>
                i > start && on(i) && c.t?.follows.includes(r.d.id) ? (
                  <circle key={c.key} className={`dot ${c.t.state === 'designed' || c.t.state === 'coming' ? 'open' : ''}`} cx={x(i)} cy={yy} r={5}>
                    <title>{`${c.t.id} followed ${r.d.id}`}</title>
                  </circle>
                ) : null,
              )}
              <circle className={`node ${r.d.replacedBy ? 'old' : ''}`} cx={x(start)} cy={yy} r={8} />
              {r.d.checkedBy?.passing && <path className="tick" d={`M${x(start) - 3.5} ${yy} l2.5 2.6 l4.8 -5`} />}
              <title>{`${r.d.id} · ${r.d.title}\nChosen: ${r.d.chosen}`}</title>
            </g>
          );
        })}
        {visible.flatMap((r) => {
          const to = rowY.get(r.d.id)!;
          const col = g.colOf(r.d.from);
          if (!on(col)) return [];
          const links = [...(r.d.buildsOn ?? []).map((b) => ({ b, kind: 'built' })), ...(r.d.replaces ? [{ b: r.d.replaces, kind: 'replaces' }] : [])];
          return links.map(({ b, kind }) => {
            const from = rowY.get(b);
            if (from === undefined) return null;
            const dir = to > from ? 1 : -1;
            return (
              <g key={`${r.d.id}-${b}-${kind}`} className={`link ${kind} ${dim(r.d.id) || dim(b) ? 'dim' : ''}`}>
                <path d={`M${x(col)} ${from + 6 * dir} L${x(col)} ${to - 9 * dir}`} />
                <circle cx={x(col)} cy={from} r={3.2} />
              </g>
            );
          });
        })}
      </svg>
    </div>
  );
}

/* ── the lists under the map ── */

function Inherit({ decisions, tickets, onPick }: { decisions: Decision[]; tickets: TimelineTicket[]; onPick: (p: Pick) => void }) {
  return (
    <div className="arch-cards">
      <div className="arch-card">
        <h4>What a new ticket inherits today</h4>
        <p className="note">The Architect, the Builder and the Reviewer read all of these before they start.</p>
        {[...DECISION_AREAS, 'Other' as const].map((a) => {
          const list = decisions.filter((d) => !d.replacedBy && (d.area ?? 'Other') === a);
          return list.length ? (
            <div key={a} className={`inherit area-${a.toLowerCase()}`}>
              <b><i /> {a}</b>
              {list.map((d) => (
                <button key={d.id} onClick={() => onPick({ kind: 'adr', id: d.id })}>
                  <span className="mono">{d.id}</span> {d.title}
                </button>
              ))}
            </div>
          ) : null;
        })}
      </div>
      <div className="arch-card">
        <h4>Coming next</h4>
        <p className="note">Tickets not built yet, and the past decisions that will shape them.</p>
        {tickets.filter((t) => t.state === 'designed' || t.state === 'coming').map((t) => (
          <div key={t.id} className="coming">
            <button onClick={() => onPick({ kind: 'ticket', id: t.id })}>
              <span className="mono">{t.id}</span> {t.title}
            </button>
            <span className="pills">
              {t.follows.length ? (
                t.follows.map((f) => (
                  <button key={f} className="pill click" onClick={() => onPick({ kind: 'adr', id: f })}>{f}</button>
                ))
              ) : (
                <span className="note">Not designed yet. Will read the {decisions.filter((d) => !d.replacedBy).length} rules in force.</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionTable({ decisions, picked, onPick }: { decisions: Decision[]; picked: string | null; onPick: (p: Pick) => void }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 90 }}>ID</th>
          <th>Decision</th>
          <th style={{ width: 110 }}>Area</th>
          <th style={{ width: 120 }}>From</th>
          <th style={{ width: 150 }}>Checked by</th>
        </tr>
      </thead>
      <tbody>
        {[...decisions].reverse().map((d) => (
          <tr key={d.id} className={`click ${picked === d.id ? 'on' : ''}`} onClick={() => onPick({ kind: 'adr', id: d.id })}>
            <td className="mono">{d.id}</td>
            <td style={{ fontWeight: picked === d.id ? 600 : 500, color: d.replacedBy ? 'var(--dim)' : undefined }}>
              {d.replacedBy ? <s>{d.title}</s> : d.title} {d.replacedBy && <span className="pill wait">Replaced by {d.replacedBy}</span>}
            </td>
            <td><span className={`areatag area-${(d.area ?? 'Other').toLowerCase()}`}><i /> {d.area ?? 'Other'}</span></td>
            <td style={{ color: 'var(--muted)', fontSize: 13 }}>{d.from}</td>
            <td>
              {!d.checkedBy ? (
                <span className="pill wait">Not checkable</span>
              ) : d.checkedBy.passing ? (
                <span className="pill ok"><Check size={13} strokeWidth={2.5} /> A {d.checkedBy.kind}</span>
              ) : (
                <span className="pill you">Test being written</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── the side panel ── */

function Detail({ pick, decisions, tickets, impact, onPick }: { pick: Pick; decisions: Decision[]; tickets: TimelineTicket[]; impact: ImpactCheck[]; onPick: (p: Pick) => void }) {
  const adr = (id: string) => (
    <button key={id} className="pill click" onClick={() => onPick({ kind: 'adr', id })}>{id}</button>
  );
  const tk = (id: string) => {
    const t = tickets.find((x) => x.id === id);
    return (
      <button key={id} className={`pill click st-${t?.state ?? 'shipped'}`} title={t ? `${t.title} · ${STATE_NAME[t.state]}` : id} onClick={() => onPick({ kind: 'ticket', id })}>
        {id}
      </button>
    );
  };

  if (pick?.kind === 'ticket') {
    const t = tickets.find((x) => x.id === pick.id);
    if (!t) return <aside className="sidepanel arch-side"><p className="note">That ticket is not on this board.</p></aside>;
    return (
      <aside className="sidepanel arch-side">
        <span className="note mono">{t.id} · {STATE_NAME[t.state]}{t.release ? ` · ${t.release}` : ''}</span>
        <h3>{t.title}</h3>
        <div className="lbl">Decision it made</div>
        {t.made ? <p style={{ fontSize: 13.5 }}>{adr(t.made)} {decisions.find((d) => d.id === t.made)?.title}</p> : <p className="note">None. It worked inside the rules it had.</p>}
        <div className="lbl">Past decisions its design followed</div>
        {t.follows.length ? <div className="pills">{t.follows.map(adr)}</div> : <p className="note">{t.state === 'coming' ? 'Not designed yet. When it is, it reads every rule in force.' : 'None recorded.'}</p>}
        <p style={{ marginTop: 18 }}>
          <Link to="/board" search={{ ticket: t.id }} className="btn">Open the ticket</Link>
        </p>
      </aside>
    );
  }

  const d = pick?.kind === 'adr' ? decisions.find((x) => x.id === pick.id) : undefined;
  if (!d) {
    return (
      <aside className="sidepanel arch-side">
        <span className="note mono">HOW IT WORKS</span>
        <h3>Every choice is remembered</h3>
        <p style={{ fontSize: 13.5, marginTop: 8 }}>
          When a ticket needs a technical choice, the Architect writes it with the options and the why. You approve it with the design. From then on it is a rule:
          every later ticket reads it, and the tickets whose design used it are linked here.
        </p>
        <p style={{ fontSize: 13.5, marginTop: 10 }}>A new decision can build on an older one, or replace it. A replaced decision stops being a rule, but its history stays.</p>
        <p className="note" style={{ marginTop: 14 }}>Point at a decision to light up what it touched. Click it for the full story. Press Play to watch the project grow.</p>
      </aside>
    );
  }
  const built = decisions.filter((x) => x.buildsOn?.includes(d.id));
  const later = d.tickets.filter((t) => t !== d.from);
  const ahead = tickets.filter((t) => (t.state === 'designed' || t.state === 'coming') && t.follows.includes(d.id) && !later.includes(t.id));
  return (
    <aside className="sidepanel arch-side">
      <span className="note mono">
        {d.id} · {d.area ?? 'Other'} · {d.proposed ? 'found in the code, not approved yet' : `approved by ${d.approvedBy}`} · {dateShort(d.date)}
      </span>
      <h3>{d.title}</h3>
      {d.proposed && (
        <div className="box" style={{ borderColor: 'var(--you-line)', background: 'var(--you-soft)', marginTop: 8 }}>
          <b>Proposed, not a rule yet.</b> It becomes one when you approve the <Link to="/overview">Overview</Link>.
        </div>
      )}
      {d.replacedBy && (
        <div className="box" style={{ borderColor: 'var(--you-line)', background: 'var(--you-soft)', marginTop: 8 }}>
          <b>No longer a rule.</b> Replaced by {adr(d.replacedBy)}.
        </div>
      )}
      <div className="lbl">Chosen</div>
      <p style={{ fontSize: 13.5, fontWeight: 600 }}>{d.chosen}</p>
      <div className="lbl">Why</div>
      <p style={{ fontSize: 13.5 }}>{d.why}</p>
      {d.options.length > 1 && (
        <>
          <div className="lbl">Also looked at</div>
          {d.options.filter((o) => o !== d.chosen).map((o) => <p key={o} className="note" style={{ fontSize: 13 }}>{o}</p>)}
        </>
      )}
      <div className="lbl">Where it came from</div>
      <div className="pills" style={{ alignItems: 'center' }}>
        {d.from === 'Project scan' ? <span className="pill">Project scan</span> : tk(d.from)}
        {(d.buildsOn ?? []).length > 0 && <span className="note">built on</span>}
        {(d.buildsOn ?? []).map(adr)}
        {d.replaces && <span className="note">replaces</span>}
        {d.replaces && adr(d.replaces)}
      </div>
      <div className="lbl">What it shaped</div>
      {later.length || built.length ? (
        <>
          {later.length > 0 && <p className="note" style={{ marginBottom: 6 }}>Tickets whose design followed it</p>}
          <div className="pills">{later.map(tk)}</div>
          {built.length > 0 && <p className="note" style={{ margin: '10px 0 6px' }}>Decisions built on it</p>}
          <div className="pills">{built.map((b) => adr(b.id))}</div>
        </>
      ) : (
        <p className="note">Nothing yet. Every new ticket reads it.</p>
      )}
      {ahead.length > 0 && (
        <>
          <div className="lbl">Still ahead</div>
          <p className="note" style={{ marginBottom: 6 }}>Designed, not built yet. They will follow it.</p>
          <div className="pills">{ahead.map((t) => tk(t.id))}</div>
        </>
      )}
      <ImpactBox d={d} check={impact.find((c) => c.adr === d.id)} tk={tk} />
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
    </aside>
  );
}

/** Each approved decision is checked against the tickets planned before it, so older plans do not miss it. */
function ImpactBox({ d, check, tk }: { d: Decision; check?: ImpactCheck; tk: (id: string) => React.ReactNode }) {
  const act = useAct();
  if (d.replacedBy) return null;
  const busy = check?.status === 'pending' || check?.status === 'running' || act.isPending;
  const run = () => act.mutate({ path: '/api/v1/architecture/impact', body: { adr: d.id }, done: `The Architect is checking the open tickets against ${d.id}.` });
  return (
    <>
      <div className="lbl">Tickets planned before it</div>
      {busy ? (
        <p className="note" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Loader2 size={13} className="spin" /> The Architect is checking the open tickets.
        </p>
      ) : check?.status === 'done' ? (
        <>
          <p className="note" style={{ marginBottom: 6 }}>
            {check.checked?.length
              ? `Checked ${check.checked.length} open ${check.checked.length === 1 ? 'ticket' : 'tickets'} ${check.at ? ago(check.at) : ''}. ${check.affected?.length ? 'These need a change, waiting for you:' : 'None need a change.'}`
              : 'No open ticket was planned before it.'}
          </p>
          <div className="pills">{(check.affected ?? []).map(tk)}</div>
          <button className="btn sm quiet" style={{ marginTop: 8 }} onClick={run}>Check again</button>
        </>
      ) : (
        <>
          <p className="note" style={{ marginBottom: 8 }}>
            {check?.status === 'failed' ? `The last check stopped: ${check.error ?? ''}` : 'Not checked yet. Plans written before it may still do it the old way.'}
          </p>
          <button className="btn sm" onClick={run}>Check open tickets</button>
        </>
      )}
    </>
  );
}

/* ── layout and links ── */

interface Col { key: string; label: string; t?: TimelineTicket }
interface Row { d: Decision; area: DecisionArea | 'Other' }

/** One column per ticket in order (and the first scan), one row per decision grouped by area. */
function columns(decisions: Decision[], tickets: TimelineTicket[]) {
  const cols: Col[] = [];
  if (decisions.some((d) => !tickets.some((t) => t.id === d.from))) cols.push({ key: 'scan', label: 'Scan' });
  for (const t of tickets) cols.push({ key: t.id, label: t.id, t });
  const colOf = (from: string) => {
    const i = cols.findIndex((c) => c.key === from);
    return i < 0 ? 0 : i;
  };
  const order = [...DECISION_AREAS, 'Other'];
  const rows: Row[] = decisions
    .map((d) => ({ d, area: (d.area ?? 'Other') as Row['area'] }))
    .sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area) || colOf(a.d.from) - colOf(b.d.from));
  return { cols, rows, colOf };
}

function ticketOfAdr(decisions: Decision[], id: string): string {
  return decisions.find((d) => d.id === id)?.from ?? '';
}

/** Everything a picked decision or ticket touched: up the chain it was built on, and down to what it shaped. */
function relatedTo(pick: Pick, decisions: Decision[], tickets: TimelineTicket[]): Set<string> | null {
  if (!pick) return null;
  const out = new Set<string>([pick.id]);
  const parents = (d: Decision) => [...(d.buildsOn ?? []), ...(d.replaces ? [d.replaces] : [])];
  if (pick.kind === 'ticket') {
    const t = tickets.find((x) => x.id === pick.id);
    for (const f of t?.follows ?? []) out.add(f);
    if (t?.made) out.add(t.made);
    return out;
  }
  const up = [pick.id];
  while (up.length) {
    const id = up.pop();
    const d = decisions.find((x) => x.id === id);
    for (const p of d ? parents(d) : []) if (!out.has(p)) (out.add(p), up.push(p));
  }
  const down = [pick.id];
  while (down.length) {
    const id = down.pop()!;
    for (const d of decisions) if (parents(d).includes(id) && !out.has(d.id)) (out.add(d.id), down.push(d.id));
  }
  for (const id of [...out]) {
    const d = decisions.find((x) => x.id === id);
    if (d && id === pick.id) for (const t of d.tickets) out.add(t);
    if (d) out.add(d.from);
  }
  for (const t of tickets) if (t.follows.includes(pick.id)) out.add(t.id);
  return out;
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function num(id: string): number {
  return Number(id.replace(/\D/g, '')) || 0;
}

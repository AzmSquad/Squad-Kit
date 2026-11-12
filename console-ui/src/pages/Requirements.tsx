import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Check, FileText, ListTree, MessageCircle, Pause, Pencil, Play, Plus, Send, Trash2 } from 'lucide-react';
import type { BreakdownLevel, BreakdownRow, BreakdownView } from '../api/requirements-types';
import {
  allStories,
  barParts,
  basisWords,
  buildEstimate,
  builtWords,
  countWords,
  estimateBits,
  findPart,
  firstSentence,
  jobBusy,
  leftWords,
  openAtFirst,
  rowChip,
  sendStep,
  sendStepWords,
  statusChip,
  stopTag,
  type Tone,
} from '../lib/requirements';
import { sendPlanOf, useBreakdown, useBreakdowns, useReqAct } from '../lib/requirementsData';
import { useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { PHONE, useMedia } from '../lib/popups';
import { shellQuote } from '../lib/text';
import { Cmd, Written } from '../components/ui';
import { langProps, typedDir } from '../lib/lang';
import { CarryOn, ReadingCard, FailedCard, QuestionsView } from '../components/BreakdownRead';
import { DecidedPanel, ItemPanel, Tree, canEdit } from '../components/BreakdownTree';
import { BreakdownMap } from '../components/BreakdownMap';
import {
  AddBrdDialog,
  AddPartDialog,
  AskAnalystDialog,
  BrdViewer,
  BreakdownMenu,
  DeleteBreakdownDialog,
  LeftOutDialog,
  SendDialog,
  plainError,
  useOpenRef,
  type MenuChoice,
} from '../components/BreakdownDialogs';
import { TicketDrawer } from './TicketDrawer';
import { BrokenTickets } from './Board';
import '../styles/requirements.css';

/**
 * The Requirements page: every BRD the person added, each broken down into epics, features and stories. One
 * breakdown goes from reading, to questions, to a tree to edit and approve, to building by itself.
 */

const base = (id: string) => `/api/v1/requirements/${encodeURIComponent(id)}`;

function Chip({ text, tone }: { text: string; tone: Tone }) {
  return (
    <span className={`rq-chip-s ${tone}`}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

/* ── The list ───────────────────────────────────────────── */

export function RequirementsPage() {
  const list = useBreakdowns();
  const board = useBoard();
  const me = board.data?.ready ? board.data.meta.user?.name : undefined;
  const [adding, setAdding] = useState(false);
  const rows = list.data?.breakdowns ?? [];
  const broken = board.data?.brokenRecords?.filter((b) => b.kind === 'breakdown') ?? [];
  return (
    <>
      <div className="top">
        <h1>Requirements</h1>
        <span className="grow" />
        <Cmd text="squad requirements list" />
        <button className="btn pri" onClick={() => setAdding(true)}>
          <Plus size={15} /> Add a BRD
        </button>
      </div>
      <div className="scroll">
        <div className="page rq-list">
          {broken.length > 0 && <BrokenTickets list={broken} label="Breakdowns that could not be read" />}
          {list.isLoading ? (
            <p className="note">Reading your breakdowns…</p>
          ) : list.isError ? (
            <p className="rq-err" role="alert">
              squad-kit could not read the breakdowns. {plainError(list.error)}
            </p>
          ) : !rows.length ? (
            <div className="rq-empty">
              <span className="ring">
                <ListTree size={20} />
              </span>
              <div>
                <h2>Turn a BRD into stories the squad can build</h2>
                <p>
                  Add your business requirements document: a PDF, a Word file, Markdown or text. The Analyst reads it, asks you only about parts that are missing or that clash, and breaks it into epics, features and stories for you to edit and approve. Nothing is built or sent anywhere until you approve.
                </p>
                <button className="btn pri" onClick={() => setAdding(true)}>
                  <Plus size={15} /> Add a BRD
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="note rq-lead">Each BRD you add is one breakdown. Open one to edit it, approve it, send it or build it.</p>
              <div className="rq-rows">
                {rows.map((r) => (
                  <ListRow key={r.id} r={r} me={me} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {adding && <AddBrdDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function ListRow({ r, me }: { r: BreakdownRow; me?: string }) {
  const [deleting, setDeleting] = useState(false);
  const chip = rowChip(r);
  const c = r.counts;
  const started = r.status === 'approved' && (c.merged > 0 || c.building > 0 || c.needsYou > 0 || r.building);
  const mine = !me || r.owner.trim().toLowerCase() === me.trim().toLowerCase();
  // The menu sits beside the row's link, not in it: a button inside a link would open the breakdown too.
  return (
    <div className={`rq-rowcard ${r.status === 'questions' || c.needsYou ? 'you' : ''}`}>
      <RowLink r={r} chip={chip} started={started} />
      {mine && (
        <BreakdownMenu
          label={`More actions for ${r.id}`}
          choices={[{ key: 'delete', danger: true, title: `squad requirements delete ${r.id}`, label: <><Trash2 size={15} /> Delete breakdown…</>, onPick: () => setDeleting(true) }]}
        />
      )}
      {deleting && <DeleteBreakdownDialog id={r.id} title={r.title} onClose={() => setDeleting(false)} />}
    </div>
  );
}

function RowLink({ r, chip, started }: { r: BreakdownRow; chip: { text: string; tone: Tone }; started: boolean }) {
  const c = r.counts;
  return (
    <Link to="/requirements/$id" params={{ id: r.id }} className="rq-rowlink">
      <span className="rq-rid mono">{r.id}</span>
      <span className="rq-rname">
        <Written as="b" text={r.title} />
        <span {...langProps(r.source.name)}>
          <FileText size={12} aria-hidden="true" /> <Written text={r.source.name} />
        </span>
      </span>
      <span className="rq-rcount">{c.epics || c.stories ? countWords(c) : 'Not broken down yet'}</span>
      <span className="rq-rstate">
        <Chip {...chip} />
        {c.needsYou > 0 && <span className="rq-rneeds">{c.needsYou} {c.needsYou === 1 ? 'needs' : 'need'} you</span>}
      </span>
      <span className="rq-rprog">
        {started && (
          <>
            <span className="rq-pb" aria-hidden="true">
              <b style={{ width: `${c.stories ? Math.round((c.merged / c.stories) * 100) : 0}%` }} />
            </span>
            <span className="rq-meta">
              {c.merged} of {c.stories} merged
            </span>
          </>
        )}
      </span>
    </Link>
  );
}

/* ── One breakdown ──────────────────────────────────────── */

type Dialog = { kind: 'send' } | { kind: 'ask'; item: string; text?: string } | { kind: 'add'; level: BreakdownLevel; under?: string } | { kind: 'leftout' } | { kind: 'delete' } | null;

export function BreakdownPage() {
  const { id } = useParams({ from: '/requirements/$id' });
  const search = useSearch({ from: '/requirements/$id' });
  const navigate = useNavigate({ from: '/requirements/$id' });
  const q = useBreakdown(id);
  const v = q.data;
  const phone = useMedia(PHONE);

  const setSearch = (patch: Partial<typeof search>) => void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });
  const select = (key: string | undefined) => setSearch({ item: key, decided: undefined });
  const openTicket = (ticket: string) => setSearch({ ticket });

  if (q.isLoading) return <div className="center">Opening {id}…</div>;
  if (!v)
    return (
      <div className="center">
        <div>
          <h2>{/404/.test(String(q.error)) ? `No breakdown ${id}` : `squad-kit could not open ${id}`}</h2>
          <p>{/404/.test(String(q.error)) ? 'It may have been deleted.' : plainError(q.error)}</p>
          <p style={{ marginTop: 12 }}>
            <Link to="/requirements" className="btn">
              All breakdowns
            </Link>
          </p>
        </div>
      </div>
    );
  return <Breakdown v={v} search={search} select={select} openTicket={openTicket} setSearch={setSearch} phone={phone} />;
}

interface Search {
  item?: string;
  view?: 'map';
  ticket?: string;
  decided?: boolean;
}

function Breakdown({ v, search, select, openTicket, setSearch, phone }: { v: BreakdownView; search: Search; select(key: string | undefined): void; openTicket(id: string): void; setSearch(p: Partial<Search>): void; phone: boolean }) {
  const act = useReqAct();
  const navigate = useNavigate();
  const { toast } = usePrefs();
  const [dialog, setDialog] = useState<Dialog>(null);
  const doc = useOpenRef(v);
  const [open, setOpen] = useState<Set<string>>(() => openAtFirst(v, search.item));
  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  // The Analyst wrote the first epics while the page was open: open them as they come.
  useEffect(() => {
    if (v.epics.length) setOpen((s) => (s.size ? s : openAtFirst(v, search.item)));
  }, [v.epics.length]);
  // A link to a part (?item=S-14) opens the epic and feature it sits in.
  useEffect(() => {
    const f = findPart(v, search.item);
    if (!f) return;
    setOpen((s) => (s.has(f.epic.key) && (!f.feature || s.has(f.feature.key)) ? s : new Set([...s, f.epic.key, ...(f.feature ? [f.feature.key] : [])])));
  }, [search.item, v.epics.length]);

  const built = v.status === 'ready' || v.status === 'approved';
  const map = search.view === 'map' && built && !phone;
  const mode = v.status === 'approved' ? 'build' : 'plan';
  const selected = findPart(v, search.item) ? search.item : undefined;
  const building = Boolean(v.state.build?.on);
  const chip = statusChip(v);
  const askable = canEdit(v) && !jobBusy(v.state.job);

  // Escape closes the chosen part's panel: from a text field it first leaves the field, and typed changes stay until saved or undone.
  const overlay = Boolean(dialog || search.ticket || doc.viewer !== undefined);
  useEffect(() => {
    if (!selected || overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-veil')) return;
      // The key's own field: the rename box closes itself, a field of the panel is left first.
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return el.closest('.rq-panel') ? el.blur() : undefined;
      if (document.querySelector('.rq-panel[data-dirty="true"]')) return toast('Save or undo your changes first.');
      select(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, overlay]);

  const actions = <Actions v={v} onSend={() => setDialog({ kind: 'send' })} onAsk={() => setDialog({ kind: 'ask', item: v.id })} phone={phone} />;
  const menu: MenuChoice[] = v.mine
    ? [
        // After approval the header has no Ask the Analyst: it stays here while some stories have not started.
        ...(v.status === 'approved' && askable && allStories(v).some(({ story }) => !story.ticket)
          ? [{ key: 'ask', title: `squad requirements redo ${v.id} ${v.id} "<what to change>"`, label: <><MessageCircle size={15} /> Ask the Analyst…</>, onPick: () => setDialog({ kind: 'ask', item: v.id }) }]
          : []),
        { key: 'delete', danger: true, title: `squad requirements delete ${v.id}`, label: <><Trash2 size={15} /> Delete breakdown…</>, onPick: () => setDialog({ kind: 'delete' }) },
      ]
    : [];
  const command = map ? `squad requirements show ${v.id} --map` : v.status === 'approved' && v.mine && v.counts.merged < v.counts.stories ? `squad requirements build ${v.id}${building ? ' --pause' : ''}` : `squad requirements show ${v.id}`;

  const panel = selected ? (
    <ItemPanel
      v={v}
      k={selected}
      onClose={() => select(undefined)}
      onSelect={select}
      onAsk={(item) => setDialog({ kind: 'ask', item })}
      onOpenRef={doc.open}
      onOpenTicket={openTicket}
      onAdd={(level, under) => setDialog({ kind: 'add', level, under })}
    />
  ) : null;
  const decidedPanel = (onClose?: () => void) => <DecidedPanel v={v} onSelect={select} onOpenTicket={openTicket} onClose={onClose} />;

  return (
    <div className={`rq ${phone ? 'phone' : ''}`}>
      <header className="rq-head">
        <div className="rq-h1row">
          <div className="rq-titlecol">
            <div className="rq-crumbs">
              <Link to="/requirements">Requirements</Link> › {v.id}
              {v.status === 'questions' && <> › <Written text={v.title} /></>}
            </div>
            <div className="rq-name">
              <Rename v={v} />
              <Chip {...chip} />
            </div>
          </div>
          <Cmd text={command} keep={command.slice(command.indexOf(v.id))} />
          {built && !phone && (
            <div className="seg rq-viewseg" role="group" aria-label="View">
              <button className={!map ? 'on' : ''} aria-pressed={!map} onClick={() => setSearch({ view: undefined })}>
                Tree
              </button>
              <button className={map ? 'on' : ''} aria-pressed={map} onClick={() => setSearch({ view: 'map' })}>
                Map
              </button>
            </div>
          )}
          {!phone && actions}
          <BreakdownMenu choices={menu} label={`More actions for ${v.id}`} />
        </div>
        {built && <InfoLine v={v} onDecided={() => setSearch({ item: undefined, decided: true })} onLeftOut={() => setDialog({ kind: 'leftout' })} onDoc={() => doc.open()} />}
        {v.status === 'approved' && <BuildRow v={v} />}
        {v.status === 'ready' && v.mine && (v.problems?.length ?? 0) > 0 && (
          <div className="rq-probs" id="rq-probs" role="note">
            <b>Before you approve:</b>
            <ul>
              {v.problems!.slice(0, 4).map((p) => (
                <Written as="li" key={p} text={p} />
              ))}
              {v.problems!.length > 4 && <li>and {v.problems!.length - 4} more</li>}
            </ul>
          </div>
        )}
        {!v.mine && <p className="rq-notmine">{v.owner}'s breakdown: only their squad builds it. You see it read only.</p>}
        <JobLine v={v} />
      </header>

      {!built ? (
        <div className="scroll">
          <div className="rq-pad">
            {v.status === 'failed' ? <FailedCard v={v} /> : v.status === 'questions' ? <QuestionsView v={v} onOpenRef={doc.open} /> : <ReadingCard v={v} />}
            {(v.status === 'drafting' || v.status === 'failed') && v.epics.length > 0 && (
              <div className="rq-sofar">
                <div className="rq-lab">What it wrote so far</div>
                <Tree v={v} mode="plan" open={open} onToggle={toggle} onDecide={openTicket} />
              </div>
            )}
          </div>
        </div>
      ) : map ? (
        <div className="rq-split">
          <BreakdownMap v={v} selected={selected} onSelect={(k) => select(k)} onDecide={openTicket} />
          {panel && <div className="rq-aside over">{panel}</div>}
        </div>
      ) : phone ? (
        <div className="scroll rq-phonebody">
          <NeedsYouCards v={v} onDecide={openTicket} />
          <div className="rq-phonetree">
            <Tree v={v} mode={mode} selected={selected} open={open} onToggle={toggle} onSelect={select} onDecide={openTicket} onAdd={(level, under) => setDialog({ kind: 'add', level, under })} />
          </div>
          <p className="rq-phonenote">
            The map view is on bigger screens.{' '}
            {v.decided.length > 0 && (
              <button className="rq-link" onClick={() => setSearch({ item: undefined, decided: true })}>
                {v.decided.length} decided for you
              </button>
            )}
          </p>
        </div>
      ) : (
        <div className="rq-split">
          <div className="scroll rq-treecol">
            <Tree v={v} mode={mode} selected={selected} open={open} onToggle={toggle} onSelect={select} onDecide={openTicket} onAdd={(level, under) => setDialog({ kind: 'add', level, under })} />
          </div>
          <div className={`rq-aside ${panel ? '' : `idle ${search.decided ? 'wanted' : ''}`}`}>{panel ?? decidedPanel(search.decided ? () => setSearch({ decided: undefined }) : undefined)}</div>
        </div>
      )}

      {phone && built && !map && (panel || search.decided) && <div className="rq-sheet">{panel ?? decidedPanel(() => setSearch({ decided: undefined }))}</div>}
      {phone && built && v.mine && <div className="rq-bottom">{actions}</div>}

      {search.ticket && <TicketDrawer id={search.ticket} onClose={() => setSearch({ ticket: undefined })} />}
      {dialog?.kind === 'send' && <SendDialog v={v} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'ask' && <AskAnalystDialog v={v} item={dialog.item} text={dialog.text} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'add' && <AddPartDialog v={v} level={dialog.level} under={dialog.under} onClose={() => setDialog(null)} onAdded={(key) => select(key)} />}
      {dialog?.kind === 'leftout' && <LeftOutDialog v={v} onClose={() => setDialog(null)} onOpenRef={doc.open} onAsk={askable ? (text) => setDialog({ kind: 'ask', item: v.id, text }) : undefined} />}
      {dialog?.kind === 'delete' && (
        <DeleteBreakdownDialog id={v.id} title={v.title} sentTo={v.sent ? v.tracker?.label : undefined} onClose={() => setDialog(null)} onDeleted={() => void navigate({ to: '/requirements' })} />
      )}
      {doc.viewer !== undefined && <BrdViewer v={v} at={doc.viewer ?? undefined} onClose={doc.close} />}
      {act.isPending && <span className="sr-only" role="status">Working…</span>}
    </div>
  );
}

/** The name, and Rename: `squad requirements rename BR-1 "<name>"`. */
function Rename({ v }: { v: BreakdownView }) {
  const act = useReqAct();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(v.title);
  if (!editing)
    return (
      <>
        <Written as="h1" text={v.title} />
        {v.mine && (
          <button
            className="iconbtn rq-rename"
            aria-label="Rename the breakdown"
            title={`squad requirements rename ${v.id} "<name>"`}
            onClick={() => {
              setName(v.title);
              setEditing(true);
            }}
          >
            <Pencil size={13} />
          </button>
        )}
      </>
    );
  const save = () => act.mutate({ path: base(v.id), method: 'PATCH', body: { title: name.trim() }, done: 'Renamed.' }, { onSuccess: () => setEditing(false) });
  return (
    <form
      className="rq-renameform"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) save();
      }}
    >
      <input className="input" autoFocus aria-label="Name of the breakdown" dir={typedDir(name)} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
      <button className="btn sm pri" type="submit" disabled={!name.trim() || act.isPending} title={`squad requirements rename ${v.id} ${shellQuote(name.trim() || v.title)}`}>
        Save
      </button>
      <button className="btn sm" type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

/** The header's buttons, by where the breakdown is. On a phone they sit in the bottom bar. */
function Actions({ v, onSend, onAsk, phone }: { v: BreakdownView; onSend(): void; onAsk(): void; phone: boolean }) {
  const act = useReqAct();
  if (!v.mine) return null;
  const busy = jobBusy(v.state.job);
  const sendBtn = v.tracker && (
    <button className="btn" onClick={onSend} disabled={v.state.sync?.status === 'running'} title={`squad requirements send ${v.id}`}>
      {!phone && <Send size={14} />} {v.sent ? 'Send changes' : `Send to ${v.tracker.label}`}
    </button>
  );
  if (v.status === 'ready') {
    const problems = v.problems ?? [];
    return (
      <>
        <button className="btn" onClick={onAsk} disabled={busy} title={`squad requirements redo ${v.id} ${v.id} "<what to change>"`}>
          {!phone && <MessageCircle size={14} />} Ask the Analyst
        </button>
        <button
          className="btn pri rq-approve"
          disabled={problems.length > 0 || busy || act.isPending}
          aria-describedby={problems.length ? 'rq-probs' : undefined}
          title={problems.length ? problems[0] : `squad requirements approve ${v.id}`}
          onClick={() => act.mutate({ path: `${base(v.id)}/approve`, done: v.tracker ? 'Approved. Build continuously, start a story, or send it.' : 'Approved. Build continuously, or start one story.' })}
        >
          <Check size={15} /> Approve breakdown
        </button>
      </>
    );
  }
  if (v.status !== 'approved') return null;
  const all = v.counts.stories > 0 && v.counts.merged === v.counts.stories;
  const on = Boolean(v.state.build?.on);
  // Held at this month's budget: Build continuously again lets it go on for the rest of the month.
  const atBudget = v.state.build?.heldFor === 'budget';
  // The Analyst rewrote stories after the approval: Build continuously again says the person read them.
  const toRead = v.state.build?.heldFor === 'review';
  return (
    <>
      {sendBtn}
      {!all && on && (
        <button className="btn" disabled={act.isPending} title={`squad requirements build ${v.id} --pause`} onClick={() => act.mutate({ path: `${base(v.id)}/build`, body: { on: false }, done: 'Paused. Running stories finish their step; no new ones start.' })}>
          <Pause size={14} /> Pause
        </button>
      )}
      {!all && (!on || atBudget || toRead) && (
        <button
          className="btn pri"
          disabled={act.isPending}
          title={atBudget ? `Go on past this month's budget: squad requirements build ${v.id}` : `squad requirements build ${v.id}`}
          onClick={() => act.mutate({ path: `${base(v.id)}/build`, body: { on: true }, done: atBudget ? "It goes on past this month's budget, for the rest of the month." : toRead ? 'It goes on, with the rewritten stories.' : 'Building continuously. Stories start in order of what they need.' })}
        >
          <Play size={14} /> Build continuously
        </button>
      )}
    </>
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function whoWords(name: string, me: string | undefined): string {
  return me && name.trim().toLowerCase() === me.trim().toLowerCase() ? 'you' : name;
}

function dayWords(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? 'today' : `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

/** Where it comes from, its size, the estimate, and links to what was decided and left out. */
function InfoLine({ v, onDecided, onLeftOut, onDoc }: { v: BreakdownView; onDecided(): void; onLeftOut(): void; onDoc(): void }) {
  const board = useBoard();
  const me = board.data?.ready ? board.data.meta.user?.name : undefined;
  const s = v.source;
  const e = v.estimate;
  const bits = estimateBits(e);
  const c = v.counts;
  const showEstimate = v.status === 'ready';
  return (
    <div className="rq-info">
      <span>
        From{' '}
        <button className="rq-link" onClick={onDoc} title="Open the document">
          <Written text={s.name} />
        </button>
        {s.kind === 'pdf' && s.pages ? `, ${plural(s.pages, 'page')}` : ''}
        {s.pictures ? `, ${plural(s.pictures, 'picture')}` : ''}, added by <Written text={whoWords(s.addedBy, me)} /> {dayWords(s.addedAt)}
      </span>
      <span>
        <b>{c.epics}</b> {c.epics === 1 ? 'epic' : 'epics'}, <b>{c.features}</b> {c.features === 1 ? 'feature' : 'features'}, <b>{c.stories}</b> {c.stories === 1 ? 'story' : 'stories'}
      </span>
      {showEstimate && e.stories > 0 && (
        <span>
          About {bits.cost && <><b>{bits.cost}</b> and </>}
          <b>{bits.time}</b> to build, {e.parallel} at a time <span className="rq-dim">({basisWords(e)})</span>
        </span>
      )}
      {v.decided.length > 0 && (
        <button className="rq-link" onClick={onDecided}>
          {v.decided.length} decided for you
        </button>
      )}
      {v.leftOut.length > 0 && (
        <button className="rq-link" onClick={onLeftOut}>
          {plural(v.leftOut.length, 'part')} left out
        </button>
      )}
      {v.sent && v.tracker && <span>Sent to {v.tracker.label}</span>}
    </div>
  );
}

/** Once approved: the progress bar and counts, the estimate left, the rule line, and why it waits when held. */
function BuildRow({ v }: { v: BreakdownView }) {
  const act = useReqAct();
  const c = v.counts;
  const b = barParts(c);
  const on = Boolean(v.state.build?.on);
  const held = v.state.build?.held;
  const sync = v.state.sync;
  const started = c.merged + c.building + c.needsYou > 0 || v.progress.some((p) => p.ticket);
  const toGo = Math.max(0, c.stories - c.merged - c.building - c.needsYou);
  const built = builtWords(v);
  const step = sendStep(sync, sendPlanOf(v.id));
  const stepWords = sendStepWords(step);
  const how = 'It stops only for a missing part, a clash or a failed check, and merges each story when its checks and review pass. You send releases out from Releases.';
  return (
    <div className="rq-build">
      {started || on ? (
        <div className="rq-progress">
          <span className="rq-segbar" role="img" aria-label={`${c.merged} of ${c.stories} stories merged, ${c.building} building, ${c.needsYou} need you`}>
            {b.merged > 0 && <i className="m" style={{ flexGrow: b.merged }} />}
            {b.building > 0 && <i className="b" style={{ flexGrow: b.building }} />}
            {b.needsYou > 0 && <i className="y" style={{ flexGrow: b.needsYou }} />}
            {b.rest > 0 && <i className="w" style={{ flexGrow: b.rest }} />}
          </span>
          <span className="rq-pnum">
            <b>
              {c.merged} of {c.stories}
            </b>{' '}
            merged
          </span>
          <span className="rq-meta">
            {[c.building ? `${c.building} building` : '', c.needsYou ? `${c.needsYou} ${c.needsYou === 1 ? 'needs' : 'need'} you` : '', toGo ? `${toGo} to go` : ''].filter(Boolean).join(', ')}
          </span>
          {c.merged < c.stories && <span className="rq-meta">{leftWords(v.estimate)}</span>}
        </div>
      ) : (
        v.mine && (
          <div className="rq-rule">
            Build continuously: {buildEstimate(v.estimate)}. {how}
          </div>
        )
      )}
      {(started || on) && on && c.merged < c.stories && (
        <div className="rq-rule">
          {v.estimate.parallel} at a time. {how}
        </div>
      )}
      {built && (
        <div className="rq-built" role="status">
          <Check size={14} strokeWidth={2.6} aria-hidden="true" />
          <span>
            <Written text={built.text} />
            {built.release && (
              <>
                {' '}
                Send it out from <Link to="/releases">Releases</Link>.
              </>
            )}
          </span>
        </div>
      )}
      {held && (on || v.state.build?.heldFor === 'budget') && (
        <div className="rq-held" role="status">
          <Pause size={13} aria-hidden="true" /> Waiting: <Written text={held} />
        </div>
      )}
      {sync && (sync.status === 'running' || sync.status === 'pending') && (
        <div className="rq-syncline" role="status">
          Sending to {v.tracker?.label ?? 'the tracker'}
          {stepWords ? `: ${stepWords}` : '…'}
          <span className="rq-pbar">
            <i style={{ width: `${step.pct || 5}%` }} />
          </span>
        </div>
      )}
      {sync?.status === 'failed' && (
        <div className="rq-syncline fail" role="alert">
          The send to {v.tracker?.label ?? 'the tracker'} stopped{sync.error ? `: ${sync.error}` : '.'}
          {v.mine && (
            <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: `${base(v.id)}/send`, done: 'Sending again. What was sent stays; nothing is made twice.' })}>
              Send again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** While the Analyst redoes a part or answers a question on a written breakdown: what it does, and Stop. */
function JobLine({ v }: { v: BreakdownView }) {
  const act = useReqAct();
  const j = v.state.job;
  if (!jobBusy(j) || (v.status !== 'ready' && v.status !== 'approved')) {
    if (j?.status === 'failed' && j.step === 'redo' && (v.status === 'ready' || v.status === 'approved'))
      return (
        <div className="rq-jobline fail" role="status">
          The redo of {j.item === v.id ? 'the breakdown' : j.item} stopped{j.error ? <>: <Written text={j.error} /></> : '.'}
          {v.mine && (
            <button className="btn sm" onClick={() => act.mutate({ path: `${base(v.id)}/${j.capped ? 'more' : 'retry'}`, done: 'The Analyst tries the redo again.' })}>
              {j.capped ? 'Give it more' : 'Try again'}
            </button>
          )}
        </div>
      );
    return null;
  }
  return (
    <div className="rq-jobline" role="status">
      <span className="live" aria-hidden="true" />
      <Written text={j!.status === 'stopping' ? 'Stopping the Analyst…' : `${j!.now ?? 'The Analyst is working'}${j!.ask ? `: "${j!.ask}"` : ''}`} />
      <CarryOn v={v} />
      {v.mine && j!.status !== 'stopping' && (
        <button className="btn sm" onClick={() => act.mutate({ path: `${base(v.id)}/stop`, done: 'Stopping the Analyst.' })} title={`squad requirements stop ${v.id}`}>
          Stop
        </button>
      )}
    </div>
  );
}

/** On a phone: each story that needs the person, on top, with a full-width Decide. */
function NeedsYouCards({ v, onDecide }: { v: BreakdownView; onDecide(ticket: string): void }) {
  const board = useBoard();
  const tickets = board.data?.ready ? board.data.tickets : [];
  const you = v.progress.filter((p) => p.state === 'needs-you');
  const cards: ReactNode[] = useMemo(
    () =>
      you.map((p) => {
        const s = findPart(v, p.key)?.story;
        const t = p.ticket ? tickets.find((x) => x.id === p.ticket) : undefined;
        const why = t?.agentQuestion?.text ? firstSentence(t.agentQuestion.text) : t?.waiting?.summary;
        return (
          <div key={p.key} className="rq-youcard">
            <div className="rq-pop-w">{[p.key, p.ticket, stopTag(p.stop)].filter(Boolean).join(' · ')}</div>
            <Written as="div" className="rq-youcard-t" text={`${s?.title ?? ''}${why ? `: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : ''}`} />
            {p.ticket && (
              <button className="btn you" onClick={() => onDecide(p.ticket!)}>
                Decide
              </button>
            )}
          </div>
        );
      }),
    [you.map((p) => p.key + p.ticket).join(), tickets],
  );
  return <>{cards}</>;
}

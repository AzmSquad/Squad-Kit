import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Download, Plus, Search } from 'lucide-react';
import { api } from '../api/client';
import type { Actor, BrokenTicket, DraftJob, Stage, Ticket, TrackerStatus } from '../api/types';
import { useBoard } from '../lib/data';
import { BugDialog, NewTicketDialog, PullDialog } from '../components/dialogs';
import { Cmd, CouldNotLoad, Glyph, STAGE_NAME, Written } from '../components/ui';
import { TicketDrawer } from './TicketDrawer';
import { BoardCost } from '../components/Usage';
import { isMine, ownerOf, useMe } from '../components/HandOver';
import { changeWaits, openChange } from '../components/ChangeCard';
import { CardLine, isRunning } from '../components/LiveNow';
import { DependsTag } from '../components/Depends';
import { OutsideTag } from '../components/Outside';
import { NoNewTestsTag } from '../components/Gates';
import { FirstStoryGuide } from '../components/FirstStory';
import { needsYou, testChangeWaits } from '../lib/waiting';
import { NOT_CHECKED_WHY } from '../lib/gates';
import { typedDir } from '../lib/lang';
import { SetupCard, useSetupWaits } from '../components/Setup';
import { CardAutoTag, CardBreakdownKey } from '../components/AutoTicket';

const LANES: { stage: Stage; role: Actor; who: string }[] = [
  { stage: 'tickets', role: 'analyst', who: 'Analyst' },
  { stage: 'specs', role: 'architect', who: 'Architect' },
  { stage: 'implement', role: 'builder', who: 'Builder' },
  { stage: 'test', role: 'tester', who: 'Tester' },
  { stage: 'review', role: 'reviewer', who: 'Reviewer' },
  { stage: 'release', role: 'release', who: 'Release' },
  { stage: 'bugs', role: 'triage', who: 'Triage' },
];

type View = 'all' | 'mine' | 'bugs';

export function BoardPage() {
  const board = useBoard();
  // The setup runs, or its overview waits for the person: the board shows it first.
  const setup = useSetupWaits();
  const search = useSearch({ from: '/board' });
  const navigate = useNavigate({ from: '/board' });
  const [dialog, setDialog] = useState<'new' | 'pull' | 'bug' | null>(null);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // A draft from an idea waits under New ticket after the dialog closes; the button says so.
  const kept = useQuery({
    queryKey: ['ticket-draft-current'],
    queryFn: () => api<{ draft: DraftJob | null }>('/api/v1/tickets/draft/current'),
    enabled: dialog !== 'new',
    refetchInterval: (q) => (q.state.data?.draft?.status === 'working' ? 2000 : 30_000),
  });
  const draftTag = { working: 'drafting…', done: 'draft ready', failed: 'draft stopped', cancelled: '' }[kept.data?.draft?.status ?? 'cancelled'];
  // Write your next story, from the first win: the window opens here, and the address forgets it.
  useEffect(() => {
    if (!search.write) return;
    setDialog('new');
    void navigate({ search: (s) => ({ ...s, write: undefined }), replace: true });
  }, [search.write, navigate]);
  const view: View = search.view ?? 'all';
  const open = (id: string) => void navigate({ search: (s) => ({ ...s, ticket: id }) });
  const close = () => void navigate({ search: (s) => ({ ...s, ticket: undefined }) });

  const data = board.data?.ready ? board.data : null;
  const tickets = useMemo(() => {
    const all = [...(data?.tickets ?? []), ...(showArchived ? (data?.archived ?? []) : [])];
    const q = query.trim().toLowerCase();
    return all.filter((t) => {
      if (view === 'bugs' && t.kind !== 'bug') return false;
      if (view === 'mine' && !isMine(t, data?.meta.user?.name)) return false;
      return !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
    });
  }, [data, query, view, showArchived]);

  if (board.isLoading) return <div className="center">Loading the board…</div>;
  if (board.isError && !board.data) return <CouldNotLoad what="the board" error={board.error} onRetry={() => void board.refetch()} />;
  if (!data) return <NoBoard settings={board.data?.settings} />;

  // What needs the person shows in the banner at the top of every page. Here: setup, the first ticket, or all calm.
  const waiting = data.tickets.filter(needsYou);

  return (
    <>
      <div className="top">
        <h1>Board</h1>
        <div className="seg" role="tablist">
          {(['all', 'mine', 'bugs'] as View[]).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => void navigate({ search: (s) => ({ ...s, view: v === 'all' ? undefined : v }) })}>
              {v === 'all' ? 'All tickets' : v === 'mine' ? 'Mine' : 'Bugs'}
            </button>
          ))}
        </div>
        <span className="grow" />
        <label className="search">
          <Search size={15} />
          <input dir={typedDir(query)} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tickets" aria-label="Search tickets" />
        </label>
        <PullButton onPull={() => setDialog('pull')} />
        <button className="btn pri" onClick={() => setDialog('new')}>
          <Plus size={15} /> New ticket
          {draftTag && <span className="btn-tag">{draftTag}</span>}
        </button>
      </div>

      {(setup || waiting.length === 0) && (
        <section className="waiting" aria-label="Waiting for you">
          <div className="wh">
            <h2>Waiting for you</h2>
            <span className="grow" />
            <Cmd text="squad inbox" />
          </div>
          {setup ? (
            <SetupCard />
          ) : data.meta.engine === 'live' && data.tickets.length === 0 ? (
            <div className="calmlane">
              <span className="glyph"><Plus size={14} strokeWidth={2.5} /></span>
              <span>
                <b>Start with your first ticket.</b> Write what you want in plain words. The squad asks what it needs to know.
              </span>
              <span className="grow" style={{ flex: 1 }} />
              <button className="btn pri sm" onClick={() => setDialog('new')}>
                <Plus size={14} /> New ticket
              </button>
            </div>
          ) : (
            <div className="calmlane">
              <span className="glyph"><Check size={14} strokeWidth={2.5} /></span>
              <span><b>Nothing needs you right now.</b> The squad is working. New questions and approvals show up at the top of every page.</span>
            </div>
          )}
        </section>
      )}

      {(data.broken?.length ?? 0) > 0 && <BrokenTickets list={data.broken!} />}
      {(data.brokenRecords?.length ?? 0) > 0 && <BrokenTickets list={data.brokenRecords!} label="Files that could not be read" />}

      <FirstStoryGuide tickets={data.tickets} archived={data.archived ?? []} live={data.meta.engine === 'live'} project={data.meta.project} onOpen={open} />

      <div className="board">
        {LANES.map((lane) => {
          const here = tickets.filter((t) => t.stage === lane.stage);
          return (
            <section key={lane.stage} className="lane" aria-label={STAGE_NAME[lane.stage]}>
              <div className="lh">
                <Glyph role={lane.role} />
                <span className="t">
                  <b>{STAGE_NAME[lane.stage]}</b>
                  <small>{lane.who}</small>
                </span>
                <span className="n">{here.length}</span>
              </div>
              {here.map((t) => (
                <Card key={t.id} t={t} selected={search.ticket === t.id} onOpen={() => open(t.id)} />
              ))}
              {here.length === 0 && <div className="empty-lane">Nothing here</div>}
            </section>
          );
        })}
      </div>

      <div className="foot">
        <span>
          Last 30 days <b>{data.stats.released30} tickets released</b>
        </span>
        <span>
          <b>{data.stats.bugs30}</b> {data.stats.bugs30 === 1 ? 'bug' : 'bugs'} found after release
        </span>
        <span>
          <b>{data.stats.open}</b> open tickets
        </span>
        <BoardCost />
        <span className="grow" />
        {(data.archived?.length ?? 0) > 0 && (
          <button className="btn sm quiet" title="squad board --archived" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? 'Hide archived' : `Show archived (${data.archived!.length})`}
          </button>
        )}
        <button className="btn sm quiet" onClick={() => setDialog('bug')}>Report a bug</button>
      </div>

      {search.ticket && <TicketDrawer id={search.ticket} onClose={close} />}
      {dialog === 'new' && <NewTicketDialog onClose={() => setDialog(null)} onCreated={(t) => open(t.id)} />}
      {dialog === 'pull' && <PullDialog onClose={() => setDialog(null)} onCreated={(t) => open(t.id)} />}
      {dialog === 'bug' && <BugDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function Card({ t, selected, onOpen }: { t: Ticket; selected: boolean; onOpen(): void }) {
  const you = Boolean(t.waiting) || t.quiet?.kind === 'stuck' || changeWaits(t) || testChangeWaits(t);
  const me = useMe();
  return (
    <button className={`card ${you ? 'you' : ''} ${t.kind === 'bug' ? 'bug' : ''} ${selected ? 'sel' : ''}`} onClick={onOpen}>
      <div className="row1">
        <span className="id">{t.id}</span>
        {t.track === 'express' && <span className="prio express">Express</span>}
        <CardAutoTag t={t} />
        {you ? <span className="youtag">You</span> : t.kind === 'bug' ? <span className="prio">Bug</span> : t.priority === 'high' ? <span className="prio">High</span> : null}
        {me && !isMine(t, me) && <Written className="prio owner" title="Their squad works on it" text={ownerOf(t)} />}
        {t.archived && <span className="prio owner">Archived</span>}
        {t.gates?.checks === 'unchecked' && (
          <span className="prio unchecked" title={NOT_CHECKED_WHY}>
            Not checked
          </span>
        )}
        <OutsideTag t={t} />
        <NoNewTestsTag t={t} />
        <DependsTag t={t} />
      </div>
      <Written as="h4" text={t.title} />
      <CardBreakdownKey t={t} />
      {/* Running: who, which step, what it does, how long and the usual time, with the step bar. */}
      {isRunning(t) && !you ? (
        <CardLine t={t} />
      ) : (
        <>
          <div className="st">
            {t.live && !you ? <span className="live" /> : t.stage === 'release' ? <Check size={13} strokeWidth={2.5} /> : null}
            <Written text={t.quiet ? (t.quiet.kind === 'stuck' ? `Looks stuck: ${t.quiet.command ?? 'no progress'}` : `Taking long: ${t.quiet.command ?? t.status}`) : t.status} />
          </div>
          {typeof t.progress === 'number' && !you && (
            <div className="bar">
              <i style={{ width: `${t.progress}%` }} />
            </div>
          )}
        </>
      )}
    </button>
  );
}

/** Pull from the tracker this project is connected to; without one, the way to connect it. */
function PullButton({ onPull }: { onPull(): void }) {
  const tracker = useQuery({ queryKey: ['tracker'], queryFn: () => api<TrackerStatus>('/api/v1/tracker'), refetchInterval: 60_000 });
  const t = tracker.data;
  if (!t) return null;
  if (t.type === 'none') {
    return (
      <Link to="/settings" className="btn">
        <Download size={15} /> Connect a tracker
      </Link>
    );
  }
  return (
    <button className="btn" onClick={onPull}>
      <Download size={15} /> Pull from {t.label ?? 'the tracker'}
    </button>
  );
}

/** Tickets and records whose file cannot be read: never silently gone. What happened, and what an engineer needs one click away. */
export function BrokenTickets({ list, label = 'Tickets that could not be read' }: { list: BrokenTicket[]; label?: string }) {
  return (
    <section className="stuckbox" role="alert" aria-label={label} style={{ marginBottom: 14 }}>
      {list.map((b) => (
        <div key={b.id}>
          <p>{b.problem}</p>
          <details>
            <summary className="note">For an engineer</summary>
            <pre className="mono note" style={{ whiteSpace: 'pre-wrap' }}>{`${b.file}\n${b.detail}`}</pre>
          </details>
        </div>
      ))}
    </section>
  );
}

export function NoBoard({ settings }: { settings?: string | undefined }) {
  if (settings) {
    return (
      <div className="center">
        <div role="alert">
          <h2>This board cannot open</h2>
          <p>{settings}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="center">
      <div>
        <h2>No board yet</h2>
        <p>This project has not been set up yet. Go to Home to set it up, or to try a sample board.</p>
        <p style={{ marginTop: 12 }}>
          <a className="btn" href="/">Go to Home</a> <Cmd text="squad demo" />
        </p>
      </div>
    </div>
  );
}

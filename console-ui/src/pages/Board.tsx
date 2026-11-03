import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Download, Plus, Search } from 'lucide-react';
import { api } from '../api/client';
import type { Actor, DraftJob, Stage, Ticket, TrackerStatus } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { BugDialog, NewTicketDialog, PullDialog } from '../components/dialogs';
import { Cmd, Glyph, STAGE_NAME } from '../components/ui';
import { TicketDrawer } from './TicketDrawer';
import { BoardCost } from '../components/Usage';
import { isMine, ownerOf, useMe } from '../components/HandOver';
import { changeWaits, openChange } from '../components/ChangeCard';
import { CardLine, isRunning } from '../components/LiveNow';
import { ReportButton } from '../components/Report';
import { needsYou } from '../lib/waiting';

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
  if (!data) return <NoBoard />;

  // What needs the person shows in the banner at the top of every page. Here: setup, the first ticket, or all calm.
  const setup = data.meta.engine === 'live' && Boolean(data.meta.scan && data.meta.scan.status !== 'done');
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
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tickets" aria-label="Search tickets" />
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
            <ScanState meta={data.meta} />
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
  const you = Boolean(t.waiting) || t.quiet?.kind === 'stuck' || changeWaits(t);
  const me = useMe();
  return (
    <button className={`card ${you ? 'you' : ''} ${t.kind === 'bug' ? 'bug' : ''} ${selected ? 'sel' : ''}`} onClick={onOpen}>
      <div className="row1">
        <span className="id">{t.id}</span>
        {t.track === 'express' && <span className="prio express">Express</span>}
        {you ? <span className="youtag">You</span> : t.kind === 'bug' ? <span className="prio">Bug</span> : t.priority === 'high' ? <span className="prio">High</span> : null}
        {me && !isMine(t, me) && <span className="prio owner" title="Their squad works on it">{ownerOf(t)}</span>}
        {t.archived && <span className="prio owner">Archived</span>}
      </div>
      <h4>{t.title}</h4>
      {/* Running: who, which step, what it does, how long and the usual time, with the step bar. */}
      {isRunning(t) && !you ? (
        <CardLine t={t} />
      ) : (
        <>
          <div className="st">
            {t.live && !you ? <span className="live" /> : t.stage === 'release' ? <Check size={13} strokeWidth={2.5} /> : null}
            <span>{t.quiet ? (t.quiet.kind === 'stuck' ? `Looks stuck: ${t.quiet.command ?? 'no progress'}` : `Taking long: ${t.quiet.command ?? t.status}`) : t.status}</span>
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

type SetupStep = { label: string; state: 'done' | 'now' | 'todo' | 'fail'; note?: string };

/** A project's first open: what squad-kit set up, then the Architect reading the project, step by step. */
function ScanState({ meta }: { meta: BoardResponseMeta }) {
  const act = useAct();
  const scan = meta.scan!;
  const failed = scan.status === 'failed';
  const tool = meta.tools.find((t) => t.ready);
  const steps: SetupStep[] = [
    { label: 'Project files and board', state: 'done', note: '.squad/ in this folder' },
    tool
      ? { label: `${tool.name} is ready`, state: 'done', note: 'The squad works with it' }
      : { label: 'An AI tool', state: 'fail', note: 'Install Claude Code and sign in once, then press Try again' },
    {
      label: 'The Architect reads the project',
      state: failed ? 'fail' : scan.status === 'running' ? 'now' : 'todo',
      note: failed ? scan.error : scan.status === 'running' ? (scan.now ?? 'Starting…') : 'Starts in a moment',
    },
    { label: 'Ready for your first ticket', state: 'todo', note: 'Write it, or pull it from your tracker' },
  ];
  return (
    <div className="setup">
      <div className="setup-head">
        <b>{failed ? 'The Architect could not read the project.' : 'Setting up your project'}</b>
        <span>{failed ? 'Fix what the step below says, then try again. Nothing was lost: your project files are as they were.' : 'The Architect maps the project and finds how to test and run it. This takes a few minutes.'}</span>
        {failed && (
          <span className="drafterr-ways">
            <button className="btn sm pri" onClick={() => act.mutate({ path: '/api/v1/scan', done: 'Reading the project again' })}>Try again</button>
            <ReportButton small />
          </span>
        )}
      </div>
      <ol className="setup-steps">
        {steps.map((st) => (
          <li key={st.label} className={st.state}>
            <span className="mark">{st.state === 'done' ? <Check size={12} strokeWidth={3} /> : st.state === 'fail' ? '!' : st.state === 'now' ? <span className="live" /> : null}</span>
            <span className="txt">
              <b>{st.label}</b>
              {st.note && <small title={st.note}>{st.note}</small>}
            </span>
          </li>
        ))}
      </ol>
      {!failed && (
        <div className="setup-bar" aria-hidden>
          <i />
        </div>
      )}
    </div>
  );
}

type BoardResponseMeta = NonNullable<ReturnType<typeof useBoard>['data']>['meta'];

function NoBoard() {
  return (
    <div className="center">
      <div>
        <h2>No board yet</h2>
        <p>Run this in the terminal to open a sample board where the squad works on its own:</p>
        <p style={{ marginTop: 12 }}>
          <Cmd text="squad demo" />
        </p>
      </div>
    </div>
  );
}

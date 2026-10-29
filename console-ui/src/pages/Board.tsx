import { useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Download, Plus, Search } from 'lucide-react';
import type { Actor, Stage, Ticket } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { BugDialog, NewTicketDialog, PullDialog } from '../components/dialogs';
import { Cmd, Glyph, STAGE_NAME, actionLabel } from '../components/ui';
import { TicketDrawer } from './TicketDrawer';

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
  const view: View = search.view ?? 'all';
  const open = (id: string) => void navigate({ search: (s) => ({ ...s, ticket: id }) });
  const close = () => void navigate({ search: (s) => ({ ...s, ticket: undefined }) });

  const data = board.data?.ready ? board.data : null;
  const tickets = useMemo(() => {
    const all = data?.tickets ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((t) => {
      if (view === 'bugs' && t.kind !== 'bug') return false;
      if (view === 'mine' && t.createdBy !== data?.meta.user.name) return false;
      return !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
    });
  }, [data, query, view]);

  if (board.isLoading) return <div className="center">Loading the board…</div>;
  if (!data) return <NoBoard />;

  const ORDER = ['questions', 'plan', 'stuck', 'proof', 'release'];
  const waiting = data.tickets
    .filter((t) => t.waiting)
    .sort((a, b) => ORDER.indexOf(a.waiting!.kind) - ORDER.indexOf(b.waiting!.kind));

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
        <button className="btn" onClick={() => setDialog('pull')}>
          <Download size={15} /> Pull from Azure
        </button>
        <button className="btn pri" onClick={() => setDialog('new')}>
          <Plus size={15} /> New ticket
        </button>
      </div>

      <section className="waiting" aria-label="Waiting for you">
        <div className="wh">
          <h2>
            Waiting for you {waiting.length > 0 && <span className="count">{waiting.length}</span>}
          </h2>
          <p>{waiting.length ? 'Everything else is handled by the squad.' : ''}</p>
          <span className="grow" />
          <Cmd text="squad inbox" />
        </div>
        {data.meta.engine === 'live' && data.meta.scan && data.meta.scan.status !== 'done' ? (
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
        ) : waiting.length === 0 ? (
          <div className="calmlane">
            <span className="glyph"><Check size={14} strokeWidth={2.5} /></span>
            <span><b>Nothing needs you right now.</b> The squad is working. New questions and approvals show up here.</span>
          </div>
        ) : (
          <div className="wcards">
            {waiting.slice(0, 3).map((t) => (
              <button key={t.id} className="wcard" onClick={() => open(t.id)}>
                <div className="grow">
                  <div className="meta">
                    <span className="id">{t.id}</span>
                    <span>{STAGE_NAME[t.stage]}</span>
                  </div>
                  <h3>{t.title}</h3>
                  <p>{t.waiting!.summary}</p>
                </div>
                <span className="btn sm pri">{actionLabel(t)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

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
        <span className="grow" />
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
  const you = Boolean(t.waiting);
  return (
    <button className={`card ${you ? 'you' : ''} ${t.kind === 'bug' ? 'bug' : ''} ${selected ? 'sel' : ''}`} onClick={onOpen}>
      <div className="row1">
        <span className="id">{t.id}</span>
        {you ? <span className="youtag">You</span> : t.kind === 'bug' ? <span className="prio">Bug</span> : t.priority === 'high' ? <span className="prio">High</span> : null}
      </div>
      <h4>{t.title}</h4>
      <div className="st">
        {t.live && !you ? <span className="live" /> : t.stage === 'release' ? <Check size={13} strokeWidth={2.5} /> : null}
        <span>{t.status}</span>
      </div>
      {typeof t.progress === 'number' && !you && (
        <div className="bar">
          <i style={{ width: `${t.progress}%` }} />
        </div>
      )}
    </button>
  );
}

function ScanState({ meta }: { meta: BoardResponseMeta }) {
  const act = useAct();
  if (meta.scan?.status === 'failed') {
    return (
      <div className="calmlane">
        <span className="glyph you">!</span>
        <span>
          <b>The Architect could not read the project.</b> {meta.scan.error}
        </span>
        <span className="grow" style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => act.mutate({ path: '/api/v1/scan', done: 'Reading the project again' })}>Try again</button>
      </div>
    );
  }
  return (
    <div className="calmlane">
      <span className="live" />
      <span>
        <b>The Architect is reading your project.</b> It writes the project map and finds how to test and run it. This takes a minute or two.
      </span>
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

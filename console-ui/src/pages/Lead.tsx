import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { History, Plus, X } from 'lucide-react';
import { api } from '../api/client';
import type { DecisionsResponse, LeadSummary, LeadView } from '../api/types';
import { useApps, useBoard } from '../lib/data';
import { dateShort, ago, CouldNotLoad, Written } from '../components/ui';
import { dollars, exampleQuestions } from '../lib/lead';
import { useLead, useLeadConversation } from '../lib/leadData';
import { AskInput, ContextChip, SafeLine, useSendLead } from '../components/LeadAsk';
import { LeadTurnView, showNewest } from '../components/LeadTurn';
import { LeadRail } from '../components/LeadRail';
import '../styles/lead.css';

/**
 * The Squad lead: one place to talk to the squad about the whole project. The conversation sits in the middle, its
 * answers showing their work first; what needs you, the squad now and what the lead can do sit in the rail beside it.
 * `c` in the address opens a conversation. Terminal: `squad ask`, `squad lead`.
 */
export function LeadPage() {
  const search = useSearch({ from: '/lead' });
  const navigate = useNavigate();
  const lead = useLead();
  const board = useBoard();
  const apps = useAppNames();
  const id = search.c ?? null;
  const conv = useLeadConversation(id);
  const { send, busy } = useSendLead();
  const [text, setText] = useState('');
  const [history, setHistory] = useState(false);
  const [rail, setRail] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const c = id ? conv.data : undefined;
  const meta = board.data?.ready ? board.data.meta : undefined;
  const project = meta?.project ?? 'the project';
  const open = (cid: string | null) => {
    setHistory(false);
    void navigate({ to: '/lead', search: cid ? { c: cid } : {} });
  };
  const go = (t = text, fresh = false) =>
    send({ text: t.trim(), conversation: c?.id ?? null, context: c ? null : { from: 'board', page: 'Squad lead' }, fresh }, (x) => {
      setText('');
      if (x.id !== id) open(x.id);
    });

  // The newest question stays in view, with its answer under it.
  const turns = c?.turns.length ?? 0;
  useEffect(() => {
    showNewest(feed.current);
  }, [id, turns, c?.thinking]);

  const needs = lead.data?.needsYou.length ?? 0;
  return (
    <div className={`lead-page ${rail ? 'rail-open' : ''}`}>
      <div className="lead-thread">
        <header className="lead-h">
          <img className="lead-logo" src="/logo.svg" alt="" />
          <div className="lead-title">
            <h1>Squad lead</h1>
            <Knows project={project} stories={board.data?.ready ? board.data.tickets.length + board.data.stats.released30 : undefined} />
          </div>
          <span className="grow" />
          <button className="btn sm" onClick={() => open(null)} disabled={!id} aria-label="New conversation">
            <Plus size={14} /> <span className="wide">New conversation</span>
          </button>
          <span className="lead-hist">
            <button className="btn sm" onClick={() => setHistory(!history)} aria-expanded={history} aria-haspopup="true" aria-label="History">
              <History size={14} /> <span className="wide">History</span>
            </button>
            {history && <HistoryMenu items={lead.data?.conversations ?? []} current={id} onPick={open} onClose={() => setHistory(false)} />}
          </span>
          <button className="btn sm lead-railbtn" onClick={() => setRail(!rail)} aria-expanded={rail}>
            Needs you{needs ? ` · ${needs}` : ''}
          </button>
        </header>

        <div className="scroll lead-feed" ref={feed}>
          <div className="lead-col">
            {id && conv.isError && !c ? (
              <CouldNotLoad what="this conversation" error={conv.error} onRetry={() => void conv.refetch()} />
            ) : c ? (
              <>
                <div className="lead-day">
                  {dateShort(c.startedAt)} · <Written text={c.title} />
                </div>
                {c.turns.map((t, i) => (
                  <LeadTurnView key={t.n} c={c} turn={t} last={i === c.turns.length - 1} onAgain={(q, fresh) => go(q, fresh)} />
                ))}
              </>
            ) : id ? (
              <p className="note">Loading…</p>
            ) : (
              <Empty view={lead.data} apps={apps} onPick={(q) => setText(q)} onOpen={open} />
            )}
          </div>
        </div>

        <div className="lead-composer">
          <AskInput
            id="lead-page-ask"
            value={text}
            onChange={setText}
            onSend={() => go()}
            busy={busy || Boolean(c?.thinking)}
            placeholder={c ? 'Ask a follow-up…' : `Ask about ${project}, or ask for something…`}
            chip={c && c.context.from !== 'board' ? <ContextChip ctx={c.context} /> : undefined}
            autoFocus={!id}
          />
          <SafeLine />
        </div>
      </div>
      {rail && <div className="lead-veil" onClick={() => setRail(false)} />}
      <LeadRail view={lead.data} />
      {rail && (
        <button className="iconbtn lead-railx" onClick={() => setRail(false)} aria-label="Close">
          <X size={16} />
        </button>
      )}
    </div>
  );
}

function useAppNames(): string[] {
  return (useApps().data?.apps ?? []).map((a) => a.name);
}

/** "RoomFlow · knows the code, 18 stories, 10 decisions". */
function Knows({ project, stories }: { project: string; stories?: number }) {
  const decisions = useQuery({ queryKey: ['lead', 'decisions'], queryFn: () => api<DecisionsResponse>('/api/v1/decisions'), staleTime: 60_000 }).data?.decisions.length;
  const parts = ['knows the code', ...(stories ? [`${stories} ${stories === 1 ? 'story' : 'stories'}`] : []), ...(decisions ? [`${decisions} ${decisions === 1 ? 'decision' : 'decisions'}`] : [])];
  return (
    <div className="lead-sub">
      <span className="pulse" aria-hidden="true" />
      <Written text={project} />
      <span>· {parts.join(', ')}</span>
    </div>
  );
}

/** No conversation open: what to ask, three questions from the project, and the latest conversations. */
function Empty({ view, apps, onPick, onOpen }: { view?: LeadView; apps: string[]; onPick(q: string): void; onOpen(id: string): void }) {
  const examples = exampleQuestions({ apps, needsYou: view?.needsYou ?? [], squadNow: view?.squadNow ?? [] });
  const recent = (view?.conversations ?? []).slice(0, 5);
  return (
    <div className="lead-empty">
      <h2>Ask about the app, the stories or the code</h2>
      <p>Or say what is wrong. It reads what the squad knows, looks at the app in its own copy, and answers in plain words. Changes come as stories you create.</p>
      <div className="lead-examples">
        {examples.map((q) => (
          <button key={q} className="lead-ex" onClick={() => onPick(q)}>
            {q}
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <div className="lbl">Recent conversations</div>
          <ConversationList items={recent} current={null} onPick={onOpen} />
        </>
      )}
    </div>
  );
}

function ConversationList({ items, current, onPick }: { items: LeadSummary[]; current: string | null; onPick(id: string): void }) {
  return (
    <ul className="lead-list">
      {items.map((s) => (
        <li key={s.id}>
          <button className={s.id === current ? 'on' : ''} onClick={() => onPick(s.id)}>
            <Written as="b" text={s.title} />
            <small>
              {s.thinking ? <span className="live" aria-label="Answering now" /> : null}
              {ago(s.updatedAt)}
              {s.turns > 1 ? ` · ${s.turns} questions` : ''}
              {s.costUsd ? ` · ${dollars(s.costUsd)}` : ''}
              {s.story ? ` · made ${s.story}` : ''}
            </small>
          </button>
        </li>
      ))}
    </ul>
  );
}

function HistoryMenu({ items, current, onPick, onClose }: { items: LeadSummary[]; current: string | null; onPick(id: string): void; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lead-histmenu" role="dialog" aria-label="Past conversations">
      {items.length ? <ConversationList items={items} current={current} onPick={onPick} /> : <p className="note">No conversations yet.</p>}
    </div>
  );
}

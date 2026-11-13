import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { History, Plus } from 'lucide-react';
import type { LeadSummary, LeadView, SquadNowItem } from '../api/types';
import { useApps, useBoard } from '../lib/data';
import { dateShort, ago, CouldNotLoad, Written } from '../components/ui';
import { dollars, exampleQuestions, leadCount, squadLine } from '../lib/lead';
import { useLead, useLeadConversation } from '../lib/leadData';
import { useStickToBottom } from '../lib/stick-to-bottom';
import { focusBoxIn, useShowsTalk } from '../lib/here';
import { AskInput, ContextChip, SafeLine, useSendLead } from '../components/LeadAsk';
import { LeadTurnView } from '../components/LeadTurn';
import { Brief, CanLink } from '../components/LeadCan';
import { ToBottom } from '../components/ToBottom';
import '../styles/lead.css';

/**
 * The Squad lead: one place to talk to the squad about the whole project, as a chat with the page's whole width,
 * centred. Its answers show their work first. Who is working now is one line under its name; what needs you is in the
 * top bar, and what the lead can do is one press away under the box. The lead's popup and head stay away while this
 * page shows the talk. `c` in the address opens a conversation. Terminal: `squad ask`, `squad lead`.
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
  const c = id ? conv.data : undefined;
  // It opens at the bottom and follows the answer only while you are at the bottom (lib/stick-to-bottom).
  const stick = useStickToBottom(id ?? 'new', leadCount(c));
  // The lead's talk is on this page: no popup of it meanwhile, and ⌘K comes to this box.
  useShowsTalk('lead', () => focusBoxIn(document.querySelector<HTMLElement>('.lead-composer')));
  const meta = board.data?.ready ? board.data.meta : undefined;
  const project = meta?.project ?? 'the project';
  const open = (cid: string | null) => {
    setHistory(false);
    void navigate({ to: '/lead', search: cid ? { c: cid } : {} });
  };
  const go = (t = text, fresh = false) =>
    send({ text: t.trim(), conversation: c?.id ?? null, context: c ? null : { from: 'board', page: 'Squad lead' }, fresh }, (x) => {
      setText('');
      stick.toBottom();
      if (x.id !== id) open(x.id);
    });

  return (
    <div className="lead-page">
      <div className="lead-thread">
        <header className="lead-h">
          <img className="lead-logo" src="/logo.svg" alt="" />
          <div className="lead-title">
            <h1>Squad lead</h1>
            <SquadNow project={project} now={lead.data?.squadNow ?? []} />
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
        </header>

        {/* A conversation sticks to its newest message; the start page reads from the top. */}
        <div className="scroll lead-feed" ref={id ? stick.boxRef : undefined}>
          <div className="lead-col" ref={id ? stick.contentRef : undefined}>
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
          {id && <ToBottom s={stick} />}
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
          <div className="lead-foot">
            <SafeLine />
            <CanLink />
          </div>
        </div>
      </div>
    </div>
  );
}

function useAppNames(): string[] {
  return (useApps().data?.apps ?? []).map((a) => a.name);
}

/** "The squad now" in one line under the lead's name: "Mawid · 2 agents working", each agent in its tooltip. */
function SquadNow({ project, now }: { project: string; now: SquadNowItem[] }) {
  const { line, more } = squadLine(now);
  return (
    <div className="lead-sub" title={more || undefined}>
      <span className={`pulse ${now.length ? '' : 'idle'}`} aria-hidden="true" />
      <Written text={project} />
      <span>· {line}</span>
    </div>
  );
}

/** No conversation open: what to ask, three questions from the project, what's new, and the latest conversations. */
function Empty({ view, apps, onPick, onOpen }: { view?: LeadView; apps: string[]; onPick(q: string): void; onOpen(id: string): void }) {
  const examples = exampleQuestions({ apps, needsYou: view?.needsYou ?? [], squadNow: view?.squadNow ?? [] });
  const recent = (view?.conversations ?? []).slice(0, 5);
  const news = view?.whatsNew ?? [];
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
      {view?.brief && <Brief b={view.brief} />}
      {news.length > 0 && (
        <>
          <div className="lbl">What&apos;s new</div>
          <ul className="lead-news">
            {news.slice(0, 5).map((x) => (
              <li key={x.id}>
                <Link to="/board" search={{ ticket: x.story }}>
                  <Written text={x.words} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
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

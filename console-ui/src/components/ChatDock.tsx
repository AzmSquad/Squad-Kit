import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { api } from '../api/client';
import type { AgentName, ChatSummary } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { isolated } from '../lib/lang';
import { PHONE, chatDock, useChatDock, useMedia } from '../lib/chatDock';
import { AGENT_TITLE, Avatar, ChatView } from './Chat';
import { DocPane, type OpenDoc } from './ChatFiles';

/** Every talk with an agent, for the tabs, the Conversations page and the side menu count. */
export function useChats(q = '') {
  return useQuery({
    queryKey: ['conversations', q],
    queryFn: () => api<ChatSummary[]>(`/api/v1/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    refetchInterval: 1500,
  });
}

/** Answers in an open talk you have not read yet: the agent's messages since you last wrote, and not seen here. */
export function unreadOf(s: ChatSummary, seen: Record<string, number>): number {
  if (!s.open) return 0;
  const had = seen[s.id];
  return had === undefined ? s.fresh : Math.min(s.fresh, Math.max(0, s.count - had));
}

/** True while the chat panel sits open beside the board, so the board can make room. */
export function useDocked(): boolean {
  const dock = useChatDock();
  const phone = useMedia(PHONE);
  const chats = useChats();
  return !phone && !dock.min && (chats.data ?? []).some((s) => s.open);
}

/** One line for a talk that is out of sight: who is typing, or who answered. */
export function chatLine(s: ChatSummary): string {
  const who = AGENT_TITLE[s.with];
  if (s.thinking) return `The ${who} is typing on ${s.id}`;
  if (s.yourTurn) return `The ${who} answered on ${s.id}`;
  return `${who} on ${s.id}`;
}

/**
 * The chat docked beside the board: one tab per open talk, resizable, and minimized to a small card. You can keep
 * working on the board while you talk. Markdown and PDF files open beside it.
 */
export function ChatDock() {
  const dock = useChatDock();
  const phone = useMedia(PHONE);
  const navigate = useNavigate();
  const chats = useChats();
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const open = (chats.data ?? []).filter((s) => s.open);
  const cur = open.find((s) => s.id === dock.tab) ?? open[0];
  // The talk in front always has its tab in view.
  useEffect(() => {
    strip.current?.querySelector('.ctab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [cur?.id, dock.min]);
  if (!cur) return null;
  const full = (id: string) => void navigate({ to: '/conversations', search: { ticket: id } });

  if (dock.min || phone) {
    const lead = open.find((s) => s.thinking) ?? open.find((s) => s.yourTurn) ?? cur;
    return (
      <div className="cmini" role="status">
        <Avatar role={lead.with} small live={lead.thinking} />
        <div>
          <b>
            {open.length} {open.length === 1 ? 'conversation' : 'conversations'}
          </b>
          <small>{chatLine(lead)}</small>
        </div>
        <button className="btn pri sm" onClick={() => (phone ? full(lead.id) : chatDock.restore())}>
          Open
        </button>
      </div>
    );
  }

  const drag = (e: MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = dock.width;
    const move = (ev: globalThis.MouseEvent) => chatDock.resize(w0 + (x0 - ev.clientX));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('cresizing');
    };
    document.body.classList.add('cresizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <>
      {doc && <DocPane doc={doc} onClose={() => setDoc(null)} />}
      <section className="cdock" style={{ width: dock.width }} aria-label="Conversations">
        <span className="cgrip" onMouseDown={drag} aria-hidden="true" />
        <div className="ctabs">
          <div className="ctabscroll" role="tablist" aria-label="Open conversations" ref={strip}>
            {open.map((s) => {
              const on = s.id === cur.id;
              const unread = unreadOf(s, dock.seen);
              return (
                <button key={s.id} className={`ctab ${on ? 'on' : ''}`} role="tab" aria-selected={on} onClick={() => chatDock.pick(s.id)} title={`${s.id} · ${s.title}`}>
                  <Avatar role={s.with} small />
                  <span className="tid">{s.id}</span>
                  <span className="tn">{AGENT_TITLE[s.with]}</span>
                  {s.thinking && !on && (
                    <span className={`cdots sm c-${s.with}`} aria-label="Typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {unread > 0 && !on && (
                    <span className="cbadge" aria-label={`${unread} unread`}>
                      {unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <NewTalk />
          <span className="grow" />
          <button className="iconbtn" onClick={() => full(cur.id)} aria-label="Open full screen" title="Full screen">
            <Maximize2 size={15} />
          </button>
          <button className="iconbtn" onClick={chatDock.minimize} aria-label="Minimize" title="Minimize">
            <Minus size={16} />
          </button>
        </div>
        <ChatView key={cur.id} id={cur.id} size="panel" onOpenDoc={setDoc} />
      </section>
    </>
  );
}

/** Start a talk with any agent on any ticket. */
export function NewTalk() {
  const board = useBoard();
  const act = useAct();
  const [open, setOpen] = useState(false);
  const [ticket, setTicket] = useState('');
  const [agent, setAgent] = useState<AgentName>('analyst');
  const tickets = (board.data?.ready ? board.data.tickets : []).filter((t) => !t.chat?.open && !t.takenOver);
  const start = () =>
    act.mutate(
      { path: `/api/v1/tickets/${ticket}/chat/start`, body: { with: agent } },
      {
        onSuccess: () => {
          setOpen(false);
          chatDock.show(ticket);
        },
      },
    );
  return (
    <span className="cmenu-w">
      <button className="iconbtn" onClick={() => setOpen(!open)} aria-label="Start a new conversation" title="Start a new conversation" aria-expanded={open}>
        <Plus size={16} />
      </button>
      {open && (
        <div className="cmenu cnew" role="dialog" aria-label="Start a new conversation">
          <label>
            <span>Ticket</span>
            <select className="input" value={ticket} onChange={(e) => setTicket(e.target.value)}>
              <option value="">Pick a ticket</option>
              {tickets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} · {isolated(t.title)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Talk to</span>
            <select className="input" value={agent} onChange={(e) => setAgent(e.target.value as AgentName)}>
              {(Object.keys(AGENT_TITLE) as AgentName[]).map((a) => (
                <option key={a} value={a}>
                  The {AGENT_TITLE[a]}
                </option>
              ))}
            </select>
          </label>
          <div className="cbtns">
            <button className="btn pri sm" disabled={!ticket || act.isPending} onClick={start}>
              Start talking
            </button>
            <button className="btn sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

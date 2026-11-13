import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ConversationResponse } from '../api/types';
import { useTicket } from '../lib/data';
import { popups, useMedia } from '../lib/popups';
import { REDUCED } from '../lib/reveal';
import { agentFor, decideKind, pressedLately } from '../lib/decide';
import { isAgent, keyOf, useWriting } from '../lib/writing';
import { BoxOnly, ChatBox, useBoxAsk } from './decide/BoxAsk';
import { DecideCard } from './decide/DecideCard';
import { SplitDone } from './split/SplitCard';
import type { OpenDoc } from './ChatFiles';
import { merge } from '../lib/conversation';
import { useDraft } from '../lib/drafts';
import {
  AGENT_TITLE,
  type ChatSize,
  primaryOf,
  SESSION,
  TalkButton,
  talkKind,
  type Tool,
  workingRole,
} from './chat/parts';
import { ChatHeader } from './chat/ChatHeader';
import { Drafting, type Pending, Sending } from './chat/Sending';
import { AgentMessage, SquadNote, Thinking, YouMessage } from './chat/Messages';
import { Composer } from './chat/Composer';

/* ── The talk ──────────────────────────────────────────── */


/**
 * One chat with one agent, in four sizes: a popup over any page, the full-screen Conversations page, a phone, and the
 * old side panel. Replies come from the agent's real session; while it works you see what it reads and its working
 * steps, and its words appear as they are written: the reply so far while it comes, then the rest, at a reading pace.
 * Answers that were already here show whole. When the story waits for you, its decision card closes the talk, with
 * the board's own buttons. Only your buttons move the ticket on.
 */
export function ChatView({ id, size, onOpenDoc, onFull, onPanel }: { id: string; size: ChatSize; onOpenDoc(d: OpenDoc): void; onFull?(): void; onPanel?(): void }) {
  const ticket = useTicket(id);
  const t = ticket.data;
  const c = t?.chat;
  const thread = useRef<HTMLDivElement>(null);
  const reduced = useMedia(REDUCED);
  // Kept on this computer until sent: another tab, Minimize, Full screen or a reload lose nothing.
  const [text, setText] = useDraft(id, 'chat', '');
  const input = useRef<HTMLTextAreaElement>(null);
  // A tapped choice is sent like a typed message.
  const sendRef = useRef<((words: string) => void) | null>(null);
  // Your message shows as sending until the board has it.
  const [pending, setPending] = useState<Pending | null>(null);
  // "Something's wrong" on the decision card: the box asks for the words, and they go to the board.
  const { box, cancel: cancelBox, door } = useBoxAsk(() => setTimeout(() => input.current?.focus(), 0));
  const count = t?.chat?.messages.length ?? 0;
  useEffect(() => {
    if (pending && count > pending.count) setPending(null);
  }, [count, pending]);
  // Beside the work the agent talks in a side conversation of its own.
  const convKey = c ? (c.beside ? 'chat' : SESSION[c.with]) : '';
  const conv = useQuery({
    queryKey: ['conversation', id, convKey],
    queryFn: () => api<ConversationResponse>(`/api/v1/tickets/${id}/conversations/${convKey}`),
    enabled: Boolean(c && (c.beside ? c.side : t?.sessions?.[SESSION[c.with]])),
    refetchInterval: c?.thinking ? 1500 : 8000,
    retry: false,
  });
  const steps = useMemo(() => merge(conv.data?.updates ?? []).filter((i): i is Tool => i.kind === 'tool'), [conv.data]);
  const stepsFor = (from?: string, to?: string) => steps.filter((s) => (!from || (s.at ?? '') >= from) && (!to || (s.at ?? '') <= to));

  // New answers are written out word by word; answers that were already here show whole.
  const messages = useMemo(() => c?.messages ?? [], [c?.messages]);
  const { writing: reveal, fresh, drafted } = useWriting(messages, Boolean(c), reduced);

  // Stay at the newest message while it is written, unless you scrolled up to read.
  const pinned = useRef(true);
  const col = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  // Pictures load after the words, so the talk grows later: keep the newest message in view then too.
  useEffect(() => {
    const el = thread.current;
    const inner = col.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [t?.id, Boolean(c)]);
  useEffect(() => {
    if (c) popups.seen(id, messages.length);
  }, [c, id, messages.length]);

  if (!t) return <div className="cempty">{ticket.isError ? `No ticket ${id}.` : 'Loading…'}</div>;
  // What the story waits on you for closes the talk, or the card of the press you just made.
  const waits = decideKind(t) !== null || pressedLately(t.id);
  const decide = waits ? <DecideCard key={t.id} story={t.id} /> : null;
  if (!c) {
    return (
      <ChatBox.Provider value={door}>
        <div className={`chat-v csize-${size}`}>
          <div className="cthread" ref={thread}>
            <div className="ccol" ref={col}>
              <SplitDone t={t} />
              {decide}
              <div className="cempty inline">
                <p>No talk on {t.id} yet.</p>
                <TalkButton t={t} agent={agentFor(t)} primary small />
              </div>
            </div>
          </div>
          {box && <BoxOnly t={t} box={box} onCancel={cancelBox} />}
        </div>
      </ChatBox.Provider>
    );
  }
  const who = AGENT_TITLE[c.with];
  const kind = talkKind(t);
  const lastYou = [...messages].reverse().find((m) => m.who === 'you');
  const primary = primaryOf(t);
  const worker = workingRole(t);
  const opening =
    kind.kind === 'working'
      ? `You are asking the ${who}. ${worker ? `The ${AGENT_TITLE[worker]}` : 'The squad'} keeps working on ${t.id}, and this talk changes nothing.`
      : kind.kind === 'review' || kind.kind === 'still'
        ? `You are asking the ${who} about ${t.id}. It stays where it is, and this talk changes nothing.`
        : kind.kind === 'released'
          ? `${t.id} is ${t.stage === 'done' ? 'released' : 'accepted'}. Ask the ${who} anything about it.`
          : `You started talking with the ${who}. Its work on ${t.id} waits until you press ${primary ? primary.label : 'Done'}${primary && primary.label !== 'Back to work' ? ' or Done' : ''}.`;
  const lastAgent = [...messages].reverse().find(isAgent);
  const focus = (with_?: string) => {
    if (with_ !== undefined) setText(with_);
    setTimeout(() => input.current?.focus(), 0);
  };
  // The reply so far, while the agent writes it.
  const draft = c.thinking && c.draft && messages.at(-1)?.note !== 'waits' ? c.draft : '';

  return (
    <ChatBox.Provider value={door}>
      <div className={`chat-v csize-${size}`}>
        <ChatHeader t={t} size={size} onFull={onFull} onPanel={onPanel} />
        <div
          className="cthread"
          ref={thread}
          aria-live="polite"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="ccol" ref={col}>
            {c.open && size !== 'pop' && <div className="cnote-pill">{opening}</div>}
            {messages.map((m, i) => {
              if (m.who === 'squad') return <SquadNote key={i} t={t} m={m} last={i === messages.length - 1} onAsk={() => focus()} />;
              if (m.who === 'you') return <YouMessage key={i} t={t} m={m} fresh={fresh(m)} onOpenDoc={onOpenDoc} onReply={(q) => focus(q)} />;
              const prev = messages[i - 1];
              const writing = reveal?.key === keyOf(m);
              const next = messages[i + 1];
              return (
                <AgentMessage
                  key={i}
                  t={t}
                  m={m}
                  size={size}
                  used={stepsFor(prev?.at, m.at)}
                  writing={writing ? reveal!.shown : null}
                  answer={next?.who === 'you' ? next.text : undefined}
                  canChoose={c.open && !c.thinking && m === lastAgent && i === messages.length - 1}
                  newest={m === lastAgent}
                  onChoose={(o) => sendRef.current?.(o)}
                  onOther={() => focus()}
                  onOpenDoc={onOpenDoc}
                  onReply={(q) => focus(q)}
                />
              );
            })}
            {pending && <Sending p={pending} />}
            {draft ? (
              <Drafting t={t} role={c.with} text={draft} size={size} onShown={(n) => (drafted.current = { text: draft, shown: n })} />
            ) : (
              // While the answer waits for the usage limit, the note says until when instead of the dots.
              c.thinking && messages.at(-1)?.note !== 'waits' && <Thinking role={c.with} steps={stepsFor(lastYou?.at ?? messages.at(-1)?.at)} hasMessage={Boolean(lastYou)} />
            )}
            <SplitDone t={t} />
            {decide}
          </div>
        </div>
        {c.open ? (
          <Composer t={t} size={size} text={text} setText={setText} input={input} onSent={() => (pinned.current = true)} sendRef={sendRef} setPending={setPending} box={box} onBoxCancel={cancelBox} />
        ) : box ? (
          <BoxOnly t={t} box={box} onCancel={cancelBox} />
        ) : (
          <div className="cclosed">This talk is over. It stays here to read.</div>
        )}
      </div>
    </ChatBox.Provider>
  );
}

export { AGENT_TITLE, SESSION, Avatar, TalkButton, workingRole, stageLine } from './chat/parts';
export type { ChatSize } from './chat/parts';

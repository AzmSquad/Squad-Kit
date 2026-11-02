import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  Bug,
  Check,
  ChevronRight,
  CircleAlert,
  Code,
  Compass,
  Copy,
  Eye,
  Loader2,
  Maximize2,
  MessageCircle,
  Mic,
  Minimize2,
  Paperclip,
  PencilLine,
  Plus,
  Reply,
  Search,
  Square,
  SquareCheck,
  SquarePlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../api/client';
import type { AgentName, ChatMessage, ConversationResponse, Ticket } from '../api/types';
import { useAct, useTicket } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { chatDock } from '../lib/chatDock';
import { detect, firstWords, langLabel, textClass, wordCount } from '../lib/lang';
import { ChatMarkdown, Folded, lineCount } from './ChatMarkdown';
import { AUDIO, ChatFiles, type OpenDoc } from './ChatFiles';
import { merge, type Item as AcpItem } from './Conversation';
import { readFile, type PickedFile } from './dialogs';
import { ProposeChange, canPropose, shipped } from './ChangeCard';
import { TakeOverButton, canTakeOver } from './TakeOver';
import { STAGE_NAME, clock, dateShort } from './ui';

export const AGENT_TITLE: Record<AgentName, string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' };
export const SESSION: Record<AgentName, 'intake' | 'build' | 'review' | 'tester'> = { analyst: 'intake', architect: 'intake', builder: 'build', reviewer: 'review', tester: 'tester' };
const ICON: Record<AgentName, LucideIcon> = { analyst: Search, architect: Compass, builder: Code, reviewer: Eye, tester: SquareCheck };

/** Who is working on a ticket right now, from the step it is on. */
const PHASE_ROLE: Record<string, AgentName> = {
  'analyst-read': 'analyst',
  triage: 'analyst',
  'spec-rewrite': 'analyst',
  'chat-spec': 'analyst',
  'plan-write': 'architect',
  'plan-rewrite': 'architect',
  'answered-architect': 'architect',
  'chat-design': 'architect',
  build: 'builder',
  unstick: 'builder',
  fix: 'builder',
  test: 'builder',
  'review-fix': 'builder',
  'update-base': 'builder',
  'answered-builder': 'builder',
  'chat-carry-builder': 'builder',
  review: 'reviewer',
  'answered-reviewer': 'reviewer',
  'chat-carry-reviewer': 'reviewer',
  proof: 'tester',
  'chat-carry-tester': 'tester',
};

export type ChatSize = 'panel' | 'full' | 'phone';
type Tool = Extract<AcpItem, { kind: 'tool' }>;

/** An agent's mark in its own color; it breathes while the agent works. */
export function Avatar({ role, small, live }: { role: AgentName; small?: boolean; live?: boolean }) {
  const Icon = ICON[role] ?? Search;
  return (
    <span className={`cav av-${role} ${small ? 'sm' : ''} ${live ? 'live' : ''}`} aria-hidden="true">
      <Icon size={small ? 13 : 16} strokeWidth={2} />
    </span>
  );
}

/** Open a talk with one agent from anywhere. It opens in the chat panel beside the board. */
export function TalkButton({ t, agent, label, primary }: { t: Ticket; agent: AgentName; label?: string; primary?: boolean }) {
  const act = useAct();
  return (
    <button
      className={`btn ${primary ? 'pri' : ''}`}
      disabled={act.isPending}
      onClick={() =>
        act.mutate(
          { path: `/api/v1/tickets/${t.id}/chat/start`, body: { with: agent } },
          { onSuccess: () => chatDock.show(t.id) },
        )
      }
    >
      <MessageCircle size={14} /> {label ?? `Talk to the ${AGENT_TITLE[agent]}`}
    </button>
  );
}

/** The agent working on the ticket now, if any. */
export function workingRole(t: Ticket): AgentName | null {
  return t.live && t.squad?.phase ? (PHASE_ROLE[t.squad.phase] ?? null) : null;
}

/** "Specs · your turn", "Implement · working", "Released · v0.3.0". */
export function stageLine(t: Ticket): { text: string; tone: 'you' | 'work' | 'done' } {
  if (t.stage === 'done') return { text: `Released${t.release ? ` · ${t.release}` : ''}`, tone: 'done' };
  if (t.stage === 'release') return { text: `Accepted${t.release ? ` · ready for ${t.release}` : ''}`, tone: 'done' };
  const stage = STAGE_NAME[t.stage];
  if (t.chat?.open && !t.chat.beside) return { text: `${stage} · ${t.chat.thinking ? 'talking' : 'your turn'}`, tone: 'you' };
  if (t.waiting) return { text: `${stage} · your turn`, tone: 'you' };
  return { text: `${stage}${t.live ? ' · working' : ''}`, tone: t.live ? 'work' : 'you' };
}

/**
 * What the talk may do, in the words the header uses. A chat beside the work (the squad works on the ticket, or it is
 * accepted) changes nothing: asking never stops the work, and accepted work answers questions only.
 */
function talkKind(t: Ticket): { kind: 'talk' | 'working' | 'released'; note: string } {
  const c = t.chat!;
  const who = AGENT_TITLE[c.with];
  if (c.beside && shipped(t)) return { kind: 'released', note: 'Questions only' };
  if (c.beside) return { kind: 'working', note: 'Asking never stops the work' };
  return { kind: 'talk', note: `The ${who} waits while you talk` };
}

/** The button that ends the talk the way it was meant to end. */
function primaryOf(t: Ticket): { label: string; path: string; done: string } | null {
  const c = t.chat!;
  const who = AGENT_TITLE[c.with];
  if (c.beside) return null;
  if (c.with === 'analyst') return { label: `${t.story ? 'Update' : 'Write'} the spec`, path: 'write', done: `The Analyst is ${t.story ? 'updating' : 'writing'} the spec from your talk.` };
  if (c.with === 'architect' && t.specApproved) return { label: `${t.steps ? 'Update' : 'Write'} the design`, path: 'write', done: `The Architect is ${t.steps ? 'updating' : 'writing'} the design from your talk.` };
  if (c.with === 'architect') return null;
  return { label: 'Back to work', path: 'done', done: `The ${who} carries on as you agreed.` };
}

/* ── The header ────────────────────────────────────────── */

function ChatHeader({ t, size, onFull, onPanel }: { t: Ticket; size: ChatSize; onFull?(): void; onPanel?(): void }) {
  const act = useAct();
  // A change goes through the spec: proposed here, or on accepted work a new linked ticket or a bug report.
  const [change, setChange] = useState(false);
  const c = t.chat!;
  const who = AGENT_TITLE[c.with];
  const kind = talkKind(t);
  const stage = stageLine(t);
  const primary = c.open ? primaryOf(t) : null;
  const busy = act.isPending || Boolean(c.thinking);
  const later = c.with === 'builder' || c.with === 'reviewer' || c.with === 'tester';
  const worker = workingRole(t);
  const run = (path: string, done: string) => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/${path}`, done });

  const buttons = (
    <>
      {c.open && primary && (
        <button className="btn pri" disabled={busy} onClick={() => run(primary.path, primary.done)}>
          <Check size={15} strokeWidth={2.5} /> {primary.label}
        </button>
      )}
      {c.open && kind.kind === 'talk' && !later && (
        <button className="btn" disabled={busy} onClick={() => run('done', 'Done talking.')}>
          {primary ? 'Done, no changes' : 'Done'}
        </button>
      )}
      {c.open && kind.kind === 'talk' && later && canTakeOver(t) && <TakeOverButton t={t} />}
      {c.open && kind.kind === 'released' && (
        <>
          <button className="btn" onClick={() => setChange(true)}>
            <SquarePlus size={14} /> New linked ticket
          </button>
          <button className="btn" onClick={() => setChange(true)}>
            <Bug size={14} /> Report a bug
          </button>
        </>
      )}
      {c.open && kind.kind === 'working' && canPropose(t) && (
        <button className="btn" onClick={() => setChange(true)}>
          <PencilLine size={14} /> Propose a change
        </button>
      )}
      {c.open && kind.kind !== 'talk' && (
        <button className="btn" disabled={act.isPending} onClick={() => run('done', `Done asking the ${who}.`)}>
          Done
        </button>
      )}
      {!c.open && !t.takenOver && (
        <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/start`, body: { with: c.with } }, { onSuccess: () => chatDock.show(t.id) })}>
          <MessageCircle size={14} /> Talk to the {who} again
        </button>
      )}
    </>
  );

  const banner =
    c.open && kind.kind === 'working' ? (
      <div className="cbanner work">
        <span className="livedot" aria-hidden="true" />
        <span>
          <b>{worker ? `The ${AGENT_TITLE[worker]} keeps working` : t.live || t.squad ? 'The squad keeps working' : 'Nothing waits for this talk'}</b>
          {t.status ? <> · {t.status}</> : null}. Your questions change nothing on {t.id}; a change goes through the spec.
        </span>
      </div>
    ) : c.open && kind.kind === 'released' ? (
      <div className="cbanner done">
        <span>
          <b>{t.id} is {t.stage === 'done' ? `released${t.release ? ` in ${t.release}` : ''}` : `accepted${t.release ? ` for ${t.release}` : ''}`}.</b> Ask anything about it. A change becomes a new
          linked ticket or a bug report.
        </span>
      </div>
    ) : null;

  const dialogs = change ? <ProposeChange t={t} from={c.with} onClose={() => setChange(false)} /> : null;

  if (size === 'phone') {
    return (
      <div className="chead-m">
        <div className="chead-m-row">
          <span className="ctitle">{t.title}</span>
          {c.open && primary && (
            <button className="btn pri sm" disabled={busy} onClick={() => run(primary.path, primary.done)}>
              {primary.label}
            </button>
          )}
          {c.open && !primary && (
            <button className="btn sm" disabled={act.isPending} onClick={() => run('done', 'Done talking.')}>
              Done
            </button>
          )}
        </div>
        {banner}
        {c.open && kind.kind === 'released' && (
          <div className="chead-m-row">
            <button className="btn sm" onClick={() => setChange(true)}>
              <SquarePlus size={13} /> New linked ticket
            </button>
            <button className="btn sm" onClick={() => setChange(true)}>
              <Bug size={13} /> Report a bug
            </button>
          </div>
        )}
        {dialogs}
      </div>
    );
  }

  if (size === 'full') {
    return (
      <div className="chead-f">
        <div className="chead-f-row">
          <Avatar role={c.with} live={c.thinking} />
          <div className="chead-f-t">
            <div className="chead-line">
              <span className="cid">{t.id}</span>
              <span className={`cstage ${stage.tone}`}>{stage.text}</span>
              {c.open && <span className="cnote">{kind.note}</span>}
            </div>
            <div className="ctitle">{t.title}</div>
          </div>
          <span className="grow" />
          <div className="cbtns">{buttons}</div>
          {onPanel && (
            <button className="iconbtn" onClick={onPanel} aria-label="Back to the side panel" title="Back to the side panel">
              <Minimize2 size={16} />
            </button>
          )}
        </div>
        {banner}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="chead-p">
      <div className="chead-line">
        <span className="cid">{t.id}</span>
        <span className={`cstage ${stage.tone}`}>{stage.text}</span>
        <span className="grow" />
        {c.open && <span className="cnote">{kind.note}</span>}
        {onFull && (
          <button className="iconbtn sm" onClick={onFull} aria-label="Open full screen" title="Full screen">
            <Maximize2 size={14} />
          </button>
        )}
      </div>
      <div className="ctitle">{t.title}</div>
      {banner}
      <div className="cbtns">{buttons}</div>
      {dialogs}
    </div>
  );
}

/* ── The talk ──────────────────────────────────────────── */

const keyOf = (m: ChatMessage) => `${m.at}|${m.who}`;
const isAgent = (m: ChatMessage) => m.who !== 'you' && m.who !== 'squad';

/**
 * One chat with one agent, in three sizes: the side panel beside the board, the full-screen Conversations page and a
 * phone. Replies come from the agent's real session; while it works you see what it reads and its working steps, and
 * each new answer is written out word by word. Only your buttons move the ticket on.
 */
export function ChatView({ id, size, onOpenDoc, onFull, onPanel }: { id: string; size: ChatSize; onOpenDoc(d: OpenDoc): void; onFull?(): void; onPanel?(): void }) {
  const ticket = useTicket(id);
  const t = ticket.data;
  const c = t?.chat;
  const thread = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  // A tapped choice is sent like a typed message.
  const sendRef = useRef<((words: string) => void) | null>(null);
  // Your message shows as sending until the board has it.
  const [pending, setPending] = useState<Pending | null>(null);
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
  const known = useRef<Set<string> | null>(null);
  const [reveal, setReveal] = useState<{ key: string; shown: number; total: number } | null>(null);
  const messages = useMemo(() => c?.messages ?? [], [c?.messages]);
  useEffect(() => {
    if (!c) return;
    const keys = messages.map(keyOf);
    if (!known.current) {
      known.current = new Set(keys);
      return;
    }
    const fresh = messages.filter((m) => !known.current!.has(keyOf(m)));
    for (const k of keys) known.current.add(k);
    const last = fresh.filter(isAgent).at(-1);
    if (last) setReveal({ key: keyOf(last), shown: 0, total: wordCount(last.text) });
  }, [c, messages]);
  useEffect(() => {
    if (!reveal) return;
    if (reveal.shown >= reveal.total) {
      setReveal(null);
      return;
    }
    const step = Math.max(1, Math.ceil(reveal.total / 120));
    const timer = setTimeout(() => setReveal((r) => (r ? { ...r, shown: r.shown + step } : r)), 55);
    return () => clearTimeout(timer);
  }, [reveal]);

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
    if (c) chatDock.seen(id, messages.length);
  }, [c, id, messages.length]);

  if (!t) return <div className="cempty">{ticket.isError ? `No ticket ${id}.` : 'Loading…'}</div>;
  if (!c) {
    return (
      <div className="cempty">
        <p>No talk on {t.id} yet.</p>
        <TalkButton t={t} agent="analyst" primary />
      </div>
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
      : kind.kind === 'released'
        ? `${t.id} is ${t.stage === 'done' ? 'released' : 'accepted'}. Ask the ${who} anything about it.`
        : `You started talking with the ${who}. Its work on ${t.id} waits until you press ${primary ? primary.label : 'Done'}${primary && primary.label !== 'Back to work' ? ' or Done' : ''}.`;
  const lastAgent = [...messages].reverse().find(isAgent);
  const focus = (with_?: string) => {
    if (with_ !== undefined) setText(with_);
    setTimeout(() => input.current?.focus(), 0);
  };

  return (
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
          {c.open && <div className="cnote-pill">{opening}</div>}
          {messages.map((m, i) => {
            if (m.who === 'squad') return <SquadNote key={i} t={t} m={m} last={i === messages.length - 1} onAsk={() => focus()} />;
            if (m.who === 'you') return <YouMessage key={i} t={t} m={m} onOpenDoc={onOpenDoc} onReply={(q) => focus(q)} />;
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
          {c.thinking && <Thinking role={c.with} steps={stepsFor(lastYou?.at ?? messages.at(-1)?.at)} hasMessage={Boolean(lastYou)} />}
        </div>
      </div>
      {c.open ? (
        <Composer t={t} size={size} text={text} setText={setText} input={input} onSent={() => (pinned.current = true)} sendRef={sendRef} setPending={setPending} />
      ) : (
        <div className="cclosed">This talk is over. It stays here to read.</div>
      )}
    </div>
  );
}

/* ── Messages ──────────────────────────────────────────── */

interface Pending {
  text: string;
  files: PickedFile[];
  count: number;
}

/** Your message on its way: each file with its upload bar, then the words. */
function Sending({ p }: { p: Pending }) {
  const d = detect(p.text);
  return (
    <div className="cyou cmsg">
      <div className="cybub">
        {p.files.length > 0 && (
          <div className="cup">
            {p.files.map((f, i) => (
              <div key={i} className="cup-row">
                {f.preview ? <img className="cup-img" src={f.preview} alt="" /> : <span className="cfic sm file">{(f.name.split('.').pop() ?? '').toUpperCase().slice(0, 4)}</span>}
                <span className="cfname">{f.name}</span>
                <span className="cbar">
                  <i />
                </span>
              </div>
            ))}
          </div>
        )}
        {p.text.trim() && (
          <p className={textClass(d)} dir={d.dir} lang={d.dir === 'rtl' ? 'ar' : 'en'}>
            {p.text}
          </p>
        )}
      </div>
      <span className="cmeta">You · now · sending</span>
    </div>
  );
}

function MsgActions({ t, m, holder, onReply }: { t: Ticket; m: ChatMessage; holder: RefObject<HTMLDivElement>; onReply(q: string): void }) {
  const act = useAct();
  const { toast } = usePrefs();
  const [menu, setMenu] = useState(false);
  const [change, setChange] = useState(false);
  const words = () => {
    // A sentence you selected inside this message, or the whole message.
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed && holder.current?.contains(sel.anchorNode) ? sel.toString().trim() : '';
    return (picked || m.text).trim().slice(0, 2000);
  };
  const add = (kind: 'rule' | 'criterion' | 'note', label: string) => {
    setMenu(false);
    act.mutate({ path: `/api/v1/tickets/${t.id}/notes`, body: { text: words(), kind }, done: `Added to the spec as ${label}.` });
  };
  const copy = () => void navigator.clipboard?.writeText(m.text).then(() => toast('Copied'), () => toast('Could not copy. Select the text instead.', 'err'));
  const quote = () => onReply(`> ${m.text.replace(/\s+/g, ' ').slice(0, 160)}${m.text.length > 160 ? '…' : ''}\n\n`);
  return (
    <div className="cacts">
      <button className="cact" onClick={copy}>
        <Copy size={13} /> Copy
      </button>
      {/* Your message can become a change to the spec: the Analyst writes it, and you approve it. */}
      {m.who === 'you' && m.text.trim() && canPropose(t) && (
        <button className="cact" onClick={() => setChange(true)}>
          <PencilLine size={13} /> Propose as a change
        </button>
      )}
      {!shipped(t) && m.text.trim() && (
        <span className="cmenu-w">
          <button className="cact" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} onMouseDown={(e) => e.preventDefault()}>
            <Plus size={13} /> Add to spec
          </button>
          {menu && (
            <div className="cmenu" role="menu" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" onClick={() => add('rule', 'a business rule')} onMouseDown={(e) => e.preventDefault()}>
                <b>A business rule</b>
                <small>Every agent must follow it</small>
              </button>
              <button role="menuitem" onClick={() => add('criterion', 'a "done when" item')} onMouseDown={(e) => e.preventDefault()}>
                <b>A "done when" item</b>
                <small>The Tester proves it with a screenshot</small>
              </button>
              <button role="menuitem" onClick={() => add('note', 'a note')} onMouseDown={(e) => e.preventDefault()}>
                <b>A note</b>
                <small>Context for the next steps</small>
              </button>
            </div>
          )}
        </span>
      )}
      {t.chat?.open && (
        <button className="cact" onClick={quote}>
          <Reply size={13} /> Reply
        </button>
      )}
      {change && <ProposeChange t={t} initial={m.text} from={t.chat?.with} onClose={() => setChange(false)} />}
    </div>
  );
}

/** Your own words: each line its own paragraph, so a line in Arabic and a line in English each read right. */
function asParagraphs(text: string): string {
  let fence = false;
  return text
    .split('\n')
    .map((l, i, all) => {
      if (/^\s*```/.test(l)) fence = !fence;
      const next = all[i + 1] ?? '';
      return !fence && l.trim() && next.trim() && !/^\s*([-*+]|\d+\.|>|```)\s/.test(next) ? `${l}\n` : l;
    })
    .join('\n');
}

function YouMessage({ t, m, onOpenDoc, onReply }: { t: Ticket; m: ChatMessage; onOpenDoc(d: OpenDoc): void; onReply(q: string): void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(false);
  const voice = !m.text.trim() && (m.files ?? []).some((f) => AUDIO.test(f));
  return (
    <div className={`cyou cmsg ${picked ? 'picked' : ''}`}>
      <div className="cybub" ref={holder} onClick={() => setPicked(!picked)}>
        {m.text.trim() && <ChatMarkdown text={asParagraphs(m.text)} ticket={t.id} />}
        {m.files && m.files.length > 0 && <ChatFiles ticket={t.id} files={m.files} onOpen={onOpenDoc} sent from="From you" />}
      </div>
      <span className="cmeta">
        You · {when(m.at)}
        {voice ? ' · written out from your voice' : ''}
      </span>
      <MsgActions t={t} m={m} holder={holder} onReply={onReply} />
    </div>
  );
}

function when(at: string): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? clock(at) : `${dateShort(at)} ${clock(at)}`;
}

function AgentMessage({
  t,
  m,
  size,
  used,
  writing,
  answer,
  canChoose,
  newest,
  onChoose,
  onOther,
  onOpenDoc,
  onReply,
}: {
  t: Ticket;
  m: ChatMessage;
  /** The latest answer always shows whole. */
  newest: boolean;
  size: ChatSize;
  used: Tool[];
  writing: number | null;
  answer?: string;
  canChoose: boolean;
  onChoose(o: string): void;
  onOther(): void;
  onOpenDoc(d: OpenDoc): void;
  onReply(q: string): void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(false);
  const role = m.who as AgentName;
  const name = AGENT_TITLE[role] ?? 'Agent';
  const live = writing !== null;
  const text = live ? firstWords(m.text, writing) : m.text;
  const body = <ChatMarkdown text={text} ticket={t.id} stream={live} caret={live} />;
  return (
    <div className={`cag cmsg ag-${role} ${picked ? 'picked' : ''}`}>
      <Avatar role={role} live={live} />
      <div className="cwho">
        <b>{name}</b>
        {live ? <span className="shim">Writing</span> : <span className="ctime">{when(m.at)}</span>}
      </div>
      <div className="cagb" ref={holder} onClick={(e) => size === 'phone' && !(e.target as HTMLElement).closest('button, a') && setPicked(!picked)}>
        {used.length > 0 && <Looked steps={used} />}
        {live || newest ? body : <Folded lines={lineCount(m.text)}>{body}</Folded>}
        {!live && m.files && m.files.length > 0 && <ChatFiles ticket={t.id} files={m.files} onOpen={onOpenDoc} from={`From the ${name} · ${when(m.at)}`} />}
        {!live && m.options && m.options.length > 0 && <Choices options={m.options} answer={answer} can={canChoose} onChoose={onChoose} onOther={onOther} />}
      </div>
      {!live && size === 'phone' && <span className="cmeta">{name} · {when(m.at)}</span>}
      {!live && <MsgActions t={t} m={m} holder={holder} onReply={onReply} />}
    </div>
  );
}

/** Tap one, or write your own. The agent's recommended choice comes first. */
function Choices({ options, answer, can, onChoose, onOther }: { options: string[]; answer?: string; can: boolean; onChoose(o: string): void; onOther(): void }) {
  const d = detect(options.join(' '));
  const chosen = answer?.trim();
  return (
    <div className="cchoices" dir={d.dir}>
      {options.map((o) => {
        const od = detect(o);
        const cls = chosen ? (chosen === o.trim() ? 'on' : 'off') : can ? '' : 'off';
        return (
          <button key={o} className={`cch ${cls} ${textClass(od)}`} lang={od.dir === 'rtl' ? 'ar' : 'en'} dir={od.dir} disabled={!can} onClick={() => onChoose(o)}>
            {o}
          </button>
        );
      })}
      {can && (
        <button className="cch other" onClick={onOther} dir={d.dir}>
          {d.dir === 'rtl' ? 'إجابة أخرى…' : 'Something else…'}
        </button>
      )}
    </div>
  );
}

function stepLine(s: Tool): { title: string; plus?: number; minus?: number } {
  let plus = 0;
  let minus = 0;
  for (const c of s.content) {
    if (c.type !== 'diff') continue;
    const before = (c.oldText ?? '').split('\n').filter(Boolean).length;
    const after = c.newText.split('\n').filter(Boolean).length;
    plus += Math.max(0, after - (c.oldText == null ? 0 : Math.min(before, after)));
    minus += c.oldText == null ? 0 : Math.max(0, before - after);
  }
  return { title: s.title, ...(plus || minus ? { plus, minus } : {}) };
}

function StepRow({ s }: { s: Tool }) {
  const l = stepLine(s);
  return (
    <div className={`cstep ${s.status}`}>
      {s.status === 'completed' ? <Check size={13} strokeWidth={2.5} /> : s.status === 'failed' ? <X size={13} /> : <Loader2 size={13} className="spin" />}
      <span className="cstep-t">{l.title}</span>
      {l.plus !== undefined && (
        <span className="cstep-n">
          <span className="add">+{l.plus}</span> <span className="del">−{l.minus}</span>
        </span>
      )}
    </div>
  );
}

/** When the answer is done, its working steps fold into "Looked at 4 things". */
function Looked({ steps }: { steps: Tool[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="cactv" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : undefined }} /> Looked at {steps.length} {steps.length === 1 ? 'thing' : 'things'}
      </button>
      {open && (
        <div className="cactlist">
          {steps.map((s) => (
            <StepRow key={s.id} s={s} />
          ))}
        </div>
      )}
    </>
  );
}

/** Before the first word: what the agent is reading, live, and each working step ticking off as it ends. */
function Thinking({ role, steps, hasMessage }: { role: AgentName; steps: Tool[]; hasMessage: boolean }) {
  const now = steps.filter((s) => s.status === 'in_progress').at(-1) ?? steps.at(-1);
  const label = now ? now.title : hasMessage ? 'Reading your message' : 'Reading the ticket';
  const shown = steps.slice(-6);
  return (
    <div className={`cag cmsg ag-${role} thinking`}>
      <Avatar role={role} live />
      <div className="cwho">
        <b>{AGENT_TITLE[role]}</b>
        <span className="shim">{label}</span>
      </div>
      <div className="cagb">
        <span className="cdots" aria-label={`The ${AGENT_TITLE[role]} is answering`}>
          <i />
          <i />
          <i />
        </span>
        {shown.length > 0 && (
          <div className="csteps">
            {steps.length > shown.length && <div className="cstep more">and {steps.length - shown.length} earlier steps</div>}
            {shown.map((s) => (
              <StepRow key={s.id} s={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A line from squad-kit. A stop or a failure always says what happened, that nothing was lost, and a way on. */
function SquadNote({ t, m, last, onAsk }: { t: Ticket; m: ChatMessage; last: boolean; onAsk(): void }) {
  const act = useAct();
  const failed = m.note === 'failed' || (!m.note && m.text.startsWith('Could not answer'));
  const who = t.chat ? AGENT_TITLE[t.chat.with] : 'agent';
  const ways = last && t.chat?.open && !t.chat.thinking && (failed || m.note === 'stopped');
  const retry = () => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/retry` });
  if (failed) {
    return (
      <div className="cfail cmsg">
        <div className="cfail-t">
          <CircleAlert size={15} /> The {who} could not answer. Nothing was lost.
          <span className="cfail-why">{m.text.replace(/^Could not answer:\s*/, '')}</span>
        </div>
        {ways && (
          <div className="cbtns">
            <button className="btn pri sm" disabled={act.isPending} onClick={retry}>
              Try again
            </button>
            <button className="btn sm" onClick={onAsk}>
              Ask something else
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="cnote-w cmsg">
      <div className="cnote-pill">{m.text}</div>
      {ways && (
        <div className="cbtns">
          <button className="btn sm" disabled={act.isPending} onClick={retry}>
            Ask again
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Typing box ────────────────────────────────────────── */

const MAX_FILE = 10 * 1024 * 1024;

/**
 * The typing box turns to the language you write in, as you type. Files come by the clip, a paste or a drop; a voice
 * note by the microphone. While the agent answers, Send becomes Stop.
 */
function Composer({
  t,
  size,
  text,
  setText,
  input,
  onSent,
  sendRef,
  setPending,
}: {
  t: Ticket;
  size: ChatSize;
  text: string;
  setText(v: string): void;
  input: RefObject<HTMLTextAreaElement>;
  onSent(): void;
  sendRef: { current: ((words: string) => void) | null };
  setPending(p: Pending | null): void;
}) {
  const act = useAct();
  const { toast } = usePrefs();
  const c = t.chat!;
  const who = AGENT_TITLE[c.with];
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const d = detect(text);
  const label = langLabel(d);
  const rows = Math.min(6, Math.max(1, text.split('\n').length));

  const add = async (list: FileList | File[]) => {
    const picked = [...list];
    const big = picked.find((f) => f.size > MAX_FILE);
    if (big) toast(`${big.name} is larger than 10 MB.`, 'err');
    const read = await Promise.all(picked.filter((f) => f.size <= MAX_FILE).slice(0, 10).map(readFile)).catch((err: Error) => {
      toast(err.message, 'err');
      return [];
    });
    setFiles((now) => [...now, ...read].slice(0, 10));
  };
  const send = (words = text, extra: PickedFile[] = []) => {
    const all = [...files, ...extra];
    if ((!words.trim() && !all.length) || c.thinking || act.isPending) return;
    // The message shows as sending in the talk at once; the typing box is free again. On a failure it comes back.
    setPending({ text: words, files: all, count: c.messages.length });
    const typed = text;
    setText('');
    setFiles([]);
    onSent();
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/chat/send`, body: { text: words, files: all.map(({ name, data }) => ({ name, data })) } },
      {
        onError: () => {
          setPending(null);
          setText(typed);
          setFiles(all.filter((f) => !extra.includes(f)));
        },
      },
    );
  };
  sendRef.current = (o: string) => send(o);
  const stop = () => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/stop` });
  const placeholder = size === 'phone' ? `Message the ${who}` : `Message the ${who} in Arabic or English`;

  return (
    <div
      className="ccomp"
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={() => setDrag(false)}
      onDrop={(e: DragEvent) => (e.preventDefault(), setDrag(false), void add(e.dataTransfer.files))}
    >
      {drag && <div className="cdrop">Drop files to add them to your message</div>}
      <Recorder
        who={who}
        size={size}
        onDone={(f) => send(text, [f])}
        render={(rec) =>
          rec.on ? (
            rec.box
          ) : (
            <div className={`cbox ${size === 'phone' ? 'm' : ''}`}>
              {files.length > 0 && (
                <div className="cpicked">
                  {files.map((f, i) => (
                    <span key={i} className="chip">
                      {f.preview ? <img src={f.preview} alt="" /> : <Paperclip size={12} />} {f.name}
                      <button className="iconbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, k) => k !== i))}>
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {size === 'phone' && (
                <button className="ib" aria-label="Add screenshots or files" onClick={() => fileInput.current?.click()}>
                  <Plus size={20} />
                </button>
              )}
              <textarea
                ref={input}
                className={`cta ${text ? textClass(d) : 't-en'}`}
                dir={text ? d.dir : 'auto'}
                lang={d.dir === 'rtl' ? 'ar' : 'en'}
                rows={rows}
                value={text}
                placeholder={placeholder}
                aria-label="Your message"
                onChange={(e) => setText(e.target.value)}
                onPaste={(e: ClipboardEvent) => {
                  const pics = [...e.clipboardData.files];
                  if (pics.length) void add(pics);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              {size === 'phone' ? (
                c.thinking ? (
                  <button className="csend m stop" onClick={stop} aria-label="Stop the answer">
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : text.trim() || files.length ? (
                  <button className="csend m" onClick={() => send()} aria-label="Send" disabled={act.isPending}>
                    <ArrowUp size={18} />
                  </button>
                ) : (
                  <button className="csend m mic" onClick={rec.start} aria-label="Record a voice note">
                    <Mic size={18} />
                  </button>
                )
              ) : (
                <div className="crow">
                  <button className="ib" aria-label="Add screenshots or files" title="Add screenshots or files" onClick={() => fileInput.current?.click()}>
                    <Paperclip size={16} />
                  </button>
                  <button className="ib" aria-label="Record a voice note" title="Record a voice note" onClick={rec.start}>
                    <Mic size={16} />
                  </button>
                  {label && <span className="clchip">{label}</span>}
                  <span className="grow" />
                  {c.thinking ? (
                    <button className="cstop" onClick={stop} disabled={c.stopping || act.isPending}>
                      <Square size={11} fill="currentColor" /> {c.stopping ? 'Stopping…' : 'Stop'}
                    </button>
                  ) : (
                    <button className="csend" onClick={() => send()} disabled={act.isPending || (!text.trim() && !files.length)} aria-label="Send">
                      <ArrowUp size={17} />
                    </button>
                  )}
                </div>
              )}
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void add(e.target.files)} />
            </div>
          )
        }
      />
      {size !== 'phone' && <div className="chint">Enter sends · Shift+Enter for a new line · It answers in the language you write</div>}
    </div>
  );
}

/** A voice note from the microphone. It is sent when you press Done; the agent reads its written text. */
function Recorder({ who, size, onDone, render }: { who: string; size: ChatSize; onDone(f: PickedFile): void; render(r: { on: boolean; start(): void; box: ReactNode }): ReactNode }) {
  const { toast } = usePrefs();
  const [on, setOn] = useState(false);
  const [secs, setSecs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const keep = useRef(false);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [on]);
  useEffect(() => () => rec.current?.stream.getTracks().forEach((x) => x.stop()), []);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm', 'audio/ogg', 'audio/mp4'].find((x) => MediaRecorder.isTypeSupported?.(x)) ?? '';
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((x) => x.stop());
        if (!keep.current || !chunks.length) return;
        const mime = r.mimeType || type || 'audio/webm';
        const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'weba';
        const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
        const file = new File(chunks, `voice-note-${stamp}.${ext}`, { type: mime });
        void readFile(file).then(onDone);
      };
      rec.current = r;
      keep.current = false;
      setSecs(0);
      r.start();
      setOn(true);
    } catch {
      toast('The microphone is not available. Allow it for this page, or attach a voice note file.', 'err');
    }
  };
  const finish = (send: boolean) => {
    keep.current = send;
    rec.current?.stop();
    setOn(false);
  };
  const box = (
    <div className={`crec ${size === 'phone' ? 'm' : ''}`} role="group" aria-label="Recording a voice note">
      <span className="crdot" />
      <span className="crt">
        0:{String(secs).padStart(2, '0')} · Recording for the {who}
      </span>
      <span className="clw" aria-hidden="true">
        {Array.from({ length: 22 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${(i % 7) * 0.11}s` }} />
        ))}
      </span>
      <button className="btn sm" onClick={() => finish(false)}>
        Cancel
      </button>
      <button className="btn sm pri" onClick={() => finish(true)}>
        Send
      </button>
    </div>
  );
  return <>{render({ on, start: () => void start(), box })}</>;
}

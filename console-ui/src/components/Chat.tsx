import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, Loader2, MessageCircle, Paperclip, Send, X } from 'lucide-react';
import { api } from '../api/client';
import type { AgentName, ChatMessage, ConversationResponse, Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { Cmd, Glyph } from './ui';
import { Attachments } from './Attachments';
import { Item, Markdown, merge, type Item as AcpItem } from './Conversation';
import { readFile, type PickedFile } from './dialogs';

export const AGENT_TITLE: Record<AgentName, string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' };
const SESSION: Record<AgentName, 'intake' | 'build' | 'review' | 'tester'> = { analyst: 'intake', architect: 'intake', builder: 'build', reviewer: 'review', tester: 'tester' };

/** "Talk it through" from anywhere: opens the chat with one agent. Its work pauses while you talk. */
export function TalkButton({ t, agent, label, primary }: { t: Ticket; agent: AgentName; label?: string; primary?: boolean }) {
  const act = useAct();
  return (
    <button
      className={`btn ${primary ? 'pri' : ''}`}
      disabled={act.isPending}
      onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/start`, body: { with: agent }, done: `Talking with the ${AGENT_TITLE[agent]}. Its work waits.` })}
    >
      <MessageCircle size={14} /> {label ?? `Talk to the ${AGENT_TITLE[agent]}`}
    </button>
  );
}

/**
 * The chat with an agent. Its replies come from its real Claude Code session; while it answers you see what it reads,
 * drawn from the session's ACP updates. Only your buttons move the ticket on.
 */
export function ChatPanel({ t }: { t: Ticket }) {
  const c = t.chat!;
  const act = useAct();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const who = AGENT_TITLE[c.with];
  const conv = useQuery({
    queryKey: ['conversation', t.id, SESSION[c.with]],
    queryFn: () => api<ConversationResponse>(`/api/v1/tickets/${t.id}/conversations/${SESSION[c.with]}`),
    refetchInterval: c.thinking ? 1500 : 8000,
    retry: false,
  });
  const steps = useMemo(() => merge(conv.data?.updates ?? []).filter((i): i is Extract<AcpItem, { kind: 'tool' }> => i.kind === 'tool'), [conv.data]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [c.messages.length, c.thinking]);

  const add = async (list: FileList | File[]) => {
    const picked = await Promise.all([...list].slice(0, 10).map(readFile));
    setFiles((f) => [...f, ...picked].slice(0, 10));
  };
  const send = () => {
    if ((!text.trim() && !files.length) || c.thinking) return;
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/chat/send`, body: { text, files: files.map(({ name, data }) => ({ name, data })) } },
      {
        onSuccess: () => {
          setText('');
          setFiles([]);
        },
      },
    );
  };
  const writes = c.with === 'analyst' || (c.with === 'architect' && Boolean(t.specApproved));
  const what = c.with === 'analyst' ? 'spec' : 'design';
  const has = c.with === 'analyst' ? Boolean(t.story) : Boolean(t.steps);
  const later = c.with === 'builder' || c.with === 'reviewer' || c.with === 'tester';
  const session = conv.data?.sessionId;
  // Tool steps between each of your messages and the reply that followed, so each answer shows what it looked at.
  const stepsFor = (from?: string, to?: string) => steps.filter((s) => (!from || (s.at ?? '') >= from) && (!to || (s.at ?? '') <= to));

  return (
    <>
      <div className="db chatdb" onDragOver={(e) => (e.preventDefault(), setDrag(true))} onDragLeave={() => setDrag(false)} onDrop={(e: DragEvent) => (e.preventDefault(), setDrag(false), void add(e.dataTransfer.files))}>
        <div className="youbox">
          <span className="ring">
            <MessageCircle size={15} />
          </span>
          <div>
            <b>Talking it through with the {who}</b>
            <span>{later ? `Its work is paused. Press Done and it carries on as you agreed.` : `Nothing is written until you press ${writes ? `${has ? 'Update' : 'Write'} the ${what}` : 'a button'}. You still approve it after.`}</span>
          </div>
        </div>
        <div className="chat">
          {c.messages.map((m, i) => {
            const prev = c.messages[i - 1];
            const used = m.who !== 'you' && m.who !== 'squad' ? stepsFor(prev?.at, m.at) : [];
            return <Bubble key={i} m={m} t={t} used={used} cwd={conv.data?.cwd} />;
          })}
          {c.thinking && <Thinking who={who} role={c.with} step={stepsFor(c.messages.at(-1)?.at).at(-1)} />}
          <div ref={end} />
        </div>
        {c.ready && !c.thinking && (
          <div className="chatready">
            <Check size={14} strokeWidth={2.5} /> The {who} thinks it understands enough. {writes ? `Press ${has ? 'Update' : 'Write'} the ${what} when you are happy.` : later ? 'Press Done when you are happy.' : ''}
          </div>
        )}
        {drag && <div className="chatdrop">Drop files to add them to your message</div>}
      </div>
      <div className="chatcompose">
        {files.length > 0 && (
          <div className="chatfiles">
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
        <div className="chatrow">
          <button className="iconbtn" title="Add screenshots, files or a voice note" aria-label="Add files" onClick={() => fileInput.current?.click()}>
            <Paperclip size={16} />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void add(e.target.files)} />
          <textarea
            className="chatinput"
            rows={1}
            value={text}
            disabled={c.thinking}
            placeholder={c.thinking ? `The ${who} is answering…` : `Message the ${who}. Enter sends, Shift+Enter for a new line`}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e: ClipboardEvent) => {
              const pics = [...e.clipboardData.files];
              if (pics.length) void add(pics);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn pri sendbtn" disabled={c.thinking || act.isPending || (!text.trim() && !files.length)} onClick={send} aria-label="Send">
            <Send size={15} />
          </button>
        </div>
      </div>
      <div className="df">
        {writes && (
          <button className="btn pri" disabled={c.thinking || act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/write`, done: `The ${who} is ${has ? 'updating' : 'writing'} the ${what} from your talk.` })}>
            <Check size={15} strokeWidth={2.5} /> {has ? 'Update' : 'Write'} the {what}
          </button>
        )}
        <button className={`btn ${writes ? '' : 'pri'}`} disabled={c.thinking || act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/chat/done`, done: later ? `The ${who} carries on as you agreed.` : 'Done talking.' })}>
          {later ? 'Done, carry on' : writes ? 'Done, no changes' : 'Done'}
        </button>
        <span className="grow" />
        {session && conv.data?.cwd && <Cmd text={`cd "${conv.data.cwd}" && claude --resume ${session}`} />}
      </div>
    </>
  );
}

function Bubble({ m, t, used, cwd }: { m: ChatMessage; t: Ticket; used: Extract<AcpItem, { kind: 'tool' }>[]; cwd?: string }) {
  const [open, setOpen] = useState(false);
  if (m.who === 'you') {
    return (
      <div className="bubble you">
        {m.text && <div className="btext">{m.text}</div>}
        {m.files && m.files.length > 0 && <Attachments ticket={t.id} files={m.files} />}
      </div>
    );
  }
  if (m.who === 'squad') return <div className="bubble squad">{m.text}</div>;
  return (
    <div className="bubble agent">
      <Glyph role={m.who} small />
      <div className="bbody">
        {used.length > 0 && (
          <button className="looked" onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Looked at {used.length} {used.length === 1 ? 'thing' : 'things'}
          </button>
        )}
        {open && (
          <div className="conv lookedlist">
            {used.map((it) => (
              <Item key={it.id} it={it} ticket={t.id} cwd={cwd} />
            ))}
          </div>
        )}
        <div className="conv-text">
          <Markdown text={m.text} />
        </div>
      </div>
    </div>
  );
}

function Thinking({ who, role, step }: { who: string; role: AgentName; step?: Extract<AcpItem, { kind: 'tool' }> }) {
  return (
    <div className="bubble agent thinking">
      <Glyph role={role} small />
      <div className="bbody">
        <span className="dots" aria-label={`The ${who} is answering`}>
          <i />
          <i />
          <i />
        </span>
        <span className="note">{step ? step.title : `The ${who} is thinking`}</span>
        {step?.status === 'in_progress' && <Loader2 size={12} className="spin" />}
      </div>
    </div>
  );
}

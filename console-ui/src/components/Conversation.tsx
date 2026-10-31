import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Highlight, themes } from 'prism-react-renderer';
import { Zoomable } from './Lightbox';
import {
  Brain,
  Check,
  Download,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  Pencil,
  Search,
  Send,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { api, ticketFileUrl } from '../api/client';
import type { AcpContentBlock, AcpToolContent, AcpToolKind, AcpToolStatus, AcpUpdate, ConversationResponse, ConversationSummary, Ticket } from '../api/types';
import { lineDiff } from '../lib/diff';
import { usePrefs } from '../lib/prefs';
import { Cmd, clock } from './ui';
import { useAct } from '../lib/data';
import { TakeOverButton, canTakeOver } from './TakeOver';

/**
 * The real conversation behind each role on a ticket, drawn from Agent Client Protocol (ACP) updates: messages,
 * thoughts, the plan, tool calls with their status, diffs of every edit, command output, pictures, recordings and files.
 */
export function ConversationTab({ t }: { t: Ticket }) {
  const list = useQuery({
    queryKey: ['conversations', t.id],
    queryFn: () => api<ConversationSummary[]>(`/api/v1/tickets/${t.id}/conversations`),
    refetchInterval: 3000,
  });
  const sessions = list.data ?? [];
  const [key, setKey] = useState<string | null>(null);
  // Follow the role that is working now; the person can pick another one.
  const chosen = key ?? sessions.filter((s) => s.started).at(-1)?.key ?? null;
  const conv = useQuery({
    queryKey: ['conversation', t.id, chosen],
    queryFn: () => api<ConversationResponse>(`/api/v1/tickets/${t.id}/conversations/${chosen}`),
    enabled: Boolean(chosen),
    refetchInterval: t.live ? 2000 : 10_000,
  });
  const items = useMemo(() => merge(conv.data?.updates ?? []), [conv.data]);
  const [follow, setFollow] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: 'end' });
  }, [items.length, follow, chosen]);

  if (!sessions.length) {
    return (
      <div className="db">
        <p className="note">No conversation yet. It starts when the Analyst reads the ticket.</p>
      </div>
    );
  }
  return (
    <div className="db">
      <div className="pills" style={{ marginBottom: 6 }}>
        {sessions.map((s) => (
          <button key={s.key} className={`btn sm ${s.key === chosen ? 'pri' : ''}`} disabled={!s.started} onClick={() => setKey(s.key)}>
            {s.label}
          </button>
        ))}
        <span className="grow" />
        <label className="note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow live
        </label>
      </div>
      <p className="note" style={{ fontSize: 12.5, margin: '0 0 14px' }}>
        A real Claude Code session on your subscription, read only, shown in the Agent Client Protocol format.{' '}
        {conv.data && conv.data.total > (conv.data.updates.length ?? 0) ? `Showing the latest ${conv.data.updates.length} of ${conv.data.total} updates.` : ''}
      </p>
      <div className="conv">
        {items.map((it, i) => (
          <Item key={it.kind === 'tool' ? it.id : i} it={it} ticket={t.id} cwd={conv.data?.cwd} />
        ))}
        <div ref={end} />
      </div>
      {chosen && <MessageAgent t={t} to={AGENT_OF[chosen] ?? 'builder'} />}
      {conv.data?.command && (
        <>
          <div className="lbl">Open it in Claude Code</div>
          <Cmd text={conv.data.command} />
          <p className="note" style={{ fontSize: 12.5, marginTop: 6 }}>
            {chosen === 'build' && canTakeOver(t) ? (
              <>
                To work in it yourself, press <b>Take over</b> first, so you and the squad never edit at the same time.{' '}
                <TakeOverButton t={t} />
              </>
            ) : t.takenOver ? (
              'The ticket is yours: type into it freely, then press Give back on the Now tab.'
            ) : (
              'Read it any time. To work in it, take the ticket over while it is being built.'
            )}
          </p>
        </>
      )}
    </div>
  );
}

const AGENT_OF: Record<string, 'analyst' | 'builder' | 'reviewer' | 'tester'> = { intake: 'analyst', build: 'builder', review: 'reviewer', tester: 'tester' };
const AGENT_NAME = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' } as const;

/** Message the agent: it reads it at its next step (a safe moment), and the work goes on. */
function MessageAgent({ t, to }: { t: Ticket; to: keyof typeof AGENT_NAME }) {
  const act = useAct();
  const [text, setText] = useState('');
  if (t.stage === 'done') return null;
  const send = () =>
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/notes`, body: { text, to }, done: `Sent. The ${AGENT_NAME[to]} reads it at its next step.` },
      { onSuccess: () => setText('') },
    );
  return (
    <div className="msgagent">
      <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message the ${AGENT_NAME[to]}…`} onKeyDown={(e) => e.key === 'Enter' && text.trim() && send()} />
      <button className="btn sm pri" disabled={!text.trim() || act.isPending} onClick={send}>
        <Send size={13} /> Send
      </button>
    </div>
  );
}

/* ── Turning ACP updates into things to draw ───────────── */

type Item =
  | { kind: 'message'; from: 'squad-kit' | 'claude-code' | 'agent' | 'thought'; content: AcpContentBlock; at?: string }
  | { kind: 'plan'; entries: Extract<AcpUpdate, { sessionUpdate: 'plan' }>['entries']; at?: string }
  | { kind: 'tool'; id: string; title: string; toolKind: AcpToolKind; status: AcpToolStatus; content: AcpToolContent[]; command?: string; at?: string };

/** A tool call and its later updates become one row whose status and content grow as the agent works. */
function merge(updates: { at?: string; update: AcpUpdate }[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  for (const { at, update: u } of updates) {
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        const from = u.content.type === 'text' && u.content._meta?.squadKit?.from === 'claude-code' ? 'claude-code' : 'squad-kit';
        items.push({ kind: 'message', from, content: u.content, at });
        break;
      }
      case 'agent_message_chunk':
        items.push({ kind: 'message', from: 'agent', content: u.content, at });
        break;
      case 'agent_thought_chunk':
        items.push({ kind: 'message', from: 'thought', content: u.content, at });
        break;
      case 'plan':
        items.push({ kind: 'plan', entries: u.entries, at });
        break;
      case 'tool_call': {
        const row: Extract<Item, { kind: 'tool' }> = {
          kind: 'tool',
          id: u.toolCallId,
          title: u.title,
          toolKind: u.kind ?? 'other',
          status: u.status ?? 'in_progress',
          content: [...(u.content ?? [])],
          command: u.rawInput?.command,
          at,
        };
        tools.set(u.toolCallId, row);
        items.push(row);
        break;
      }
      case 'tool_call_update': {
        // ACP: fields in an update replace the ones the call had.
        const row = tools.get(u.toolCallId);
        if (!row) break;
        if (u.status) row.status = u.status;
        if (u.title) row.title = u.title;
        if (u.kind) row.toolKind = u.kind;
        if (u.rawInput?.command) row.command = u.rawInput.command;
        if (u.content) row.content = [...u.content];
        break;
      }
    }
  }
  return items;
}

/* ── Drawing ───────────────────────────────────────────── */

function Item({ it, ticket, cwd }: { it: Item; ticket: string; cwd?: string }) {
  if (it.kind === 'plan') return <PlanCard entries={it.entries} />;
  if (it.kind === 'tool') return <ToolRow it={it} ticket={ticket} cwd={cwd} />;
  const { from, content } = it;
  if (from === 'agent') {
    return (
      <div className="conv-text">
        <Block content={content} ticket={ticket} />
      </div>
    );
  }
  return <Folded from={from} content={content} ticket={ticket} />;
}

function Folded({ from, content, ticket }: { from: 'squad-kit' | 'claude-code' | 'thought'; content: AcpContentBlock; ticket: string }) {
  const body = content.type === 'text' ? content.text : '';
  const long = body.length > 420 || body.split('\n').length > 8;
  const [open, setOpen] = useState(!long && from !== 'thought');
  const label = from === 'squad-kit' ? 'squad-kit asked' : from === 'claude-code' ? 'Note from Claude Code' : 'Thinking';
  return (
    <div className={from === 'thought' ? 'conv-thought' : 'conv-prompt'}>
      <button className="conv-who linkish" onClick={() => setOpen(!open)}>
        {from === 'thought' && <Brain size={12} />} {label} {!open && <span className="note">· show</span>}
      </button>
      {open && (from === 'thought' ? <div style={{ whiteSpace: 'pre-wrap' }}>{body}</div> : <Block content={content} ticket={ticket} />)}
    </div>
  );
}

const KIND_ICON: Record<AcpToolKind, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  delete: X,
  move: Pencil,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Wrench,
  other: Wrench,
};

function ToolRow({ it, ticket, cwd }: { it: Extract<Item, { kind: 'tool' }>; ticket: string; cwd?: string }) {
  const hasMedia = it.content.some((c) => c.type === 'content' && (c.content.type === 'image' || c.content.type === 'resource_link'));
  const hasDiff = it.content.some((c) => c.type === 'diff');
  const [open, setOpen] = useState(hasDiff || hasMedia || it.status === 'failed');
  useEffect(() => {
    if (it.status === 'failed' || hasMedia) setOpen(true);
  }, [it.status, hasMedia]);
  const Icon = KIND_ICON[it.toolKind] ?? Wrench;
  const body = it.content.length > 0 || it.command;
  return (
    <div className={`conv-tool ${it.status}`}>
      <button className="conv-tool-head" onClick={() => body && setOpen(!open)} aria-expanded={open}>
        <Icon size={14} />
        <span className="mono conv-tool-title">{it.title}</span>
        <span className="conv-at">{it.at ? clock(it.at) : ''}</span>
        <StatusChip status={it.status} />
      </button>
      {open && body && (
        <div className="conv-tool-body">
          {it.command && it.toolKind === 'execute' && <pre className="conv-cmd">$ {it.command}</pre>}
          {it.content.map((c, i) => (
            <ToolContent key={i} c={c} ticket={ticket} cwd={cwd} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: AcpToolStatus }) {
  if (status === 'completed') return <span className="conv-status ok"><Check size={12} /> Done</span>;
  if (status === 'failed') return <span className="conv-status bad"><X size={12} /> Failed</span>;
  return <span className="conv-status run"><Loader2 size={12} className="spin" /> Running</span>;
}

function ToolContent({ c, ticket, cwd }: { c: AcpToolContent; ticket: string; cwd?: string }) {
  if (c.type === 'diff') {
    // Paths inside the project show relative to it, like in a code review.
    const shown = cwd && c.path.startsWith(`${cwd}/`) ? c.path.slice(cwd.length + 1) : c.path;
    return <DiffView path={shown} oldText={c.oldText ?? ''} newText={c.newText} isNew={c.oldText == null} />;
  }
  if (c.type === 'terminal') return <p className="note">Terminal {c.terminalId}</p>;
  // Agents that speak ACP send command output as fenced markdown (```console …```).
  if (c.content.type === 'text') return c.content.text.trimStart().startsWith('```') ? <Markdown text={c.content.text} /> : <Output text={c.content.text} />;
  return <Block content={c.content} ticket={ticket} />;
}

function Output({ text }: { text: string }) {
  const long = text.length > 600 || text.split('\n').length > 12;
  const [open, setOpen] = useState(!long);
  return (
    <div className="conv-out">
      <pre>{open ? text : `${text.split('\n').slice(0, 10).join('\n').slice(0, 600)}…`}</pre>
      {long && (
        <button className="linkbtn" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all output'}
        </button>
      )}
    </div>
  );
}

function DiffView({ path, oldText, newText, isNew }: { path: string; oldText: string; newText: string; isNew: boolean }) {
  const lines = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  const added = lines.filter((l) => l.kind === 'add').length;
  const removed = lines.filter((l) => l.kind === 'del').length;
  const [all, setAll] = useState(lines.length <= 40);
  const shown = all ? lines : lines.slice(0, 40);
  return (
    <div className="conv-diff">
      <div className="conv-diff-head mono">
        <span style={{ overflowWrap: 'anywhere' }}>{path}</span>
        <span className="grow" />
        {isNew ? <span className="add">new file · {added} lines</span> : <span><span className="add">+{added}</span> <span className="del">−{removed}</span></span>}
      </div>
      <pre>
        {shown.map((l, i) =>
          l.kind === 'gap' ? (
            <div key={i} className="gap">⋯</div>
          ) : (
            <div key={i} className={l.kind}>
              <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
              {l.text || ' '}
            </div>
          ),
        )}
      </pre>
      {lines.length > 40 && (
        <button className="linkbtn" style={{ margin: '0 10px 8px' }} onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

function PlanCard({ entries }: { entries: Extract<AcpUpdate, { sessionUpdate: 'plan' }>['entries'] }) {
  const done = entries.filter((e) => e.status === 'completed').length;
  return (
    <div className="conv-plan">
      <div className="conv-who"><ListChecks size={13} /> Plan · {done} of {entries.length} done</div>
      {entries.map((e, i) => (
        <div key={i} className={`conv-plan-row ${e.status}`}>
          <span className="box">{e.status === 'completed' ? <Check size={11} /> : e.status === 'in_progress' ? <Loader2 size={11} className="spin" /> : null}</span>
          {e.content}
        </div>
      ))}
    </div>
  );
}

/** One ACP content block: markdown text, an image, audio, or a file the agent made. */
function Block({ content, ticket }: { content: AcpContentBlock; ticket: string }) {
  switch (content.type) {
    case 'text':
      return <Markdown text={content.text} />;
    case 'image':
      return <Zoomable className="conv-img" src={`data:${content.mimeType};base64,${content.data}`} alt="Picture the agent looked at" />;
    case 'audio':
      return <audio controls src={`data:${content.mimeType};base64,${content.data}`} />;
    case 'resource_link':
      return <FileCard uri={content.uri} name={content.name} mime={content.mimeType ?? ''} size={content.size ?? undefined} ticket={ticket} />;
    case 'resource':
      return content.resource.text ? <Output text={content.resource.text} /> : <FileCard uri={content.resource.uri} name={content.resource.uri.split('/').pop() ?? 'file'} mime={content.resource.mimeType ?? ''} ticket={ticket} />;
  }
}

function FileCard({ uri, name, mime, size, ticket }: { uri: string; name: string; mime: string; size?: number; ticket: string }) {
  const url = ticketFileUrl(ticket, uri);
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
    return (
      <div className="conv-media">
        <Zoomable className="conv-img" src={url} alt={name} />
        <span className="note mono">{name}</span>
      </div>
    );
  }
  if (mime.startsWith('video/')) {
    return (
      <div className="conv-media">
        <video className="conv-img" src={url} controls preload="metadata" />
        <span className="note mono">{name}</span>
      </div>
    );
  }
  if (mime.startsWith('audio/')) return <audio controls src={url} />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="conv-file">
      <Download size={15} />
      <span className="mono">{name}</span>
      <span className="note">{[mime.split('/').pop(), size ? `${Math.max(1, Math.round(size / 1024))} KB` : ''].filter(Boolean).join(' · ')}</span>
    </a>
  );
}

function Markdown({ text }: { text: string }) {
  const { theme } = usePrefs();
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            const lang = /language-(\w+)/.exec(className ?? '')?.[1];
            const code = String(children).replace(/\n$/, '');
            if (!lang && !code.includes('\n')) return <code className="mono">{children}</code>;
            return (
              <div className="md-code">
                {lang && <span className="md-lang">{lang === 'mermaid' ? 'Diagram (Mermaid)' : lang}</span>}
                <Highlight code={code} language={lang ?? 'text'} theme={theme === 'dark' ? themes.vsDark : themes.github}>
                  {({ tokens, getLineProps, getTokenProps }) => (
                    <pre>
                      {tokens.map((line, i) => (
                        <div key={i} {...getLineProps({ line })}>
                          {line.map((token, k) => (
                            <span key={k} {...getTokenProps({ token })} />
                          ))}
                        </div>
                      ))}
                    </pre>
                  )}
                </Highlight>
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

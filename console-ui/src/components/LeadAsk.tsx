import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ArrowUp, Eye, ShieldCheck, X } from 'lucide-react';
import type { LeadContext, LeadConversation, Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { chipWords, pageContext, problemQuestion } from '../lib/lead';
import { leadAsk, useLeadAsk } from '../lib/leadAsk';
import { useLeadConversation } from '../lib/leadData';
import { typedDir } from '../lib/lang';
import { LeadMark } from './LeadMark';
import { LeadTurnView, showNewest } from './LeadTurn';
import '../styles/lead.css';

/**
 * Asking the Squad lead from anywhere: ⌘K or Ctrl+K on any board page, "Ask the lead" on a story's stop, slow or
 * waiting card, "Ask about it" in Your apps. The box opens with the question filled in where the board knows it, sends
 * it with where it was asked from, and shows the answer right there, with a way to the Squad lead page. Nothing is sent
 * until the person presses Send.
 */

/** Sends a question: a new conversation, or a follow-up in one. */
export function useSendLead() {
  const act = useAct<LeadConversation>();
  const qc = useQueryClient();
  const send = (o: { text: string; context?: LeadContext | null; conversation?: string | null; fresh?: boolean }, then: (c: LeadConversation) => void) =>
    act.mutate({
      path: o.conversation ? `/api/v1/lead/conversations/${encodeURIComponent(o.conversation)}/messages` : '/api/v1/lead/conversations',
      body: { text: o.text, ...(o.context ? { context: o.context } : {}), ...(o.fresh ? { fresh: true } : {}) },
      after: (c) => {
        qc.setQueryData(['lead', 'conversation', c.id], c);
        then(c);
      },
    });
  return { send, busy: act.isPending };
}

/** The question box: Enter sends, Shift+Enter starts a new line. */
export function AskInput({
  id,
  value,
  onChange,
  onSend,
  busy,
  placeholder,
  chip,
  autoFocus,
}: {
  id?: string;
  value: string;
  onChange(v: string): void;
  onSend(): void;
  busy: boolean;
  placeholder: string;
  chip?: ReactNode;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);
  const ready = value.trim().length > 0 && !busy;
  return (
    <div className="lead-box">
      <textarea
        id={id}
        ref={ref}
        rows={1}
        value={value}
        dir={typedDir(value)}
        placeholder={placeholder}
        aria-label="Your question"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (ready) onSend();
          }
        }}
      />
      <div className="lead-bar">
        {chip}
        <span className="grow" />
        <button className="lead-send" disabled={!ready} onClick={onSend} aria-label="Send" title="Send (Enter)">
          <ArrowUp size={17} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}

/** Where the question is asked from, as a small chip in the box. */
export function ContextChip({ ctx }: { ctx: LeadContext }) {
  return (
    <span className="lt-ctx" title="The lead reads this first, so you do not have to describe it">
      <Eye size={12} aria-hidden="true" />
      {chipWords(ctx)}
    </span>
  );
}

/** "It reads and looks on its own…": under every ask box. */
export function SafeLine() {
  return (
    <p className="lead-hint">
      <ShieldCheck size={13} aria-hidden="true" />
      It reads and looks on its own. It changes nothing without your OK: changes come as stories you create.
    </p>
  );
}

/** ⌘K or Ctrl+K on any board page, and the box itself. On the Squad lead page the keys go to its own box. */
export function LeadAskHost() {
  const s = useLeadAsk();
  const loc = useRouterState({ select: (r) => r.location });
  const path = loc.pathname;
  const search = loc.search as Record<string, unknown>;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      if (leadAsk.get().open) return leadAsk.close();
      const own = path.startsWith('/lead') ? document.getElementById('lead-page-ask') : null;
      if (own) return own.focus();
      leadAsk.open({ context: pageContext(path, search) });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path, search]);
  if (!s.open || !s.context) return null;
  return <AskBox key={s.n} text={s.text} context={s.context} conversation={s.conversation} />;
}

function AskBox({ text: start, context, conversation }: { text: string; context: LeadContext; conversation: string | null }) {
  const [text, setText] = useState(start);
  const conv = useLeadConversation(conversation);
  const { send, busy } = useSendLead();
  const navigate = useNavigate();
  const feed = useRef<HTMLDivElement>(null);
  const c = conv.data;
  const turns = c?.turns.length ?? 0;
  const go = (t = text, fresh = false) =>
    send({ text: t.trim(), context: c ? null : context, conversation: c?.id ?? null, fresh }, (x) => {
      leadAsk.sent(x.id);
      setText('');
    });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.lightbox') && leadAsk.close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The newest question stays in view, with its answer under it.
  useEffect(() => {
    showNewest(feed.current);
  }, [turns, c?.thinking]);
  const openPage = () => {
    leadAsk.close();
    void navigate({ to: '/lead', search: c ? { c: c.id } : {} });
  };
  return (
    <div className="modal-veil lask-veil" onMouseDown={(e) => e.target === e.currentTarget && leadAsk.close()}>
      <div className="lask" role="dialog" aria-modal="true" aria-label="Ask the Squad lead">
        <header className="lask-h">
          <img src="/logo.svg" alt="" />
          <b>Ask the Squad lead</b>
          <span className="grow" />
          <kbd>Esc</kbd>
          <button className="iconbtn" onClick={leadAsk.close} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        {c && (
          <div className="lask-feed" ref={feed}>
            {c.turns.map((t, i) => (
              <LeadTurnView key={t.n} c={c} turn={t} last={i === c.turns.length - 1} onAgain={(q, fresh) => go(q, fresh)} />
            ))}
          </div>
        )}
        <div className="lask-ask">
          <AskInput
            value={text}
            onChange={setText}
            onSend={() => go()}
            busy={busy || Boolean(c?.thinking)}
            placeholder={c ? 'Ask a follow-up…' : context.from === 'app' ? `Ask about ${context.app ?? 'the app'}, or ask for something…` : 'Ask about the project, or ask for something…'}
            chip={<ContextChip ctx={c?.context ?? context} />}
            autoFocus
          />
        </div>
        <footer className="lask-f">
          <SafeLine />
          <span className="grow" />
          {c ? (
            <button className="btn sm" onClick={openPage}>
              Open in the Squad lead page
            </button>
          ) : (
            <span className="note">Enter sends</span>
          )}
        </footer>
      </div>
    </div>
  );
}

/** "Ask the lead" on a card: opens the box with the problem filled in, for the person to send or change. */
export function AskLeadButton({ text, context, label = 'Ask the lead', className = 'btn' }: { text?: string; context: LeadContext; label?: string; className?: string }) {
  return (
    <button className={className} onClick={() => leadAsk.open({ ...(text ? { text } : {}), context })}>
      <LeadMark size={14} className="lead-ic" />
      {label}
    </button>
  );
}

/** "Ask the lead" on a story's card, with its problem: stopped, slow, looks stuck, or waiting for you. */
export function AskLeadAbout({ t, problem, className }: { t: Pick<Ticket, 'id' | 'stuck'>; problem: 'slow' | 'stuck' | 'waiting' | 'error'; className?: string }) {
  const error = problem === 'error' ? t.stuck?.title ?? t.stuck?.question : undefined;
  return <AskLeadButton text={problemQuestion(problem, t.id)} context={{ from: 'problem', problem, story: t.id, ...(error ? { error: error.slice(0, 400) } : {}) }} {...(className ? { className } : {})} />;
}

/** Above a story that waits for you: one line, and the lead reads the story for you. */
export function AskLeadStrip({ t }: { t: Ticket }) {
  return (
    <div className="lead-strip">
      <LeadMark size={15} className="lead-ic" />
      <span>Not sure what to do here? The Squad lead reads this story and tells you, in plain words.</span>
      <AskLeadAbout t={t} problem="waiting" className="btn sm" />
    </div>
  );
}

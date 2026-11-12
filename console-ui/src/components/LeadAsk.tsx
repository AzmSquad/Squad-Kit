import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Eye, ShieldCheck } from 'lucide-react';
import type { LeadContext, LeadConversation, Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { chipWords, problemQuestion } from '../lib/lead';
import { leadAsk } from '../lib/leadAsk';
import { typedDir } from '../lib/lang';
import { askedHere } from '../lib/reveal';
import { LeadMark } from './LeadMark';
import '../styles/lead.css';

/**
 * Asking the Squad lead from anywhere: ⌘K or Ctrl+K on any board page, "Ask the lead" on a story's stop, slow or
 * waiting card, "Ask about it" in Your apps. The lead's popup opens with the question filled in where the board knows
 * it, sends it with where it was asked from, and shows the answer right there (components/ChatPopups). Nothing is
 * sent until the person presses Send.
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
        askedHere.add(`${c.id}.${c.turns.at(-1)?.n ?? 0}`);
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
  // The send button gives a small push when it sends.
  const [went, setWent] = useState(false);
  const go = () => {
    setWent(true);
    setTimeout(() => setWent(false), 220);
    onSend();
  };
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
            if (ready) go();
          }
        }}
      />
      <div className="lead-bar">
        {chip}
        <span className="grow" />
        <button className={`lead-send ${went ? 'go' : ''}`} disabled={!ready} onClick={go} aria-label="Send" title="Send (Enter)">
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

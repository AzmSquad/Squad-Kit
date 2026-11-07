import { useState, type ReactNode } from 'react';
import { Check, Copy, PenLine, RotateCcw } from 'lucide-react';
import type { Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { stuckTitle, wayButtons } from '../lib/problem';
import type { ReportAsk } from '../lib/report';
import { shellQuote } from '../lib/text';
import { OpenInEditor } from './Changes';
import { ReportButton } from './Report';
import { Cmd, Written } from './ui';
import { useDraft } from '../lib/drafts';
import { typedDir } from '../lib/lang';

/**
 * Every error the person sees, one way (phase 10): what happened in plain words, what is safe, and the ways out as
 * buttons, with Report a problem last. The exact error stays one click away, in the ticket's Developer tab.
 */

export interface Way {
  label: string;
  onClick(): void;
  primary?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  /** A longer line on hover: what the choice does. */
  title?: string;
}

export function ErrorCard({
  title,
  what,
  safe = [],
  ways,
  report,
  hint,
  calm,
  children,
}: {
  title: string;
  what: ReactNode;
  safe?: string[];
  ways: Way[];
  /** What Report a problem covers; false leaves it out. */
  report?: ReportAsk | false;
  hint?: ReactNode;
  /** A decision more than an error (a step paused at its limit, no tests yet): the card is grey, not red. */
  calm?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`drafterr errcard${calm ? ' calm' : ''}`} role="alert">
      <b className="errcard-title">{title}</b>
      <div className="errcard-what">{what}</div>
      {safe.length > 0 && (
        <ul className="safe-list">
          {safe.map((s) => (
            <li key={s}>
              <Check size={15} strokeWidth={2.6} aria-hidden="true" />
              {s}
            </li>
          ))}
        </ul>
      )}
      <div className="errcard-lbl">What you can do</div>
      <div className="drafterr-ways">
        {ways.map((w) => (
          <button key={w.label} className={`btn ${w.primary ? 'pri' : ''}`} disabled={w.disabled} title={w.title} onClick={w.onClick}>
            {w.icon}
            {w.label}
          </button>
        ))}
        {report !== false && <ReportButton {...(report ?? {})} />}
      </div>
      {hint && <div className="errcard-hint">{hint}</div>}
      {children}
    </div>
  );
}

/**
 * A stopped ticket. Try again and Send it back to the plan go at once (one call each); Continue anyway asks why first,
 * and Fix it yourself opens the ticket's copy first. Nothing is lost whatever the person picks.
 */
export function StuckCard({ t, extra }: { t: Ticket; extra?: ReactNode }) {
  const act = useAct();
  const [open, setOpen, clearOpen] = useDraft<'reason' | 'fix' | 'note' | null>(t.id, 'stuck-open', null);
  const [text, setText, clearText] = useDraft(t.id, 'stuck-text', '');
  const buttons = wayButtons(t.stuck);
  const decide = (index: number, body: { note?: string; reason?: string }, done: string) =>
    act.mutate(
      { path: `/api/v1/tickets/${t.id}/decide`, body: { choice: index, ...body }, done },
      {
        onSuccess: () => {
          clearOpen();
          clearText();
        },
      },
    );
  const retry = buttons.find((b) => b.way === 'retry');
  const pending = open === 'reason' || open === 'fix' ? buttons.find((b) => b.needs === open) : undefined;
  const note = open === 'note' && text.trim() ? text.trim() : '';
  const ways: Way[] = buttons.map((b) => ({
    label: b.label,
    title: b.note,
    primary: b.primary,
    disabled: act.isPending,
    icon: b.way === 'retry' ? <RotateCcw size={14} /> : b.way === 'yourself' ? <PenLine size={14} /> : undefined,
    onClick: () => {
      if (b.needs) {
        setOpen(open === b.needs ? null : b.needs);
        setText('');
        return;
      }
      decide(b.index, b.way === 'retry' && note ? { note } : {}, b.way === 'retry' ? 'Trying again. The squad carries on.' : 'Decided. The squad carries on.');
    },
  }));
  const cmd = pending
    ? `squad decide ${t.id} ${pending.index + 1}${pending.needs === 'reason' ? ` --reason ${shellQuote(text.trim() || '…')}` : ''}`
    : `squad decide ${t.id}${retry && note ? ` ${retry.index + 1} --note ${shellQuote(note)}` : ''}`;
  return (
    <div className="db">
      <ErrorCard
        title={stuckTitle(t.stuck)}
        calm={t.stuck?.kind === 'no-tests' || t.stuck?.gate === 'cap'}
        what={
          t.stuck?.points?.length ? (
            <>
              <Written as="div" text={t.stuck.question} />
              <ul className="errcard-points">
                {t.stuck.points.map((p) => (
                  <Written as="li" key={p} text={p} />
                ))}
              </ul>
            </>
          ) : (
            <Written as="div" text={t.stuck?.question ?? ''} />
          )
        }
        safe={t.stuck?.safe ?? ['Nothing was lost: the work so far is kept.']}
        ways={ways}
        report={{ ticket: t.id }}
        hint={
          <>
            {retry && open !== 'note' && (
              <button className="linkbtn" onClick={() => setOpen('note')}>
                Add a note for the squad first
              </button>
            )}
            {t.stuck?.detail ? ' Engineers: the exact error is in the Developer tab.' : ''}
          </>
        }
      />
      {open === 'note' && (
        <>
          <div className="lbl">A note for the squad (optional)</div>
          <textarea className="waynote" rows={2} dir={typedDir(text)} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: the test server needs the VPN, it is on now" />
          <p className="note" style={{ fontSize: 12.5 }}>
            The squad reads it first when you press {retry?.label ?? 'Try again'}.
          </p>
        </>
      )}
      {open === 'reason' && pending && (
        <>
          <div className="lbl">{pending.way === 'skip-hooks' ? 'Why save it without the check?' : 'Why continue anyway?'}</div>
          <textarea className="waynote" rows={2} dir={typedDir(text)} value={text} onChange={(e) => setText(e.target.value)} placeholder={pending.way === 'skip-hooks' ? 'For example: the check needs a licence this laptop does not have' : 'For example: the failing test is broken on main too, fixed in SK-160'} />
          <p className="note" style={{ fontSize: 12.5 }}>Only you can do this. Your reason shows on the ticket, the pull request and the release notes.</p>
          <div className="errcard-confirm">
            <button className="btn pri" disabled={!text.trim() || act.isPending} onClick={() => decide(pending.index, { reason: text }, 'Decided. The squad carries on.')}>
              <Check size={15} strokeWidth={2.5} /> {pending.label}
            </button>
          </div>
        </>
      )}
      {open === 'fix' && pending && (
        <div className="stuckbox" style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 8px' }}>
            Open the ticket&apos;s copy, fix it, and save. Then press <b>I fixed it</b>: the checks, review and proof run again.
          </p>
          <div className="errcard-confirm">
            <OpenInEditor t={t} />
            <button className="btn pri" disabled={act.isPending} onClick={() => decide(pending.index, {}, 'OK. The checks run again on your fix.')}>
              <Check size={15} strokeWidth={2.5} /> I fixed it, check again
            </button>
          </div>
        </div>
      )}
      <div className="errcard-cmd">
        <Cmd text={cmd} />
      </div>
      {extra}
    </div>
  );
}

/** The Developer tab: the exact error behind a stopped ticket, to copy or send. */
export function ExactError({ t }: { t: Ticket }) {
  const { toast } = usePrefs();
  if (!t.stuck || t.waiting?.kind !== 'stuck') return null;
  const text = t.stuck.detail ?? t.stuck.question;
  const copy = () => {
    const done = navigator.clipboard?.writeText(text);
    if (!done) return toast('Could not copy. Select the text instead.', 'err');
    void done.then(
      () => toast('Copied the exact error'),
      () => toast('Could not copy. Select the text instead.', 'err'),
    );
  };
  return (
    <>
      <div className="lbl">The exact error</div>
      <pre className="exact-err">{text}</pre>
      <div className="pills" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={copy}>
          <Copy size={13} /> Copy
        </button>
        <ReportButton ticket={t.id} small />
        <Cmd text="squad logs --tail" />
      </div>
    </>
  );
}

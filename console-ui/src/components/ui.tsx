import { Fragment, useCallback, useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';
import { ArrowUp, Bug, Check, Code, Copy, Eye, Search, SquareCheck, Triangle, User, X, PenLine, Users } from 'lucide-react';
import type { Actor, Stage, Ticket } from '../api/types';
import { usePrefs } from '../lib/prefs';
import { loadTrouble } from '../lib/load-trouble';
import { detect, runs, type Dir } from '../lib/lang';

export const ROLE_NAME: Record<Actor, string> = {
  analyst: 'Analyst',
  architect: 'Architect',
  spec: 'Spec writer',
  builder: 'Builder',
  tester: 'Tester',
  reviewer: 'Reviewer',
  release: 'Release',
  triage: 'Triage',
  you: 'You',
  squad: 'Squad',
};

const ROLE_ICON: Record<Actor, typeof Search> = {
  analyst: Search,
  architect: Triangle,
  spec: PenLine,
  builder: Code,
  tester: SquareCheck,
  reviewer: Eye,
  release: ArrowUp,
  triage: Bug,
  you: User,
  squad: Users,
};

export function Glyph({ role, small, size }: { role: Actor; small?: boolean; size?: number }) {
  const Icon = ROLE_ICON[role];
  return (
    <span className={`glyph ${small ? 'sm' : ''} ${role === 'you' ? 'you' : ''}`} title={ROLE_NAME[role]}>
      <Icon size={size ?? (small ? 12 : 14)} strokeWidth={2} />
    </span>
  );
}

/** The other language inside a line, in its own order: a ticket number or an English word in Arabic keeps its place. */
export function Runs({ text, dir }: { text: string; dir: Dir }) {
  return <>{runs(String(text ?? ''), dir).map((r, i) => (r.dir ? <bdi key={i} dir={r.dir}>{r.text}</bdi> : r.text))}</>;
}

/**
 * Words a person or an agent wrote, in the frame the app draws around them. They run the way their own language runs,
 * each piece by itself, as a chat message does (lib/lang). `lead` is the frame's own word or a ticket number in front:
 * it stays in its own order and does not count towards the direction.
 */
export function Written({
  text,
  lead,
  as: Tag = 'span',
  children,
  ...attrs
}: { text: string; lead?: ReactNode; as?: 'span' | 'div' | 'p' | 'b' | 'small' | 'li' | 'h1' | 'h2' | 'h3' | 'h4' } & HTMLAttributes<HTMLElement>) {
  const { dir } = detect(text);
  return (
    <Tag {...attrs} dir={dir} lang={dir === 'rtl' ? 'ar' : 'en'}>
      {lead && (
        <>
          {dir === 'rtl' ? <bdi dir="ltr">{lead}</bdi> : lead}{' '}
        </>
      )}
      <Runs text={text} dir={dir} />
      {children}
    </Tag>
  );
}

/** Text that keeps its line breaks: each line runs its own way, so an Arabic line and an English line sit side by side. */
export function WrittenLines({ text, as: Tag = 'div', ...attrs }: { text: string; as?: 'div' | 'p' } & HTMLAttributes<HTMLElement>) {
  return <Tag {...attrs}>{text.trimEnd().split('\n').map((l, i) => (l.trim() ? <Written key={i} className="wline" text={l} /> : <br key={i} />))}</Tag>;
}

/** "Payments › Invoices": a path of names people wrote. The frame keeps its order, each name keeps its own. */
export function Place({ path }: { path: string }) {
  if (!detect(path).share) return <>{path}</>;
  return (
    <>
      {path.split(' › ').map((p, i) => (
        <Fragment key={i}>
          {i > 0 && ' › '}
          <Written text={p} />
        </Fragment>
      ))}
    </>
  );
}

/**
 * The terminal command for an action, one click to copy. Hidden when "Show commands" is off. `keep`: the end of the
 * command (an id and its options) that stays in sight when the command is cut short; the start gives way first.
 */
export function Cmd({ text, keep }: { text: string; keep?: string }) {
  const { showCommands, toast } = usePrefs();
  if (!showCommands) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => toast('Command copied'),
      () => toast('Could not copy. Select the text instead.', 'err'),
    );
  };
  const cut = keep && text.endsWith(keep) && text.length > keep.length ? text.length - keep.length : 0;
  return (
    <span className="term" dir="ltr" title="The same action in the terminal">
      <b>&gt;_</b>
      {cut ? (
        <>
          <span>{text.slice(0, cut).trimEnd()}</span>
          <span className="term-keep">{keep}</span>
        </>
      ) : (
        <span>{text}</span>
      )}
      <button onClick={copy} aria-label={`Copy ${text}`}>
        <Copy size={13} />
      </button>
    </span>
  );
}

export const TRACK: { stage: Stage; name: string }[] = [
  { stage: 'tickets', name: 'Tickets' },
  { stage: 'specs', name: 'Specs' },
  { stage: 'implement', name: 'Implement' },
  { stage: 'test', name: 'Test' },
  { stage: 'review', name: 'Review' },
  { stage: 'release', name: 'Release' },
];

/** Where the ticket is, with how long each finished stage took and the usual time of the ones to come. */
export function Tracker({ ticket }: { ticket: Ticket }) {
  const stage = ticket.stage === 'bugs' ? 'tickets' : ticket.stage;
  const at = stage === 'done' ? TRACK.length : TRACK.findIndex((s) => s.stage === stage);
  const mode = ticket.waiting ? 'you' : 'work';
  const notes = new Map((ticket.now?.stages ?? []).map((x) => [x.stage, x.note]));
  return (
    <div className="track" aria-label="Where this ticket is">
      {TRACK.map((s, i) => {
        const cls = i < at ? 'done' : i === at ? `cur ${mode}` : '';
        const note = notes.get(s.stage);
        return (
          <div key={s.stage} className={`ts ${cls}`}>
            <span className="nd">{i < at ? <Check size={12} strokeWidth={3} /> : null}</span>
            {s.name}
            {i === at && (
              <span className="tag">{mode === 'you' ? 'Your turn' : ticket.stage === 'release' ? 'Ready' : ticket.dependency?.way === 'wait' && !ticket.dependency.started && !ticket.squad ? 'Waiting' : 'Working'}</span>
            )}
            {notes.size > 0 && <span className="tnote">{i === at && note === 'your turn' ? '' : (note ?? '')}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  icon,
  wide,
  losing,
}: {
  title: string;
  wide?: boolean;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  /** What closing by accident would lose, such as attached files: Esc, the cross and a click outside ask first. Typed text needs no asking: it stays as a draft. */
  losing?: string | null;
}) {
  const [asking, setAsking] = useState(false);
  const leave = useCallback(() => (losing ? setAsking(true) : onClose()), [losing, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && leave();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leave]);
  return (
    <div className="modal-veil" onMouseDown={(e) => e.target === e.currentTarget && leave()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          {icon}
          <Written as="h3" text={title} />
          <span className="grow" />
          <button className="iconbtn" onClick={leave} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="mb">{children}</div>
        {asking ? (
          <footer role="alertdialog" aria-label="Close this window?">
            <span className="grow">Close and lose {losing}? What you typed stays as a draft.</span>
            <button className="btn pri" autoFocus onClick={() => setAsking(false)}>Keep working</button>
            <button className="btn" onClick={onClose}>Close</button>
          </footer>
        ) : (
          footer && <footer>{footer}</footer>
        )}
      </div>
    </div>
  );
}

/** A page's first load did not get through: it says so, with the way on, and never shows an empty page as if it were true. */
export function CouldNotLoad({ what, error, onRetry }: { what: string; error: unknown; onRetry(): void }) {
  const t = loadTrouble(error, what);
  return (
    <div className="center">
      <div role="alert">
        <h2>This did not load</h2>
        <p>{t.text}</p>
        <p style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn pri" onClick={onRetry}>Try again</button>
          {t.home && <a className="btn" href="/">Go to Home</a>}
        </p>
      </div>
    </div>
  );
}

/** Beside the buttons of a dialog with typed text: it stays when the dialog closes, until it is sent or cleared. */
export function DraftNote({ onClear }: { onClear(): void }) {
  return (
    <span className="note draftnote">
      Kept as a draft on this computer.{' '}
      <button type="button" className="linkbtn" onClick={onClear}>
        Clear
      </button>
    </span>
  );
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function dateShort(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return dateShort(iso);
}

/** Bold the **words** the squad marks in notes, without a markdown library. */
export function Rich({ text, dir }: { text: string; dir: Dir }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith('**') ? <strong key={i}><Runs text={p.slice(2, -2)} dir={dir} /></strong> : <span key={i}><Runs text={p} dir={dir} /></span>))}
    </>
  );
}

export function NotesView({ notes }: { notes: string }) {
  return (
    <div className="notes">
      {notes.split('\n').map((line, i) => {
        // Each line runs its own way, with its bullet on the side it starts from.
        const { dir } = detect(line);
        if (line.startsWith('### ')) return <Written as="h4" key={i} text={line.slice(4)} />;
        if (line.startsWith('- ')) return <p key={i} dir={dir} lang={dir === 'rtl' ? 'ar' : 'en'}>• <Rich text={line.slice(2)} dir={dir} /></p>;
        if (!line.trim()) return null;
        return <p key={i} dir={dir} lang={dir === 'rtl' ? 'ar' : 'en'}><Rich text={line} dir={dir} /></p>;
      })}
    </div>
  );
}

/** The command that answers whatever a ticket is waiting on. */
export function commandFor(t: Ticket): string {
  switch (t.waiting?.kind) {
    case 'questions':
      return `squad answer ${t.id}`;
    case 'stuck':
      return `squad decide ${t.id}`;
    case 'ask':
      return `squad reply ${t.id}`;
    case 'yours':
      return `squad give-back ${t.id}`;
    case 'chat':
      return `squad chat ${t.id}`;
    case 'depends':
      return `squad build ${t.id} --on-branch`;
    case 'change':
    case 'spec':
    case 'plan':
    case 'proof':
      return `squad approve ${t.id}`;
    default:
      return `squad watch ${t.id}`;
  }
}

/** A newer decision changes this ticket's plan: the line the waiting cards show. */
export function outdatedLine(t: Ticket): string {
  const o = t.outdated ?? [];
  return o.length === 1 ? `${o[0]!.adr} came after this plan and changes it` : `${o.map((x) => x.adr).join(' and ')} came after this plan and change it`;
}

export function actionLabel(t: Ticket): string {
  switch (t.waiting?.kind) {
    case 'questions':
      return 'Answer';
    case 'spec':
      return 'Review spec';
    case 'plan':
      return t.specApproved ? 'Review design' : 'Review plan';
    case 'proof':
      return 'Check proof';
    case 'stuck':
      return 'Decide';
    case 'ask':
      return 'Answer';
    case 'yours':
      return 'Give back';
    case 'chat':
      return 'Open chat';
    case 'change':
      return 'Review design update';
    case 'depends':
      return 'Choose';
    default:
      return 'Open';
  }
}

export const STAGE_NAME: Record<Stage, string> = {
  tickets: 'Tickets',
  specs: 'Specs',
  implement: 'Implement',
  test: 'Test',
  review: 'Review',
  release: 'Release',
  bugs: 'Bugs',
  done: 'Released',
};

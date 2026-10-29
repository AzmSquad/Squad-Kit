import { useEffect, type ReactNode } from 'react';
import { ArrowUp, Bug, Check, Code, Copy, Eye, Search, SquareCheck, Triangle, User, X, PenLine, Users } from 'lucide-react';
import type { Actor, Stage, Ticket } from '../api/types';
import { usePrefs } from '../lib/prefs';

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

/** The terminal command for an action, one click to copy. Hidden when "Show commands" is off. */
export function Cmd({ text }: { text: string }) {
  const { showCommands, toast } = usePrefs();
  if (!showCommands) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => toast('Command copied'),
      () => toast('Could not copy. Select the text instead.', 'err'),
    );
  };
  return (
    <span className="term" title="The same action in the terminal">
      <b>&gt;_</b>
      <span>{text}</span>
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

export function Tracker({ ticket }: { ticket: Ticket }) {
  const stage = ticket.stage === 'bugs' ? 'tickets' : ticket.stage;
  const at = stage === 'done' ? TRACK.length : TRACK.findIndex((s) => s.stage === stage);
  const mode = ticket.waiting ? 'you' : 'work';
  return (
    <div className="track" aria-label="Where this ticket is">
      {TRACK.map((s, i) => {
        const cls = i < at ? 'done' : i === at ? `cur ${mode}` : '';
        return (
          <div key={s.stage} className={`ts ${cls}`}>
            <span className="nd">{i < at ? <Check size={12} strokeWidth={3} /> : null}</span>
            {s.name}
            {i === at && (
              <span className="tag">{mode === 'you' ? 'Your turn' : ticket.stage === 'release' ? 'Ready' : 'Working'}</span>
            )}
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
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          {icon}
          <h3>{title}</h3>
          <span className="grow" />
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="mb">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
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
export function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>))}
    </>
  );
}

export function NotesView({ notes }: { notes: string }) {
  return (
    <div className="notes">
      {notes.split('\n').map((line, i) => {
        if (line.startsWith('### ')) return <h4 key={i}>{line.slice(4)}</h4>;
        if (line.startsWith('- ')) return <p key={i}>• <Rich text={line.slice(2)} /></p>;
        if (!line.trim()) return null;
        return <p key={i}><Rich text={line} /></p>;
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
    case 'plan':
    case 'proof':
      return `squad approve ${t.id}`;
    default:
      return `squad watch ${t.id}`;
  }
}

export function actionLabel(t: Ticket): string {
  switch (t.waiting?.kind) {
    case 'questions':
      return 'Answer';
    case 'plan':
      return 'Review plan';
    case 'proof':
      return 'Check proof';
    case 'stuck':
      return 'Decide';
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

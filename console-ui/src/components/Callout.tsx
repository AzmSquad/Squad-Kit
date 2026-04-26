import type { ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Info } from 'lucide-react';

type Tone = 'default' | 'info' | 'success' | 'warning' | 'danger';

interface Props {
  tone?: Tone;
  title?: ReactNode;
  /** Override icon. Defaults to a tone-matched Lucide icon. */
  icon?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

const toneStyles: Record<Tone, { fg: string; bg: string; border: string; icon: ReactNode }> = {
  default: {
    fg: 'var(--color-text)',
    bg: 'var(--gray-2)',
    border: 'var(--color-border)',
    icon: <Info size={14} className="text-[var(--color-text-muted)]" aria-hidden />,
  },
  info: {
    fg: 'var(--color-text)',
    bg: 'var(--color-info-bg)',
    border: 'var(--color-info-border)',
    icon: <Info size={14} className="text-[var(--color-info)]" aria-hidden />,
  },
  success: {
    fg: 'var(--color-text)',
    bg: 'var(--color-ok-bg)',
    border: 'var(--color-ok-border)',
    icon: <CheckCircle2 size={14} className="text-[var(--color-ok)]" aria-hidden />,
  },
  warning: {
    fg: 'var(--color-text)',
    bg: 'var(--color-warn-bg)',
    border: 'var(--color-warn-border)',
    icon: <AlertTriangle size={14} className="text-[var(--color-warn)]" aria-hidden />,
  },
  danger: {
    fg: 'var(--color-text)',
    bg: 'var(--color-fail-bg)',
    border: 'var(--color-fail-border)',
    icon: <AlertCircle size={14} className="text-[var(--color-fail)]" aria-hidden />,
  },
};

export function Callout({ tone = 'default', title, icon, action, children, className = '' }: Props) {
  const t = toneStyles[tone];
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'note'}
      style={{ background: t.bg, borderColor: t.border, color: t.fg }}
      className={`flex gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 text-sm ${className}`}
    >
      <div className="mt-0.5">{icon ?? t.icon}</div>
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? <div className={`text-[13px] ${title ? 'mt-0.5 text-[var(--color-text-muted)]' : ''}`}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

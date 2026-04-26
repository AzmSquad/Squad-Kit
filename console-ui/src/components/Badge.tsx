import { forwardRef, type HTMLAttributes } from 'react';

type Tone =
  | 'default'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  // legacy aliases (kept for backwards compatibility; story 05 migrates callers)
  | 'ok'
  | 'warn'
  | 'fail'
  | 'muted';

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Show a colored dot before the label. */
  dot?: boolean;
}

const map: Record<Tone, { fg: string; bg: string; border: string }> = {
  default: { fg: 'var(--color-text-muted)', bg: 'var(--gray-2)', border: 'var(--color-border)' },
  success: { fg: 'var(--color-ok)', bg: 'var(--color-ok-bg)', border: 'var(--color-ok-border)' },
  warning: { fg: 'var(--color-warn)', bg: 'var(--color-warn-bg)', border: 'var(--color-warn-border)' },
  danger: { fg: 'var(--color-fail)', bg: 'var(--color-fail-bg)', border: 'var(--color-fail-border)' },
  info: { fg: 'var(--color-info)', bg: 'var(--color-info-bg)', border: 'var(--color-info-border)' },
  // legacy aliases
  ok: { fg: 'var(--color-ok)', bg: 'var(--color-ok-bg)', border: 'var(--color-ok-border)' },
  warn: { fg: 'var(--color-warn)', bg: 'var(--color-warn-bg)', border: 'var(--color-warn-border)' },
  fail: { fg: 'var(--color-fail)', bg: 'var(--color-fail-bg)', border: 'var(--color-fail-border)' },
  muted: { fg: 'var(--color-text-muted)', bg: 'var(--gray-2)', border: 'var(--color-border)' },
};

export const Badge = forwardRef<HTMLSpanElement, Props>(function Badge(
  { tone = 'default', dot, className = '', children, ...rest },
  ref,
) {
  const c = map[tone];
  return (
    <span
      ref={ref}
      style={{ color: c.fg, background: c.bg, borderColor: c.border }}
      className={
        `inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] font-medium tabular ${className}`
      }
      {...rest}
    >
      {dot ? <span style={{ background: c.fg }} className="h-1.5 w-1.5 rounded-full" /> : null}
      {children}
    </span>
  );
});

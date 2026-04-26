import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type Size = 'sm' | 'md' | 'lg';

interface Props {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /** When set, replaces the default single Close action. */
  footer?: ReactNode;
  /** Defaults to `md`. */
  size?: Size;
  /** Show a description directly under the title. */
  description?: ReactNode;
  /** When false, ESC won't close (e.g. while a destructive op is mid-flight). Default true. */
  dismissible?: boolean;
}

const widthClass: Record<Size, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

export function Dialog({
  open,
  title,
  description,
  children,
  onClose,
  footer,
  size = 'md',
  dismissible = true,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  // Capture the trigger to restore focus on close.
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    } else if (lastFocusedRef.current && document.contains(lastFocusedRef.current)) {
      lastFocusedRef.current.focus();
      lastFocusedRef.current = null;
    }
  }, [open]);

  // Body scroll lock.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Auto-focus the first focusable element inside the panel.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panel).focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Focus trap + ESC handler.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('aria-hidden'));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [dismissible, onClose],
  );

  if (!open) return null;

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 animate-fade-in"
      style={{ background: 'rgba(0, 0, 0, 0.6)' }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="squad-dialog-title"
        tabIndex={-1}
        className={
          `relative w-full ${widthClass[size]} ` +
          `rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] ` +
          `shadow-2xl outline-none animate-fade-up`
        }
      >
        <div className="border-b border-[var(--color-border)] px-5 py-3">
          <div id="squad-dialog-title" className="text-sm font-semibold text-[var(--color-text)]">
            {title}
          </div>
          {description ? (
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{description}</p>
          ) : null}
        </div>
        <div className="px-5 py-4 text-sm text-[var(--color-text)]">{children}</div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
          {footer ?? (
            <button type="button" className="btn-secondary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

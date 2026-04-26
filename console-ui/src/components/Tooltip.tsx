import { useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';

interface Props {
  label: ReactNode;
  /** Single child element that the tooltip describes. */
  children: ReactElement;
  side?: 'top' | 'bottom';
  /** Optional delay before showing in ms. Default 250. */
  delay?: number;
}

export function Tooltip({ label, children, side = 'top', delay = 250 }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  const show = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOpen(true);
    }, delay);
  }, [delay]);

  const hide = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <span className="relative inline-flex">
      <span
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={open ? id : undefined}
        className="inline-flex"
      >
        {children}
      </span>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className={
            `pointer-events-none absolute left-1/2 z-[var(--z-tooltip)] -translate-x-1/2 ` +
            `${side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'} ` +
            `whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] ` +
            `bg-[var(--gray-2)] px-2 py-1 text-[11px] text-[var(--color-text)] shadow-lg animate-fade-in`
          }
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}

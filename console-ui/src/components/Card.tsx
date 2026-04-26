import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

type Variant = 'default' | 'flat' | 'inset';

interface Props extends HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
  /** Sets `data-interactive` so :hover styles apply only to clickable cards. */
  interactive?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
}

const variantClass: Record<Variant, string> = {
  default: 'bg-[var(--color-surface)] border border-[var(--color-border)]',
  flat: 'bg-transparent border border-[var(--color-border)]',
  inset: 'bg-[var(--gray-2)] border border-[var(--color-border)]',
};

export const Card = forwardRef<HTMLDivElement, Props>(function Card(
  { variant = 'default', interactive, header, footer, className = '', children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-interactive={interactive || undefined}
      className={
        `${variantClass[variant]} rounded-[var(--radius-md)] ` +
        `data-[interactive]:transition-colors data-[interactive]:hover:border-[var(--color-border-strong)] ` +
        `${className}`
      }
      {...rest}
    >
      {header ? (
        <div className="border-b border-[var(--color-border)] px-[var(--space-card)] py-3 text-sm font-medium text-[var(--color-text)]">
          {header}
        </div>
      ) : null}
      <div className="p-[var(--space-card)]">{children}</div>
      {footer ? (
        <div className="border-t border-[var(--color-border)] px-[var(--space-card)] py-3 text-sm text-[var(--color-text-muted)]">
          {footer}
        </div>
      ) : null}
    </div>
  );
});

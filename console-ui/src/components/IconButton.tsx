import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Icon content (a Lucide icon, usually). */
  icon: ReactNode;
  /** Required: accessible label, also rendered in the tooltip. */
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
}

const sizeClass: Record<NonNullable<Props['size']>, string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
};

const variantClass: Record<NonNullable<Props['variant']>, string> = {
  ghost: 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--gray-3)]',
  secondary: 'border border-[var(--color-border)] bg-[var(--gray-3)] text-[var(--color-text)] hover:bg-[var(--gray-4)]',
};

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { icon, label, size = 'md', variant = 'ghost', className = '', ...rest },
  ref,
) {
  return (
    <Tooltip label={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={
          `inline-flex items-center justify-center rounded-[var(--radius-md)] transition-colors ` +
          `${sizeClass[size]} ${variantClass[variant]} ${className}`
        }
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
});

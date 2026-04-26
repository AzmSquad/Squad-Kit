import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { leftSlot, rightSlot, invalid, className = '', ...rest },
  ref,
) {
  return (
    <div
      data-invalid={invalid || undefined}
      className={
        `flex w-full items-center gap-2 rounded-[var(--radius-md)] border bg-[var(--gray-2)] px-3 py-2 text-sm ` +
        `border-[var(--color-border)] focus-within:border-[var(--color-border-strong)] ` +
        `data-[invalid]:border-[var(--color-fail)] ` +
        `transition-colors ${className}`
      }
    >
      {leftSlot ? <span className="text-[var(--color-text-dim)]">{leftSlot}</span> : null}
      <input
        ref={ref}
        className="flex-1 bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] outline-none"
        {...rest}
      />
      {rightSlot ? <span className="text-[var(--color-text-dim)]">{rightSlot}</span> : null}
    </div>
  );
});

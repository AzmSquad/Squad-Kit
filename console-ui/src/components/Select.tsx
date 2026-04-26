import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

type Props = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { className = '', children, ...rest },
  ref,
) {
  return (
    <div className={`relative w-full ${className}`}>
      <select
        ref={ref}
        className="
          w-full appearance-none rounded-[var(--radius-md)] border border-[var(--color-border)]
          bg-[var(--gray-2)] px-3 py-2 pr-9 text-sm text-[var(--color-text)]
          outline-none focus:border-[var(--color-border-strong)]
          transition-colors
        "
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]"
        aria-hidden
      />
    </div>
  );
});

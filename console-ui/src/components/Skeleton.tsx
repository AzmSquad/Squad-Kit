import { forwardRef, type HTMLAttributes } from 'react';

export const Skeleton = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Skeleton(
  { className = '', style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      style={{
        background: `linear-gradient(90deg, var(--gray-3) 0%, var(--gray-4) 50%, var(--gray-3) 100%)`,
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.4s linear infinite',
        ...style,
      }}
      className={`rounded-[var(--radius-sm)] ${className}`}
      {...rest}
    />
  );
});

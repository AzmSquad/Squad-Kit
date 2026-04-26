import type { HTMLAttributes } from 'react';

export function Kbd({ className = '', children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`kbd ${className}`} {...rest}>
      {children}
    </span>
  );
}

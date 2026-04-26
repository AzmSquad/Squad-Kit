import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const baseByVariant: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

const sizePadding: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-[13px]',
  md: '',
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    className = '',
    disabled,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`${baseByVariant[variant]} ${sizePadding[size]} ${className}`.trim()}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size="sm" aria-hidden /> : leftIcon}
      <span>{children}</span>
      {!loading && rightIcon}
    </button>
  );
});

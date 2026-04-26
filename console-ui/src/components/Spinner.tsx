import type { CSSProperties, HTMLAttributes } from 'react';

type Size = 'xs' | 'sm' | 'md' | 'lg';

const sizePx: Record<Size, number> = { xs: 10, sm: 12, md: 16, lg: 20 };

interface Props extends HTMLAttributes<HTMLSpanElement> {
  size?: Size;
}

export function Spinner({ size = 'md', style, className = '', ...rest }: Props) {
  const px = sizePx[size];
  const inline: CSSProperties = {
    width: px,
    height: px,
    borderWidth: Math.max(1, Math.floor(px / 8)),
    borderStyle: 'solid',
    borderColor: 'currentColor',
    borderTopColor: 'transparent',
    borderRadius: '999px',
    display: 'inline-block',
    animation: 'spin 0.7s linear infinite',
    ...style,
  };
  return <span role="status" aria-label="Loading" style={inline} className={className} {...rest} />;
}

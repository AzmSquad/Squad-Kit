import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders with default tone', () => {
    render(<Badge>idle</Badge>);
    expect(screen.getByText('idle')).toBeInTheDocument();
  });

  it('respects success tone via inline style (no !important)', () => {
    render(<Badge tone="success">ok</Badge>);
    const el = screen.getByText('ok');
    const style = el.getAttribute('style') ?? '';
    expect(style).toContain('var(--color-ok)');
  });

  it('legacy "ok" alias maps to the success palette', () => {
    render(<Badge tone="ok">planned</Badge>);
    const el = screen.getByText('planned');
    const style = el.getAttribute('style') ?? '';
    expect(style).toContain('var(--color-ok)');
  });

  it('renders a dot when dot prop is true', () => {
    render(
      <Badge tone="info" dot>
        live
      </Badge>,
    );
    const el = screen.getByText('live').parentElement!;
    expect(el.querySelectorAll('span').length).toBeGreaterThanOrEqual(1);
  });
});

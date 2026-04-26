import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders primary variant by default', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button')).toHaveClass('btn-primary');
  });

  it('calls onClick when pressed', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner and is disabled when loading', () => {
    render(<Button loading>Save</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('data-loading', 'true');
    expect(btn.querySelector('[role="status"]')).toBeTruthy();
  });

  it('forwards refs', () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<Button ref={ref}>X</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('renders leftIcon when not loading', () => {
    render(
      <Button leftIcon={<span data-testid="ic">!</span>}>X</Button>,
    );
    expect(screen.getByTestId('ic')).toBeInTheDocument();
  });
});

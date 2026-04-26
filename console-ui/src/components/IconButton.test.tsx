import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('renders the icon, name for assistive tech, and handles clicks', () => {
    const onClick = vi.fn();
    render(
      <IconButton icon={<span data-testid="ic">+</span>} label="Add item" onClick={onClick} />,
    );
    const btn = screen.getByRole('button', { name: 'Add item' });
    expect(screen.getByTestId('ic')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

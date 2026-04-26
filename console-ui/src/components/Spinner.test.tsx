import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Spinner } from './Spinner';

describe('Spinner', () => {
  it('renders with role status and an accessible label', () => {
    render(<Spinner />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-label', 'Loading');
  });
});

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CacheHitRing } from './CacheHitRing';

describe('CacheHitRing', () => {
  it('renders the rounded percentage label', () => {
    render(<CacheHitRing ratio={0.423} />);
    expect(screen.getByText('42%')).toBeInTheDocument();
  });
});

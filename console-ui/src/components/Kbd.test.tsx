import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Kbd } from './Kbd';

describe('Kbd', () => {
  it('applies the kbd class for token styling', () => {
    render(<Kbd>⌘K</Kbd>);
    expect(screen.getByText('⌘K')).toHaveClass('kbd');
  });
});

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Callout } from './Callout';

describe('Callout', () => {
  it('renders with title and body', () => {
    render(
      <Callout tone="warning" title="Heads up">
        Rate limit close
      </Callout>,
    );
    expect(screen.getByText('Heads up')).toBeInTheDocument();
    expect(screen.getByText('Rate limit close')).toBeInTheDocument();
  });

  it('uses role=alert for warning and danger', () => {
    render(<Callout tone="danger">Boom</Callout>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('uses role=note for info and success', () => {
    render(<Callout tone="info">Hi</Callout>);
    expect(screen.getByRole('note')).toBeInTheDocument();
  });
});

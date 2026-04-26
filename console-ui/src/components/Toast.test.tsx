import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

function Harness({ tone }: { tone?: 'success' | 'danger' }) {
  const { toast } = useToast();
  return <button onClick={() => toast({ title: 'Saved', tone })}>fire</button>;
}

describe('Toast', () => {
  it('shows a toast and auto-dismisses', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('manual dismiss removes the toast', () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});

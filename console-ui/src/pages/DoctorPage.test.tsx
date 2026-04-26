import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DoctorPage } from './DoctorPage';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

describe('DoctorPage', () => {
  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', 'a'.repeat(64));
    apiMock.mockReset();
  });

  it('Apply repair calls POST /api/doctor/fix', async () => {
    apiMock
      .mockResolvedValueOnce({
        root: '/x',
        checks: [
          {
            id: 'gitignore',
            name: 'git',
            status: 'warn',
            detail: 'x',
            fixable: true,
          },
        ],
        summary: { ok: 0, warn: 1, fail: 0, skip: 0 },
      })
      .mockResolvedValue({
        root: '/x',
        checks: [{ id: 'gitignore', name: 'git', status: 'ok', detail: 'repaired' }],
        summary: { ok: 1, warn: 0, fail: 0, skip: 0 },
      });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Run checks/i }));

    await waitFor(() => expect(screen.getByText(/Apply repair/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Apply repair/i }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith('/api/doctor/fix', { method: 'POST' });
    });
  });

  it('renders a fail check with a status dot and badge', async () => {
    apiMock.mockResolvedValueOnce({
      root: '/x',
      checks: [
        {
          id: 'n',
          name: 'broken',
          status: 'fail',
          detail: 'y',
        },
      ],
      summary: { ok: 0, warn: 0, fail: 1, skip: 0 },
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Run checks/i }));

    await waitFor(() => expect(screen.getByText('broken')).toBeInTheDocument());
    const badges = screen.getAllByText('fail');
    expect(badges.length).toBeGreaterThan(0);
    const dot = container.querySelector('[style*="var(--color-fail)"]');
    expect(dot).toBeTruthy();
  });
});

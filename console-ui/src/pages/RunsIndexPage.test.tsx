import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { RunsIndexPage } from './RunsIndexPage';
import type { ApiRunRecord } from '~/api/types';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

function runReportStub() {
  return <div data-testid="opened-run-detail">opened</div>;
}

function renderRunsIndex(initialEntries: string[] = ['/runs']) {
  const rootRoute = createRootRoute();
  const runsIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/runs',
    component: RunsIndexPage,
  });
  const runDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/runs/$runId',
    validateSearch: (search: Record<string, unknown>) => {
      const t = typeof search.tab === 'string' ? search.tab : '';
      const tab =
        t === 'plan' || t === 'issues' || t === 'telemetry' ?
          (t as 'plan' | 'issues' | 'telemetry')
        : 'plan';
      return { tab };
    },
    component: runReportStub,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([runsIndexRoute, runDetailRoute]),
    history: createMemoryHistory({ initialEntries }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const BASE: Omit<ApiRunRecord, 'runId' | 'success' | 'partial'> = {
  provider: 'anthropic',
  model: 'opus',
  feature: 'f',
  storyId: 's',
  startedAt: new Date('2024-01-02').toISOString(),
  completedAt: new Date('2024-01-02').toISOString(),
  planFile: 'f/s.plan.md',
  durationMs: 5000,
  version: 1,
};

describe('RunsIndexPage', () => {
  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', 'b'.repeat(64));
    apiMock.mockReset();
  });

  it('shows status chips and navigates row click into run detail', async () => {
    const rows: ApiRunRecord[] = [
      {
        ...BASE,
        runId: 'ok-run',
        success: true,
        partial: false,
        stats: { turns: 1, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cacheHitRatio: 0.5, durationMs: 5000 },
        validation: { enabled: true, issuesCount: 0 },
      },
      {
        ...BASE,
        runId: 'partial-run',
        feature: 'f2',
        storyId: 's2',
        success: false,
        partial: true,
        plannerRuntime: { kind: 'vercel', provider: 'anthropic' },
        stats: { turns: 1, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cacheHitRatio: 0, durationMs: 1000 },
        validation: { enabled: true, issuesCount: 2 },
      },
      {
        ...BASE,
        runId: 'fail-run',
        feature: 'f3',
        storyId: 's3',
        success: false,
        partial: false,
        stats: { turns: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cacheHitRatio: 0, durationMs: 100 },
      },
    ];
    apiMock.mockResolvedValue(rows);
    renderRunsIndex();

    expect(await screen.findByText('success')).toBeTruthy();
    expect(await screen.findByText('partial')).toBeTruthy();
    expect(await screen.findByText('failed')).toBeTruthy();

    screen.getByRole('link', { name: /Run ok-run/ }).click();

    await waitFor(() => {
      expect(screen.getByTestId('opened-run-detail')).toBeTruthy();
    });
  });
  it('shows a per-row auth chip and degrades legacy records to an em dash', async () => {
    const rows: ApiRunRecord[] = [
      { ...BASE, runId: 'sub-run', success: true, partial: false, authMode: 'subscription' },
      { ...BASE, runId: 'key-run', feature: 'f2', storyId: 's2', success: true, partial: false, authMode: 'api-key' },
      { ...BASE, runId: 'legacy-run', feature: 'f3', storyId: 's3', success: true, partial: false },
    ];
    apiMock.mockResolvedValue(rows);
    renderRunsIndex();

    const subRow = await screen.findByRole('link', { name: /Run sub-run/ });
    expect(subRow).toHaveTextContent('sub');
    expect(screen.getByRole('link', { name: /Run key-run/ })).toHaveTextContent('key');
    // Never invent a mode for a run recorded before 0.12.0.
    expect(screen.getByRole('link', { name: /Run legacy-run/ })).toHaveTextContent('—');
  });
});

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
import { Dashboard } from './Dashboard';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

function renderDashboard() {
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <Dashboard />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Dashboard', () => {
  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', 'b'.repeat(64));
    apiMock.mockReset();
  });

  it('renders stat cards and charts when runs exist', async () => {
    const dashboardPayload = {
      version: '0.6.0',
      root: '/tmp/proj',
      project: { name: 'demo-proj', primaryLanguage: 'ts' },
      planner: { provider: 'anthropic', enabled: true },
      tracker: { type: 'none' },
      lastRun: {
        stats: {
          turns: 3,
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cacheHitRatio: 0.72,
          durationMs: 1200,
        },
        completedAt: new Date().toISOString(),
        provider: 'anthropic',
        model: 'x',
        version: 1,
      },
      runs: [
        {
          runId: 'a',
          startedAt: new Date().toISOString(),
          durationMs: 2000,
          success: true,
          partial: false,
          inputTokens: 10,
          outputTokens: 5,
          cacheHitRatio: 0.5,
        },
      ],
      storyCounts: { total: 0, planned: 0, unplanned: 0 },
      stories: [],
    };
    apiMock.mockImplementation((path: string) => {
      if (path === '/api/projects/touch') return Promise.resolve({ ok: true });
      if (path === '/api/dashboard') return Promise.resolve(dashboardPayload);
      return Promise.reject(new Error(`unexpected: ${path}`));
    });

    renderDashboard();

    await waitFor(() => expect(screen.getByText('demo-proj')).toBeInTheDocument());
    /* Stat card uses tabular-nums; ring center also shows 72% as separate nodes — scope to one. */
    expect(screen.getByText('72%', { selector: '.tabular-nums' })).toBeInTheDocument();
    expect(screen.getByText(/Cache hit ratio/i)).toBeInTheDocument();
    expect(screen.getByText(/Token spend/i)).toBeInTheDocument();
    expect(screen.getByText(/Run duration/i)).toBeInTheDocument();
  });

  it('shows empty-state placeholder when there are no runs', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === '/api/projects/touch') return Promise.resolve({ ok: true });
      if (path === '/api/dashboard')
        return Promise.resolve({
          version: '0.6.0',
          root: '/tmp/proj',
          project: { name: 'empty', primaryLanguage: 'ts' },
          planner: null,
          tracker: { type: 'none' },
          lastRun: null,
          runs: [],
          storyCounts: { total: 0, planned: 0, unplanned: 0 },
          stories: [],
        });
      return Promise.reject(new Error(`unexpected: ${path}`));
    });

    renderDashboard();

    await waitFor(() => expect(screen.getByText(/No runs yet/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Generate/i })).toBeInTheDocument();
  });
});

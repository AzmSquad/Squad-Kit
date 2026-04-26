import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { PlanDiff } from './PlanDiff';
import type { PlanDiffChange } from '~/api/types';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

function renderPage() {
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: '/plans/$feature/diff',
    validateSearch: (s: Record<string, unknown>) => ({
      a: typeof s.a === 'string' ? s.a : '',
      b: typeof s.b === 'string' ? s.b : '',
    }),
    component: () => <PlanDiff />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/plans/demo/diff?a=x.md&b=y.md'] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('PlanDiff', () => {
  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', 'a'.repeat(64));
    apiMock.mockReset();
  });

  it('renders added/removed with tone backgrounds from changes', async () => {
    const changes: PlanDiffChange[] = [
      { value: 'only-a\n', removed: true },
      { value: 'only-b\n', added: true },
    ];
    apiMock.mockResolvedValue({
      feature: 'f',
      a: 'a.md',
      b: 'b.md',
      changes,
    });
    renderPage();
    const removed = await screen.findByText('only-a');
    const added = await screen.findByText('only-b');
    expect(removed).toHaveStyle({ background: 'var(--color-fail-bg)' });
    expect(added).toHaveStyle({ background: 'var(--color-ok-bg)' });
  });
});

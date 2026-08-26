import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { ConfirmProvider } from '~/components/Confirm';
import { ToastProvider } from '~/components/Toast';
import { PlansPage } from './pages/PlansPage';
import { StoryDetail } from './pages/StoryDetail';
import type { ApiPlan, ApiStoryDetail } from '~/api/types';

/**
 * Every console link built from server data, asserted on the rendered `href`.
 *
 * Two route bugs shipped green in two days — the Doctor route was defined but never registered
 * (#8 era), and the "Open plan" links passed a full workspace path where the route wanted a file
 * name (#9). Neither was catchable by the type checker: route params and paths are all `string`.
 * The #9 test even asserted the right href, but fed the component a shape the server never sends.
 *
 * So: fixtures here mirror the real API payloads, and the assertion is the href, not the label.
 */

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

function stub(label: string): ComponentType {
  return () => <div data-testid={label}>{label}</div>;
}

/** Renders `component` at `path`, with the plan/story routes registered so links can resolve. */
function renderAt(path: string, routePath: string, component: ComponentType) {
  const rootRoute = createRootRoute();
  const target = createRoute({ getParentRoute: () => rootRoute, path: routePath, component: component as never });
  // Register the destination routes too, so links can resolve — minus the one under test.
  const extras = (
    [
      { path: '/plans/$feature/$planFile', component: stub('plan-detail') },
      { path: '/stories/$feature/$id', component: stub('story-detail') },
    ] as const
  )
    .filter((e) => e.path !== routePath)
    .map((e) =>
      createRoute({ getParentRoute: () => rootRoute, path: e.path, component: e.component as never }),
    );
  const routeTree = rootRoute.addChildren([target, ...extras]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider router={router as never} />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('console link hrefs', () => {
  it('PlansPage links each plan at /plans/<feature>/<file>', async () => {
    // `GET /api/plans` returns planFile as a bare readdir entry — see src/console/api/plans.ts.
    const plans: ApiPlan[] = [
      { feature: 'tenancy', planFile: '01-story-142.md', metadata: { provider: 'anthropic' } },
    ];
    apiMock.mockImplementation(async (p: string) => {
      if (p === '/api/plans') return plans;
      throw new Error(`unexpected api path ${p}`);
    });

    renderAt('/plans', '/plans', PlansPage);

    const link = await screen.findByRole('link', { name: /01-story-142\.md/ });
    expect(link.getAttribute('href')).toBe('/plans/tenancy/01-story-142.md');
  });

  it('StoryDetail links its plan at /plans/<feature>/<file>', async () => {
    // `GET /api/stories/:feature/:id` resolves planFile via findPlanFor(), also a bare entry.
    const detail: ApiStoryDetail = {
      feature: 'tenancy',
      id: '142',
      intakePath: '.squad/stories/tenancy/142/intake.md',
      storyDir: '.squad/stories/tenancy/142',
      planFile: '01-story-142.md',
      titleHint: 'Tenant provisioning',
      intakeContent: '# intake',
    };
    apiMock.mockImplementation(async (p: string) => {
      if (p.startsWith('/api/stories/')) return detail;
      throw new Error(`unexpected api path ${p}`);
    });

    renderAt('/stories/tenancy/142', '/stories/$feature/$id', StoryDetail);

    const link = await screen.findByRole('link', { name: /01-story-142\.md/ });
    expect(link.getAttribute('href')).toBe('/plans/tenancy/01-story-142.md');
  });
});

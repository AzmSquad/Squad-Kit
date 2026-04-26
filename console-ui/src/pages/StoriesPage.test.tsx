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
import { StoriesPage } from './StoriesPage';
import type { ApiStory } from '~/api/types';

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
    path: '/stories',
    component: () => <StoriesPage />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/stories'] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('StoriesPage', () => {
  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', 'c'.repeat(64));
    apiMock.mockReset();
  });

  it('shows the page heading and a planned badge for a story with a plan', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/stories') {
        const stories: ApiStory[] = [
          {
            feature: 'feat',
            id: '01-a',
            intakePath: '/i',
            storyDir: '/s',
            planFile: '01-a.md',
            titleHint: 'Hello',
          },
        ];
        return stories;
      }
      throw new Error(`unexpected: ${path}`);
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Stories' })).toBeInTheDocument();
    expect(await screen.findByText('planned')).toBeInTheDocument();
  });

  it('renders the empty state callout', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/stories') return [] as ApiStory[];
      throw new Error(`unexpected: ${path}`);
    });

    renderPage();

    expect(await screen.findByText(/No stories yet/)).toBeInTheDocument();
  });
});

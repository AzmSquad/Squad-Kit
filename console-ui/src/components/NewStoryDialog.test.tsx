import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { NewStoryDialog } from './NewStoryDialog';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

const TOKEN = 'a'.repeat(64);

function renderDialog() {
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <NewStoryDialog open onOpenChange={() => {}} />,
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

describe('NewStoryDialog', () => {
  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', TOKEN);
    apiMock.mockReset();
    apiMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/meta') {
        return Promise.resolve({
          version: '0.6.0',
          root: '/',
          project: { name: 'p' },
          planner: null,
          tracker: { type: 'none' },
        });
      }
      if (url === '/api/stories' && !init) {
        return Promise.resolve([]);
      }
      if (url === '/api/stories' && init?.method === 'POST') {
        return Promise.resolve({
          feature: 'my-feat',
          id: 'my-title',
          storyDir: '/a',
          intakePath: '/b',
        });
      }
      return Promise.reject(new Error(`unmocked ${url}`));
    });
  });

  it('submits POST /api/stories with feature and title', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('New feature…')).toBeInTheDocument();
    });
    const title = screen.getByPlaceholderText('Short title');
    fireEvent.change(title, { target: { value: 'my title' } });
    const nf = screen.getByPlaceholderText('kebab-case feature slug');
    fireEvent.change(nf, { target: { value: 'my-feat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/api/stories',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('my-feat') as string,
        }),
      );
    });
    const postCall = apiMock.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as { feature: string; title?: string };
    expect(body.feature).toBe('my-feat');
    expect(body.title).toBe('my title');
  });
});

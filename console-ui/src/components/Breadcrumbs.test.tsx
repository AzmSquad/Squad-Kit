import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { Breadcrumbs } from './Breadcrumbs';

function renderAt(path: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const stories = createRoute({
    getParentRoute: () => root,
    path: '/stories',
    component: () => <Breadcrumbs />,
  });
  const storyDetail = createRoute({
    getParentRoute: () => root,
    path: '/stories/$feature/$id',
    component: () => <Breadcrumbs />,
  });
  const router = createRouter({
    routeTree: root.addChildren([stories, storyDetail]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(<RouterProvider router={router} />);
}

describe('Breadcrumbs', () => {
  it('renders Stories crumb on /stories', async () => {
    renderAt('/stories');
    expect(await screen.findByText('Stories')).toBeInTheDocument();
  });

  it('renders three crumbs on /stories/demo/01-pull', async () => {
    renderAt('/stories/demo/01-pull');
    expect(await screen.findByText('Stories')).toBeInTheDocument();
    expect(await screen.findByText('demo')).toBeInTheDocument();
    expect(await screen.findByText('01-pull')).toBeInTheDocument();
  });
});

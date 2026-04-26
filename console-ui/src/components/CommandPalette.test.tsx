import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { CommandPalette } from './CommandPalette';

function setup() {
  const root = createRootRoute({ component: () => null });
  const dash = createRoute({ getParentRoute: () => root, path: '/', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([dash]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <CommandPalette />
    </QueryClientProvider>,
  );
}

describe('CommandPalette', () => {
  it('opens on Cmd+K', () => {
    setup();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByPlaceholderText(/Type a command/i)).toBeInTheDocument();
  });

  it('opens on the squad:cmdk:open custom event', async () => {
    setup();
    window.dispatchEvent(new CustomEvent('squad:cmdk:open'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type a command/i)).toBeInTheDocument();
    });
  });
});

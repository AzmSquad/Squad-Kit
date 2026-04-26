import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { useGlobalShortcuts } from './useGlobalShortcuts';

function setup() {
  const root = createRootRoute({
    component: function ShortcutsShell() {
      useGlobalShortcuts();
      return <Outlet />;
    },
  });
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => null,
  });
  const stories = createRoute({
    getParentRoute: () => root,
    path: '/stories',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, stories]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
  return { router };
}

describe('useGlobalShortcuts', () => {
  it('does not handle chord when Meta is held (reserved for e.g. Cmd+K in CommandPalette)', () => {
    const { router } = setup();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'g', bubbles: true, metaKey: true, ctrlKey: false, altKey: false }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', bubbles: true, metaKey: true, ctrlKey: false, altKey: false }),
      );
    });
    expect(router.state.location.pathname).toBe('/');
  });

  it('does not trigger navigation when typing g then s in an input', () => {
    const { router } = setup();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'g', bubbles: true, altKey: false, ctrlKey: false, metaKey: false }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', bubbles: true, altKey: false, ctrlKey: false, metaKey: false }),
      );
    });
    expect(router.state.location.pathname).toBe('/');
    document.body.removeChild(input);
  });
});

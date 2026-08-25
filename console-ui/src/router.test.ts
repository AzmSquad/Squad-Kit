import { describe, it, expect } from 'vitest';
import { routeTree } from './router';
import { sections } from './components/Sidebar';

/**
 * `/doctor` was defined as a route but left out of `routeTree.addChildren([...])` in the 0.11.0
 * runs-pages work, so the sidebar link rendered a bare "Not Found" for four months across four
 * releases. A route that nothing links to is dead code; a link that resolves to nothing is a bug,
 * and the type checker catches neither. This asserts the two stay in sync.
 */
function registeredPaths(): string[] {
  const children = (routeTree as unknown as { children?: unknown[] }).children ?? [];
  return children
    .map((r) => {
      const route = r as { path?: string; options?: { path?: string } };
      return route.options?.path ?? route.path;
    })
    .filter((p): p is string => typeof p === 'string');
}

describe('router', () => {
  it('registers a route for every sidebar destination', () => {
    const paths = new Set(registeredPaths());
    const missing = sections
      .flatMap((s) => s.items.map((i) => i.to))
      .filter((to) => !paths.has(to));

    expect(missing).toEqual([]);
  });

  it('still routes /doctor specifically', () => {
    expect(registeredPaths()).toContain('/doctor');
  });
});

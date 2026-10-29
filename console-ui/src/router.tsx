import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { BoardPage } from './pages/Board';
import { ProofPage } from './pages/Proof';
import { ReleasesPage } from './pages/Releases';
import { BugsPage, DecisionsPage, InboxPage, SettingsPage, SquadPage } from './pages/Pages';

const rootRoute = createRootRoute({ component: Shell });

const index = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/board' });
  },
});

const board = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  // `t` is taken by the session token in the URL, so the open ticket uses `ticket`.
  validateSearch: (s: Record<string, unknown>): { ticket?: string; view?: 'mine' | 'bugs' } => ({
    ticket: typeof s.ticket === 'string' && s.ticket ? s.ticket : undefined,
    view: s.view === 'mine' || s.view === 'bugs' ? s.view : undefined,
  }),
  component: BoardPage,
});

const proof = createRoute({ getParentRoute: () => rootRoute, path: '/tickets/$id/proof', component: ProofPage });
const inbox = createRoute({ getParentRoute: () => rootRoute, path: '/inbox', component: InboxPage });
const releases = createRoute({ getParentRoute: () => rootRoute, path: '/releases', component: ReleasesPage });
const decisions = createRoute({ getParentRoute: () => rootRoute, path: '/decisions', component: DecisionsPage });
const bugs = createRoute({ getParentRoute: () => rootRoute, path: '/bugs', component: BugsPage });
const squad = createRoute({ getParentRoute: () => rootRoute, path: '/squad', component: SquadPage });
const settings = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });

const routeTree = rootRoute.addChildren([index, board, proof, inbox, releases, decisions, bugs, squad, settings]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

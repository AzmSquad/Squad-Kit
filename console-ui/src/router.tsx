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
  validateSearch: (s: Record<string, unknown>): { t?: string; view?: 'mine' | 'bugs' } => ({
    t: typeof s.t === 'string' && s.t ? s.t : undefined,
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

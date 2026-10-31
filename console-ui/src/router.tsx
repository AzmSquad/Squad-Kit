import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { BoardPage } from './pages/Board';
import { ProofPage } from './pages/Proof';
import { ReleasesPage } from './pages/Releases';
import { BacklogPage } from './pages/Backlog';
import { ArchitecturePage, type ArchView } from './pages/Architecture';
import { BugsPage, InboxPage, SettingsPage, SquadPage } from './pages/Pages';

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
const backlog = createRoute({ getParentRoute: () => rootRoute, path: '/backlog', component: BacklogPage });
const inbox = createRoute({ getParentRoute: () => rootRoute, path: '/inbox', component: InboxPage });
const releases = createRoute({ getParentRoute: () => rootRoute, path: '/releases', component: ReleasesPage });
// Decisions now live on the Architecture page; old links still work.
const decisions = createRoute({
  getParentRoute: () => rootRoute,
  path: '/decisions',
  beforeLoad: () => {
    throw redirect({ to: '/architecture', search: { view: 'list' } });
  },
});
const architecture = createRoute({
  getParentRoute: () => rootRoute,
  path: '/architecture',
  validateSearch: (s: Record<string, unknown>): { adr?: string; view?: ArchView } => ({
    adr: typeof s.adr === 'string' && s.adr ? s.adr : undefined,
    view: ['timeline', 'list', 'project', 'lessons'].includes(s.view as string) ? (s.view as ArchView) : undefined,
  }),
  component: ArchitecturePage,
});
const bugs = createRoute({ getParentRoute: () => rootRoute, path: '/bugs', component: BugsPage });
const squad = createRoute({ getParentRoute: () => rootRoute, path: '/squad', component: SquadPage });
const settings = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });

const routeTree = rootRoute.addChildren([index, board, backlog, proof, inbox, releases, decisions, architecture, bugs, squad, settings]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

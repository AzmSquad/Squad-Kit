import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { CrashPage } from './components/Crash';
import { BoardPage } from './pages/Board';
import { ProofPage } from './pages/Proof';
import { ReleasesPage } from './pages/Releases';
import { BacklogPage } from './pages/Backlog';
import { ArchitecturePage, type ArchView } from './pages/Architecture';
import { BugsPage, InboxPage, SettingsPage, SquadPage } from './pages/Pages';
import { HomePage } from './pages/Home';
import { PROJECT, PROJECT_BASE } from './api/client';
import { ConversationsPage } from './pages/Conversations';
import { OverviewPage } from './pages/Overview';
import { SetupPage } from './pages/Setup';
import { BreakdownPage, RequirementsPage } from './pages/Requirements';

// One app, many projects (ADR-001): a project's pages sit under /p/<project id>/ (the router's base), and the app's
// Home, with every project and one Waiting for you list, at /.
const rootRoute = createRootRoute({
  component: PROJECT ? Shell : HomePage,
  beforeLoad: ({ location }) => {
    if (!PROJECT && location.pathname !== '/') throw redirect({ to: '/' });
  },
});

const index = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    // The Overview is the project's home: the handover the first time, then the project at a glance.
    if (PROJECT) throw redirect({ to: '/overview' });
  },
});
// The first run, full page: squad-kit gets to know the project, step by step.
const setup = createRoute({ getParentRoute: () => rootRoute, path: '/setup', component: SetupPage });
const overview = createRoute({ getParentRoute: () => rootRoute, path: '/overview', component: OverviewPage });

// Requirements: every BRD added, and one breakdown. `item` opens a part (a link can open S-14), `ticket` a story's ticket.
const requirements = createRoute({ getParentRoute: () => rootRoute, path: '/requirements', component: RequirementsPage });
const breakdown = createRoute({
  getParentRoute: () => rootRoute,
  path: '/requirements/$id',
  validateSearch: (s: Record<string, unknown>): { item?: string; view?: 'map'; ticket?: string; decided?: boolean } => ({
    item: typeof s.item === 'string' && s.item ? s.item : undefined,
    view: s.view === 'map' ? 'map' : undefined,
    ticket: typeof s.ticket === 'string' && s.ticket ? s.ticket : undefined,
    decided: s.decided === true || s.decided === 'true' ? true : undefined,
  }),
  component: BreakdownPage,
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
    view: ['timeline', 'stack', 'list', 'project', 'lessons'].includes(s.view as string) ? (s.view as ArchView) : undefined,
  }),
  component: ArchitecturePage,
});
// Every talk with an agent, full screen. `ticket` picks the talk.
const conversations = createRoute({
  getParentRoute: () => rootRoute,
  path: '/conversations',
  validateSearch: (s: Record<string, unknown>): { ticket?: string } => ({ ticket: typeof s.ticket === 'string' && s.ticket ? s.ticket : undefined }),
  component: ConversationsPage,
});
const bugs = createRoute({ getParentRoute: () => rootRoute, path: '/bugs', component: BugsPage });
const squad = createRoute({ getParentRoute: () => rootRoute, path: '/squad', component: SquadPage });
const settings = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });

const routeTree = rootRoute.addChildren([index, setup, overview, requirements, breakdown, board, backlog, proof, inbox, conversations, releases, decisions, architecture, bugs, squad, settings]);

export const router = createRouter({ routeTree, defaultPreload: false, basepath: PROJECT_BASE || '/', defaultErrorComponent: CrashPage });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

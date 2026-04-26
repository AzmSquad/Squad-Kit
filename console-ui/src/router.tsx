import type { ComponentType } from 'react';
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { StoriesPage } from './pages/StoriesPage';
import { StoryDetail } from './pages/StoryDetail';
import { PlansPage } from './pages/PlansPage';
import { PlanDetail } from './pages/PlanDetail';
import { PlanDiff } from './pages/PlanDiff';
import { GeneratePage } from './pages/GeneratePage';
import { ConfigPage } from './pages/ConfigPage';
import { SecretsPage } from './pages/SecretsPage';
import { TrackerPage } from './pages/TrackerPage';
import { DoctorPage } from './pages/DoctorPage';
import { DesignPlayground } from './pages/DesignPlayground';

const rootRoute = createRootRoute({
  component: Layout,
});

function leaf(path: string, component: ComponentType) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: component as never,
  });
}

const dashboard = leaf('/', Dashboard);
const stories = leaf('/stories', StoriesPage);
const storyDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stories/$feature/$id',
  component: StoryDetail as never,
});
const plans = leaf('/plans', PlansPage);
const planDetail = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plans/$feature/$planFile',
  component: PlanDetail as never,
});
const planDiff = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plans/$feature/diff',
  validateSearch: (search: Record<string, unknown>) => ({
    a: typeof search.a === 'string' ? search.a : '',
    b: typeof search.b === 'string' ? search.b : '',
  }),
  component: PlanDiff as never,
});
const generate = createRoute({
  getParentRoute: () => rootRoute,
  path: '/generate',
  validateSearch: (search: Record<string, unknown>) => ({
    feature: typeof search.feature === 'string' ? search.feature : '',
    storyId: typeof search.storyId === 'string' ? search.storyId : '',
  }),
  component: GeneratePage as never,
});
const config = leaf('/config', ConfigPage);
const secrets = leaf('/secrets', SecretsPage);
const tracker = leaf('/tracker', TrackerPage);
const doctor = leaf('/doctor', DoctorPage);
const design = createRoute({
  getParentRoute: () => rootRoute,
  path: '/__design',
  validateSearch: (search: Record<string, unknown>) => ({
    design: typeof search.design === 'string' ? search.design : undefined,
  }),
  component: DesignPlayground as never,
});

export const routeTree = rootRoute.addChildren([
  dashboard,
  stories,
  storyDetail,
  plans,
  planDetail,
  planDiff,
  generate,
  config,
  secrets,
  tracker,
  doctor,
  design,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

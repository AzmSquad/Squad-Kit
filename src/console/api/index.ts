import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { mountStoriesApi } from './stories.js';
import { mountPlansApi } from './plans.js';
import { mountConfigApi } from './config.js';
import { mountMetaApi } from './meta.js';
import { mountRunsApi } from './runs.js';
import { mountSecretsApi } from './secrets.js';
import { mountTrackerApi } from './tracker.js';
import { mountDoctorApi } from './doctor.js';
import { mountCopyPlanPromptApi } from './copy-plan-prompt.js';
import { mountDashboardApi } from './dashboard.js';
import { mountProjectsApi } from './projects.js';

export interface MountApiOptions {
  paths: SquadPaths;
}

export function mountApi(app: Hono, opts: MountApiOptions): void {
  mountMetaApi(app, opts);
  mountDashboardApi(app, opts);
  mountProjectsApi(app, opts);
  mountStoriesApi(app, opts);
  mountPlansApi(app, opts);
  mountConfigApi(app, opts);
  mountRunsApi(app, opts);
  mountSecretsApi(app, opts);
  mountTrackerApi(app, opts);
  mountDoctorApi(app, opts);
  mountCopyPlanPromptApi(app, opts);
}

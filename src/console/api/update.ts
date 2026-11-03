import type { Hono } from 'hono';
import type { UpdateService } from '../updates.js';
import { act, body } from './app.js';

/**
 * The Update button (app-wide, beside the projects): where squad-kit stands, Check for updates, Update now, and the
 * person's choices. Every answer is the whole status, so the page shows it as it is. Terminal: `squad upgrade`.
 */
export function mountUpdateApi(app: Hono, updates: UpdateService): void {
  app.get('/api/v1/app/update', (c) => c.json(updates.status()));

  app.post('/api/v1/app/update/check', (c) => act(c, () => updates.check()));

  // Update now. { now: true } does not wait for running steps: they stop and pick up again after the restart.
  app.post('/api/v1/app/update', async (c) => {
    const b = await body<{ now?: boolean }>(c);
    return act(c, () => updates.start({ now: b.now === true }));
  });

  // Not now while it waits for a safe moment, or Close on the note after it.
  app.delete('/api/v1/app/update', (c) => act(c, () => updates.close()));

  // Check every day (on or off), and Later for one version.
  app.put('/api/v1/app/update', async (c) => {
    const b = await body<{ daily?: boolean; later?: string | null }>(c);
    return act(c, () => updates.prefs({ daily: typeof b.daily === 'boolean' ? b.daily : undefined, later: typeof b.later === 'string' || b.later === null ? b.later : undefined }));
  });

  // After the install failed and the person ran the command by hand.
  app.post('/api/v1/app/update/restart', (c) => act(c, () => updates.restartNow()));
}

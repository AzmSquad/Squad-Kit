import type { Hono } from 'hono';
import { phoneView, stopPhoneNow } from '../../engine/phone/status.js';
import { act } from './act.js';

/**
 * squad-kit's own phones on this computer: which ones it made, whether each runs, and Stop, which shuts them down now.
 * One call each, the same as `squad phone` and `squad phone stop`. Only squad-kit's own devices, by their id.
 */

export function mountPhoneApi(app: Hono): void {
  app.get('/api/v1/phone', (c) => act(c, () => phoneView()));

  // Stop: squad-kit's phones shut down now. One taking pictures for a story is left, and the answer says so.
  app.post('/api/v1/phone/stop', (c) => act(c, () => stopPhoneNow()));
}

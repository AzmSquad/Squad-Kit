import type { Hono } from 'hono';
import { phoneView, startPhoneNow, stopPhoneNow } from '../../engine/phone/status.js';
import { act } from './act.js';

/**
 * squad-kit's own phones on this computer: which ones it made, whether each runs, Start, which brings one up hidden
 * now, and Stop, which shuts them down now. One call each, the same as `squad phone`, `squad phone start <phone>` and
 * `squad phone stop`. Only squad-kit's own devices, by their id.
 */

export function mountPhoneApi(app: Hono): void {
  app.get('/api/v1/phone', (c) => act(c, () => phoneView()));

  // Stop: squad-kit's phones shut down now. One taking pictures for a story is left, and the answer says so.
  app.post('/api/v1/phone/stop', (c) => act(c, () => stopPhoneNow()));

  // Start: squad-kit's phone comes up now, hidden, with Maestro ready: { "phone": "android" } or "iphone" (the default).
  app.post('/api/v1/phone/start', (c) =>
    act(c, async () => {
      const b = (await c.req.json().catch(() => ({}))) as { phone?: unknown };
      const which = String(b?.phone ?? 'iphone').toLowerCase();
      if (which !== 'android' && which !== 'iphone' && which !== 'ios') throw new Error(`"${which}" is not a phone here. Use android or iphone.`);
      return startPhoneNow(which === 'android' ? 'android' : 'ios');
    }),
  );
}

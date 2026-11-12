import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { appNews, findApp, withAppCommands } from '../../board/apps.js';
import { boardExists, boardPaths, listTickets, readMeta, writeMeta } from '../../board/store.js';
import { AppError, appRunner, type AppStatus, type StartOptions } from '../../engine/run-app.js';
import { act } from './act.js';
import { signInNote } from '../../engine/lead/notes.js';

/**
 * Your apps, in the sidebar: Start, Open, Restart and Stop for each app of the project, each one call. Terminal:
 * `squad app start`, `squad app stop`, `squad app restart`, `squad app status`, `squad app set`.
 */

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

/** How to start: on squad-kit's iPhone, the web version, and the language, as the body says. */
function how(b: StartOptions): Pick<StartOptions, 'phone' | 'web' | 'language'> {
  return { ...(b.phone === true ? { phone: true } : {}), ...(b.web === true ? { web: true } : {}), ...(typeof b.language === 'string' ? { language: b.language } : {}) };
}

export function mountAppsApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);
  const runner = () => appRunner(bp);
  const name = (c: Context) => decodeURIComponent(c.req.param('name') ?? '');

  /** The app's status with what its code holds, the new version a merge brought, and how to sign in, once the Squad lead learned it. */
  const withNews = (s: AppStatus) => {
    const signIn = signInNote(bp);
    return { ...s, ...appNews(readMeta(bp), listTickets(bp), s, runner().notNowOf(s.repo)), ...(signIn ? { signIn } : {}) };
  };

  app.get('/api/v1/apps', async (c) => {
    if (!boardExists(bp)) return c.json({ apps: [] });
    const meta = readMeta(bp);
    const apps = (await runner().status()).map(withNews);
    const reading = meta.scan?.status === 'pending' || meta.scan?.status === 'running';
    return c.json({ apps, live: meta.engine === 'live', reading, ...(meta.scan?.status === 'failed' && meta.scan.error ? { readError: meta.scan.error } : {}) });
  });

  // An iPhone app on a Mac opens on squad-kit's iPhone: { "phone": true }, in a language: { "language": "ar" }.
  // { "web": true } is "Use the web version now": a phone start on its way stops first.
  app.post('/api/v1/apps/:name/start', async (c) => {
    const b = await body<StartOptions>(c);
    return act(c, async () => withNews(await runner().startAs(name(c), { nextPort: Boolean(b.nextPort), stopOther: Boolean(b.stopOther), ...how(b) })));
  });

  app.post('/api/v1/apps/:name/stop', (c) => act(c, async () => withNews(await runner().stop(name(c)))));

  // Also "Run the new version" after a merge: the app starts again on the newest main.
  app.post('/api/v1/apps/:name/restart', async (c) => {
    const b = await body<StartOptions>(c);
    return act(c, async () => withNews(await runner().restart(name(c), { nextPort: Boolean(b.nextPort), stopOther: Boolean(b.stopOther), ...how(b) })));
  });

  app.get('/api/v1/apps/:name/output', (c) =>
    act(c, async () => {
      const s = await runner().statusOf(name(c));
      return { name: s.name, start: s.start ?? null, url: s.url ?? null, address: s.address ?? null, dir: s.dir, commit: s.commit ?? null, lines: runner().lines(name(c)) };
    }),
  );

  // "Type it": the start command and the address, saved in the project's settings.
  app.put('/api/v1/apps/:name/commands', async (c) => {
    const b = await body<{ start?: string; url?: string }>(c);
    return act(c, async () => {
      const meta = readMeta(bp);
      const a = findApp(meta, name(c));
      writeMeta(bp, withAppCommands(meta, a.repo, { start: b.start, url: b.url }));
      return withNews(await runner().statusOf(a.name));
    });
  });

  app.post('/api/v1/apps/:name/not-now', async (c) => {
    const b = await body<{ ticket?: string }>(c);
    return act(c, () => {
      if (!b.ticket) throw new Error('Say which ticket.');
      runner().notNow(name(c), b.ticket);
      return { ok: true };
    });
  });
}

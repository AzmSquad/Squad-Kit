import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { log } from '../../core/app-log.js';
import { activePause, endPause, limitText } from '../../engine/usage-limit.js';
import { planReport, writeReport, type ReportInput } from '../../engine/report.js';
import type { OpenProjects } from '../open-projects.js';
import { act, body } from './app.js';

/**
 * An error no route expected: the exact one goes to the app log (and the terminal), the person gets plain words and a
 * way out.
 */
export function onUnexpected(err: Error, c: Context): Response {
  if (err instanceof HTTPException) return err.getResponse();
  log.error(`${c.req.method} ${new URL(c.req.url).pathname} failed: ${err.stack ?? err.message}`);
  // The toast that shows it offers Try again and Report a problem.
  return c.json({ error: 'squad-kit ran into a problem it did not expect, so this did not finish.' }, 500);
}

/**
 * When something goes wrong (phase 10), app-wide beside the projects: the usage-limit wait with Try now, and Report a
 * problem, for a ticket, a project or the app as a whole. Terminal: `squad try-now`, `squad report [ticket]`.
 */
export function mountSupportApi(app: Hono, opts: { projects: OpenProjects }): void {
  const limit = () => {
    const pause = activePause();
    return { pause, ...(pause ? { text: limitText(pause) } : {}) };
  };

  app.get('/api/v1/app/usage-limit', (c) => c.json(limit()));

  // Try now: the queue starts again at once. If the limit is still there, the first step finds it and waits again.
  app.post('/api/v1/app/usage-limit/try-now', (c) =>
    act(c, () => {
      if (endPause()) log.info('Try now: the queue carries on before the usage limit was due to reset');
      return limit();
    }),
  );

  const input = (q: { project?: string; ticket?: string; note?: string }): ReportInput => {
    const p = q.project ? opts.projects.get(q.project) : undefined;
    if (q.project && !p) throw new Error('That project is not open in squad-kit.');
    if (q.ticket && !p) throw new Error('Name the project of the ticket.');
    return {
      ...(p ? { bp: p.bp } : { projects: opts.projects.summaries() }),
      ...(q.ticket ? { ticket: q.ticket } : {}),
      ...(q.note ? { note: q.note.slice(0, 4000) } : {}),
    };
  };

  // What the report will hold, for the dialog, before anything is saved.
  app.get('/api/v1/app/report', (c) => act(c, () => planReport(input({ project: c.req.query('project'), ticket: c.req.query('ticket') }))));

  // Save the report: one zip in the person's Downloads folder. The answer says where it is.
  app.post('/api/v1/app/report', async (c) => {
    const b = await body<{ project?: string; ticket?: string; note?: string }>(c);
    return act(c, () => {
      const r = writeReport(input(b));
      const project = b.project ? (opts.projects.summaries().find((p) => p.id === b.project)?.name ?? b.project) : undefined;
      log.info(`Saved a problem report: ${r.file}`, { ...(project ? { project } : {}), ...(b.ticket ? { ticket: b.ticket } : {}) });
      return r;
    });
  });
}

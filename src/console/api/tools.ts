import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths } from '../../board/store.js';
import { checkTools, getToolNow, projectTools, updateToolNow } from '../../engine/tools/index.js';
import type { ToolSource } from '../../engine/tools/get.js';
import type { ToolId } from '../../engine/tools/catalog.js';
import { act } from './act.js';

/**
 * The Tools page, "What this project needs": the lines for this project on this computer, Check again, Get it for the
 * tools squad-kit gets itself, and Update for your own copy of a tool squad-kit can update safely. One call each, the
 * same as `squad tools`, `squad tools check`, `squad tools get <tool>`, `squad tools update <tool>`.
 */

export function mountToolsApi(app: Hono, opts: { paths: SquadPaths; source?: (id: ToolId) => Promise<ToolSource> }): void {
  const bp = boardPaths(opts.paths.squadDir);

  app.get('/api/v1/tools', (c) => act(c, () => projectTools(bp)));

  // Check again: after installing something, squad-kit looks at this computer again, and a story waiting for it goes on.
  app.post('/api/v1/tools/check', (c) =>
    act(c, async () => {
      await checkTools();
      return projectTools(bp);
    }),
  );

  // Get it: the download runs beside everything else; the page follows it on the line until it is Ready.
  app.post('/api/v1/tools/:tool/get', (c) =>
    act(c, () => {
      getToolNow(c.req.param('tool'), opts.source ? { source: opts.source } : {});
      return projectTools(bp);
    }),
  );

  // Update: it changes the tool for every project that uses it, so the call carries the person's OK, { "ok": true }.
  // Without it squad-kit says the warning and changes nothing. The page follows the update on the line, as with Get it.
  app.post('/api/v1/tools/:tool/update', (c) =>
    act(c, async () => {
      const b = (await c.req.json().catch(() => ({}))) as { ok?: unknown };
      await updateToolNow(bp, c.req.param('tool'), { ok: b?.ok === true });
      return projectTools(bp);
    }),
  );
}

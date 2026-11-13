import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths, requireTicket } from '../../board/store.js';
import { pullRequestView } from '../../engine/contribution/view.js';
import { fixThese, leaveClosed, leaveNotes } from '../../engine/contribution/actions.js';
import { bringCopyUpToDate, contributeChecklist, ideaPage, makeMyCopy } from '../../engine/contribution/checklist.js';
import { act, body } from './app.js';

/**
 * A story's pull request, and the contribution checklist of squad-kit's own code (ADR-008): one GET each for what the
 * board shows, and one POST per button, each the same as a terminal command (`squad pr`, `squad contribute`).
 */
export function mountContributionApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);

  // `squad pr MA-21`: where the pull request went, where it stands, the owner's notes, and the buttons that work now.
  app.get('/api/v1/tickets/:id/pull-request', (c) => act(c, () => pullRequestView(requireTicket(bp, c.req.param('id')))));

  // Fix these: the Builder fixes the owner's notes, then the fix goes to the same pull request: `squad pr MA-21 --fix`.
  app.post('/api/v1/tickets/:id/pull-request/fix', (c) => act(c, () => pullRequestView(fixThese(bp, c.req.param('id')))));

  // Answer them yourself, on the code host: `squad pr MA-21 --leave`.
  app.post('/api/v1/tickets/:id/pull-request/leave', (c) => act(c, () => pullRequestView(leaveNotes(bp, c.req.param('id')))));

  // The owner closed it: leave it closed, `squad pr MA-21 --leave-closed`. Send it again is the stop card's choice.
  app.post('/api/v1/tickets/:id/pull-request/leave-closed', (c) => act(c, () => pullRequestView(leaveClosed(bp, c.req.param('id')))));

  // `squad contribute`: the checklist, each item with its state and its action.
  app.get('/api/v1/contribute', (c) => act(c, () => contributeChecklist(bp)));

  // Make my copy (a fork): `squad contribute --fork`.
  app.post('/api/v1/contribute/fork', (c) => act(c, () => makeMyCopy(bp)));

  // Bring it up to date with the main repo: `squad contribute --sync`.
  app.post('/api/v1/contribute/sync', (c) => act(c, () => bringCopyUpToDate(bp)));

  // Tell the maintainers first: the new issue page, filled in. { title, text } → { link }. `squad contribute --idea`.
  app.post('/api/v1/contribute/idea', async (c) => {
    const b = await body<{ title?: unknown; text?: unknown }>(c);
    return act(c, () => ideaPage(bp, typeof b.title === 'string' ? b.title : '', typeof b.text === 'string' ? b.text : ''));
  });
}

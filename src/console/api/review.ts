import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { BoardActionError } from '../../board/actions.js';
import { boardPaths, requireTicket } from '../../board/store.js';
import { reviewView } from '../../engine/review-record/view.js';
import { goPast, writeReviewAgain } from '../../engine/review-record/actions.js';
import { act, body } from './app.js';

/**
 * The review of a story, round by round (ADR-007): what the Changes tab shows and `squad review <story>` prints, and its
 * two buttons, each the same as a terminal command.
 */
export function mountReviewApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);

  // `squad review MA-21`: every round with its notes, where each stands, and who pressed Looks right.
  app.get('/api/v1/tickets/:id/review', (c) => act(c, () => reviewView(requireTicket(bp, c.req.param('id')))));

  // Go past one open note, with a reason: `squad review MA-21 --past 3 --reason "<why>"`. { note: 3, reason }
  app.post('/api/v1/tickets/:id/review/past', async (c) => {
    const b = await body<{ note?: unknown; reason?: unknown }>(c);
    return act(c, () => {
      if (typeof b.note !== 'number' || !Number.isInteger(b.note)) throw new BoardActionError('Say which note, by its number.');
      return goPast(bp, c.req.param('id'), b.note, typeof b.reason === 'string' ? b.reason : '');
    });
  });

  // Write the review into the pull request again, after the code host said no: `squad review MA-21 --write`.
  app.post('/api/v1/tickets/:id/review/write', (c) => act(c, () => writeReviewAgain(bp, c.req.param('id'))));
}

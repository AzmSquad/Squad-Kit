import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { BoardActionError } from '../../board/actions.js';
import { boardPaths, requireTicket } from '../../board/store.js';
import { chatToRequirements, createParts, decideSplit, partsFromDraft, sendToRequirements, type SplitChoice } from '../../board/split.js';
import { draftFiles, draftJob, draftUsed } from '../../engine/draft.js';
import { act, body } from './app.js';

/**
 * A story too big for one (board/split.ts): one call per button, the same as `squad split` and `squad new --from`.
 * Nothing is split or sent before one of these is pressed, and the same press sent again makes nothing twice.
 */

const CHOICES: SplitChoice['choice'][] = ['split', 'keep', 'change', 'requirements'];

export function mountSplitApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);

  // The card on a story: `squad split MA-21 --yes`, `--keep`, `--change "<note>"` or `--requirements`, each only where
  // the card has that button. `expect`: pressed on a decision card in a chat, the story must still wait on what the
  // card showed (board/wait-key.ts).
  app.post('/api/v1/tickets/:id/split', async (c) => {
    const b = await body<{ choice?: string; note?: string; expect?: string }>(c);
    return act(c, () => {
      const choice = CHOICES.find((x) => x === b.choice);
      if (!choice) throw new BoardActionError('Choose split, keep, change or requirements.');
      return decideSplit(bp, c.req.param('id'), { choice, ...(typeof b.note === 'string' ? { note: b.note } : {}), ...(typeof b.expect === 'string' ? { expect: b.expect } : {}) });
    });
  });

  // A big text pasted into a story's talk, sent to Requirements from the hint under it: `squad split MA-21
  // --chat-requirements`. `at` names the message; sent once, the same press gets the same breakdown.
  app.post('/api/v1/tickets/:id/chat/requirements', async (c) => {
    const b = await body<{ at?: string }>(c);
    return act(c, () => chatToRequirements(bp, c.req.param('id'), typeof b.at === 'string' ? b.at : undefined));
  });

  // New ticket's Create N stories: the draft's parts become stories, the first one starts (`squad new --from "…"
  // --split`). Pressed again, it answers with the stories it made.
  app.post('/api/v1/tickets/draft/:id/split', (c) => {
    const id = c.req.param('id');
    return act(c, () => {
      const job = draftJob(bp, id);
      if (job.used?.stories) return { tickets: job.used.stories.map((s) => requireTicket(bp, s)) };
      if (!job.draft?.split || job.draft.split.size !== 'few') throw new BoardActionError('This draft has no split. Create it as one story.');
      const tickets = createParts(bp, job.draft.split, partsFromDraft(job.draft, job.text, draftFiles(bp, id).files), { startFirst: true, key: `draft:${id}` });
      draftUsed(bp, id, { stories: tickets.map((t) => t.id) });
      return { tickets };
    });
  });

  // Send to Requirements, from New ticket or `squad new --from "…" --requirements`. Pressed again, the same breakdown.
  app.post('/api/v1/tickets/draft/:id/requirements', (c) => {
    const id = c.req.param('id');
    return act(c, () => {
      const job = draftJob(bp, id);
      const made = job.used?.breakdown;
      const b = made ? { id: made } : sendToRequirements(bp, { text: job.text, files: draftFiles(bp, id).files, ...(job.draft?.title ? { name: job.draft.title } : {}) });
      if (!made) draftUsed(bp, id, { breakdown: b.id });
      return { breakdown: { id: b.id } };
    });
  });
}

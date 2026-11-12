import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardExists, boardPaths } from '../../board/store.js';
import { askLead, stopLead } from '../../engine/lead/ask.js';
import { morningBrief } from '../../engine/lead/brief.js';
import { ACTIONS, ALLOWABLE, NEVER, leadCan } from '../../engine/lead/can.js';
import { runCard, type CardEdits } from '../../engine/lead/cards.js';
import { LEAD_ANSWER_MS, MAX_LEAD_DAY_USD } from '../../engine/lead/limits.js';
import { needsYou, squadNow } from '../../engine/lead/needs-you.js';
import { signInNote } from '../../engine/lead/notes.js';
import { LEAD_READS, LEAD_LOOKS } from '../../engine/lead/window.js';
import { leadRules, listConversations, requireConversation, saveLeadRules, spentToday, summaryOf } from '../../engine/lead/store.js';
import { readMeta } from '../../board/store.js';
import { DEFAULT_QUALITY, stepCaps } from '../../engine/levels.js';
import { act } from './act.js';

/**
 * The Squad lead: ask, follow up, press a card, and see what needs you and what the squad does now. Each is one call,
 * the same as `squad ask`, `squad lead` and `squad lead run <card>` in the terminal.
 */

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function mountLeadApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);
  const ready = () => boardExists(bp);
  const today = () => ({ costUsd: Math.round(spentToday(bp) * 100) / 100, limitUsd: MAX_LEAD_DAY_USD });
  const limits = () => {
    const caps = ready() ? stepCaps({ role: 'lead', step: 'ask', quality: readMeta(bp).quality ?? DEFAULT_QUALITY }) : stepCaps({ role: 'lead', step: 'ask' });
    return { questionUsd: caps.spendUsd, questionTurns: caps.turns, dayUsd: MAX_LEAD_DAY_USD, minutes: LEAD_ANSWER_MS / 60_000 };
  };

  // Everything the Squad lead page opens with: the conversations, what needs you, the squad now, the morning brief.
  app.get('/api/v1/lead', (c) => {
    if (!ready()) return c.json({ conversations: [], needsYou: [], squadNow: [], rules: { always: [], brief: false }, today: { costUsd: 0, limitUsd: MAX_LEAD_DAY_USD } });
    const rules = leadRules(bp);
    const signIn = signInNote(bp);
    return c.json({
      conversations: listConversations(bp).map(summaryOf),
      needsYou: needsYou(bp),
      squadNow: squadNow(bp),
      ...(rules.brief ? { brief: morningBrief(bp) } : {}),
      rules,
      today: today(),
      ...(signIn ? { signIn } : {}),
    });
  });

  // One call each, for the rail and the phone.
  app.get('/api/v1/lead/needs-you', (c) => c.json({ items: ready() ? needsYou(bp) : [] }));
  app.get('/api/v1/lead/squad-now', (c) => c.json({ items: ready() ? squadNow(bp) : [] }));
  app.get('/api/v1/lead/brief', (c) => c.json(ready() ? { on: leadRules(bp).brief, brief: morningBrief(bp) } : { on: false }));

  // Ask: { "text": "...", "context": { "from": "app", "path": "/my-bookings" } }. Answered at once when squad-kit can
  // answer itself; otherwise the conversation comes back thinking, and GET /lead/conversations/<id> follows it.
  app.post('/api/v1/lead/conversations', async (c) => {
    const b = await body<{ text?: string; context?: unknown; fresh?: boolean }>(c);
    return act(c, () => askLead(bp, { text: b.text ?? '', ...(b.context !== undefined ? { context: b.context } : {}), fresh: b.fresh === true }).conversation);
  });

  app.post('/api/v1/lead/conversations/:id/messages', async (c) => {
    const b = await body<{ text?: string; context?: unknown; fresh?: boolean }>(c);
    return act(c, () => askLead(bp, { text: b.text ?? '', conversation: c.req.param('id'), ...(b.context !== undefined ? { context: b.context } : {}), fresh: b.fresh === true }).conversation);
  });

  app.get('/api/v1/lead/conversations/:id', (c) => act(c, () => requireConversation(bp, c.req.param('id'))));
  app.post('/api/v1/lead/conversations/:id/stop', (c) => act(c, () => stopLead(bp, c.req.param('id'))));

  // Press a card: { "always": true } turns "Always allow" on first (only for the low-risk ones), { "dismiss": true } is
  // Not now, and { "edits": { "title": ..., "doneWhen": [...] } } is Edit before Create.
  app.post('/api/v1/lead/cards/:id/run', async (c) => {
    const b = await body<{ always?: boolean; dismiss?: boolean; edits?: CardEdits }>(c);
    return act(c, () =>
      runCard(bp, c.req.param('id'), {
        always: b.always === true,
        dismiss: b.dismiss === true,
        ...(b.edits && typeof b.edits === 'object' ? { edits: b.edits } : {}),
        find: (id) => needsYou(bp).flatMap((x) => x.cards).find((x) => x.id === id),
      }),
    );
  });

  // The rules: "Always allow" (only the low-risk set), the morning brief, and the never list, read only.
  app.get('/api/v1/lead/rules', (c) =>
    c.json({
      ...(ready() ? leadRules(bp) : { always: [], brief: false }),
      allowable: ALLOWABLE.map((id) => ({ id, name: ACTIONS[id].name })),
      never: Object.entries(NEVER).map(([id, n]) => ({ id, name: n.name, refusal: n.refusal })),
      limits: limits(),
      today: ready() ? today() : { costUsd: 0, limitUsd: MAX_LEAD_DAY_USD },
    }),
  );
  app.put('/api/v1/lead/rules', async (c) => {
    const b = await body<{ always?: unknown; brief?: unknown; never?: unknown }>(c);
    return act(c, () => saveLeadRules(bp, b));
  });

  // "What it can do": the three levels in words, what it reads, and its limits.
  app.get('/api/v1/lead/can', (c) => c.json({ ...leadCan(), reads: [...LEAD_READS], looks: [...LEAD_LOOKS], limits: limits() }));
}

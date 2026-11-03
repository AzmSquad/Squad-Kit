import { listDecisions, now, readMeta, type BoardPaths } from '../board/store.js';
import { cleanOverview, hasOverview, readOverview, writeOverview } from '../board/overview.js';
import { corrections, readTalk, writeTalk } from '../board/first-run.js';
import type { AgentResult } from '../modules/ai-tool/types.js';
import * as P from './prompts.js';

/**
 * The live engine's part of the overview that needs an agent beside the setup: the Architect's answers when the
 * person says something is wrong, what they said for the next read, and the picture of the parts after a read of the
 * code. The setup's steps themselves are in onboard.ts.
 */

const STOPPED = 'You stopped the squad.';

/** What the Architect wrote about the project, as text it can read back in the talk. */
function understood(bp: BoardPaths): string {
  const meta = readMeta(bp);
  const o = readOverview(bp);
  const list = (head: string, items: string[]) => (items.length ? `${head}:\n${items.map((x) => `- ${x}`).join('\n')}` : '');
  return [
    meta.scan?.summary ? `What it is: ${meta.scan.summary}` : '',
    o.users ? `Who uses it: ${o.users}` : '',
    list('What it can do today', o.can),
    list('Worth knowing', o.worth),
    list('How it fits together', o.parts.map((p) => `${p.name}: ${p.what}${p.files.length ? ` (${p.files.join(', ')})` : ''}`)),
    list('Good first tickets', o.ideas.map((i) => i.title)),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface TalkControl {
  running: boolean;
  stop(): void;
  launch(job: () => Promise<void>): void;
  run(o: { prompt: string }): Promise<AgentResult>;
}

/** Each turn of the engine: the Architect answers a waiting message, or its answer stops. */
export function talkReply(bp: BoardPaths, c: TalkControl): void {
  const t = readTalk(bp);
  if (!t?.open) return;
  if (t.stopping) {
    c.stop();
    if (!c.running) {
      writeTalk(bp, {
        ...t,
        thinking: false,
        stopping: undefined,
        messages: t.thinking ? [...t.messages, { who: 'squad', text: 'You stopped this answer. Ask again, or carry on.', at: now(), note: 'stopped' }] : t.messages,
      });
    }
    return;
  }
  if (!t.thinking || c.running) return;
  c.launch(async () => {
    const prompt = P.overviewTalkPrompt(readMeta(bp), listDecisions(bp), understood(bp), t.messages);
    try {
      const r = await c.run({ prompt });
      const out = (r.structured ?? {}) as { reply?: string; options?: string[] };
      const options = (out.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 4);
      const fresh = readTalk(bp) ?? t;
      writeTalk(bp, {
        ...fresh,
        thinking: false,
        messages: [...fresh.messages, { who: 'architect', text: (out.reply ?? r.text ?? '').trim() || '(no answer)', at: now(), ...(options.length ? { options } : {}) }],
      });
    } catch (err) {
      const fresh = readTalk(bp) ?? t;
      const stopped = Boolean(fresh.stopping) || (err as Error).message === STOPPED;
      writeTalk(bp, {
        ...fresh,
        thinking: false,
        stopping: undefined,
        messages: [
          ...fresh.messages,
          stopped
            ? { who: 'squad', text: 'You stopped this answer. Ask again, or carry on.', at: now(), note: 'stopped' }
            : { who: 'squad', text: `The Architect could not answer: ${(err as Error).message}`, at: now(), note: 'failed' },
        ],
      });
    }
  });
}

/** What the person said in the talk, when they asked for the read again with it. */
export function readSaid(bp: BoardPaths): string {
  const t = readTalk(bp);
  return t?.reread ? corrections(t) : '';
}

/** The read with what they said is done. */
export function readAgainDone(bp: BoardPaths): void {
  const t = readTalk(bp);
  if (t) writeTalk(bp, { ...t, reread: false });
}

/** A read of the code for the architecture page also brings the overview's picture of the parts up to date. */
export function saveBlueprintParts(bp: BoardPaths, answer: unknown): void {
  if (!hasOverview(bp) || !answer || typeof answer !== 'object') return;
  const a = answer as { parts?: unknown; links?: unknown };
  const fresh = cleanOverview({ parts: a.parts, links: a.links });
  if (!fresh.parts.length) return;
  writeOverview(bp, { ...readOverview(bp), parts: fresh.parts, links: fresh.links, refreshedAt: now() });
}

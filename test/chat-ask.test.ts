import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

const calls: RunOptions[] = [];
const answers: unknown[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answers.shift() ?? { reply: 'ok', ready: false }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, listTickets, readMeta, readTicket, updateTicket, writeMeta, ticketFilesDir } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { tick } = await import('../src/board/engine.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { chatSummaries } = await import('../src/engine/conversations.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
type Squad = { chatReply(id: string): Promise<void>; chatStopped(id: string): void };
const live = () => writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-side-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A ticket the Builder is building right now. */
function building() {
  const t = actions.createTicket(bp, { title: 'Limit bookings' });
  updateTicket(bp, t.id, (x) => {
    x.stage = 'implement';
    x.live = true;
    x.status = 'Builder is writing the limit check';
    x.squad = { phase: 'build', nextAt: new Date().toISOString() };
    x.worktree = tmp;
    x.sessions = { intake: 'i-1', build: 'b-1' };
  });
  return readTicket(bp, t.id)!;
}

describe('answers beside the work', () => {
  it('carries choices and the files it may show, and the chat rules ask for them', async () => {
    live();
    const t0 = building();
    const shot = path.join(ticketFilesDir(bp, t0.id), 'outbox.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    fs.writeFileSync(shot, 'png');
    actions.startChat(bp, t0.id, 'analyst');
    answers.push({ reply: 'Here it is. Which one?', ready: true, options: ['Yes', ' ', 'No'], files: [shot, `file://${shot}`, path.join(os.tmpdir(), 'elsewhere.png')] });
    await (new LiveSquad(bp) as unknown as Squad).chatReply(t0.id);
    const call = calls.at(-1)!;
    expect(call.schema).toBe(P.CHAT_SCHEMA);
    expect(call.prompt).toContain('put up to 4 short answers in "options"');
    expect(call.prompt).toContain('put its full path in "files"');
    const t = readTicket(bp, t0.id)!;
    // Only files inside the ticket's own folders, once each.
    expect(t.chat!.messages.at(-1)).toMatchObject({ who: 'analyst', options: ['Yes', 'No'], files: [fs.realpathSync(shot)] });
    expect(t.chat!.ready).toBe(false);
    expect(t.squad?.phase).toBe('build');
    expect(t.live).toBe(true);
  });

  it('Done while the side answer is still written stops that answer, never the step', () => {
    live();
    const t0 = building();
    let t = actions.startChat(bp, t0.id, 'analyst');
    expect(t.chat).toMatchObject({ beside: true, thinking: true });
    t = actions.chatDone(bp, t0.id);
    expect(t.chat).toMatchObject({ open: false, stopping: true });
    expect(t.stopRequested).toBeUndefined();
    (new LiveSquad(bp) as unknown as Squad).chatStopped(t0.id);
    t = readTicket(bp, t0.id)!;
    expect(t.chat!.thinking).toBe(false);
    expect(t.chat!.messages.some((m) => m.note === 'stopped')).toBe(false);
    expect(t.squad?.phase).toBe('build');
  });
});

describe('stop and try again', () => {
  it('stops the answer with a way on, then asks again (demo board)', () => {
    let t = actions.createTicket(bp, { title: 'Dark mode', talkFirst: true });
    expect(t.chat!.thinking).toBe(true);
    t = actions.chatStop(bp, t.id);
    expect(t.chat!.stopping).toBe(true);
    tick(bp);
    t = readTicket(bp, t.id)!;
    expect(t.chat!.thinking).toBe(false);
    expect(t.chat!.messages.at(-1)).toMatchObject({ who: 'squad', note: 'stopped' });
    expect(() => actions.chatStop(bp, t.id)).toThrow(/no answer being written/);
    t = actions.chatRetry(bp, t.id);
    expect(t.chat!.thinking).toBe(true);
    expect(t.chat!.messages.some((m) => m.who === 'squad')).toBe(false);
  });

  it('Stop on a side answer aborts the chat run only: the Builder keeps building', async () => {
    live();
    const t0 = building();
    actions.startChat(bp, t0.id, 'analyst');
    // Only this ticket is in play.
    for (const x of listTickets(bp)) if (x.id !== t0.id) updateTicket(bp, x.id, (y) => ((y.squad = null), (y.live = false), (y.chat = undefined)));
    const squad = new LiveSquad(bp) as unknown as {
      running: Set<string>;
      stops: Map<string, AbortController>;
      tick(): void;
      chatStopped(id: string): void;
    };
    // Both run at once: the Builder's step under the ticket, the answer under its own job.
    const step = new AbortController();
    const chat = new AbortController();
    squad.running.add(t0.id);
    squad.stops.set(t0.id, step);
    squad.running.add(`__chat:${t0.id}`);
    squad.stops.set(`__chat:${t0.id}`, chat);
    actions.chatStop(bp, t0.id);
    squad.tick();
    expect(chat.signal.aborted).toBe(true);
    expect(step.signal.aborted).toBe(false);
    // The run ends; its catch hands back to the person with a way on.
    squad.running.delete(`__chat:${t0.id}`);
    squad.chatStopped(t0.id);
    const t = readTicket(bp, t0.id)!;
    expect(t.chat).toMatchObject({ open: true, thinking: false });
    expect(t.chat!.stopping).toBeUndefined();
    expect(t.chat!.messages.at(-1)!.note).toBe('stopped');
    expect(t.live).toBe(true);
    expect(t.squad?.phase).toBe('build');
    expect(t.stopRequested).toBeUndefined();
    step.abort();
  });

  it('a failed answer is marked so the person gets Try again', async () => {
    live();
    const t0 = building();
    actions.startChat(bp, t0.id, 'analyst');
    vi.spyOn(LiveSquad.prototype as unknown as { runAgent(): Promise<unknown> }, 'runAgent').mockRejectedValueOnce(new Error('The connection dropped'));
    await (new LiveSquad(bp) as unknown as Squad).chatReply(t0.id);
    const last = readTicket(bp, t0.id)!.chat!.messages.at(-1)!;
    expect(last).toMatchObject({ who: 'squad', note: 'failed', text: 'Could not answer: The connection dropped' });
    const t = actions.chatRetry(bp, t0.id);
    expect(t.chat!.thinking).toBe(true);
    expect(t.chat!.messages.some((m) => m.who === 'squad')).toBe(false);
  });
});

describe('the chat list', () => {
  it('lists open talks first, counts fresh answers and finds words inside messages', () => {
    const a = actions.createTicket(bp, { title: 'Outbox in test mode', talkFirst: true });
    updateTicket(bp, a.id, (x) => {
      x.chat!.thinking = false;
      x.chat!.messages = [
        { who: 'analyst', text: 'Here is what I understand so far.', at: '2026-11-01T10:38:00Z' },
        { who: 'you', text: 'تمام. نحتفظ بالرسائل 30 يوم فقط', at: '2026-11-01T10:41:00Z' },
        { who: 'analyst', text: 'سؤال أخير: بأي وقت نعرض عمود الوقت في Outbox؟', at: '2026-11-01T10:42:00Z' },
      ];
    });
    const b = actions.createTicket(bp, { title: 'Dark mode' });
    updateTicket(bp, b.id, (x) => {
      x.chat = { with: 'builder', open: false, messages: [{ who: 'builder', text: 'Done.', at: '2026-11-01T11:00:00Z' }], before: { waiting: null }, beside: true };
    });
    const list = chatSummaries([readTicket(bp, b.id)!, readTicket(bp, a.id)!]);
    expect(list.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(list[0]).toMatchObject({ open: true, yourTurn: true, with: 'analyst', count: 3, fresh: 1, beside: false });
    expect(list[1]).toMatchObject({ open: false, fresh: 1, beside: true });
    expect(list[0]!.last!.text).toContain('Outbox');
    const found = chatSummaries([readTicket(bp, a.id)!, readTicket(bp, b.id)!], 'بالرسائل');
    expect(found.map((x) => x.id)).toEqual([a.id]);
    expect(found[0]!.match).toContain('نحتفظ بالرسائل');
    expect(chatSummaries([readTicket(bp, a.id)!], 'dark')).toEqual([]);
  });
});

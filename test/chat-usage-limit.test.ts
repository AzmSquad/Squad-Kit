import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * A chat message during Claude's usage limit waits, instead of failing: the chat says when it gets its answer, and
 * the answer comes by itself when the squad carries on. The clock is a fake one: the test moves it past the reset.
 */

type Answer = (opts: RunOptions) => Promise<RunResult>;
const runs: RunOptions[] = [];
let answers: Answer[] = [];
const limited = (message: string): Answer => async (opts) => ({ ok: false, sessionId: opts.sessionId ?? '', text: '', error: 'Claude stopped.', detail: message });
const replies = (reply: string): Answer => async (opts) => ({ ok: true, sessionId: opts.resume ?? opts.sessionId ?? '', text: reply, structured: { reply, ready: false } } as RunResult);
const never: Answer = (opts) => new Promise((resolve) => opts.signal?.addEventListener('abort', () => resolve({ ok: false, sessionId: '', text: '', error: 'Stopped.' })));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions): Promise<RunResult> => {
    runs.push(opts);
    return (answers.shift() ?? never)(opts);
  },
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { chatStop, createTicket } = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { activePause, chatWaitText, endPause, resetWords, startPause } = await import('../src/engine/usage-limit.js');
type BoardPaths = import('../src/board/store.js').BoardPaths;

let tmp: string;
const stops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// 12:00 UTC: London is on GMT in November, so "3:40pm (Europe/London)" is 15:40 UTC.
const NOON = Date.parse('2026-11-03T12:00:00Z');
const RESET = '2026-11-03T15:40:00.000Z';

/** A ticket waiting for you, with a chat open on it and the person's message sent: the Analyst is to answer. */
function chatting(): { bp: BoardPaths; id: string } {
  const dir = path.join(tmp, 'app');
  fs.mkdirSync(dir);
  setupProject(dir);
  const { bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'app');
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct' });
  const t = createTicket(bp, { title: 'Opening hours' });
  updateTicket(bp, t.id, (x) => {
    x.squad = null;
    x.live = false;
    x.waiting = { kind: 'spec', summary: 'The spec is ready' };
    x.chat = { with: 'analyst', open: true, thinking: true, before: { waiting: x.waiting }, messages: [{ who: 'you', text: 'Can owners close on holidays?', at: new Date().toISOString() }] };
  });
  return { bp, id: t.id };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-chat-limit-')));
  runs.length = 0;
  answers = [];
  endPause();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  endPause();
  await sleep(50);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a chat message during the usage limit', () => {
  it('that hits the limit waits, says when it gets its answer, and is answered when the squad carries on', async () => {
    const { bp, id } = chatting();
    answers = [limited("You've hit your session limit · resets 3:40pm (Europe/London)"), replies('Yes: a holiday is a day with no hours.')];
    stops.push(new LiveSquad(bp).start(25));

    await until('the chat answer to start', () => runs.length === 1);
    await until('the pause', () => activePause() !== null);
    const said = `Claude's usage limit is reached. Your message waits and gets its answer ${resetWords(RESET)}`;
    await until('the chat to say it waits', () => readTicket(bp, id)!.chat!.messages.at(-1)?.text === said);
    const c = readTicket(bp, id)!.chat!;
    expect(c.messages.at(-1)).toMatchObject({ who: 'squad', note: 'waits' });
    // Still answering, never "Could not answer".
    expect(c.thinking).toBe(true);
    expect(c.messages.some((m) => m.note === 'failed')).toBe(false);

    // Nothing is asked again while the limit lasts, and the line is said once.
    await sleep(300);
    expect(runs).toHaveLength(1);
    expect(readTicket(bp, id)!.chat!.messages.filter((m) => m.note === 'waits')).toHaveLength(1);

    // Past the reset: the squad carries on, and the message gets its answer by itself.
    vi.setSystemTime(Date.parse('2026-11-03T15:41:00Z'));
    await until('the answer after the reset', () => readTicket(bp, id)!.chat!.thinking === false);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('Can owners close on holidays?');
    const after = readTicket(bp, id)!.chat!;
    expect(after.messages.at(-1)).toMatchObject({ who: 'analyst', text: 'Yes: a holiday is a day with no hours.' });
    expect(after.messages.map((m) => m.who)).toEqual(['you', 'squad', 'analyst']);
  }, 30_000);

  it('sent while the squad already waits is not run at all until the reset, and Stop still works', async () => {
    startPause({ name: 'Claude', resetsAt: RESET }, {}, NOON);
    const { bp, id } = chatting();
    stops.push(new LiveSquad(bp).start(25));
    await until('the chat to say it waits', () => readTicket(bp, id)!.chat!.messages.at(-1)?.note === 'waits');
    expect(readTicket(bp, id)!.chat!.messages.at(-1)!.text).toBe(chatWaitText(activePause()!, true));
    await sleep(200);
    expect(runs).toHaveLength(0);

    // The person stops waiting: the chat stays open, with a way on.
    chatStop(bp, id);
    await until('the stop', () => readTicket(bp, id)!.chat!.thinking === false);
    expect(readTicket(bp, id)!.chat!.messages.at(-1)).toMatchObject({ who: 'squad', note: 'stopped' });
    expect(runs).toHaveLength(0);
  }, 30_000);

  it('words it with and without a reset time, and for a chat just opened', () => {
    const p = startPause({ name: 'Claude', resetsAt: RESET }, {}, NOON);
    expect(chatWaitText(p, true, NOON)).toBe(`Claude's usage limit is reached. Your message waits and gets its answer ${resetWords(RESET, NOON)}`);
    expect(chatWaitText(p, false, NOON)).toBe(`Claude's usage limit is reached. The chat waits and the answer comes ${resetWords(RESET, NOON)}`);
    endPause();
    const q = startPause({ name: 'Claude' }, {}, NOON);
    expect(chatWaitText(q, true, NOON)).toBe("Claude's usage limit is reached. Your message waits and gets its answer once the limit resets");
  });
});

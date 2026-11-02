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
    return { ok: true, structured: answers.shift() ?? { summary: 'done' }, text: '', sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const actions = await import('../src/board/actions.js');
const { tick } = await import('../src/board/engine.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
type Squad = { step(id: string, phase: string): Promise<void>; chatReply(id: string): Promise<void>; stopped(id: string, phase?: string): void };
const live = () => writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct' });

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-chat-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('talk it through with the Analyst first', () => {
  it('opens a chat instead of questions, keeps one session, and writes the spec only when you say so', async () => {
    live();
    let t = actions.createTicket(bp, { title: 'Limit bookings', ask: 'One person blocks the day.', talkFirst: true });
    expect(t.waiting?.kind).toBe('chat');
    expect(t.squad).toBeNull();
    expect(t.chat).toMatchObject({ with: 'analyst', open: true, thinking: true, before: { phase: 'analyst-read' } });
    const squad = new LiveSquad(bp) as unknown as Squad;

    answers.push({ reply: 'I understand one person books too much. Who is the person: a name or an ID?', ready: false });
    await squad.chatReply(t.id);
    let call = calls.at(-1)!;
    expect(call.prompt).toContain('Open the talk');
    expect(call.prompt).toContain('Limit bookings');
    expect(call.schema).toBe(P.CHAT_SCHEMA);
    expect(call.sessionId).toBeTruthy();
    const session = readTicket(bp, t.id)!.sessions!.intake!;
    expect(session).toBe(call.sessionId);
    t = readTicket(bp, t.id)!;
    expect(t.chat!.messages.at(-1)).toMatchObject({ who: 'analyst', text: expect.stringContaining('a name or an ID') });
    expect(t.chat!.thinking).toBe(false);

    // Your message, with a screenshot: same session, and the agent is told where the file is.
    t = actions.sendChat(bp, t.id, 'By national ID. See the screen.', [{ name: 'screen.png', data: Buffer.from('png').toString('base64') }]);
    expect(t.chat!.messages.at(-1)!.files![0]).toMatch(/tickets\/.+\/files\/screen\.png$/);
    expect(() => actions.sendChat(bp, t.id, 'again')).toThrow(/still answering/);
    answers.push({ reply: 'Clear: 3 a day per national ID. I understand enough to write the spec.', ready: true });
    await squad.chatReply(t.id);
    call = calls.at(-1)!;
    expect(call.resume).toBe(session);
    expect(call.prompt).toContain('The person says: "By national ID. See the screen."');
    expect(call.prompt).toContain('The person attached: ');
    expect(call.prompt).toContain('Do not write or change any files');
    expect(readTicket(bp, t.id)!.chat!.ready).toBe(true);

    t = actions.chatWrite(bp, t.id);
    expect(t.squad?.phase).toBe('chat-spec');
    expect(t.chat!.open).toBe(false);
    answers.push({ story: 'As a receptionist, I want at most 3 bookings a day per national ID.', criteria: [{ given: 'an ID with 3 bookings', when: 'it books again', then: 'it is refused' }], releaseNote: '**Limit.**' });
    await squad.step(t.id, 'chat-spec');
    call = calls.at(-1)!;
    expect(call.resume).toBe(session);
    expect(call.prompt).toContain('You and the person talked it through in this conversation. Now write the spec');
    t = readTicket(bp, t.id)!;
    expect(t.waiting?.kind).toBe('spec');
    expect(t.story).toContain('national ID');
    expect(t.activity[0]!.text).toBe('Wrote the spec from your talk');
  });

  it('Done without writing goes back to the normal questions, in the same session', async () => {
    live();
    let t = actions.createTicket(bp, { title: 'Limit bookings', talkFirst: true });
    const squad = new LiveSquad(bp) as unknown as Squad;
    answers.push({ reply: 'Hello', ready: false });
    await squad.chatReply(t.id);
    const session = readTicket(bp, t.id)!.sessions!.intake;
    t = actions.chatDone(bp, t.id);
    expect(t.squad?.phase).toBe('analyst-read');
    expect(t.waiting).toBeNull();
    answers.push({ summary: 'Ok', questions: [] });
    await squad.step(t.id, 'analyst-read').catch(() => undefined);
    expect(calls.at(-1)!.resume).toBe(session);
  });
});

describe('talk to an agent at work', () => {
  const building = () => {
    const t0 = actions.createTicket(bp, { title: 'Limit bookings' });
    return updateTicket(bp, t0.id, (x) => {
      x.stage = 'implement';
      x.live = true;
      x.squad = { phase: 'build', nextAt: new Date().toISOString() };
      x.worktree = tmp;
      x.sessions = { build: 'b-1' };
      x.steps = [{ title: 'Add the limit', status: 'doing' }];
    });
  };

  it('asking the Builder while it builds changes nothing: it answers in a side conversation', async () => {
    live();
    const t0 = building();
    expect(() => actions.startChat(bp, t0.id, 'reviewer')).toThrow(/has not worked on/);
    let t = actions.startChat(bp, t0.id, 'builder');
    expect(t.stopRequested).toBeUndefined();
    expect(t.waiting).toBeNull();
    expect(t.live).toBe(true);
    expect(t.squad?.phase).toBe('build');
    expect(t.chat).toMatchObject({ with: 'builder', open: true, beside: true });
    const squad = new LiveSquad(bp) as unknown as Squad;

    answers.push({ reply: 'I am on step 1, adding the limit.', ready: true });
    await squad.chatReply(t0.id);
    let call = calls.at(-1)!;
    // Never the session that is building: a side one, in the ticket's copy, read only.
    expect(call.resume).toBeUndefined();
    expect(call.sessionId).toBeTruthy();
    expect(call.sessionId).not.toBe('b-1');
    expect(call.cwd).toBe(tmp);
    expect(call.prompt).toContain('The squad is working on this ticket right now');
    expect(call.prompt).toContain('This talk is beside the work');
    t = readTicket(bp, t0.id)!;
    expect(t.chat!.side).toBe(call.sessionId);
    expect(t.chat!.ready).toBe(false);
    expect(t.squad?.phase).toBe('build');
    expect(t.live).toBe(true);

    actions.sendChat(bp, t0.id, 'Do cancelled bookings count?');
    answers.push({ reply: 'No, the plan counts only active ones.', ready: false });
    await squad.chatReply(t0.id);
    call = calls.at(-1)!;
    expect(call.resume).toBe(t.chat!.side);
    // Changes go through the spec, not through this talk.
    expect(() => actions.chatWrite(bp, t0.id)).toThrow(/propose a change/);

    t = actions.chatDone(bp, t0.id);
    expect(t.chat!.open).toBe(false);
    expect(t.squad?.phase).toBe('build');
    expect(t.live).toBe(true);
    expect(t.waiting).toBeNull();
  });

  it('talking to the Builder on a ticket that waits for you keeps it yours, and Done carries on in its session', async () => {
    live();
    const t0 = building();
    updateTicket(bp, t0.id, (x) => {
      x.live = false;
      x.squad = null;
      x.waiting = { kind: 'stuck', summary: 'The squad stopped and needs you' };
    });
    let t = actions.startChat(bp, t0.id, 'builder');
    expect(t.chat!.beside).toBeUndefined();
    expect(t.waiting?.kind).toBe('chat');
    expect(t.chat!.before.waiting?.kind).toBe('stuck');
    const squad = new LiveSquad(bp) as unknown as Squad;

    answers.push({ reply: 'The tests failed on the limit. Should cancelled bookings count?', ready: false });
    await squad.chatReply(t0.id);
    expect(calls.at(-1)!.resume).toBe('b-1');
    expect(calls.at(-1)!.cwd).toBe(tmp);
    actions.sendChat(bp, t0.id, 'No, cancelled ones do not count');
    answers.push({ reply: 'Understood.', ready: true });
    await squad.chatReply(t0.id);
    expect(() => actions.chatWrite(bp, t0.id)).toThrow(/does not write the spec/);

    t = actions.chatDone(bp, t0.id);
    expect(t.squad?.phase).toBe('chat-carry-builder');
    answers.push({ summary: 'Done' });
    await squad.step(t0.id, 'chat-carry-builder');
    const call = calls.at(-1)!;
    expect(call.resume).toBe('b-1');
    expect(call.prompt).toContain('they pressed Done. Carry on with the work as you agreed');
    t = readTicket(bp, t0.id)!;
    expect(t.squad?.phase).toBe('test');
    expect(t.gates).toEqual({ checks: 'pending', review: 'pending', proof: 'pending' });
  });
});

describe('on the demo board', () => {
  it('the agent answers, and the spec gets what you said', async () => {
    let t = actions.createTicket(bp, { title: 'Dark mode', ask: 'Night staff want it', talkFirst: true });
    const later = () => updateTicket(bp, t.id, (x) => x.chat!.messages.forEach((m) => (m.at = new Date(Date.now() - 60_000).toISOString())));
    updateTicket(bp, t.id, (x) => (x.activity[0]!.at = new Date(Date.now() - 60_000).toISOString()));
    tick(bp);
    t = readTicket(bp, t.id)!;
    expect(t.chat!.messages[0]!.text).toContain('I read "Dark mode"');
    actions.sendChat(bp, t.id, 'Staff on night shift only');
    later();
    tick(bp);
    actions.sendChat(bp, t.id, 'It must follow the person to any computer');
    later();
    tick(bp);
    expect(readTicket(bp, t.id)!.chat!.ready).toBe(true);
    actions.chatWrite(bp, t.id);
    updateTicket(bp, t.id, (x) => (x.squad!.nextAt = new Date(0).toISOString()));
    tick(bp);
    t = readTicket(bp, t.id)!;
    expect(t.waiting?.kind).toBe('spec');
    expect(t.criteria!.at(-1)!.then).toBe('It must follow the person to any computer');
  });
});

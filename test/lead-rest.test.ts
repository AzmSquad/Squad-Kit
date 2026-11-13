import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { goodAnswer, leadBoard } from './support/lead.js';

/**
 * "Needs you", "The squad now", the check-ins and the morning brief come from the board's own data with no AI call;
 * the REST API and the terminal do what the engine does. The agent is a fake, and counts its runs.
 */

const calls: RunOptions[] = [];
let structured: unknown = goodAnswer();
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, sessionId: 's1', text: '', structured, usage: { costUsd: 0.05 } };
  },
}));

const { readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { addToMonth } = await import('../src/board/usage.js');
const { mountLeadApi } = await import('../src/console/api/lead.js');
const { buildPaths } = await import('../src/core/paths.js');
const { checkIn, needsYou, squadNow } = await import('../src/engine/lead/needs-you.js');
const { morningBrief } = await import('../src/engine/lead/brief.js');
const { BY_ITSELF_LINE, moreTimeByItself } = await import('../src/engine/lead/by-itself.js');
const { NEVER } = await import('../src/engine/lead/can.js');
const { saveLeadRules } = await import('../src/engine/lead/store.js');
const { liveNow } = await import('../src/board/now.js');
const { readUsual } = await import('../src/board/usual.js');
const { closeOwnDoor } = await import('../src/engine/window-server.js');

let tmp: string;
let bp: Awaited<ReturnType<typeof leadBoard>>['bp'];

beforeEach(async () => {
  calls.length = 0;
  structured = goodAnswer();
  ({ tmp, bp } = await leadBoard('squad-lead-rest-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterAll(() => closeOwnDoor());

describe('Needs you and The squad now', () => {
  it("say what needs the person with the lead's check-in words, with no AI call", () => {
    const items = needsYou(bp);
    const by = (id: string) => items.find((x) => x.story === id)!;
    expect(by('SK-139')).toMatchObject({ kind: 'proof', words: 'SK-139 is ready for your check: 4 pictures, checks pass, Reviewer approved.', more: '2 "done when", all with pictures', open: '/tickets/SK-139/proof' });
    expect(by('SK-142').words).toBe('SK-142 is ready for your check: 1 picture, not checked: the project has no tests, Reviewer approved.');
    expect(by('SK-148')).toMatchObject({ kind: 'questions', words: 'The Analyst has 4 questions on SK-148.', open: '/board?ticket=SK-148' });
    expect(by('SK-144')).toMatchObject({ kind: 'stuck', words: 'SK-144 stopped: The tests were made weaker', cards: [expect.objectContaining({ id: 'now.SK-144.try_again', action: 'try_again' })] });
    expect(by('SK-155').cards[0]).toMatchObject({ id: 'now.SK-155.pictures_again', allowAlways: true });
    expect(by('SK-152').words).toBe('SK-152 needs SK-146, which is not merged yet');
    expect(calls).toHaveLength(0);
  });

  it('a slow step asks for more time, low risk, and says when Always allow gives it by itself', () => {
    updateTicket(bp, 'SK-145', (t) => (t.quiet = { since: new Date().toISOString(), kind: 'long', detail: 'Still reading' }));
    const t = readTicket(bp, 'SK-145')!;
    expect(checkIn(t, liveNow(t, readUsual(bp)))).toMatchObject({ kind: 'slow', words: 'Give SK-145 10 more minutes?', lowRisk: true, more: expect.stringMatching(/Low risk\.$/) });
    const item = needsYou(bp).find((x) => x.story === 'SK-145')!;
    expect(item.cards).toEqual([expect.objectContaining({ id: 'now.SK-145.more_time', label: 'Give it 10 more minutes', allowAlways: true })]);
    expect(item.cards[0]!.byItself).toBeUndefined();
    saveLeadRules(bp, { always: ['more_time'] });
    expect(needsYou(bp).find((x) => x.story === 'SK-145')!.cards[0]!.byItself).toBe('Always allow is on: squad-kit gives it more time by itself.');
  });

  it('gives a slow step more time by itself only with Always allow on, and the line says who did it', () => {
    expect(moreTimeByItself(bp, 'SK-145')).toBe(false);
    expect(readTicket(bp, 'SK-145')!.quietSnoozedUntil).toBeUndefined();
    saveLeadRules(bp, { always: ['more_time'] });
    expect(moreTimeByItself(bp, 'SK-145')).toBe(true);
    const t = readTicket(bp, 'SK-145')!;
    expect(t.quietSnoozedUntil).toBeDefined();
    expect(t.activity.at(-1)).toMatchObject({ who: 'squad', text: BY_ITSELF_LINE });
    expect(t.activity.some((a) => a.who === 'you' && a.text.startsWith('Gave it'))).toBe(false);
    // The watchdog's slow card calls it: the live squad's own code.
    expect(fs.readFileSync(new URL('../src/engine/live/watch.ts', import.meta.url), 'utf8')).toContain("if (q?.kind === 'long' && t.quiet?.kind !== 'long') moreTimeByItself(this.bp, id);");
  });

  it('lists who works on what now, with how far along', () => {
    const now = squadNow(bp);
    expect(now.map((x) => x.story)).toEqual(['SK-145', 'SK-146', 'SK-151', 'SK-153']);
    for (const x of now) {
      expect(x.who).toBeTruthy();
      expect(x.doing).toBeTruthy();
      if (x.progress !== undefined) expect(x.progress).toBeGreaterThan(0);
    }
  });

  it('the morning brief sums up since yesterday evening from the board alone', () => {
    const before = morningBrief(bp);
    addToMonth(bp, { costUsd: 1.5 });
    updateTicket(bp, 'SK-149', (t) => (t.mergedAt = new Date().toISOString()));
    const b = morningBrief(bp);
    expect(b.merged).toContain('SK-149');
    expect(b.working).toEqual(['SK-145', 'SK-146', 'SK-151', 'SK-153']);
    expect(b.stopped).toEqual(['SK-135', 'SK-144', 'SK-150', 'SK-155']);
    expect(b.headline).toMatch(/SK-149.* merged\. The squad is on SK-145, SK-146, SK-151 and SK-153\. /);
    expect(b.costUsd).toBeCloseTo((before.costUsd ?? 0) + 1.5, 2);
    expect(calls).toHaveLength(0);
  });
});

describe('REST', () => {
  const app = () => {
    const a = new Hono();
    mountLeadApi(a, { paths: buildPaths(tmp) });
    return a;
  };
  const post = (a: Hono, url: string, body: unknown) => a.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('asks, follows the answer, lists the conversations, and presses a card', async () => {
    const a = app();
    structured = goodAnswer({ cards: [{ kind: 'draft_story', title: 'Cancel a booking', ask: 'Customers cancel', doneWhen: [{ text: 'Cancel shows', proof: 'screen' }] }] });
    const first = (await (await post(a, '/api/v1/lead/conversations', { text: 'Can customers cancel?', context: { from: 'app', path: '/my-bookings' } })).json()) as { id: string; thinking?: boolean };
    let c: { thinking?: boolean; turns: { answer?: { cards: { id: string }[] } }[] } = { thinking: true, turns: [] };
    await vi.waitFor(async () => {
      c = (await (await a.request(`/api/v1/lead/conversations/${first.id}`)).json()) as typeof c;
      expect(c.thinking).toBe(false);
    });
    const card = c.turns[0]!.answer!.cards[0]!;
    const run = (await (await post(a, `/api/v1/lead/cards/${card.id}/run`, {})).json()) as { card: { status: string; story: string } };
    expect(run.card.status).toBe('done');
    expect(readTicket(bp, run.card.story)!.waitsToStart).toBe(true);
    const follow = (await (await post(a, `/api/v1/lead/conversations/${first.id}/messages`, { text: 'Merge it' })).json()) as { turns: { answer: { headline: string } }[] };
    expect(follow.turns[1]!.answer.headline).toBe(NEVER.git.refusal);
    const view = (await (await a.request('/api/v1/lead')).json()) as { conversations: { id: string; story?: string; turns: number }[]; needsYou: unknown[]; squadNow: unknown[]; today: { limitUsd: number } };
    expect(view.conversations[0]).toMatchObject({ id: first.id, story: run.card.story, turns: 2 });
    expect(view.needsYou.length).toBeGreaterThan(0);
    expect(view.squadNow).toHaveLength(4);
    expect(view.today.limitUsd).toBe(10);
    expect(((await (await a.request('/api/v1/lead/needs-you')).json()) as { items: unknown[] }).items).toEqual(view.needsYou);
    const now = ((await (await a.request('/api/v1/lead/squad-now')).json()) as { items: { story: string }[] }).items;
    expect(now.map((x) => x.story)).toEqual((view.squadNow as { story: string }[]).map((x) => x.story));
  });

  it('keeps Always allow to the low-risk set, the never list read only, and says what the lead can do', async () => {
    const a = app();
    const put = (body: unknown) => a.request('/api/v1/lead/rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ always: ['start_story'] })).status).toBe(400);
    const never = await put({ never: [] });
    expect(never.status).toBe(400);
    expect(((await never.json()) as { error: string }).error).toBe('The list of what the lead never does cannot change.');
    expect(await (await put({ always: ['more_time'], brief: true })).json()).toEqual({ always: ['more_time'], brief: true });
    const rules = (await (await a.request('/api/v1/lead/rules')).json()) as { always: string[]; allowable: { id: string }[]; never: { id: string; refusal: string }[]; limits: { questionUsd: number; dayUsd: number } };
    expect(rules.always).toEqual(['more_time']);
    expect(rules.allowable.map((x) => x.id)).toEqual(['more_time', 'pictures_again', 'start_app', 'morning_brief']);
    expect(rules.never.map((x) => x.refusal)).toEqual(Object.values(NEVER).map((n) => n.refusal));
    expect(rules.limits).toMatchObject({ questionUsd: 3, dayUsd: 10 });
    const can = (await (await a.request('/api/v1/lead/can')).json()) as { levels: { name: string }[]; reads: string[]; looks: string[] };
    expect(can.levels.map((l) => l.name)).toEqual(['On its own', 'After your OK', 'Never']);
    expect(can.reads).toContain('read_story');
    expect(can.looks).toEqual(['take_screenshots', 'look_at_page', 'ask_api']);
    // The brief is on now: the lead's page shows it.
    expect(((await (await a.request('/api/v1/lead')).json()) as { brief?: { headline: string } }).brief?.headline).toBeTruthy();
    expect((await post(a, '/api/v1/lead/conversations', { text: '  ' })).status).toBe(400);
    expect((await a.request('/api/v1/lead/conversations/nope')).status).toBe(400);
  });
});

describe('the terminal', () => {
  async function inProject<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
    const prev = process.cwd();
    process.chdir(tmp);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (lines.push(String(s)), true));
    try {
      const result = await fn();
      return { out: lines.join('').replace(/\u001b\[[0-9;]*m/g, ''), result };
    } finally {
      spy.mockRestore();
      process.chdir(prev);
    }
  }

  it('squad ask prints the work, the answer and the cards with their commands; squad lead lists; squad lead run presses', async () => {
    const { runLead, runLeadAsk, runLeadCard, runLeadRules } = await import('../src/commands/lead.js');
    structured = goodAnswer({ headline: 'There is no sign-in.', body: 'People pick who they are.', sources: [{ kind: 'story', ref: 'SK-145' }], cards: [{ kind: 'board_action', action: 'more_time', story: 'SK-145' }] });
    const asked = await inProject(() => runLeadAsk(['How', 'do', 'I', 'sign', 'in?'], { page: '/login' }));
    expect(calls[0]!.prompt).toContain('on the page /login');
    expect(asked.out).toContain('There is no sign-in.');
    expect(asked.out).toContain('Sources: SK-145 (Faster login)');
    const id = /squad lead run (\S+)/.exec(asked.out)![1]!;
    expect(asked.out).toContain(`squad lead run ${id} --always`);
    expect(asked.out).toMatch(/Follow up: squad ask --in \d{8}-[a-f0-9]{6}/);

    const listed = await inProject(() => runLead());
    expect(listed.out).toContain('Needs you (');
    expect(listed.out).toContain('SK-139 is ready for your check');
    expect(listed.out).toContain('How do I sign in?');

    const ran = await inProject(() => runLeadCard(id));
    expect(ran.out).toContain('Gave SK-145 10 more minutes.');
    expect(readTicket(bp, 'SK-145')!.quietSnoozedUntil).toBeDefined();

    // The old form still answers a status question at once, with no AI.
    const before = calls.length;
    const status = await inProject(() => runLeadAsk(['SK-145', 'when', 'will', 'it', 'be', 'ready?']));
    expect(calls.length).toBe(before);
    expect(status.out).toContain("from the story's live record, no AI");

    const rules = await inProject(() => runLeadRules({ always: 'more_time,start_app', brief: 'on' }));
    expect(rules.out).toContain('Always allow  Give it more time, Start the app');
    expect(readMeta(bp).lead).toEqual({ always: ['more_time', 'start_app'], brief: true });
    await expect(inProject(() => runLeadRules({ always: 'stop_story' }))).rejects.toThrow('always asks you first');
    writeMeta(bp, readMeta(bp));
  });
});

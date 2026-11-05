import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { boardPaths, readMeta, readTicket, updateTicket, writeMeta } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';
import { tick } from '../src/board/engine.js';
import { mountRequirementsApi } from '../src/console/api/requirements.js';
import { buildPaths, chooseProject } from '../src/core/paths.js';
import { setPaymentChoice } from '../src/core/settings.js';
import { allStories, breakdownView, findItem, readBreakdown, readBreakdownState } from '../src/board/requirements.js';
import { SKIP_CHOICE, addBreakdown, approveProblems } from '../src/board/requirements-actions.js';
import { requirementsCommand } from '../src/commands/requirements.js';
import type { BreakdownView } from '../src/board/requirements-types.js';

/**
 * The Requirements page's routes and the terminal commands that match them, on the sample board: BR-1 is the court
 * portal's BRD, ready to approve, and a BRD added there is read, asked about and drafted by the scripted Analyst.
 */

let tmp: string;
let bp: ReturnType<typeof boardPaths>;
let app: Hono;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-brd-api-'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 1000 });
  setPaymentChoice('subscription');
  app = new Hono();
  mountRequirementsApi(app, { paths: buildPaths(tmp) });
});

afterEach(() => {
  setPaymentChoice('auto');
  chooseProject(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: string, url: string, body?: unknown) => {
  const r = await app.request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

/** Plays the scripted Analyst until `done` holds. */
async function play(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) {
    tick(bp);
    await new Promise((r) => setTimeout(r, 3));
  }
  expect(done()).toBe(true);
}

describe('the sample board', () => {
  it("starts with the court portal's BRD broken down and ready to approve", () => {
    const b = readBreakdown(bp, 'BR-1')!;
    expect(b).toMatchObject({ title: 'Case Portal BRD v1', status: 'ready', source: { kind: 'docx', name: 'Case Portal BRD v1.docx' } });
    expect(b.epics).toHaveLength(3);
    expect(b.epics.reduce((n, e) => n + e.features.length, 0)).toBe(7);
    const stories = allStories(b);
    expect(stories).toHaveLength(20);
    expect(stories.filter((s) => /refund/i.test(s.story.title)).map((s) => s.story.title)).toEqual(['Refund the fee when a hearing is cancelled']);
    expect(stories.some((s) => s.story.dependsOn.length)).toBe(true);
    expect(b.decided.length).toBeGreaterThanOrEqual(2);
    expect(b.decided.every((d) => d.item)).toBe(true);
    expect(b.leftOut).toHaveLength(1);
    expect(approveProblems(b)).toEqual([]);
    expect(fs.readFileSync(path.join(tmp, '.squad', 'requirements', 'BR-1', 'text', 'part-01.md'), 'utf8')).toContain('## 4.4 Refunds');
    const v = breakdownView(bp, 'BR-1', 'subscription');
    expect(v.estimate).toMatchObject({ stories: 20, rough: false });
    expect(v.estimate.basedOn).toBeGreaterThan(0);
  });

  it('reads an added BRD with progress, asks one gap and one clash, then drafts after the answers', async () => {
    const b = addBreakdown(bp, { text: '# Case Portal BRD v2\n\nLawyers book hearings.' });
    const seen = new Set<string>();
    await play(() => {
      const j = readBreakdownState(bp, b.id).job;
      if (j?.found?.epics) seen.add(`${j.found.epics}/${j.found.features}`);
      return readBreakdown(bp, b.id)!.status === 'questions';
    });
    expect([...seen]).toEqual(['1/2', '2/5', '3/7']);
    const asked = readBreakdown(bp, b.id)!;
    expect(asked.questions.map((q) => q.kind)).toEqual(['clash', 'gap']);
    expect(asked.questions[0]!.refs?.length).toBe(2);

    let r = await call('POST', `/api/v1/requirements/${b.id}/questions/q1/ask`, { text: 'What changes?' });
    expect(r.status).toBe(200);
    await play(() => !readBreakdown(bp, b.id)!.questions[0]!.thinking);

    r = await call('POST', `/api/v1/requirements/${b.id}/answers`, { answers: { q1: { choice: 'Keep the fee within 48 hours (6.3)' }, q2: { choice: SKIP_CHOICE } } });
    expect((r.json as unknown as BreakdownView).status).toBe('drafting');
    const counts = new Set<number>();
    await play(() => {
      counts.add(allStories(readBreakdown(bp, b.id)!).length);
      return readBreakdown(bp, b.id)!.status === 'ready';
    });
    expect([...counts]).toEqual([0, 8, 13, 20]);
    const done = readBreakdown(bp, b.id)!;
    expect(done.decided.find((d) => d.by === 'answer')).toMatchObject({ item: 'S-12', text: expect.stringContaining('48 hours') });
    // The skipped question: the Analyst decided it, and wrote it down.
    expect(done.decided.find((d) => d.text === 'Fees are paid online only, by card.')).toMatchObject({ by: 'analyst', item: 'S-10' });
    expect(approveProblems(done)).toEqual([]);
  });
});

describe('the routes', () => {
  it('lists, shows, renames and adds breakdowns', async () => {
    let r = await call('GET', '/api/v1/requirements');
    expect(r.json.breakdowns).toEqual([expect.objectContaining({ id: 'BR-1', status: 'ready', counts: expect.objectContaining({ epics: 3, features: 7, stories: 20 }) })]);
    r = await call('GET', '/api/v1/requirements/BR-1');
    const v = r.json as unknown as BreakdownView;
    expect(v).toMatchObject({ id: 'BR-1', mine: true, counts: { stories: 20, merged: 0 }, estimate: { payment: 'subscription', parallel: expect.any(Number) } });
    expect(v.progress).toHaveLength(20);
    expect((await call('GET', '/api/v1/requirements/BR-9')).status).toBe(404);
    r = await call('PATCH', '/api/v1/requirements/BR-1', { title: 'Court portal' });
    expect(r.json.title).toBe('Court portal');
    r = await call('POST', '/api/v1/requirements', { file: { name: 'Fees BRD.md', data: Buffer.from('# Fees\n\nPay by card.').toString('base64') }, with: [{ name: 'pay.png', data: Buffer.from('png').toString('base64') }] });
    expect(r.json).toMatchObject({ id: 'BR-2', title: 'Fees BRD', status: 'reading', source: { extra: ['source/pay.png'] }, state: { job: { step: 'read', status: 'pending' } } });
    r = await call('POST', '/api/v1/requirements', { file: { name: 'broken.docx', data: 'AAAA' } });
    expect(r).toEqual({ status: 400, json: { error: 'squad-kit cannot open this Word file. Save it again as .docx, or paste the text.' } });
    r = await call('POST', '/api/v1/requirements', { files: [{ name: 'Rooms.txt', data: Buffer.from('Rooms and slots.').toString('base64') }, { name: 'a.png', data: 'AA==' }] });
    expect(r.json).toMatchObject({ id: 'BR-3', title: 'Rooms', source: { kind: 'text', extra: ['source/a.png'] } });
    r = await call('POST', '/api/v1/requirements', { text: '# Pasted BRD\n\nText.', name: 'Pasted' });
    expect(r.json).toMatchObject({ id: 'BR-4', title: 'Pasted', source: { kind: 'pasted', file: 'source/pasted.md' } });
    const file = await app.request('/api/v1/requirements/BR-2/file?path=source/pay.png');
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect((await app.request('/api/v1/requirements/BR-2/file?path=../../config.yaml')).status).toBe(404);
  });

  it('edits, adds, moves, removes and redoes parts', async () => {
    let r = await call('PATCH', '/api/v1/requirements/BR-1/items/S-3', { title: 'Hold a slot for 15 minutes', size: 'L', criteria: [{ given: 'a free slot', when: 'I pick it', then: 'it is held for 15 minutes' }] });
    expect(findItem(r.json as unknown as BreakdownView, 'S-3')!.story).toMatchObject({ title: 'Hold a slot for 15 minutes', size: 'L' });
    r = await call('PATCH', '/api/v1/requirements/BR-1/items/S-1', { needs: ['S-20'] });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/^That makes a loop/);
    r = await call('POST', '/api/v1/requirements/BR-1/items', { under: 'F-2', title: 'Book for a client', story: 'As a lawyer, I want to book for a client, so that they need not come.', criteria: [{ given: 'a client', when: 'I book', then: 'the client gets the hearing' }], needs: ['S-3'] });
    expect(r.json.key).toBe('S-21');
    expect(findItem(r.json.breakdown as BreakdownView, 'S-21')!.story!.dependsOn).toEqual(['S-3']);
    r = await call('POST', '/api/v1/requirements/BR-1/items/S-21/move', { under: 'F-1', before: 'S-1' });
    expect((r.json as unknown as BreakdownView).epics[0]!.features[0]!.stories[0]!.key).toBe('S-21');
    r = await call('DELETE', '/api/v1/requirements/BR-1/items/S-21');
    expect(findItem(r.json as unknown as BreakdownView, 'S-21')).toBeNull();
    r = await call('POST', '/api/v1/requirements/BR-1/items/E-2/redo', { ask: 'Split refunds into their own feature' });
    expect((r.json as unknown as BreakdownView).state.job).toMatchObject({ step: 'redo', status: 'pending', item: 'E-2' });
    await play(() => readBreakdownState(bp, 'BR-1').job?.status === 'done');
    expect(readBreakdown(bp, 'BR-1')!.epics[1]!.goal).toBe('Split refunds into their own feature');
  });

  it('approves, starts a story, changes a decision and refuses to delete while a story builds', async () => {
    let r = await call('POST', '/api/v1/requirements/BR-1/items/S-1/start');
    expect(r.json.error).toBe('Approve BR-1 first. Nothing is built before the breakdown is approved.');
    r = await call('POST', '/api/v1/requirements/BR-1/approve');
    expect(r.json).toMatchObject({ status: 'approved', approved: { by: readMeta(bp).user.name } });
    r = await call('POST', '/api/v1/requirements/BR-1/items/S-2/start');
    expect(r.json.error).toBe('S-2 starts after S-1 merges.');
    r = await call('POST', '/api/v1/requirements/BR-1/items/S-1/start');
    const ticket = r.json.ticket as { id: string; track: string; breakdown: { id: string; item: string } };
    expect(ticket).toMatchObject({ track: 'auto', breakdown: { id: 'BR-1', item: 'S-1' } });
    expect((r.json.breakdown as BreakdownView).progress[0]).toMatchObject({ key: 'S-1', ticket: ticket.id });
    const d = readBreakdown(bp, 'BR-1')!.decided.find((x) => x.item === 'S-3')!;
    r = await call('POST', `/api/v1/requirements/BR-1/decided/${d.id}`, { text: 'Warn a minute before the hold ends' });
    expect((r.json as unknown as BreakdownView).state.job).toMatchObject({ step: 'redo', item: 'S-3' });
    r = await call('DELETE', '/api/v1/requirements/BR-1');
    expect(r.json.error).toContain(`S-1 as ${ticket.id}`);
    updateTicket(bp, ticket.id, (t) => (t.mergedAt = new Date().toISOString()));
    await play(() => readBreakdownState(bp, 'BR-1').job?.status === 'done');
    r = await call('DELETE', '/api/v1/requirements/BR-1');
    expect(r.json).toEqual({ ok: true, id: 'BR-1' });
    expect(readTicket(bp, ticket.id)).toBeTruthy();
  });

  it('stops and retries the read, and skips the questions', async () => {
    const b = addBreakdown(bp, { text: '# BRD' });
    let r = await call('POST', `/api/v1/requirements/${b.id}/stop`);
    expect(r.json).toMatchObject({ status: 'failed' });
    r = await call('POST', `/api/v1/requirements/${b.id}/retry`);
    expect(r.json).toMatchObject({ status: 'reading', state: { job: { status: 'pending' } } });
    await play(() => readBreakdown(bp, b.id)!.status === 'questions');
    r = await call('POST', `/api/v1/requirements/${b.id}/skip`);
    expect(r.json).toMatchObject({ status: 'drafting' });
    await play(() => readBreakdown(bp, b.id)!.status === 'ready');
    expect(readBreakdown(bp, b.id)!.decided.filter((x) => x.by === 'answer')).toEqual([]);
  });
});

describe('the terminal', () => {
  async function squad(...args: string[]): Promise<string> {
    let text = '';
    const quiet = [
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
        text += String(s);
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
        text += String(s);
        return true;
      }),
      vi.spyOn(console, 'log').mockImplementation((...s) => {
        text += `${s.join(' ')}\n`;
      }),
    ];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await requirementsCommand().exitOverride().parseAsync(args, { from: 'user' });
    } catch (err) {
      text += `\n${(err as Error).message}`;
    } finally {
      for (const q of quiet) q.mockRestore();
      exit.mockRestore();
    }
    return text.replace(/\u001b\[[0-9;]*m/g, '');
  }

  it('does what the page does, one command per button', async () => {
    chooseProject(tmp);
    expect(await squad('list')).toContain('BR-1  Case Portal BRD v1  Ready for you to approve');
    const shown = await squad('show', 'br-1');
    expect(shown).toContain('From Case Portal BRD v1.docx');
    expect(shown).toContain('3 epics, 7 features, 20 stories');
    expect(shown).toMatch(/About .* to build 20 stories, \d at a time \(based on \d+ finished tickets?\)/);
    expect(shown).toContain('Epic E-1  Book a hearing');
    expect(shown).toContain('S-12  Refund the fee when a hearing is cancelled  M needs S-10, S-5 From 4.4');
    expect(shown).toContain('Decided for you');
    const map = await squad('show', 'BR-1', '--map');
    expect(map).toContain('└─ S-20  Audit log of hearing changes needs S-5  ○ Not started');

    expect(await squad('edit', 'BR-1', 'S-2', '--size', 'L', '--criterion', 'Given a court | When I open the calendar | Then I see the free days')).toContain('Saved S-2 in BR-1.');
    expect(findItem(readBreakdown(bp, 'BR-1')!, 'S-2')!.story).toMatchObject({ size: 'L', criteria: [{ given: 'a court', when: 'I open the calendar', then: 'I see the free days' }] });
    expect(await squad('edit', 'BR-1', 'S-2', '--no-needs')).toContain('Saved S-2');
    expect(findItem(readBreakdown(bp, 'BR-1')!, 'S-2')!.story!.dependsOn).toEqual([]);
    expect(await squad('add-item', 'BR-1', '--under', 'E-3', '--feature', '--title', 'Exports')).toContain('Added F-8 to BR-1.');
    expect(await squad('move', 'BR-1', 'S-19', '--under', 'F-8')).toContain('Moved S-19 in BR-1.');
    expect(await squad('remove', 'BR-1', 'S-19')).toContain('Removed S-19 from BR-1.');
    expect(await squad('rename', 'BR-1', 'Court', 'portal')).toContain('BR-1 is now called Court portal.');
    expect(await squad('edit', 'BR-1', 'S-2', '--size', 'XL')).toContain('A size is S, M or L.');
    expect(await squad('approve', 'BR-1')).toContain('BR-1 is approved.');
    expect(await squad('start', 'BR-1', 'S-1')).toMatch(/S-1 started as [A-Z]+-\d+: Search free hearing slots/);
    expect(await squad('redo', 'BR-1', 'S-4', 'Confirm', 'by', 'email', 'too')).toContain('The Analyst is redoing S-4.');
    expect(await squad('decided', 'BR-1', 'd1', 'Warn first')).toContain('The Analyst is redoing S-4');
  });

  it('adds a BRD, answers with --skip, and stops and retries the Analyst', async () => {
    chooseProject(tmp);
    const doc = path.join(tmp, 'Fees BRD.md');
    fs.writeFileSync(doc, '# Fees\n\nPay by card.');
    expect(await squad('add', doc, '--name', 'Fees')).toContain('BR-2 added: Fees. The Analyst is reading it.');
    expect(await squad('stop', 'BR-2')).toContain('Stopping the Analyst on BR-2.');
    expect(await squad('retry', 'BR-2')).toContain('The Analyst carries on with BR-2.');
    await play(() => readBreakdown(bp, 'BR-2')!.status === 'questions');
    expect(await squad('show', 'BR-2')).toContain('Two parts clash');
    expect(await squad('answer', 'BR-2', '--skip')).toContain('The Analyst decides the open questions of BR-2 itself');
    await play(() => readBreakdown(bp, 'BR-2')!.status === 'ready');
    expect(await squad('delete', 'BR-2', '--yes')).toContain('Deleted BR-2.');
    expect(readBreakdown(bp, 'BR-2')).toBeNull();
  });

  it('asks about a question and prints the answer', async () => {
    chooseProject(tmp);
    addBreakdown(bp, { text: '# Fees' });
    await play(() => readBreakdown(bp, 'BR-2')!.status === 'questions');
    // The terminal plays the scripted Analyst itself while it waits.
    writeMeta(bp, { ...readMeta(bp), speed: 1000 });
    expect(await squad('ask', 'BR-2', 'q2', 'Who', 'takes', 'the', 'money?')).toContain('Analyst: The BRD only names paying by card.');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { Hono } from 'hono';
import { mountBacklogApi } from '../src/console/api/backlog.js';
import { mountBuildSendApi } from '../src/console/api/requirements-build.js';
import { readBreakdown, updateBreakdownState } from '../src/board/requirements.js';
import { epicBoard, type EpicBoard } from './support/epic.js';

/**
 * Build all over REST (ADR-013): the dialog's preview, the run it starts, the run on the Backlog's group row, and Add
 * to the run. The terminal makes the same calls (squad backlog build, squad requirements add-new).
 */

let e: EpicBoard;
let app: Hono;

beforeEach(async () => {
  e = await epicBoard();
  app = new Hono();
  mountBacklogApi(app, e.bp, async () => ({ tracker: e.tracker, user: 'Momen' }));
  mountBuildSendApi(app, e.bp);
});

afterEach(() => {
  fs.rmSync(e.tmp, { recursive: true, force: true });
});

const at = (ref: string) => `/api/v1/backlog/${encodeURIComponent(ref)}/build`;
/** The answer's body, read loosely: each test says what it expects of it. */
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

describe('Build all over REST', () => {
  it('answers the preview, starts the run with { id }, and shows the run on its group in the Backlog', async () => {
    const preview = await json(app.request(`${at('AB#120')}?sprint=${encodeURIComponent('Mawid\\Sprint 14')}`));
    expect(preview).toMatchObject({ root: { ref: 'AB#120', level: 'epic' }, sprint: { name: 'Sprint 14', count: 1 } });
    expect(preview.stories).toHaveLength(4);
    const res = await app.request(at('AB#120'), { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    const { id } = await json(res);
    expect(readBreakdown(e.bp, id)).toMatchObject({ source: { kind: 'tracker', tracker: { ref: 'AB#120' } } });
    const backlog = await json(app.request('/api/v1/backlog?sprint=all'));
    const group = backlog.tree.groups.find((g: { id: string }) => g.id === '120');
    expect(group.run).toEqual({ id, approved: false, on: false, stories: 4, merged: 0, building: 0, needsYou: 0 });
    expect(backlog.tree.groups.find((g: { id: string }) => g.id === '121').run).toBeUndefined();
    // Build all again: the dialog names the run, and pressing it answers that run (the board opens it), never a second.
    expect((await json(app.request(at('AB#120')))).run).toBe(id);
    const again = await app.request(at('AB#120'), { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ id, already: `AB#120 has a run already: ${id}. New stories under it show there with Add to the run.` });
  });

  it('takes onlySprint: only the stories in that sprint join', async () => {
    const res = await app.request(at('120'), { method: 'POST', body: JSON.stringify({ onlySprint: 'Mawid\\Sprint 14' }), headers: { 'content-type': 'application/json' } });
    const { id } = await json(res);
    expect(readBreakdown(e.bp, id)!.epics[0]!.features.flatMap((f) => f.stories.map((s) => s.tracker?.ref))).toEqual(['AB#123']);
  });

  it('Add to the run needs the project tracker, and says so plainly without one', async () => {
    const res = await app.request(at('AB#120'), { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    const { id } = await json(res);
    updateBreakdownState(e.bp, id, (s) => (s.trackerNew = [{ id: '200', ref: 'AB#200', title: 'Pay online' }]));
    const add = await app.request(`/api/v1/requirements/${id}/tracker-new`, { method: 'POST' });
    expect(add.status).toBe(400);
    expect((await json(add)).error).toBe('No tracker is connected. Add it in Settings.');
  });
});

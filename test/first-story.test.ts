import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { Breakdown, BreakdownStory } from '../src/board/requirements-types.js';
import type { BoardPaths } from '../src/board/store.js';
import type { Ticket } from '../src/board/types.js';

/**
 * A project with no code starts with one story squad-kit adds itself, and nothing else takes a step until it merges. Its
 * merge ends "no code yet", and the next read of the code says what runs. Real files and real git; no real AI runs.
 */

const calls: RunOptions[] = [];
let answer: Record<string, unknown> = {};
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: answer, sessionId: opts.resume ?? opts.sessionId } as RunResult;
  },
}));

const { readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { allStories, findItem, readBreakdown, updateBreakdown, writeBreakdown } = await import('../src/board/requirements.js');
const { approveBreakdown, editItem, redoItem, removeItem, startStory } = await import('../src/board/requirements-actions.js');
const { fillBuildQueue, setBuild } = await import('../src/board/requirements-build.js');
const { firstCodeMerged, firstOpenTicket, waitsForFirst, waitsForFirstWords, withFirstStory, withoutFirstStory } = await import('../src/board/first-story.js');
const { createTicket } = await import('../src/board/actions.js');
const { mapAfterMerge } = await import('../src/engine/sync.js');
const { makeNewProject } = await import('../src/engine/new-project.js');
const { overviewView } = await import('../src/board/first-run.js');
const { readOverview, writeOverview } = await import('../src/board/overview.js');
const { productPlan } = await import('../src/engine/product-run.js');
const { LiveSquad } = await import('../src/engine/live.js');
const P = await import('../src/engine/prompts.js');

let tmp: string;
let bp: BoardPaths;

const story = (key: string, needs: string[] = []): BreakdownStory => ({
  key,
  title: `Story ${key}`,
  story: 'As a person, I want it, so that it works.',
  criteria: [{ given: 'a', when: 'b', then: 'c' }],
  size: 'M',
  dependsOn: needs,
});

function breakdown(id = 'BR-1', status: Breakdown['status'] = 'ready', stories = [story('S-1'), story('S-2', ['S-1']), story('S-3')]): Breakdown {
  const b: Breakdown = {
    id,
    title: 'Visitor log',
    status,
    source: { file: 'source/pasted.md', name: 'Pasted text', kind: 'pasted', bytes: 10, addedBy: 'Momen', addedAt: new Date().toISOString() },
    questions: [],
    decided: [],
    leftOut: [],
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    owner: readMeta(bp).user.name,
    next: { epic: 2, feature: 1, story: 4 },
    epics: [{ key: 'E-1', title: 'Signing in', features: [], stories }],
  };
  writeBreakdown(bp, b);
  return b;
}

const ready = (id = 'BR-1', stories?: BreakdownStory[]) => {
  breakdown(id, 'ready', stories);
  return updateBreakdown(bp, id, (x) => withFirstStory(bp, x));
};

const firstOf = (b: Breakdown) => allStories(b).map((p) => p.story).find((s) => s.setsUp)!;
const room = () => ({ free: () => Infinity, pause: null, payment: async () => 'subscription' as const });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-first-story-')));
  bp = makeNewProject({ name: 'Visitor log', where: tmp, idea: 'A visitor log' }).bp;
  const meta = readMeta(bp);
  writeMeta(bp, { ...meta, engine: 'live', runner: 'direct', scan: { status: 'done', empty: true, summary: 'A new project.' } });
  calls.length = 0;
  answer = {};
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the first story in the breakdown', () => {
  it('goes first, in its own epic, and the stories that need nothing need it', () => {
    const b = ready();
    expect(b.epics[0]!.title).toBe('Set up the product');
    expect(b.epics[0]!.goal).toContain('squad-kit added this');
    const first = firstOf(b);
    expect(allStories(b)[0]!.story.key).toBe(first.key);
    expect(first.dependsOn).toEqual([]);
    expect(first.criteria.length).toBeGreaterThan(0);
    expect(first.size).toBe('S');
    expect(findItem(b, 'S-1')!.story!.dependsOn).toEqual([first.key]);
    expect(findItem(b, 'S-3')!.story!.dependsOn).toEqual([first.key]);
    // Already waits, through S-1.
    expect(findItem(b, 'S-2')!.story!.dependsOn).toEqual(['S-1']);
  });

  it('keeps every key unique, and is never added twice', () => {
    const b = ready();
    const again = updateBreakdown(bp, 'BR-1', (x) => withFirstStory(bp, x));
    expect(again.epics.length).toBe(b.epics.length);
    expect(allStories(again).filter((p) => p.story.setsUp)).toHaveLength(1);
    const keys = allStories(again).map((p) => p.story.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(again.epics.map((e) => e.key)).size).toBe(again.epics.length);
  });

  it('never comes on a project with code', () => {
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false } });
    expect(allStories(ready()).some((p) => p.story.setsUp)).toBe(false);
  });

  it('is on one breakdown only, whichever came first', () => {
    ready('BR-1');
    expect(allStories(ready('BR-2')).some((p) => p.story.setsUp)).toBe(false);
  });

  it('comes back after the Analyst rewrites the whole breakdown, and the Analyst is not shown it', () => {
    const b = ready();
    const shown = withoutFirstStory(b);
    expect(allStories(shown).some((p) => p.story.setsUp)).toBe(false);
    expect(shown.epics.map((e) => e.title)).toEqual(['Signing in']);
    expect(findItem(shown, 'S-1')!.story!.dependsOn).toEqual([]);
    // The breakdown itself stays whole.
    expect(firstOf(b)).toBeTruthy();
    const after = updateBreakdown(bp, 'BR-1', (x) => {
      x.epics = [{ key: 'E-9', title: 'New shape', features: [], stories: [story('S-9')] }];
      withFirstStory(bp, x);
    });
    expect(after.epics[0]!.title).toBe('Set up the product');
    expect(findItem(after, 'S-9')!.story!.dependsOn).toEqual([firstOf(after).key]);
  });

  it('stays when the person tries to remove it or have it redone, and its words can change', () => {
    const b = ready();
    const first = firstOf(b);
    expect(() => removeItem(bp, 'BR-1', first.key)).toThrow('so it stays');
    expect(() => removeItem(bp, 'BR-1', b.epics[0]!.key)).toThrow('so it stays');
    expect(() => redoItem(bp, 'BR-1', first.key, 'Make it longer')).toThrow('does not redo it');
    expect(() => redoItem(bp, 'BR-1', b.epics[0]!.key, 'Make it longer')).toThrow('does not redo it');
    const after = editItem(bp, 'BR-1', first.key, { title: 'Our first version' });
    expect(firstOf(after).title).toBe('Our first version');
    expect(firstOf(after).setsUp).toBe(true);
  });

  it('a story the person adds before approving waits for it too', () => {
    const b = ready();
    updateBreakdown(bp, 'BR-1', (x) => x.epics[1]!.stories.push(story('S-8')));
    const approved = approveBreakdown(bp, 'BR-1');
    expect(findItem(approved, 'S-8')!.story!.dependsOn).toEqual([firstOf(b).key]);
  });
});

describe('the queue on a project with no code', () => {
  it('starts only the first story, and the rest once it merges', async () => {
    ready();
    approveBreakdown(bp, 'BR-1');
    setBuild(bp, 'BR-1', true);
    const [turn] = await fillBuildQueue(bp, room());
    expect(turn!.started).toHaveLength(1);
    const first = readTicket(bp, turn!.started[0]!)!;
    expect(first.setsUp).toBe(true);
    expect(first.track).toBe('auto');
    const [held] = await fillBuildQueue(bp, room());
    expect(held!.started).toEqual([]);
    expect(held!.held).toContain('The next stories wait for');
    expect(() => startStory(bp, 'BR-1', 'S-1')).toThrow('merges');

    updateTicket(bp, first.id, (t) => {
      t.mergedAt = new Date().toISOString();
      t.stage = 'release';
      t.squad = null;
    });
    mapAfterMerge(bp);
    const [next] = await fillBuildQueue(bp, room());
    expect(next!.started).toHaveLength(2);
    expect(next!.started.map((id) => readTicket(bp, id)!.setsUp)).toEqual([undefined, undefined]);
  });
});

describe('the first merge', () => {
  it('ends "no code yet", and says the next read must find what runs', () => {
    mapAfterMerge(bp);
    const meta = readMeta(bp);
    expect(meta.scan).toMatchObject({ empty: false, fromNothing: true, summary: 'A new project.' });
    expect(meta.blueprint?.status).toBe('pending');
  });

  it('does nothing on a project that had code', () => {
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false } });
    firstCodeMerged(bp);
    expect(readMeta(bp).scan?.fromNothing).toBeUndefined();
  });

  it('takes away a first story that never started: another ticket brought the first code', () => {
    const b = ready();
    firstCodeMerged(bp);
    const after = readBreakdown(bp, 'BR-1')!;
    expect(allStories(after).some((p) => p.story.setsUp)).toBe(false);
    expect(after.epics.map((e) => e.title)).toEqual(['Signing in']);
    expect(findItem(after, 'S-1')!.story!.dependsOn).toEqual([]);
    expect(findItem(after, 'S-2')!.story!.dependsOn).toEqual(['S-1']);
    expect(b.epics).toHaveLength(2);
  });

  it('keeps a first story that started: its ticket is on the board', () => {
    const b = ready();
    approveBreakdown(bp, 'BR-1');
    startStory(bp, 'BR-1', firstOf(b).key);
    firstCodeMerged(bp);
    expect(firstOf(readBreakdown(bp, 'BR-1')!).ticket).toBeTruthy();
  });
});

describe('tickets that are not from a breakdown', () => {
  const ticket = (title: string, createdAt: string): Ticket => {
    const t = createTicket(bp, { title });
    return updateTicket(bp, t.id, (x) => (x.createdAt = createdAt));
  };

  it('wait for the oldest one still open, and nothing else holds them up', () => {
    const a = ticket('First', '2026-11-01T00:00:00.000Z');
    const b = ticket('Second', '2026-11-02T00:00:00.000Z');
    expect(firstOpenTicket(bp, a)).toBeUndefined();
    expect(firstOpenTicket(bp, b)?.id).toBe(a.id);
    updateTicket(bp, a.id, (x) => (x.archived = { by: 'Momen', at: new Date().toISOString() }));
    expect(firstOpenTicket(bp, b)).toBeUndefined();
    updateTicket(bp, a.id, (x) => {
      x.archived = undefined;
      x.mergedAt = new Date().toISOString();
    });
    expect(firstOpenTicket(bp, b)).toBeUndefined();
  });

  it('say so on the card, and the live squad runs only the first until it merges', async () => {
    const a = ticket('First', '2026-11-01T00:00:00.000Z');
    const b = ticket('Second', '2026-11-02T00:00:00.000Z');
    for (const t of [a, b]) updateTicket(bp, t.id, (x) => (x.squad = { phase: 'analyst-read', nextAt: new Date(0).toISOString() }));
    const squad = new LiveSquad(bp) as unknown as { tick(): void; launch(key: string, run: () => Promise<void>): void; step(id: string, phase: string): Promise<void> };
    const ran: string[] = [];
    squad.launch = (key) => void ran.push(key);
    squad.tick();
    expect(ran.filter((k) => !k.startsWith('__'))).toEqual([a.id]);
    const said = readTicket(bp, b.id)!.status;
    expect(said).toBe(waitsForFirstWords(a.id));
    expect(waitsForFirst(said)).toBe(true);
    expect(said).not.toMatch(/technolog|repo|commit/i);

    ran.length = 0;
    updateTicket(bp, a.id, (x) => {
      x.mergedAt = new Date().toISOString();
      x.squad = null;
    });
    firstCodeMerged(bp);
    squad.tick();
    expect(ran.filter((k) => !k.startsWith('__'))).toEqual([b.id]);
  });

  it('are not held on a project with code', () => {
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false } });
    const a = ticket('First', '2026-11-01T00:00:00.000Z');
    const b = ticket('Second', '2026-11-02T00:00:00.000Z');
    for (const t of [a, b]) updateTicket(bp, t.id, (x) => (x.squad = { phase: 'analyst-read', nextAt: new Date(0).toISOString() }));
    const squad = new LiveSquad(bp) as unknown as { tick(): void; launch(key: string, run: () => Promise<void>): void };
    const ran: string[] = [];
    squad.launch = (key) => void ran.push(key);
    squad.tick();
    expect(ran.filter((k) => !k.startsWith('__')).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('what the Architect is told', () => {
  const t = (more: Partial<Ticket> = {}): Ticket => ({ ...createTicket(bp, { title: 'A story' }), ...more });

  it('the first story sets up one repo with one way to start, and builds no features', () => {
    const words = P.planPrompt(t({ setsUp: true }), undefined, readMeta(bp));
    expect(words).toContain('This story sets up the product');
    expect(words).toContain('build none of its features now');
    expect(words).toContain('All the code stays in this one repo');
    expect(words).toContain('package.json in the top folder');
    expect(words).toContain('README.md');
    expect(words).toContain('picks its technology');
  });

  it('any other story on a project with no code only picks the technology', () => {
    const words = P.planPrompt(t(), undefined, readMeta(bp));
    expect(words).toContain('picks its technology');
    expect(words).not.toContain('This story sets up the product');
  });

  it('a story on a project with code hears neither', () => {
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done', empty: false } });
    const words = P.planPrompt(t(), undefined, readMeta(bp));
    expect(words).not.toContain('picks its technology');
    expect(words).not.toContain('This story sets up the product');
  });

  it('only the first read after the first merge asks what runs', () => {
    expect(P.blueprintPrompt(readMeta(bp), [], [])).not.toContain('- runs:');
    expect(P.blueprintPrompt(readMeta(bp), [], [], true)).toContain('- runs:');
    expect('runs' in P.BLUEPRINT_SCHEMA.properties).toBe(false);
    expect('runs' in P.FIRST_BLUEPRINT_SCHEMA.properties).toBe(true);
    expect(P.scanPrompt(readMeta(bp), [])).toContain('- runs:');
  });
});

describe('the first read after the first merge', () => {
  const read = (squad: unknown) => (squad as { readBlueprint(): Promise<void> }).readBlueprint();
  const runs = [
    { id: 'api', name: 'API', repo: '.', folder: 'api', url: 'http://localhost:4100' },
    { id: 'web', name: 'Web app', repo: '.', folder: 'web', needs: ['api'], url: 'http://localhost:5173' },
    { id: 'db', name: 'Database', shared: true },
  ];

  beforeEach(() => {
    for (const f of ['api', 'web']) fs.mkdirSync(path.join(bp.root, f));
    answer = { map: [{ area: 'Pages', detail: 'In web/' }], stack: [], patterns: [], runs, summary: 'A desk for today\'s visitors.', users: 'Reception staff. There are no accounts.' };
    writeOverview(bp, { ...readOverview(bp), readAt: new Date().toISOString() });
    mapAfterMerge(bp);
  });

  it('saves the parts in their folders, once', async () => {
    await read(new LiveSquad(bp));
    const meta = readMeta(bp);
    expect(meta.parts?.map((p) => [p.id, p.folder])).toEqual([['api', 'api'], ['web', 'web'], ['db', undefined]]);
    expect(meta.parts?.find((p) => p.id === 'web')?.needs).toEqual(['api']);
    expect(meta.scan?.fromNothing).toBeUndefined();
    expect(meta.scan?.summary).toBe("A desk for today's visitors.");
    expect(overviewView(bp).users).toBe('Reception staff. There are no accounts.');
    expect(calls.at(-1)?.prompt).toContain('- runs:');
    await read(new LiveSquad(bp));
    expect(calls.at(-1)?.prompt).not.toContain('- runs:');
  });

  it('one part alone stays on the road a one-part project takes', async () => {
    answer = { ...answer, runs: [{ id: 'app', name: 'Visitor log', repo: '.', url: 'http://localhost:3000' }] };
    await read(new LiveSquad(bp));
    const meta = readMeta(bp);
    expect(meta.parts?.map((p) => p.id)).toEqual(['app']);
    expect(meta.parts?.[0]?.folder).toBeUndefined();
  });

  it('a read that names nothing leaves the project as it was', async () => {
    answer = { ...answer, runs: [] };
    await read(new LiveSquad(bp));
    expect(readMeta(bp).parts).toBeUndefined();
  });

  it('runs two parts in one repo from its one command, opening what a person opens', async () => {
    await read(new LiveSquad(bp));
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, commands: { ...meta.commands, start: 'npm run dev' } });
    const ticket = createTicket(bp, { title: 'A story' });
    const plan = productPlan(bp, readMeta(bp), ticket);
    expect(plan.why).toBeUndefined();
    expect(plan.places).toHaveLength(1);
    expect(plan.places[0]).toMatchObject({ start: 'npm run dev', url: 'http://localhost:5173' });
    expect(plan.places[0]!.part.id).toBe('web');
    expect(plan.front?.part.id).toBe('web');
    const parts = (new LiveSquad(bp) as unknown as { apiParts(t: Ticket): Record<string, { url: string }> }).apiParts(ticket);
    expect(parts).toEqual({ web: { name: 'Web app', url: 'http://localhost:5173' }, api: { name: 'API', url: 'http://localhost:4100' } });
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, writeMeta, type BoardPaths } from '../../src/board/store.js';
import { DemoTracker } from '../../src/board/demo-tracker.js';
import type { Sprint } from '../../src/modules/tracker/types.js';

/**
 * A run from the tracker in tests: a board on a temp folder, and a tracker kept in memory with an epic Booking (AB#120)
 * holding two features and a story of its own:
 * - Search (AB#121): Search rooms (AB#123, Given/When/Then criteria), Filter by price (AB#124, needs AB#123);
 * - Holding (AB#122): Old holding (AB#125, closed), Hold a slot (AB#126);
 * - Show the version (AB#127), right under the epic.
 * Search rooms is in Sprint 14.
 */

export class SprintTracker extends DemoTracker {
  override readonly abilities = { sprints: true, wiki: false, bugs: true, tags: true, create: true };
  inSprint = new Set<string>();

  override async sprints(): Promise<Sprint[]> {
    return [{ name: 'Sprint 14', path: 'Mawid\\Sprint 14', current: true }];
  }

  override async list(opts: { sprint?: string; includeDone?: boolean } = {}) {
    const all = await super.list(opts);
    return opts.sprint ? all.filter((r) => this.inSprint.has(r.id)) : all;
  }
}

export interface EpicBoard {
  tmp: string;
  bp: BoardPaths;
  tracker: SprintTracker;
}

export async function epicBoard(user = 'Momen'): Promise<EpicBoard> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-epic-'));
  const bp = boardPaths(path.join(tmp, '.squad'));
  writeMeta(bp, {
    project: 'Mawid',
    key: 'MW',
    nextNumber: 20,
    engine: 'live',
    runner: 'direct',
    user: { name: user, role: 'Business analyst' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
  });
  const tracker = new SprintTracker({ baseUrl: 'https://tracker.example/items/' });
  const epic = await tracker.createItem({ level: 'epic', title: 'Booking', markdown: 'Guests book rooms online.' });
  const search = await tracker.createItem({ level: 'feature', title: 'Search', markdown: 'Find a free room.', parent: epic.id });
  const holding = await tracker.createItem({ level: 'feature', title: 'Holding', markdown: 'Keep a room while paying.', parent: epic.id });
  const rooms = await tracker.createItem({
    level: 'story',
    title: 'Search rooms',
    markdown: 'As a guest, I want to search free rooms, so that I can book one.',
    acceptance: '**Given** two free rooms\n**When** I search for tonight\n**Then** both show\n\nGiven no free room, when I search, then it says none are free.',
    parent: search.id,
  });
  const price = await tracker.createItem({ level: 'story', title: 'Filter by price', markdown: 'As a guest, I want to filter by price.', acceptance: 'Cheap rooms first.', parent: search.id });
  const old = await tracker.createItem({ level: 'story', title: 'Old holding', markdown: 'x', parent: holding.id });
  await tracker.createItem({ level: 'story', title: 'Hold a slot', markdown: 'As a guest, I want to hold a room for 10 minutes.', parent: holding.id });
  await tracker.createItem({ level: 'story', title: 'Show the version', markdown: 'The footer shows the version.', parent: epic.id });
  await tracker.linkDepends(price.id, [rooms.id]);
  await tracker.moveTo(old.id, 'closed');
  tracker.inSprint.add(rooms.id);
  return { tmp, bp, tracker };
}

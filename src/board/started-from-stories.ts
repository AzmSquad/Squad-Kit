import { listTickets, now, readMeta, type BoardPaths } from './store.js';
import { readTalk, setupOver } from './setup-state.js';
import { openOnBoard } from './depends.js';
import { trackerModule } from '../modules/registry.js';
import type { BoardMeta, Stage } from './types.js';

/**
 * A project with no code starts one of two ways: the person answers "What do you want to build?" on the Overview, or the
 * work starts from stories, pulled from the tracker or written by hand. Once a story is on the board that question is
 * over. Nothing waits for the person on the Overview, and the page shows the stories instead of asking.
 */

/** The first-run question on a project with no code went unanswered, because the work started from stories. */
export function startedFromStories(bp: BoardPaths, meta: BoardMeta = readMeta(bp)): boolean {
  const s = meta.setup;
  if (!s || s.approvedAt || !setupOver(s) || !meta.scan?.empty) return false;
  // The person said what to build: the Architect's first stories wait for their check, as always.
  if (readTalk(bp)?.idea) return false;
  return listTickets(bp).some((t) => !t.deleting && !t.archived);
}

/**
 * The first merge on such a project ends "no code yet", and with it the reason to skip the question. It stays over:
 * the setup counts as done, approved by nobody, so the Overview never asks the person to check a read of an empty folder.
 */
export function settleStartedFromStories(bp: BoardPaths, meta: BoardMeta): BoardMeta {
  if (!meta.setup || !startedFromStories(bp, meta)) return meta;
  return { ...meta, setup: { ...meta.setup, approvedAt: now(), fromStories: true } };
}

export interface OpenStory {
  id: string;
  title: string;
  stage: Stage;
}

export interface OpenStories {
  /** The tracker they came from, when they all came from the same one. */
  from?: string;
  /** Oldest first: on a project with no code the first one makes the first code, and the others wait for it. */
  open: OpenStory[];
}

/** The stories still open on the board, for a project with no code yet: its real state, before there is code to read. */
export function openStories(bp: BoardPaths): OpenStories | undefined {
  const open = openOnBoard(bp).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!open.length) return undefined;
  const kinds = [...new Set(open.map((t) => t.source.type))];
  const from = kinds.length === 1 && kinds[0] !== 'manual' ? trackerModule(kinds[0])?.label : undefined;
  return { ...(from ? { from } : {}), open: open.map((t) => ({ id: t.id, title: t.title, stage: t.stage })) };
}

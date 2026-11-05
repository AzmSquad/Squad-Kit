import type { BoardPaths } from './store.js';
import type { ChatMessage } from './types.js';
import { rangeWords, readUsual, recordUsual } from './usual.js';

/**
 * A project's first run: what squad-kit does between Add project and the first ticket, one step at a time, each with
 * its time and the usual time. It is this computer's live progress, so it lives in this computer's folder for the
 * project; what the steps learn goes into `.squad/` (the knowledge files and the decisions). Terminal: `squad setup`.
 */

export const SETUP_STEPS = ['files', 'tool', 'read', 'commands', 'tests', 'app', 'overview'] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];
export type SetupStepState = 'todo' | 'now' | 'done' | 'failed' | 'skipped' | 'stopped';

/** What Add project found in the folder. */
export type FolderKind = 'repo' | 'files' | 'empty' | 'repos' | 'older' | 'project';

export interface SetupStep {
  id: SetupStepId;
  state: SetupStepState;
  /** When it started. */
  since?: string;
  /** How long it took, once it is over. */
  seconds?: number;
  /** What it found or does now, in plain words. */
  note?: string;
  error?: string;
  /** The last lines a failed command printed, for "See what failed". */
  output?: string;
}

/** One run of the project's tests in squad-kit's own copy. */
export interface SetupTestRun {
  ok: boolean;
  command: string;
  repo?: string;
  passed?: number;
  seconds?: number;
  output?: string;
  /** It failed here, and this very command passed later on a story: it is no longer known to fail. */
  passedSince?: string;
}

/** squad-kit's own proof that it can work here: what it read, ran and opened. */
export interface SetupProof {
  /** Files in the project, from git. */
  files?: number;
  /** Files the Architect opened while it read. */
  read?: number;
  branch?: string;
  /** Changes in the person's folder that are not saved in git. */
  unsaved?: number;
  tests?: SetupTestRun[];
  app?: { ok: boolean; url?: string; command?: string; repo?: string; shot?: string; error?: string };
}

/**
 * "Something is wrong" on the overview: a talk with the Architect about what it understood. Like every agent chat it
 * stays on this computer. "Read it again with this" hands what the person said to the next read.
 */
export interface OverviewTalk {
  open: boolean;
  thinking: boolean;
  messages: ChatMessage[];
  /** The person pressed Stop on the answer. */
  stopping?: boolean;
  /** The next read takes what the person said into account. */
  reread?: boolean;
  /** On a project with no code: what the person said they want to build. */
  idea?: string;
}

export interface SetupState {
  kind: FolderKind;
  startedAt: string;
  steps: SetupStep[];
  proof?: SetupProof;
  /** The last few things the Architect read, for "See what the Architect is reading". */
  reads?: string[];
  /** The person pressed Stop: the running step ends, and nothing new starts until Start again. */
  stopping?: boolean;
  /** When the Quality question was answered here. It is asked once, during the setup. */
  qualityAt?: string;
  /** Every step is over: the overview waits for the person. */
  readyAt?: string;
  /** The person approved the overview: the rules the read found are rules now. */
  approvedAt?: string;
}

/** squad-kit's guess, in seconds, until this computer has set up a few projects of its own. */
export const SETUP_USUAL: Record<SetupStepId, [number, number]> = {
  files: [1, 3],
  tool: [1, 5],
  read: [120, 300],
  commands: [10, 180],
  tests: [10, 120],
  app: [20, 120],
  overview: [1, 3],
};

/** A fresh setup: the project files were just made, everything else is to do. */
export function newSetup(kind: FolderKind, startedMs: number, at = Date.now()): SetupState {
  const seconds = Math.max(1, Math.round((at - startedMs) / 1000));
  return {
    kind,
    startedAt: new Date(startedMs).toISOString(),
    steps: SETUP_STEPS.map((id) => (id === 'files' ? { id, state: 'done' as const, since: new Date(startedMs).toISOString(), seconds } : { id, state: 'todo' as const })),
  };
}

export function stepOf(s: SetupState, id: SetupStepId): SetupStep {
  let st = s.steps.find((x) => x.id === id);
  if (!st) {
    st = { id, state: 'todo' };
    s.steps.push(st);
    s.steps.sort((a, b) => SETUP_STEPS.indexOf(a.id) - SETUP_STEPS.indexOf(b.id));
  }
  return st;
}

/** A step starts now. */
export function begin(s: SetupState, id: SetupStepId, note?: string, at = Date.now()): void {
  const st = stepOf(s, id);
  st.state = 'now';
  st.since = new Date(at).toISOString();
  delete st.seconds;
  delete st.error;
  delete st.output;
  if (note !== undefined) st.note = note;
  else delete st.note;
}

/** A step is over: done, failed, skipped or stopped, with its time. */
export function finish(s: SetupState, id: SetupStepId, state: Exclude<SetupStepState, 'todo' | 'now'>, extra: Pick<SetupStep, 'note' | 'error' | 'output'> = {}, at = Date.now()): void {
  const st = stepOf(s, id);
  const since = st.since ? Date.parse(st.since) : at;
  st.state = state;
  if (!st.since) st.since = new Date(at).toISOString();
  st.seconds = Math.max(state === 'skipped' ? 0 : 1, Math.round((at - since) / 1000));
  if (extra.note !== undefined) st.note = extra.note;
  if (extra.error !== undefined) st.error = extra.error;
  else delete st.error;
  if (extra.output !== undefined) st.output = extra.output;
  else delete st.output;
}

/** What the read says when it is done: "Read the project: 98 files". */
export function readWords(files: number | undefined): string {
  return files ? `Read the project: ${files} ${files === 1 ? 'file' : 'files'}` : 'Read the project';
}

/** Try again from this step: it and every step after it are to do again. Approval is asked again only after a new read. */
export function resetFrom(s: SetupState, id: SetupStepId): void {
  const from = SETUP_STEPS.indexOf(id);
  for (const st of s.steps) {
    if (SETUP_STEPS.indexOf(st.id) >= from) {
      st.state = 'todo';
      delete st.since;
      delete st.seconds;
      delete st.error;
      delete st.output;
      delete st.note;
    }
  }
  delete s.readyAt;
  delete s.stopping;
  if (from <= SETUP_STEPS.indexOf('read')) delete s.approvedAt;
  if (from <= SETUP_STEPS.indexOf('tests')) s.proof = { ...s.proof, tests: undefined };
  if (from <= SETUP_STEPS.indexOf('app')) s.proof = { ...s.proof, app: undefined };
}

/** The steps after the read that still have to run, in order. */
export const PROOF_STEPS: SetupStepId[] = ['commands', 'tests', 'app', 'overview'];

/** The next step squad-kit runs itself after the read, or null when there is none (or the person stopped it). */
export function nextProofStep(s: SetupState | undefined): SetupStepId | null {
  if (!s || s.stopping) return null;
  const read = s.steps.find((x) => x.id === 'read');
  if (read?.state !== 'done') return null;
  if (s.steps.some((x) => x.state === 'now' || x.state === 'stopped')) return null;
  return PROOF_STEPS.find((id) => stepOf(s, id).state === 'todo') ?? null;
}

/** The step running now, else the first one to do. */
export function currentStep(s: SetupState): SetupStep | undefined {
  return s.steps.find((x) => x.state === 'now') ?? s.steps.find((x) => x.state === 'todo' || x.state === 'stopped');
}

/** Every step is over, whatever way: the overview can be checked. */
export function setupOver(s: SetupState): boolean {
  return s.steps.every((x) => x.state !== 'todo' && x.state !== 'now' && x.state !== 'stopped');
}

/* ── Usual times ─────────────────────────────────────── */

const LEARN_AFTER = 3;

export function usualSetupKey(id: SetupStepId): string {
  return `setup.${id}`;
}

/** The usual time of a setup step on this computer: the middle half of its history, or squad-kit's guess. */
export function setupUsual(bp: BoardPaths | null, id: SetupStepId): { low: number; high: number; learned: boolean } {
  const runs = bp ? (readUsual(bp)[usualSetupKey(id)] ?? []) : [];
  if (runs.length < LEARN_AFTER) {
    const [low, high] = SETUP_USUAL[id];
    return { low, high, learned: false };
  }
  const sorted = [...runs].sort((a, b) => a - b);
  const q = (p: number) => {
    const at = (sorted.length - 1) * p;
    const lo = Math.floor(at);
    const hi = Math.ceil(at);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
  };
  return { low: q(0.25), high: q(0.75), learned: true };
}

/** A step that went well teaches the usual time. */
export function learnSetupTime(bp: BoardPaths, st: SetupStep): void {
  if (st.state === 'done' && st.seconds && st.seconds > 1) recordUsual(bp, usualSetupKey(st.id), st.seconds);
}

/** "usually under 1 min", "usually 2 to 5 min". */
export function usualText(u: { low: number; high: number }): string {
  return `usually ${rangeWords(u)}`;
}

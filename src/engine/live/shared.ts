import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BoardPaths } from '../../board/store.js';
import { planSnapshot } from '../../board/actions.js';
import type { PortAsk, Ticket } from '../../board/types.js';
import type { PlanEntry } from '../../modules/ai-tool/types.js';
import { judgeQuestion } from '../question-filter.js';
import { hiddenFiles } from '../local-files.js';
import { QUEUED } from '../../board/now.js';
import { waitsForFirst } from '../../board/first-story.js';
import { waitsForTools } from '../tools/index.js';
import { isLimitText } from '../usage-limit.js';
import { StepError } from '../../board/problem.js';

export const STOPPED = 'You stopped the squad.';

/** A leading step number on an item of the Builder's to-do list: "1. Start from…", "Step 2: …", "2) …", "3 - …". */
const STEP_NUMBER = /^\s*(?:step\s*(\d+)\b|\(?(\d+)\s*(?:[.):]|\s[-–])(?=\s|$))/i;

/**
 * Where the Builder's own to-do list (ACP's plan update) says it is, as a plan step from 0, or null when the list says
 * nothing about the plan's `count` steps. Items with a leading step number are read by that number, so an extra item
 * ("Check everything") does not throw it off; with no numbers, the list holds one item per plan step, in order.
 */
export function planStepOf(entries: PlanEntry[], count: number): number | null {
  if (!count) return null;
  const numbered = entries
    .flatMap((e) => {
      const m = STEP_NUMBER.exec(e.content);
      const n = m ? Number(m[1] ?? m[2]) : NaN;
      return n >= 1 && n <= count ? [{ n: n - 1, status: e.status }] : [];
    })
    .sort((a, b) => a.n - b.n);
  const list = numbered.length ? numbered : entries.length === count ? entries.map((e, i) => ({ n: i, status: e.status })) : [];
  if (!list.length) return null;
  const doing = list.find((e) => e.status === 'in_progress');
  const open = list.find((e) => e.status !== 'completed');
  return doing ? doing.n : open ? open.n : Math.min(count - 1, list[list.length - 1]!.n + 1);
}


export function projectRoot(bp: BoardPaths): string {
  return bp.root;
}

/** The plan in one short key: the story, the done-when items, the decision and the steps. */
export function planKey(t: Ticket): string {
  return createHash('sha1').update(JSON.stringify(planSnapshot(t))).digest('hex').slice(0, 12);
}

/** squad-kit's own keys (tracker token, speech key): no agent may read them, whichever folder it works in. */
export async function secretFiles(bp: BoardPaths, cwd?: string): Promise<string[]> {
  return [bp.secretsFile, path.join(bp.squadDir, 'secrets.yaml'), ...(await hiddenFiles(bp, cwd))];
}

/** A step stopped on a network or service problem that usually passes by itself. */
export class PassingTrouble extends StepError {}

/** How long a step waits before each new try after such a problem: about 15 minutes in all, then a plain stop. */
export const BLIP_WAITS_MIN = [1, 2, 4, 8];

/** True when one sentence has the question filter's technical words: a port, a process, the sandbox. */
export function technicalWords(sentence: string): boolean {
  const v = judgeQuestion({ text: sentence });
  return !v.pass && v.kind === 'technical';
}

/** "the tests and the build": the checks that failed, in words for people. */
export function checkNames(names: string[]): string {
  const words: Record<string, string> = { test: 'the tests', lint: 'the lint check', build: 'the build', start: 'starting the app' };
  const w = [...new Set(names.map((n) => words[n] ?? `the ${n} check`))];
  return w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w.at(-1)}` : (w[0] ?? 'a check');
}

/** The first of the Builder's plan steps not done yet, from 1. */
export function openStep(t: Ticket): number {
  const i = (t.steps ?? []).findIndex((s) => s.status !== 'done');
  return i >= 0 ? i + 1 : 1;
}

/** A card line that says the ticket waits: for a free place, for the usage limit, or for a tool on this computer. */
export function held(status: string | undefined): boolean {
  return Boolean(status && (status.startsWith(QUEUED) || isLimitText(status) || waitsForFirst(status) || waitsForTools(status)));
}

export function attachmentDirs(t: Ticket): string[] {
  return [...new Set((t.attachments ?? []).map((a) => path.dirname(a)))];
}

/** Thrown when a step pauses to ask the person. The ticket already shows the question; nothing failed. */
export class WaitingForYou extends Error {
  constructor() {
    super('Waiting for your answer');
  }
}

export interface AgentAsk {
  text: string;
  options?: string[];
  why?: string;
  files?: string[];
  /** Builds by itself: a critical gap or a clash, the only reasons it stops. */
  kind?: 'gap' | 'clash';
  /** Builds by itself: where the gap or the clash comes from. */
  sources?: unknown;
  /** Set by squad-kit, never by the agent: the plain card about a busy port (see inTheWay). */
  port?: PortAsk;
}

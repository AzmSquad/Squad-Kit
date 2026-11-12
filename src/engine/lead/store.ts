import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readMeta, writeMeta, type BoardPaths } from '../../board/store.js';
import { BoardActionError } from '../../board/actions.js';
import { ALLOWABLE, isAllowable } from './can.js';
import type { Allowable, LeadContext, LeadConversation, LeadSummary } from './types.js';

/**
 * The lead's conversations are files: one JSON file each, in squad-kit's own folder for the project on this computer
 * (`~/.squad-kit/projects/<id>/lead/conversations/`), never in the person's repo. Each holds the messages, the work
 * trace of every answer, the time it took and what it cost. The board, the terminal and the REST API read the same files.
 */

/** squad-kit's own folder for the lead, for this project on this computer. */
export function leadDir(bp: BoardPaths): string {
  return path.join(bp.localDir, 'lead');
}

function conversationsDir(bp: BoardPaths): string {
  return path.join(leadDir(bp), 'conversations');
}

const ID = /^\d{8}-[a-f0-9]{6}$/;

function fileOf(bp: BoardPaths, id: string): string {
  if (!ID.test(id)) throw new BoardActionError(`There is no conversation "${id.slice(0, 40)}".`);
  return path.join(conversationsDir(bp), `${id}.json`);
}

/** A new conversation's id: the day and a few random letters, "20261111-a1b2c3". */
export function newConversationId(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${randomBytes(3).toString('hex')}`;
}

/** Answers being written in this app now. A file that says "thinking" with none here was cut off by a restart. */
const working = new Set<string>();

export function markWorking(bp: BoardPaths, id: string, on: boolean): void {
  const key = `${bp.squadDir}\n${id}`;
  if (on) working.add(key);
  else working.delete(key);
}

function isWorking(bp: BoardPaths, id: string): boolean {
  return working.has(`${bp.squadDir}\n${id}`);
}

/** The words for an answer a restart cut off. */
export const CUT_OFF = 'squad-kit restarted while the lead was answering, so this answer did not come. Ask again.';

export function writeConversation(bp: BoardPaths, c: LeadConversation): void {
  const file = fileOf(bp, c.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(c, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** One conversation, or null. One whose answer a restart cut off says so, instead of thinking for ever. */
export function readConversation(bp: BoardPaths, id: string): LeadConversation | null {
  let c: LeadConversation;
  try {
    c = JSON.parse(fs.readFileSync(fileOf(bp, id), 'utf8')) as LeadConversation;
  } catch (err) {
    if (err instanceof BoardActionError) throw err;
    return null;
  }
  if (c.thinking && !isWorking(bp, c.id)) {
    c.thinking = false;
    const last = c.turns.at(-1);
    if (last && !last.answer && !last.error) last.error = CUT_OFF;
  }
  return c;
}

export function requireConversation(bp: BoardPaths, id: string): LeadConversation {
  const c = readConversation(bp, id);
  if (!c) throw new BoardActionError(`There is no conversation "${id.slice(0, 40)}".`);
  return c;
}

/** Reads, changes and writes one conversation. */
export function updateConversation(bp: BoardPaths, id: string, change: (c: LeadConversation) => void): LeadConversation {
  const c = requireConversation(bp, id);
  change(c);
  c.updatedAt = new Date().toISOString();
  writeConversation(bp, c);
  return c;
}

/** Every conversation, newest first, at most `limit`. */
export function listConversations(bp: BoardPaths, limit = 200): LeadConversation[] {
  let names: string[];
  try {
    names = fs.readdirSync(conversationsDir(bp)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((f) => readConversation(bp, f.slice(0, -5)))
    .filter((c): c is LeadConversation => Boolean(c))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** What a conversation cost in all, or undefined when no answer said. */
export function costOf(c: LeadConversation): number | undefined {
  const costs = c.turns.map((t) => t.costUsd).filter((x): x is number => typeof x === 'number');
  return costs.length ? costs.reduce((s, x) => s + x, 0) : undefined;
}

export function summaryOf(c: LeadConversation): LeadSummary {
  const cost = costOf(c);
  return {
    id: c.id,
    title: c.title,
    startedAt: c.startedAt,
    updatedAt: c.updatedAt,
    turns: c.turns.length,
    thinking: Boolean(c.thinking),
    context: c.context,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(c.story ? { story: c.story } : {}),
  };
}

/** A conversation's title: the first question, cut short. */
export function titleOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 77)}…` : one || 'A question';
}

/** "2026-11-11", in this computer's time: the day a cost counts in. */
export function dayKey(at: number | string = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** What the lead's answers cost today, at API prices. */
export function spentToday(bp: BoardPaths, at = Date.now()): number {
  const today = dayKey(at);
  return listConversations(bp).reduce((sum, c) => sum + c.turns.filter((t) => dayKey(t.ask.at) === today).reduce((s, t) => s + (t.costUsd ?? 0), 0), 0);
}

/* ── The person's rules: Always allow and the morning brief ───── */

export interface LeadRules {
  /** The low-risk actions that run without asking. */
  always: Allowable[];
  /** The morning brief is on. */
  brief: boolean;
}

/** The project's rules for the lead on this computer. */
export function leadRules(bp: BoardPaths): LeadRules {
  let saved: { always?: unknown; brief?: unknown } | undefined;
  try {
    saved = readMeta(bp).lead;
  } catch {
    saved = undefined;
  }
  const always = Array.isArray(saved?.always) ? saved.always.filter((a): a is Allowable => typeof a === 'string' && isAllowable(a)) : [];
  return { always: ALLOWABLE.filter((a) => always.includes(a)), brief: saved?.brief === true };
}

/** True when "Always allow" is on for this action. */
export function allowsAlways(bp: BoardPaths, action: string): boolean {
  return leadRules(bp).always.some((a) => a === action);
}

/** Saves the rules. "Always allow" takes only the low-risk actions; the never list cannot change. */
export function saveLeadRules(bp: BoardPaths, change: { always?: unknown; brief?: unknown; never?: unknown }): LeadRules {
  if (change.never !== undefined) throw new BoardActionError('The list of what the lead never does cannot change.');
  const now = leadRules(bp);
  let always = now.always;
  if (change.always !== undefined) {
    if (!Array.isArray(change.always)) throw new BoardActionError('Always allow takes a list.');
    const bad = change.always.find((a) => typeof a !== 'string' || !isAllowable(a));
    if (bad !== undefined) throw new BoardActionError(`"Always allow" is only for low-risk actions (${ALLOWABLE.join(', ')}), so "${String(bad).slice(0, 40)}" always asks you first.`);
    always = ALLOWABLE.filter((a) => (change.always as string[]).includes(a));
  }
  const brief = change.brief === undefined ? now.brief : change.brief === true;
  const meta = readMeta(bp);
  writeMeta(bp, { ...meta, lead: { ...(always.length ? { always } : {}), ...(brief ? { brief: true } : {}) } });
  return { always, brief };
}

/** One more action under "Always allow". */
export function allowAlways(bp: BoardPaths, action: Allowable): LeadRules {
  return saveLeadRules(bp, { always: [...new Set([...leadRules(bp).always, action])] });
}

/** The context a request carries, checked: an unknown shape is a question from the board. */
export function cleanContext(raw: unknown): LeadContext {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
  const story = text(c.story, 40)?.toUpperCase();
  if (c.from === 'app' && text(c.path)) return { from: 'app', path: text(c.path)!, ...(text(c.app, 80) ? { app: text(c.app, 80)! } : {}) };
  if (c.from === 'story' && story) return { from: 'story', story };
  if (c.from === 'problem' && ['slow', 'stuck', 'waiting', 'error'].includes(c.problem as string)) {
    return { from: 'problem', problem: c.problem as 'slow', ...(story ? { story } : {}), ...(text(c.error, 2000) ? { error: text(c.error, 2000)! } : {}) };
  }
  return { from: 'board', ...(text(c.page) ? { page: text(c.page)! } : {}) };
}

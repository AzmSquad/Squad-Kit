import { agentPrivatePlaces } from './project-guard.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readMeta, type BoardPaths } from '../board/store.js';
import { BoardActionError, saveUploads, type UploadedFile } from '../board/actions.js';
import type { Ticket, TicketBrief, Track } from '../board/types.js';
import { AI_TOOLS, aiTool, describeToolEvent } from '../modules/registry.js';
import type { AgentResult, AgentRun, ToolEvent } from '../modules/ai-tool/types.js';
import { agentInstructions, readAgent } from './agents.js';
import { rulesFor } from '../board/additions.js';
import { effortOn, personLevels, resolveLevel } from './levels.js';
import { projectRoot, secretFiles } from './live.js';
import { rulesFiles } from './repos.js';
import * as P from './prompts.js';
import { prepareMedia } from './media.js';
import { recordUsage } from '../board/usage.js';
import { startPause } from './usage-limit.js';
import { log } from '../core/app-log.js';
import { ownRunWords } from './plain-stop.js';

/** A ticket the Analyst filled in from a pasted idea or chat message. Nothing is saved until the person creates it. */
export interface TicketDraft extends TicketBrief {
  title: string;
  ask: string;
  kind: Ticket['kind'];
  /** The Analyst's suggestion; the person picks. */
  track: Track;
  priority: Ticket['priority'];
  /** What the text leaves unclear. The Analyst asks about these again after the ticket is created. */
  gaps: string[];
}

export interface DraftInput {
  text: string;
  files?: UploadedFile[];
}

/** Where the Analyst is with a draft: reading the message, looking at the project, or writing the ticket. */
export type DraftStep = 'read' | 'look' | 'write';

export interface DraftProgress {
  step: DraftStep;
  /** What it looked at so far, in a few words each, oldest first: the files it read and the searches it made. */
  looked: string[];
}

export interface DraftOptions {
  /** Stops the Analyst when the person presses Cancel. */
  signal?: AbortSignal;
  onProgress?(p: DraftProgress): void;
}

/** Raised when the person cancelled the draft. */
export class DraftCancelled extends BoardActionError {
  constructor() {
    super('You stopped the Analyst. Your text is kept.');
  }
}

function checkInput(input: DraftInput): void {
  if (!input.text?.trim() && !input.files?.length) throw new BoardActionError('Paste the idea or message first, or add a file.');
}

/**
 * Turns rough text (an idea, a forwarded WhatsApp message, one line of business) into ticket fields. The Analyst
 * agent reads it, and the attached files, read only, and answers in a fixed shape; the person checks the result.
 */
export async function draftTicket(bp: BoardPaths, input: DraftInput, opts: DraftOptions = {}): Promise<TicketDraft> {
  checkInput(input);
  const text = input.text?.trim() ?? '';
  const meta = readMeta(bp);
  if (meta.engine !== 'live') return roughDraft(text);
  // The files only live here while the Analyst reads them; they are sent again when the ticket is created.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-draft-'));
  const progress: DraftProgress = { step: 'read', looked: [] };
  const report = (step: DraftStep, looked?: string | null) => {
    if (step === progress.step && (!looked || progress.looked.includes(looked))) return;
    progress.step = step;
    if (looked && !progress.looked.includes(looked)) progress.looked.push(looked);
    opts.onProgress?.({ step, looked: [...progress.looked] });
  };
  try {
    const saved = saveUploads(dir, input.files ?? []);
    // Voice and video notes are written out first, so the Analyst reads what the manager said.
    const files = [...saved, ...(await prepareMedia(bp, saved)).added];
    if (opts.signal?.aborted) throw new DraftCancelled();
    const root = projectRoot(bp);
    const r = await runAnalyst(bp, {
      cwd: root,
      prompt: P.draftPrompt(meta, text, files, { rules: rulesFiles(root) }),
      permissions: ['read'],
      schema: P.DRAFT_SCHEMA,
      addDirs: [dir],
      timeoutMs: DRAFT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
      // The first sign of life means the message is read and the Analyst is looking around; words mean it is writing.
      onActivity: () => {
        if (progress.step === 'read') report('look');
      },
      onTool: (e) => report('look', lookedAt(bp, e, root, dir)),
      onText: () => report('write'),
    }).catch((err: unknown) => {
      throw opts.signal?.aborted ? new DraftCancelled() : err;
    });
    if (opts.signal?.aborted) throw new DraftCancelled();
    return r.structured as TicketDraft;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What one tool call looked at, in a few words: the person's own file or a saved decision by name, else "the code", with no raw path or pattern. */
function lookedAt(bp: BoardPaths, e: ToolEvent, root: string, uploads: string): string | null {
  const file = [e.input.file_path, e.input.path, e.input.notebook_path].find((p): p is string => typeof p === 'string' && p.length > 0);
  if (!file) return describeToolEvent(e, root) ? 'the code' : null;
  const abs = path.resolve(root, file);
  const inside = (dir: string) => abs === dir || abs.startsWith(dir + path.sep);
  if (inside(uploads)) return `your file ${path.basename(abs)}`;
  if (inside(bp.decisionsDir)) return `saved decision ${path.basename(abs, '.md')}`;
  return 'the code';
}

/* ── Drafts the dialog can leave and come back to ─────────── */

/**
 * One draft the Analyst is writing, or wrote, for a project. It lives in this app's memory, so the person can close
 * the New ticket dialog while the Analyst works and find the draft there when they open it again. One per project:
 * a new draft replaces the last one.
 */
export interface DraftJob extends DraftProgress {
  id: string;
  status: 'working' | 'done' | 'failed' | 'cancelled';
  /** What the person pasted, kept so the dialog can show it again and so nothing they typed is lost. */
  text: string;
  files: { name: string; size: number }[];
  startedAt: string;
  endedAt?: string;
  draft?: TicketDraft;
  error?: string;
}

/** The longest filling in a new ticket may take. */
const DRAFT_MS = 4 * 60_000;

const drafts = new Map<string, { job: DraftJob; files: UploadedFile[]; stop: AbortController }>();
/** A finished draft nobody came back for is let go after a day. */
const KEEP_MS = 24 * 3_600_000;

function held(bp: BoardPaths) {
  const h = drafts.get(bp.squadDir);
  if (h?.job.endedAt && Date.now() - Date.parse(h.job.endedAt) > KEEP_MS) {
    drafts.delete(bp.squadDir);
    return undefined;
  }
  return h;
}

function heldJob(bp: BoardPaths, id: string) {
  const h = held(bp);
  if (!h || h.job.id !== id) throw new BoardActionError('This draft is gone. Paste the text again.');
  return h;
}

const copy = (job: DraftJob): DraftJob => ({ ...job, looked: [...job.looked], files: [...job.files] });

/** Starts the Analyst on a draft and returns at once; the dialog asks how it goes with {@link draftJob}. */
export function startDraft(bp: BoardPaths, input: DraftInput): DraftJob {
  checkInput(input);
  held(bp)?.stop.abort();
  const stop = new AbortController();
  const job: DraftJob = {
    id: randomUUID(),
    status: 'working',
    step: 'read',
    looked: [],
    text: input.text ?? '',
    files: (input.files ?? []).map((f) => ({ name: f.name, size: Buffer.byteLength(f.data ?? '', 'base64') })),
    startedAt: new Date().toISOString(),
  };
  drafts.set(bp.squadDir, { job, files: input.files ?? [], stop });
  const end = (fields: Partial<DraftJob>) => {
    if (job.status === 'working') Object.assign(job, fields, { endedAt: new Date().toISOString() });
  };
  const onProgress = (p: DraftProgress) => {
    if (job.status === 'working') Object.assign(job, p);
  };
  draftTicket(bp, input, { signal: stop.signal, onProgress })
    .then((draft) => end({ status: 'done', draft }))
    .catch((err: unknown) => end(err instanceof DraftCancelled ? { status: 'cancelled' } : { status: 'failed', error: err instanceof Error ? err.message : String(err) }));
  return copy(job);
}

/** The project's draft, or null when there is none. */
export function currentDraft(bp: BoardPaths): DraftJob | null {
  const h = held(bp);
  return h ? copy(h.job) : null;
}

export function draftJob(bp: BoardPaths, id: string): DraftJob {
  return copy(heldJob(bp, id).job);
}

/** The person pressed Cancel: the Analyst stops, and the text stays for another try. */
export function cancelDraft(bp: BoardPaths, id: string): DraftJob {
  const h = heldJob(bp, id);
  if (h.job.status === 'working') {
    Object.assign(h.job, { status: 'cancelled', endedAt: new Date().toISOString() });
    h.stop.abort();
  }
  return copy(h.job);
}

/** The draft is used (the ticket was created) or put aside: it no longer waits under New ticket. */
export function dismissDraft(bp: BoardPaths, id: string): { ok: true } {
  const h = held(bp);
  if (h?.job.id === id) {
    h.stop.abort();
    drafts.delete(bp.squadDir);
  }
  return { ok: true };
}

/** The files sent with a draft, so a dialog opened again can create the ticket with them. */
export function draftFiles(bp: BoardPaths, id: string): { files: UploadedFile[] } {
  return { files: heldJob(bp, id).files };
}

/** The Analyst's AI tool, the way the live squad runs it: over ACP, or directly when the board says so. */
async function runAnalyst(bp: BoardPaths, opts: AgentRun): Promise<AgentResult> {
  const agent = readAgent(bp, 'analyst');
  const tool = aiTool(agent.tool);
  if (!tool?.canRun) {
    const can = AI_TOOLS.filter((t) => t.canRun).map((t) => t.label).join(' or ');
    throw new BoardActionError(`The Analyst is set to ${tool?.label ?? agent.tool}, which squad-kit cannot run yet. Switch it to ${can} on the Harness page, under Agents.`);
  }
  const extra = [agentInstructions(agent), rulesFor(bp, 'analyst')].filter(Boolean).join('\n\n');
  // Filling in a ticket is a short, simple task: squad-kit's default is the fast level.
  const lv = resolveLevel({ role: 'analyst', step: 'draft', quality: readMeta(bp).quality }, agent.levels, personLevels());
  const effort = effortOn(tool, lv.effort);
  const r = await tool.run({
    ...opts,
    secretFiles: secretFiles(bp),
    privatePlaces: agentPrivatePlaces(),
    ...(extra ? { instructions: extra } : {}),
    level: lv.level,
    ...(effort ? { effort } : {}),
    ...(lv.model ? { model: lv.model } : {}),
    logDir: bp.chatsDir,
    direct: readMeta(bp).runner === 'direct',
  });
  // A new ticket does not exist yet: the run counts on the project's own line.
  recordUsage(bp, undefined, { role: 'analyst', step: 'draft', level: lv.level, model: lv.model || tool.modelFor(lv.level) }, r.usage);
  if (!r.ok) {
    const project = readMeta(bp).project;
    // The account's usage limit holds the whole queue too, not only this draft.
    if (r.limit) startPause(r.limit, { project });
    log.warn(`The Analyst could not fill in a new ticket: ${r.detail ?? r.error ?? 'no answer'}`, { project });
  }
  // Only squad-kit's own sentences reach the person; a tool's raw words went to the log above.
  if (!r.ok || !r.structured) throw new BoardActionError(r.error && ownRunWords(r.error, tool) ? r.error : 'The Analyst did not fill in the ticket. Try again, or write it yourself.');
  return r;
}

/** The demo board has no AI: the first line becomes the title, the rest the ask. */
function roughDraft(text: string): TicketDraft {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const title = (lines[0] ?? 'New ticket').replace(/[.!?]+$/, '').slice(0, 80);
  return {
    title,
    ask: lines.slice(1).join(' ') || title,
    kind: /\b(bug|broken|error|crash|fails?)\b/i.test(text) ? 'bug' : 'feature',
    track: /\b(typo|label|spelling|rename)\b/i.test(text) ? 'express' : 'full',
    priority: /\b(urgent|asap|blocker|today)\b/i.test(text) ? 'high' : 'normal',
    criteria: [],
    rules: [],
    edgeCases: [],
    gaps: ['The demo board fills in only the title. Connect a real project to let the Analyst write the rest.'],
  };
}

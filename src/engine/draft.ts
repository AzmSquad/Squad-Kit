import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMeta, type BoardPaths } from '../board/store.js';
import { BoardActionError, saveUploads, type UploadedFile } from '../board/actions.js';
import type { Ticket, TicketBrief, Track } from '../board/types.js';
import { AI_TOOLS, aiTool } from '../modules/registry.js';
import type { AgentResult, AgentRun } from '../modules/ai-tool/types.js';
import { agentInstructions, readAgent } from './agents.js';
import { personLevels, resolveLevel } from './levels.js';
import { projectRoot, secretFiles } from './live.js';
import { rulesFiles } from './repos.js';
import * as P from './prompts.js';
import { prepareMedia } from './media.js';

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

/**
 * Turns rough text (an idea, a forwarded WhatsApp message, one line of business) into ticket fields. The Analyst
 * agent reads it, and the attached files, read only, and answers in a fixed shape; the person checks the result.
 */
export async function draftTicket(bp: BoardPaths, input: DraftInput): Promise<TicketDraft> {
  const text = input.text?.trim() ?? '';
  if (!text && !input.files?.length) throw new BoardActionError('Paste the idea or message first, or add a file.');
  const meta = readMeta(bp);
  if (meta.engine !== 'live') return roughDraft(text);
  // The files only live here while the Analyst reads them; they are sent again when the ticket is created.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-draft-'));
  try {
    const saved = saveUploads(dir, input.files ?? []);
    // Voice and video notes are written out first, so the Analyst reads what the manager said.
    const files = [...saved, ...(await prepareMedia(bp, saved)).added];
    const root = projectRoot(bp);
    const r = await runAnalyst(bp, {
      cwd: root,
      prompt: P.draftPrompt(meta, text, files, { rules: rulesFiles(root) }),
      permissions: ['read'],
      schema: P.DRAFT_SCHEMA,
      addDirs: [dir],
      timeoutMs: 4 * 60_000,
    });
    return r.structured as TicketDraft;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The Analyst's AI tool, the way the live squad runs it: over ACP, or directly when the board says so. */
async function runAnalyst(bp: BoardPaths, opts: AgentRun): Promise<AgentResult> {
  const agent = readAgent(bp, 'analyst');
  const tool = aiTool(agent.tool);
  if (!tool?.canRun) {
    const can = AI_TOOLS.filter((t) => t.canRun).map((t) => t.label).join(' or ');
    throw new BoardActionError(`The Analyst is set to ${tool?.label ?? agent.tool}, which squad-kit cannot run yet. Switch it to ${can} in Squad and AI.`);
  }
  const extra = agentInstructions(agent);
  // Filling in a ticket is a short, simple task: squad-kit's default is the fast level.
  const lv = resolveLevel({ role: 'analyst', step: 'draft' }, agent.levels, personLevels());
  const r = await tool.run({
    ...opts,
    secretFiles: secretFiles(bp),
    ...(extra ? { instructions: extra } : {}),
    level: lv.level,
    ...(lv.effort && tool.supportsEffort ? { effort: lv.effort } : {}),
    ...(lv.model ? { model: lv.model } : {}),
    logDir: path.join(bp.dir, 'sessions'),
    direct: readMeta(bp).runner === 'direct',
  });
  if (!r.ok || !r.structured) throw new BoardActionError(r.error ?? 'The Analyst did not fill in the ticket. Try again.');
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContentBlock, PlanEntry, SessionUpdate, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk';
import type { AgentName, ChatMessage, Ticket } from '../board/types.js';
import { describeToolEvent } from '../modules/registry.js';
import { ticketDir, ticketMediaDir, type BoardPaths } from '../board/store.js';
import { outputOf } from './acp-runner.js';
import { blockedIn, blockedLine } from './sandbox.js';

/**
 * The real conversations behind a ticket, in the Agent Client Protocol (ACP) format: messages, thoughts, tool calls
 * with diffs and results, plans, images and files. Today they are read from the session files Claude Code saves;
 * agents that speak ACP themselves will produce the same updates, so the board shows every agent the same way.
 */

export const CONVERSATIONS: { key: 'intake' | 'build' | 'review' | 'tester'; label: string }[] = [
  { key: 'intake', label: 'Analyst and Architect' },
  { key: 'build', label: 'Builder' },
  { key: 'review', label: 'Reviewer' },
  { key: 'tester', label: 'Tester' },
];

/** One ACP session update with the time it happened. */
export interface AcpEntry {
  at?: string;
  update: SessionUpdate;
}

export interface Conversation {
  sessionId: string;
  cwd?: string;
  updates: AcpEntry[];
  total: number;
}

/**
 * squad-kit's own notes, kept in ACP's reserved `_meta` field: who wrote a message, and on a tool call's result what
 * the sandbox refused, in plain words.
 */
export type SquadMeta = { squadKit: { from: 'squad-kit' | 'claude-code' } };
export type BlockedMeta = { squadKit: { blocked: string[] } };

/** The plain words for what the sandbox refused in a command's output, as a tool call's `_meta`, or nothing. */
function blockedMeta(output: string): BlockedMeta | null {
  const found = blockedIn(output);
  return found.length ? { squadKit: { blocked: found.map((b) => blockedLine(b)) } } : null;
}

/** Each command result that the sandbox refused something in gets the plain words for it, never a silent failure. */
function withBlocked(updates: AcpEntry[]): AcpEntry[] {
  return updates.map((e) => {
    const u = e.update as Record<string, any>;
    const meta = u.sessionUpdate === 'tool_call_update' ? blockedMeta(outputOf(u)) : null;
    return meta ? { ...e, update: { ...u, _meta: { ...(u._meta ?? {}), ...meta } } as SessionUpdate } : e;
  });
}

/** Where Claude Code saved a session, or null if it never started. */
export function sessionFile(id: string, base = path.join(os.homedir(), '.claude', 'projects')): string | null {
  if (!/^[\w-]{8,64}$/.test(id)) return null;
  try {
    for (const d of fs.readdirSync(base)) {
      const file = path.join(base, d, `${id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {
    // No Claude Code projects folder yet.
  }
  return null;
}

type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
};
type Line = { type?: string; isSidechain?: boolean; timestamp?: string; cwd?: string; message?: { content?: string | Block[] } };

/** Messages Claude Code adds to the conversation on its own. */
const SYSTEM_PROMPT = /^\s*(<task-notification|<system-reminder|\[structured-output-enforce\]|<command-|Caveat:)/;
const MAX_TEXT = 20_000;
const MAX_RESULT = 4_000;
const MAX_IMAGE = 3_000_000;

const MEDIA: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  weba: 'audio/webm', opus: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf', csv: 'text/csv', json: 'application/json', md: 'text/markdown', txt: 'text/plain',
  html: 'text/html', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', har: 'application/json', log: 'text/plain',
};

/** The Content-Disposition for a file. A header takes plain letters only, and a person's file can have an Arabic name. */
export function dispositionOf(kind: 'inline' | 'attachment', file: string): string {
  const name = path.basename(file);
  return /^[\x20-\x7e]+$/.test(name) ? `${kind}; filename="${name.replace(/"/g, '')}"` : `${kind}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function mimeOf(file: string): string {
  return MEDIA[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** Files a run made that are worth showing: pictures, recordings, documents, data. Code files show as diffs instead. */
const SHOWN = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|pdf|csv|xlsx|docx|zip|har)$/i;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t;
}

function text(t: string, meta?: SquadMeta): ContentBlock {
  return { type: 'text', text: t, ...(meta ? { _meta: meta } : {}) };
}

function kindOf(name: string): ToolKind {
  switch (name) {
    case 'Read':
      return 'read';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'search';
    case 'Bash':
      return 'execute';
    case 'WebFetch':
    case 'WebSearch':
      return 'fetch';
    case 'TodoWrite':
      return 'think';
    default:
      return 'other';
  }
}

function diffsOf(name: string, input: Record<string, unknown>): ToolCallContent[] {
  const file = typeof input.file_path === 'string' ? input.file_path : '';
  if (!file) return [];
  const str = (v: unknown) => (typeof v === 'string' ? clip(v, MAX_TEXT) : '');
  if (name === 'Edit') return [{ type: 'diff', path: file, oldText: str(input.old_string), newText: str(input.new_string) }];
  if (name === 'Write') return [{ type: 'diff', path: file, oldText: null, newText: str(input.content) }];
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).map((e) => ({ type: 'diff', path: file, oldText: str(e.old_string), newText: str(e.new_string) }));
  }
  return [];
}

/** Picture, recording and document files a command mentions that really exist, as ACP resource links. */
function filesIn(textToScan: string, cwd: string | undefined): ToolCallContent[] {
  const found = new Set<string>();
  for (const m of textToScan.matchAll(/(?:^|[\s"'=(:])((?:\/|\.{0,2}\/)?[\w@./-]+\.(?:png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|ogg|pdf|csv|xlsx|docx|zip|har))\b/gi)) {
    const p = m[1]!;
    const abs = path.isAbsolute(p) ? p : cwd ? path.resolve(cwd, p) : '';
    if (abs && SHOWN.test(abs) && fs.existsSync(abs)) found.add(abs);
    if (found.size >= 12) break;
  }
  return [...found].map((abs) => ({
    type: 'content',
    content: { type: 'resource_link', uri: `file://${abs}`, name: path.basename(abs), mimeType: mimeOf(abs), size: fs.statSync(abs).size },
  }));
}

function resultContent(content: unknown): ToolCallContent[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'content', content: text(clip(content, MAX_RESULT)) }] : [];
  if (!Array.isArray(content)) return [];
  const out: ToolCallContent[] = [];
  for (const c of content as Block[]) {
    if (c?.type === 'text' && c.text?.trim()) out.push({ type: 'content', content: text(clip(c.text, MAX_RESULT)) });
    if (c?.type === 'image' && c.source?.data) {
      out.push({
        type: 'content',
        content:
          c.source.data.length <= MAX_IMAGE
            ? { type: 'image', data: c.source.data, mimeType: c.source.media_type ?? 'image/png' }
            : text('(a large image was left out)'),
      });
    }
  }
  return out;
}

function planOf(input: Record<string, unknown>): PlanEntry[] {
  if (!Array.isArray(input.todos)) return [];
  return (input.todos as { content?: string; status?: string }[]).map((t) => ({
    content: String(t.content ?? ''),
    priority: 'medium',
    status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
  }));
}

/**
 * A conversation as ACP updates: the last `limit` of them. Runs made through ACP saved their updates as they came
 * (`nativeDir/<id>.jsonl`); older runs are converted from the session file Claude Code saved.
 */
export function readConversation(id: string, limit = 400, base?: string, nativeDir?: string): Conversation | null {
  const native = nativeDir && /^[\w-]{8,64}$/.test(id) ? path.join(nativeDir, `${id}.jsonl`) : null;
  if (native && fs.existsSync(native)) {
    const updates: AcpEntry[] = [];
    for (const raw of fs.readFileSync(native, 'utf8').split('\n')) {
      try {
        if (raw.trim()) updates.push(JSON.parse(raw) as AcpEntry);
      } catch {
        // A line cut short while the run was writing it.
      }
    }
    const cwd = cwdOf(id, base);
    return { sessionId: id, ...(cwd ? { cwd } : {}), updates: withBlocked(updates.slice(-limit)), total: updates.length };
  }
  const file = sessionFile(id, base);
  if (!file) return null;
  const updates: AcpEntry[] = [];
  const toolFiles = new Map<string, string>();
  const toolContent = new Map<string, ToolCallContent[]>();
  // The calls that handed in the step's answer: their receipt ("Structured output provided successfully") is left out.
  const answers = new Set<string>();
  let cwd: string | undefined;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (line.isSidechain || (line.type !== 'user' && line.type !== 'assistant')) continue;
    cwd ??= line.cwd;
    const at = line.timestamp;
    const push = (update: SessionUpdate) => updates.push({ ...(at ? { at } : {}), update });
    const content = line.message?.content;
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) {
        if (line.type === 'user') {
          const from = SYSTEM_PROMPT.test(b.text) ? 'claude-code' : 'squad-kit';
          push({ sessionUpdate: 'user_message_chunk', content: text(clip(b.text, MAX_TEXT), { squadKit: { from } }) });
        } else {
          push({ sessionUpdate: 'agent_message_chunk', content: text(clip(b.text, MAX_TEXT)) });
        }
      } else if (b.type === 'thinking' && b.thinking?.trim()) {
        push({ sessionUpdate: 'agent_thought_chunk', content: text(clip(b.thinking, MAX_RESULT)) });
      } else if (b.type === 'tool_use' && b.name && b.id) {
        const input = b.input ?? {};
        if (b.name === 'TodoWrite') {
          const entries = planOf(input);
          if (entries.length) push({ sessionUpdate: 'plan', entries });
          continue;
        }
        if (b.name === 'StructuredOutput') answers.add(b.id);
        const title =
          b.name === 'StructuredOutput' ? 'Handed in its answer' : (describeToolEvent({ name: b.name, input }, cwd ?? '/') ?? `Used ${b.name}`);
        const filePath = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '';
        const command = typeof input.command === 'string' ? input.command : '';
        if (command) toolFiles.set(b.id, command);
        const callContent = [...diffsOf(b.name, input), ...(b.name !== 'Read' && filePath && SHOWN.test(filePath) ? filesIn(filePath, cwd) : [])];
        toolContent.set(b.id, callContent);
        push({
          sessionUpdate: 'tool_call',
          toolCallId: b.id,
          title,
          kind: kindOf(b.name),
          status: 'in_progress',
          // A Read of a picture brings the picture itself back in its result, so only files the agent writes get a link here.
          content: callContent,
          ...(filePath ? { locations: [{ path: filePath }] } : {}),
          rawInput: command ? { command } : filePath ? { path: filePath } : {},
        });
      } else if (b.type === 'tool_result' && b.tool_use_id) {
        const resultText = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((c) => c.text ?? '').join('\n') : '';
        // From the whole output: the result shown is cut short, and the sandbox says what it refused at the end.
        const blocked = blockedMeta(resultText);
        push({
          sessionUpdate: 'tool_call_update',
          toolCallId: b.tool_use_id,
          ...(blocked ? { _meta: blocked } : {}),
          status: b.is_error ? 'failed' : 'completed',
          // In ACP an update replaces the call's content, so it carries the diff along with the result.
          content: answers.has(b.tool_use_id)
            ? []
            : [...(toolContent.get(b.tool_use_id) ?? []), ...resultContent(b.content), ...filesIn(`${toolFiles.get(b.tool_use_id) ?? ''}\n${resultText}`, cwd)],
        });
      }
    }
  }
  return { sessionId: id, ...(cwd ? { cwd } : {}), updates: updates.slice(-limit), total: updates.length };
}

/** The folder a session ran in, from Claude Code's own session file. */
function cwdOf(id: string, base?: string): string | undefined {
  const file = sessionFile(id, base);
  if (!file) return undefined;
  const head = fs.readFileSync(file, 'utf8').slice(0, 20_000);
  return head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, '$1');
}

/** The conversations a ticket has, by role. */
export function ticketConversations(t: Ticket, base?: string, nativeDir?: string) {
  return CONVERSATIONS.flatMap((c) => {
    const id = t.sessions?.[c.key];
    if (!id) return [];
    const started = Boolean(sessionFile(id, base)) || Boolean(nativeDir && fs.existsSync(path.join(nativeDir, `${id}.jsonl`)));
    return [{ key: c.key, label: c.label, sessionId: id, started }];
  });
}

/** Folders a ticket's files may be shown from: its copy of the code, its proof and its attachments. */
/** The folders a ticket's files may be shown from: its copy, the screenshots, its folder and its voice notes. */
export function ticketFolders(t: Ticket, bp: BoardPaths): string[] {
  return [t.storyDir ?? t.worktree, bp.proofDir, ticketDir(bp, t.id), ticketMediaDir(bp, t.id)].filter((d): d is string => Boolean(d));
}

/** The real path of a file if it sits inside one of the allowed folders, else null. */
export function allowedFile(file: string, folders: string[]): string | null {
  try {
    const real = fs.realpathSync(file);
    const ok = folders.some((f) => {
      try {
        const root = fs.realpathSync(f);
        return real === root || real.startsWith(root + path.sep);
      } catch {
        return false;
      }
    });
    return ok && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** One ticket's talk with an agent, as the chat list shows it. */
export interface ChatSummary {
  id: string;
  title: string;
  stage: Ticket['stage'];
  release?: string;
  with: AgentName;
  open: boolean;
  thinking: boolean;
  /** Beside the work: the ticket kept working, or it is accepted. */
  beside: boolean;
  /** The agent answered and waits for the person. */
  yourTurn: boolean;
  /** Agent messages since the person last wrote. */
  fresh: number;
  count: number;
  at: string;
  last?: { who: ChatMessage['who']; text: string; at: string };
  /** The words around a search hit inside a message. */
  match?: string;
}

/** Every ticket's talk, open ones first, then the latest. `q` looks in ticket numbers, titles and every message. */
export function chatSummaries(tickets: Ticket[], q = ''): ChatSummary[] {
  const needle = q.trim().toLowerCase();
  const out: ChatSummary[] = [];
  for (const t of tickets) {
    const c = t.chat;
    if (!c || (!c.open && !c.messages.length)) continue;
    const last = c.messages.at(-1);
    const mine = c.messages.map((m) => m.who).lastIndexOf('you');
    const fresh = c.messages.slice(mine + 1).filter((m) => m.who !== 'you' && m.who !== 'squad').length;
    let match: string | undefined;
    if (needle && !`${t.id} ${t.title}`.toLowerCase().includes(needle)) {
      const hit = c.messages.find((m) => m.text.toLowerCase().includes(needle));
      if (!hit) continue;
      const i = hit.text.toLowerCase().indexOf(needle);
      match = `${i > 40 ? '…' : ''}${hit.text.slice(Math.max(0, i - 40), i + needle.length + 60).replace(/\s+/g, ' ').trim()}`;
    }
    out.push({
      id: t.id,
      title: t.title,
      stage: t.stage,
      ...(t.release ? { release: t.release } : {}),
      with: c.with,
      open: c.open,
      thinking: Boolean(c.thinking),
      beside: Boolean(c.beside),
      yourTurn: c.open && !c.thinking && Boolean(last) && last!.who !== 'you',
      fresh,
      count: c.messages.length,
      at: last?.at ?? t.activity[0]?.at ?? t.createdAt,
      ...(last ? { last: { who: last.who, text: last.text.slice(0, 240), at: last.at } } : {}),
      ...(match ? { match } : {}),
    });
  }
  return out.sort((a, b) => Number(b.open) - Number(a.open) || b.at.localeCompare(a.at));
}

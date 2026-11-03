import fs from 'node:fs';
import path from 'node:path';
import { dec, enc, splitHeader, withHeader } from './docs.js';
import type { BoardPaths } from './store.js';

/**
 * The project's overview: what the Architect understood when it read the project, for the person to check before the
 * first ticket, and the project's home after that. It is the project's knowledge, so it lives in
 * `.squad/knowledge/overview.md`, readable by people and tools. A project read by an older squad-kit has no such
 * file: its summary and map stay in `knowledge/project.md`, and the overview fills in after the next read.
 */

export const PART_KINDS = ['people', 'screens', 'server', 'logic', 'data', 'tests', 'outside'] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** One part of the code, a box in "How it fits together". */
export interface CodePart {
  id: string;
  name: string;
  what: string;
  files: string[];
  kind?: PartKind;
}

/** One part uses another: an arrow in the picture. */
export interface PartLink {
  from: string;
  to: string;
  label?: string;
}

/** A good first ticket the Architect saw. Once made, it names its ticket. */
export interface TicketIdea {
  title: string;
  why: string;
  ticket?: string;
}

export interface Overview {
  /** Who uses the project, in a sentence or two. */
  users?: string;
  /** What it can do today, one short line each. */
  can: string[];
  /** Surprises, gaps and risks worth knowing before the first ticket. */
  worth: string[];
  ideas: TicketIdea[];
  parts: CodePart[];
  links: PartLink[];
  /** When the Architect last read the project. */
  readAt?: string;
  /** When it was last brought up to date after a merged ticket. */
  refreshedAt?: string;
  /** The person checked it: "Looks right, start working". */
  approved?: { by: string; at: string };
}

export function emptyOverview(): Overview {
  return { can: [], worth: [], ideas: [], parts: [], links: [] };
}

export function overviewFile(bp: BoardPaths): string {
  return path.join(bp.knowledgeDir, 'overview.md');
}

const MARK = /^(\\*)(#|- )/;

/** One line of free text: no line breaks, and a line that looks like part of the shape gets a backslash in front. */
function line(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return MARK.test(one) ? `\\${one}` : one;
}

function unline(text: string): string {
  return /^\\+/.test(text) && MARK.test(text.slice(1)) ? text.slice(1) : text;
}

const listOf = (items: string[]) => items.map((x) => `- ${line(x)}`).join('\n');

export function overviewDoc(o: Overview): string {
  const header: Record<string, unknown> = {};
  if (o.readAt) header.readAt = o.readAt;
  if (o.refreshedAt) header.refreshedAt = o.refreshedAt;
  if (o.approved) header.approved = o.approved;
  const parts = o.parts.map((p) => {
    const to = o.links.filter((l) => l.from === p.id).map((l) => `${enc(l.to)}${l.label ? ` (${l.label.replace(/[()|]/g, ' ').trim()})` : ''}`);
    return [
      `### ${enc(p.name)}`,
      '',
      `- Id: ${enc(p.id)}`,
      ...(p.kind ? [`- Kind: ${p.kind}`] : []),
      ...(p.files.length ? [`- Files: ${p.files.map(enc).join(' | ')}`] : []),
      ...(to.length ? [`- Links to: ${to.join(' | ')}`] : []),
      '',
      line(p.what),
    ].join('\n');
  });
  const ideas = o.ideas.map((i) => [`### ${enc(i.title)}`, '', ...(i.ticket ? [`- Ticket: ${enc(i.ticket)}`, ''] : []), line(i.why)].join('\n'));
  const body = [
    '# Overview',
    `## Who uses it\n\n${o.users ? line(o.users) : ''}`,
    `## What it can do today\n\n${listOf(o.can)}`,
    `## Worth knowing\n\n${listOf(o.worth)}`,
    `## How it fits together\n\n${parts.join('\n\n')}`,
    `## Good first tickets\n\n${ideas.join('\n\n')}`,
  ];
  return withHeader(header, body.join('\n\n'));
}

/** The text under each `## ` heading, by heading. */
function sectionsOf(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let head: string | null = null;
  let lines: string[] = [];
  for (const l of body.split('\n')) {
    const m = /^## (.+)$/.exec(l);
    if (m) {
      if (head) out.set(head, lines.join('\n'));
      head = m[1]!.trim();
      lines = [];
    } else if (head) lines.push(l);
  }
  if (head) out.set(head, lines.join('\n'));
  return out;
}

/** `### ` blocks: the heading and the lines under it. */
function blocks(text: string): { head: string; lines: string[] }[] {
  const out: { head: string; lines: string[] }[] = [];
  for (const l of text.split('\n')) {
    const m = /^### (.+)$/.exec(l);
    if (m) out.push({ head: dec(m[1]!.trim()), lines: [] });
    else if (out.length) out[out.length - 1]!.lines.push(l);
  }
  return out;
}

const items = (text = '') =>
  text
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => unline(l.slice(2).trim()))
    .filter(Boolean);

const prose = (lines: string[]) => unline(lines.filter((l) => l.trim() && !/^- (Id|Kind|Files|Links to|Ticket): /.test(l)).join(' ').trim());
const fact = (lines: string[], key: string) => lines.find((l) => l.startsWith(`- ${key}: `))?.slice(key.length + 4).trim();

export function parseOverviewDoc(text: string): Overview {
  const { header, body } = splitHeader(text);
  const s = sectionsOf(body);
  const o = emptyOverview();
  if (typeof header.readAt === 'string') o.readAt = header.readAt;
  if (typeof header.refreshedAt === 'string') o.refreshedAt = header.refreshedAt;
  if (header.approved && typeof header.approved.by === 'string') o.approved = { by: header.approved.by, at: String(header.approved.at ?? '') };
  const users = unline((s.get('Who uses it') ?? '').trim());
  if (users) o.users = users;
  o.can = items(s.get('What it can do today'));
  o.worth = items(s.get('Worth knowing'));
  for (const b of blocks(s.get('How it fits together') ?? '')) {
    const id = dec(fact(b.lines, 'Id') ?? b.head);
    const kind = PART_KINDS.find((k) => k === fact(b.lines, 'Kind'));
    const files = fact(b.lines, 'Files')?.split(' | ').map((f) => dec(f.trim())).filter(Boolean) ?? [];
    o.parts.push({ id, name: b.head, what: prose(b.lines), files, ...(kind ? { kind } : {}) });
    for (const to of fact(b.lines, 'Links to')?.split(' | ') ?? []) {
      const m = /^(.*?)(?: \((.*)\))?$/.exec(to.trim());
      if (m?.[1]) o.links.push({ from: id, to: dec(m[1].trim()), ...(m[2] ? { label: m[2] } : {}) });
    }
  }
  for (const b of blocks(s.get('Good first tickets') ?? '')) {
    const ticket = fact(b.lines, 'Ticket');
    o.ideas.push({ title: b.head, why: prose(b.lines), ...(ticket ? { ticket: dec(ticket) } : {}) });
  }
  return o;
}

/** The overview as `.squad/` has it; an empty one when the project was read before overviews existed. */
export function readOverview(bp: BoardPaths): Overview {
  try {
    return parseOverviewDoc(fs.readFileSync(overviewFile(bp), 'utf8'));
  } catch {
    return emptyOverview();
  }
}

export function writeOverview(bp: BoardPaths, o: Overview): void {
  const file = overviewFile(bp);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, overviewDoc(o));
  fs.renameSync(tmp, file);
}

export function hasOverview(bp: BoardPaths): boolean {
  return fs.existsSync(overviewFile(bp));
}

/**
 * The Architect's answer, made safe to keep: short lists, part ids that are unique, arrows only between parts that
 * exist, and at most three ideas. Anything missing (an answer from before these fields) is empty.
 */
export function cleanOverview(a: {
  users?: unknown;
  can?: unknown;
  worth?: unknown;
  ideas?: unknown;
  parts?: unknown;
  links?: unknown;
}): Omit<Overview, 'readAt' | 'approved' | 'refreshedAt'> {
  const texts = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).map((x) => x.trim()).slice(0, max) : []);
  const parts: CodePart[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(a.parts) ? a.parts : []) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const id = (typeof r.id === 'string' && r.id.trim() ? r.id.trim() : name).slice(0, 60);
    if (!name || !id || seen.has(id)) continue;
    seen.add(id);
    const kind = PART_KINDS.find((k) => k === r.kind);
    parts.push({ id, name, what: typeof r.what === 'string' ? r.what.trim() : '', files: texts(r.files, 4), ...(kind ? { kind } : {}) });
    if (parts.length >= 10) break;
  }
  const links: PartLink[] = [];
  for (const l of Array.isArray(a.links) ? a.links : []) {
    if (!l || typeof l !== 'object') continue;
    const r = l as Record<string, unknown>;
    if (typeof r.from !== 'string' || typeof r.to !== 'string' || r.from === r.to || !seen.has(r.from) || !seen.has(r.to)) continue;
    if (links.some((x) => x.from === r.from && x.to === r.to)) continue;
    links.push({ from: r.from, to: r.to, ...(typeof r.label === 'string' && r.label.trim() ? { label: r.label.trim().slice(0, 30) } : {}) });
  }
  const ideas: TicketIdea[] = [];
  for (const i of Array.isArray(a.ideas) ? a.ideas : []) {
    if (!i || typeof i !== 'object') continue;
    const r = i as Record<string, unknown>;
    if (typeof r.title !== 'string' || !r.title.trim()) continue;
    ideas.push({ title: r.title.trim().slice(0, 120), why: typeof r.why === 'string' ? r.why.trim() : '' });
    if (ideas.length >= 3) break;
  }
  return {
    ...(typeof a.users === 'string' && a.users.trim() ? { users: a.users.trim() } : {}),
    can: texts(a.can, 8),
    worth: texts(a.worth, 6),
    ideas,
    parts,
    links: links.slice(0, 20),
  };
}

/**
 * A ticket was merged: the overview is brought up to date. What it can do today lists the merged work from the board
 * itself; the picture of the parts follows with the Architect's next read of the code, which runs when files came,
 * went or moved.
 */
export function overviewAfterMerge(bp: BoardPaths, at = new Date().toISOString()): void {
  if (!hasOverview(bp)) return;
  writeOverview(bp, { ...readOverview(bp), refreshedAt: at });
}

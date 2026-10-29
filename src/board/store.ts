import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Actor, BoardMeta, Decision, Release, Ticket } from './types.js';

export interface BoardPaths {
  dir: string;
  metaFile: string;
  ticketsDir: string;
  decisionsDir: string;
  releasesDir: string;
  proofDir: string;
}

export function boardPaths(squadDir: string): BoardPaths {
  const dir = path.join(squadDir, 'board');
  return {
    dir,
    metaFile: path.join(dir, 'board.yaml'),
    ticketsDir: path.join(dir, 'tickets'),
    decisionsDir: path.join(dir, 'decisions'),
    releasesDir: path.join(dir, 'releases'),
    proofDir: path.join(dir, 'proof'),
  };
}

export function boardExists(bp: BoardPaths): boolean {
  return fs.existsSync(bp.metaFile);
}

export function now(): string {
  return new Date().toISOString();
}

function readYaml<T>(file: string): T {
  return yaml.load(fs.readFileSync(file, 'utf8')) as T;
}

/** Write through a temp file so the console and a terminal command never see half a file. */
function writeYaml(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, yaml.dump(data, { lineWidth: 110, noRefs: true }), 'utf8');
  fs.renameSync(tmp, file);
}

function listYaml<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => readYaml<T>(path.join(dir, f)));
}

export function readMeta(bp: BoardPaths): BoardMeta {
  return readYaml<BoardMeta>(bp.metaFile);
}

export function writeMeta(bp: BoardPaths, meta: BoardMeta): void {
  writeYaml(bp.metaFile, meta);
}

function idNumber(id: string): number {
  return Number(id.replace(/^\D+/, '')) || 0;
}

export function listTickets(bp: BoardPaths): Ticket[] {
  return listYaml<Ticket>(bp.ticketsDir).sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

export function readTicket(bp: BoardPaths, id: string): Ticket | null {
  const file = path.join(bp.ticketsDir, `${id.toUpperCase()}.yaml`);
  return fs.existsSync(file) ? readYaml<Ticket>(file) : null;
}

export function requireTicket(bp: BoardPaths, id: string): Ticket {
  const ticket = readTicket(bp, id);
  if (!ticket) throw new Error(`No ticket ${id.toUpperCase()} on this board.`);
  return ticket;
}

export function writeTicket(bp: BoardPaths, ticket: Ticket): void {
  writeYaml(path.join(bp.ticketsDir, `${ticket.id}.yaml`), ticket);
}

/** Read, change and save one ticket. */
export function updateTicket(bp: BoardPaths, id: string, change: (t: Ticket) => void): Ticket {
  const ticket = requireTicket(bp, id);
  change(ticket);
  writeTicket(bp, ticket);
  return ticket;
}

export function nextTicketId(bp: BoardPaths): string {
  const meta = readMeta(bp);
  const id = `${meta.key}-${meta.nextNumber}`;
  meta.nextNumber += 1;
  writeMeta(bp, meta);
  return id;
}

export function addActivity(ticket: Ticket, who: Actor, text: string): void {
  ticket.activity.unshift({ at: now(), who, text });
}

export function listDecisions(bp: BoardPaths): Decision[] {
  return listYaml<Decision>(bp.decisionsDir).sort((a, b) => idNumber(b.id) - idNumber(a.id));
}

export function writeDecision(bp: BoardPaths, decision: Decision): void {
  writeYaml(path.join(bp.decisionsDir, `${decision.id}.yaml`), decision);
}

export function nextDecisionId(bp: BoardPaths): string {
  const top = listDecisions(bp)[0];
  const n = top ? idNumber(top.id) + 1 : 1;
  return `ADR-${String(n).padStart(3, '0')}`;
}

function versionKey(v: string): number[] {
  return v.replace(/^v/, '').split('.').map(Number);
}

export function listReleases(bp: BoardPaths): Release[] {
  return listYaml<Release>(bp.releasesDir).sort((a, b) => {
    const [x, y] = [versionKey(a.version), versionKey(b.version)];
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
}

export function readRelease(bp: BoardPaths, version: string): Release | null {
  const v = version.startsWith('v') ? version : `v${version}`;
  const file = path.join(bp.releasesDir, `${v}.yaml`);
  return fs.existsSync(file) ? readYaml<Release>(file) : null;
}

export function writeRelease(bp: BoardPaths, release: Release): void {
  writeYaml(path.join(bp.releasesDir, `${release.version}.yaml`), release);
}

export function draftRelease(bp: BoardPaths): Release | null {
  return listReleases(bp).find((r) => r.status === 'draft') ?? null;
}

export function latestRelease(bp: BoardPaths): Release | null {
  return listReleases(bp).find((r) => r.status === 'released') ?? null;
}

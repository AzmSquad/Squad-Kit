import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { squadHome } from '../core/home.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../core/config.js';
import { isMediaNote } from '../engine/media.js';
import {
  LAYOUT,
  boardPaths,
  hasLegacyBoard,
  listDecisions,
  listReleases,
  newProjectId,
  readMeta,
  readTicket,
  ticketDir,
  ticketFilesDir,
  ticketMediaDir,
  writeDecision,
  writeMeta,
  writeRelease,
  writeTicket,
  type BoardPaths,
} from './store.js';
import type { BoardMeta, Decision, Release, Ticket } from './types.js';
import { runningConsole } from './console-info.js';

/**
 * Moves a board from the layout before ADR-001 (everything in `.squad/board/`) to the two homes, once. A full copy of
 * `.squad/` is kept first; every ticket, decision and release read back from the new files must equal the old one,
 * or the old files come back and nothing changes.
 */

export interface MoveReport {
  tickets: number;
  decisions: number;
  releases: number;
  files: number;
  backup: string;
  /** This computer's folder for the project now. */
  localDir: string;
}

export class MoveError extends Error {}

const read = <T>(file: string): T => yaml.load(fs.readFileSync(file, 'utf8')) as T;

function listYaml<T>(dir: string): T[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => read<T>(path.join(dir, f))) : [];
}

/** Notes written out from a voice or video note belong with it, on this computer. */
function isMediaFile(name: string): boolean {
  return isMediaNote(name) || /\.transcript\.txt$/.test(name) || /\.(ogg|opus|oga|m4a|mp3|wav|aac|amr|flac|weba|mp4|mov|m4v|webm)\.screen/.test(name);
}

function copyDir(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return fs.readdirSync(from).length;
}

/** Replaces every old file path inside a ticket with its new one. */
function repath<T>(v: T, map: Map<string, string>): T {
  if (typeof v === 'string') return (map.get(v) ?? v) as T;
  if (Array.isArray(v)) return v.map((x) => repath(x, map)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, repath(x, map)])) as T;
  return v;
}

/** The same in meaning: text without outer spaces, and an option not chosen with or without `chosen: false`. */
function same(v: unknown): unknown {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(same);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k, x]) => x !== undefined && !(k === 'chosen' && x === false))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, same(x)]),
    );
  }
  return v;
}

function differences(label: string, before: unknown, after: unknown): string[] {
  const a = same(before) as Record<string, unknown>;
  const b = same(after) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${label}: ${k}`);
}

/**
 * Opens a project's board, moving it to the new layout first when it is still in the old one. Never while that
 * board runs somewhere: squad-kit moves its files once, when nothing is running.
 */
export function openBoard(squadDir: string): { bp: BoardPaths; moved: MoveReport | null } {
  const bp = boardPaths(squadDir);
  if (!hasLegacyBoard(bp)) return { bp, moved: null };
  if (runningConsole(bp)) throw new MoveError('This board is open somewhere else. Close it first (or run: squad console --restart): squad-kit moves its files to the new layout once, while nothing runs.');
  const moved = moveBoard(bp);
  return { bp: boardPaths(squadDir), moved };
}

export function moveBoard(bp: BoardPaths, now = new Date()): MoveReport {
  if (!hasLegacyBoard(bp)) throw new MoveError('There is no board to move: it is moved already, or there is none.');
  const legacy = bp.legacyDir;
  const meta = read<BoardMeta>(path.join(legacy, 'board.yaml'));
  const backup = path.join(squadHome(), 'backups', `${path.basename(bp.root)}-${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.cpSync(bp.squadDir, backup, { recursive: true });

  const id = newProjectId(meta.project || path.basename(bp.root));
  const configBefore = fs.existsSync(bp.configFile) ? fs.readFileSync(bp.configFile, 'utf8') : null;
  let next: BoardPaths | null = null;
  const created = (p: BoardPaths) => [p.ticketsDir, p.decisionsDir, p.releasesDir, p.rulesDir, p.knowledgeDir, p.localDir];
  // Only folders this move makes are removed if it fails: a project's own folders of these names are left alone.
  const before = new Set([...created(bp)].filter((d) => fs.existsSync(d)));
  try {
    // The project's id first: it names this computer's folder for the project.
    const config = configBefore !== null ? loadConfig(bp.configFile) : { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: meta.project } };
    saveConfig(bp.configFile, { ...config, board: { id } });
    next = boardPaths(bp.squadDir);
    if (next.projectId !== id) throw new MoveError('The new settings did not save the project id.');
    writeMeta(next, { ...meta, id, layout: LAYOUT, documentsInGit: meta.documentsInGit ?? true });

    let files = copyDir(path.join(legacy, 'agents'), next.rulesDir);
    files += copyDir(path.join(legacy, 'context', 'wiki'), next.wikiDir);
    files += copyDir(path.join(legacy, 'proof'), next.proofDir);
    files += copyDir(path.join(legacy, 'sessions'), next.chatsDir);
    // The board's link and port carry over, so an open browser tab keeps working.
    if (fs.existsSync(path.join(legacy, 'console.json'))) fs.copyFileSync(path.join(legacy, 'console.json'), next.consoleFile);
    const oldSecrets = path.join(bp.squadDir, 'secrets.yaml');
    if (fs.existsSync(oldSecrets)) {
      fs.mkdirSync(path.dirname(next.secretsFile), { recursive: true });
      fs.copyFileSync(oldSecrets, next.secretsFile);
      fs.chmodSync(next.secretsFile, 0o600);
    }

    // Tickets: their files go to the ticket's folder, or to this computer for voice and video notes.
    const tickets = listYaml<Ticket>(path.join(legacy, 'tickets'));
    const moved: Ticket[] = [];
    for (const t of tickets) {
      const map = new Map<string, string>();
      const from = path.join(legacy, 'attachments', t.id);
      if (fs.existsSync(from)) {
        for (const name of fs.readdirSync(from)) {
          const src = path.join(from, name);
          if (!fs.statSync(src).isFile()) continue;
          const dest = name === 'mockup.html' ? path.join(ticketDir(next, t.id), name) : isMediaFile(name) ? path.join(ticketMediaDir(next, t.id), name) : path.join(ticketFilesDir(next, t.id), name);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          map.set(src, dest);
          files += 1;
        }
      }
      const nt = repath(t, map);
      writeTicket(next, nt);
      moved.push(nt);
    }
    const decisions = listYaml<Decision>(path.join(legacy, 'decisions'));
    for (const d of decisions) writeDecision(next, d);
    const releases = listYaml<Release>(path.join(legacy, 'releases'));
    for (const r of releases) writeRelease(next, r);

    // Every record read back from the new files must equal the old one.
    const problems: string[] = [];
    for (const t of moved) {
      const back = readTicket(next, t.id);
      if (!back) problems.push(`${t.id}: missing`);
      else problems.push(...differences(t.id, t, back));
    }
    const decisionsBack = new Map(listDecisions(next).map((d) => [d.id, d]));
    for (const d of decisions) problems.push(...differences(d.id, d, decisionsBack.get(d.id) ?? {}));
    const releasesBack = new Map(listReleases(next).map((r) => [r.version, r]));
    for (const r of releases) problems.push(...differences(r.version, r, releasesBack.get(r.version) ?? {}));
    const metaBack = readMeta(next);
    for (const k of ['project', 'key', 'nextNumber', 'engine', 'commands', 'git', 'repos', 'map', 'lessons'] as const) {
      if (JSON.stringify(same(meta[k])) !== JSON.stringify(same(metaBack[k]))) problems.push(`board settings: ${k}`);
    }
    if (JSON.stringify(same(meta.blueprint?.stack ?? [])) !== JSON.stringify(same(metaBack.blueprint?.stack ?? []))) problems.push('board settings: stack');
    if (problems.length) throw new MoveError(`The new files did not match the old ones, so nothing changed: ${problems.slice(0, 8).join('; ')}`);

    // All good: the old layout goes; the copy in the backup stays.
    fs.rmSync(legacy, { recursive: true, force: true });
    fs.rmSync(oldSecrets, { force: true });
    return { tickets: moved.length, decisions: decisions.length, releases: releases.length, files, backup, localDir: next.localDir };
  } catch (err) {
    // Put everything back the way it was.
    for (const dir of [...created(bp), ...(next ? created(next) : [])]) if (!before.has(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (configBefore === null) fs.rmSync(bp.configFile, { force: true });
    else fs.writeFileSync(bp.configFile, configBefore, 'utf8');
    if (err instanceof MoveError) throw err;
    throw new MoveError(`Moving the board failed, so nothing changed: ${(err as Error).message}`);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../core/config.js';
import { squadHome } from '../core/home.js';
import { git } from '../engine/git.js';
import { BOARD_STAGES } from './types.js';
import { REVIEW_HOME } from './review-types.js';
import type { Actor, BoardMeta, Decision, Question, Release, Step, Ticket } from './types.js';
import { pauseClock, trackStage, waitsNow } from './clock.js';
import { clearStaleStop, oldStop } from './stale-stop.js';
import { dropOldChecked, showOutsideStep } from './outside-step.js';
import { hasMergeMarks, isPlain, wrongField, type FieldShape } from './shape.js';
import { decisionDoc, lessonsDoc, parseDecisionDoc, parseLessonsDoc, parseProjectDoc, parseReleaseDoc, parseStackDoc, projectDoc, readTicketDocs, releaseDoc, stackDoc, ticketDocs, type TicketDocInput } from './docs.js';

/**
 * The board's files, in two homes (ADR-001). The project's `.squad/` holds its memory: settings, rules, knowledge,
 * decisions, tickets and releases, as files people can read and share. `~/.squad-kit/projects/<id>/` holds what
 * belongs to this computer: live state, activity, agent chats, screenshots, voice notes and tokens. Every read
 * joins the two; every write splits them again, so the rest of squad-kit sees one ticket as before.
 */

export const LAYOUT = 2;

export interface BoardPaths {
  /** The project folder: its code (or its repos) and `.squad/`. */
  root: string;
  /** `.squad/`, the project's memory. */
  squadDir: string;
  configFile: string;
  ticketsDir: string;
  decisionsDir: string;
  releasesDir: string;
  /** The agents' files: tool, levels and house rules. */
  rulesDir: string;
  knowledgeDir: string;
  wikiDir: string;
  /** Links the two homes. */
  projectId: string;
  /** This computer's folder for the project. */
  localDir: string;
  localMetaFile: string;
  /** Each ticket's live state. */
  stateDir: string;
  /** Every agent conversation, one ACP log per session. */
  chatsDir: string;
  proofDir: string;
  /** Voice and video notes, by ticket, with their written text and screen pictures. */
  mediaDir: string;
  consoleFile: string;
  pidFile: string;
  secretsFile: string;
  /** Where everything lived before layout 2. Only the move reads it. */
  legacyDir: string;
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

/** The project's id: saved in its settings; until then one made from the folder, the way ticket copies are named. */
function projectIdOf(squadDir: string): string {
  try {
    const raw = yaml.load(fs.readFileSync(path.join(squadDir, 'config.yaml'), 'utf8')) as { board?: { id?: string } } | undefined;
    if (raw?.board?.id) return String(raw.board.id);
  } catch {
    // No settings yet.
  }
  const root = path.resolve(path.dirname(squadDir));
  return `${path.basename(root).replace(/[^\w.-]+/g, '-') || 'project'}-${hash(root)}`;
}

export function boardPaths(squadDir: string): BoardPaths {
  const squad = path.resolve(squadDir);
  const projectId = projectIdOf(squad);
  const localDir = path.join(squadHome(), 'projects', projectId);
  return {
    root: path.dirname(squad),
    squadDir: squad,
    configFile: path.join(squad, 'config.yaml'),
    ticketsDir: path.join(squad, 'tickets'),
    decisionsDir: path.join(squad, 'decisions'),
    releasesDir: path.join(squad, 'releases'),
    rulesDir: path.join(squad, 'rules'),
    knowledgeDir: path.join(squad, 'knowledge'),
    wikiDir: path.join(squad, 'knowledge', 'wiki'),
    projectId,
    localDir,
    localMetaFile: path.join(localDir, 'board.yaml'),
    stateDir: path.join(localDir, 'state'),
    chatsDir: path.join(localDir, 'chats'),
    proofDir: path.join(localDir, 'proof'),
    mediaDir: path.join(localDir, 'files'),
    consoleFile: path.join(localDir, 'console.json'),
    pidFile: path.join(localDir, 'squad.pid'),
    secretsFile: path.join(localDir, 'secrets.yaml'),
    legacyDir: path.join(squad, 'board'),
  };
}

/** A board in the layout before ADR-001, waiting to be moved. */
export function hasLegacyBoard(bp: BoardPaths): boolean {
  return fs.existsSync(path.join(bp.legacyDir, 'board.yaml')) && !configBoard(bp);
}

export function boardExists(bp: BoardPaths): boolean {
  return Boolean(configBoard(bp));
}

export function now(): string {
  return new Date().toISOString();
}

/* ── Files ──────────────────────────────────────────────── */

/** Write through a temp file so the console and a terminal command never see half a file. Unchanged files are left alone. */
function writeFile(file: string, text: string): void {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function dumpYaml(data: unknown): string {
  return yaml.dump(JSON.parse(JSON.stringify(data)), { lineWidth: 110, noRefs: true });
}

function readYaml<T>(file: string): T | undefined {
  return fs.existsSync(file) ? (yaml.load(fs.readFileSync(file, 'utf8')) as T) : undefined;
}

function readText(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

/** Reads are cached by the files' change times, so a board with thousands of tickets stays fast. */
const cache = new Map<string, { stamp: string; value: unknown }>();

function stampOf(files: string[]): string {
  return files.map((f) => (fs.existsSync(f) ? `${fs.statSync(f).mtimeMs}:${fs.statSync(f).size}` : '-')).join('|');
}

function cached<T>(key: string, files: string[], read: () => T): T {
  const stamp = stampOf(files);
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return structuredClone(hit.value) as T;
  const value = read();
  cache.set(key, { stamp, value });
  return structuredClone(value);
}

/* ── Board settings ─────────────────────────────────────── */

/** The board's settings that belong to the project, kept in `.squad/config.yaml` under `board:`. */
const PROJECT_META = ['id', 'layout', 'documentsInGit', 'quality', 'allowedHosts', 'network', 'guard', 'project', 'key', 'nextNumber', 'engine', 'commands', 'noTests', 'alwaysNewTests', 'git', 'repos', 'parts', 'atOnce', 'delivery', 'localFiles', 'lockedFiles', 'database'] as const;
/** What the project knows, kept in `.squad/knowledge/` as Markdown. */
const KNOWLEDGE_META = ['map', 'lessons'] as const;

/** The board's settings as pages and the squad read them. A tool may write any of these in the wrong type. */
const BOARD_FIELDS: Record<string, FieldShape> = {
  id: 'text',
  project: 'text',
  key: 'text',
  nextNumber: 'number',
  engine: 'text',
  quality: 'text',
  delivery: 'text',
  atOnce: 'number',
  documentsInGit: 'yes-no',
  alwaysNewTests: 'yes-no',
  git: 'object',
  commands: 'object',
  guard: 'object',
  repos: 'objects',
  parts: 'objects',
  localFiles: 'objects',
  lockedFiles: 'objects',
  database: 'object',
  allowedHosts: 'texts',
  network: 'text',
};

function configBoard(bp: BoardPaths): Record<string, unknown> | undefined {
  try {
    const board = (yaml.load(fs.readFileSync(bp.configFile, 'utf8')) as { board?: unknown } | undefined)?.board;
    return isPlain(board) && !wrongField(board, BOARD_FIELDS) ? board : undefined;
  } catch {
    return undefined;
  }
}

/** The project's settings file is there and cannot be read (merge marks, a broken edit): the board must say so, not "no board yet". */
export function settingsProblem(bp: BoardPaths): string | null {
  if (!fs.existsSync(bp.configFile)) return null;
  try {
    const raw = yaml.load(fs.readFileSync(bp.configFile, 'utf8')) as { board?: unknown } | null;
    if (raw && typeof raw === 'object' && (raw.board === undefined || configBoard(bp))) return null;
  } catch {
    // Said below.
  }
  return "This project's settings file could not be read, so its board cannot open. Nothing is lost. An engineer can look at it.";
}

function knowledgeFiles(bp: BoardPaths) {
  return { project: path.join(bp.knowledgeDir, 'project.md'), lessons: path.join(bp.knowledgeDir, 'lessons.md'), stack: path.join(bp.knowledgeDir, 'stack.md') };
}

export function readMeta(bp: BoardPaths): BoardMeta {
  const k = knowledgeFiles(bp);
  return cached(`meta:${bp.squadDir}`, [bp.configFile, bp.localMetaFile, k.project, k.lessons, k.stack], () => {
    const board = configBoard(bp);
    if (!board) throw new Error(`No board in ${bp.squadDir}. Open it with: squad console`);
    const local = readYaml<Partial<BoardMeta>>(bp.localMetaFile) ?? {};
    const project = readText(k.project);
    const known = project ? parseProjectDoc(project) : { map: [] };
    const lessons = readText(k.lessons);
    const stack = readText(k.stack);
    const meta = { ...local, ...board, map: known.map, lessons: lessons ? parseLessonsDoc(lessons) : [] } as BoardMeta;
    if (local.scan || known.summary !== undefined) meta.scan = { status: 'done', ...local.scan, ...(known.summary !== undefined ? { summary: known.summary } : {}) };
    if (local.blueprint || stack) meta.blueprint = { status: 'done', ...local.blueprint, ...(stack ? parseStackDoc(stack) : { stack: [], patterns: [] }) };
    return meta;
  });
}

export function writeMeta(bp: BoardPaths, meta: BoardMeta): void {
  const full = { ...meta, id: meta.id ?? bp.projectId, layout: meta.layout ?? LAYOUT };
  const project = Object.fromEntries(PROJECT_META.filter((key) => full[key] !== undefined).map((key) => [key, full[key]]));
  const local: Record<string, unknown> = { ...full };
  for (const key of [...PROJECT_META, ...KNOWLEDGE_META]) delete local[key];
  const { summary, ...scanLocal } = full.scan ?? ({} as NonNullable<BoardMeta['scan']>);
  const { stack, patterns, ...blueprintLocal } = full.blueprint ?? ({} as NonNullable<BoardMeta['blueprint']>);
  if (full.scan) local.scan = scanLocal;
  if (full.blueprint) local.blueprint = blueprintLocal;

  // Project settings: in config.yaml, next to the 0.x settings, which stay as they are.
  const config = fs.existsSync(bp.configFile) ? loadConfig(bp.configFile) : { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: full.project } };
  if (JSON.stringify(config.board) !== JSON.stringify(JSON.parse(JSON.stringify(project)))) {
    fs.mkdirSync(bp.squadDir, { recursive: true });
    saveConfig(bp.configFile, { ...config, board: JSON.parse(JSON.stringify(project)) as Record<string, unknown> });
  }
  const k = knowledgeFiles(bp);
  if (full.map?.length || summary !== undefined || fs.existsSync(k.project)) writeFile(k.project, projectDoc(summary, full.map ?? []));
  if (full.lessons?.length || fs.existsSync(k.lessons)) writeFile(k.lessons, lessonsDoc(full.lessons ?? []));
  if (stack?.length || patterns?.length || fs.existsSync(k.stack)) writeFile(k.stack, stackDoc({ stack: stack ?? [], patterns: patterns ?? [] }));
  writeFile(bp.localMetaFile, dumpYaml(local));
}

/* ── Tickets ────────────────────────────────────────────── */

/**
 * Where each ticket field lives. The project keeps what another person needs to carry on; this computer keeps what
 * changes while the squad works. A new field must be given a home here, or squad-kit does not compile.
 */
export const TICKET_HOME = {
  id: 'project',
  title: 'project',
  ask: 'project',
  kind: 'project',
  source: 'project',
  priority: 'project',
  stage: 'project',
  track: 'project',
  noNewTests: 'project',
  createdAt: 'project',
  createdBy: 'project',
  owner: 'project',
  handedOver: 'project',
  archived: 'project',
  builder: 'project',
  reviewer: 'project',
  repo: 'project',
  branch: 'project',
  follows: 'project',
  work: 'project',
  gates: 'project',
  specApproved: 'project',
  overrides: 'project',
  blips: 'local',
  outdated: 'project',
  release: 'project',
  foundIn: 'project',
  severity: 'project',
  pr: 'project',
  mergedAt: 'project',
  setsUp: 'project',
  brief: 'project',
  story: 'project',
  criteria: 'project',
  releaseNote: 'project',
  alsoChanged: 'project',
  added: 'project',
  decision: 'project',
  notes: 'project',
  proof: 'project',
  offScreen: 'project',
  // Which tools this computer has: another computer may take the pictures on the phone.
  picturesNote: 'local',
  mockup: 'project',
  changes: 'project',
  changeOf: 'project',
  dependsOn: 'project',
  dependency: 'project',
  breakdown: 'project',
  decided: 'project',
  // Split: the questions' answers, the steps' titles and files inside the ticket's folder are the project's;
  // the talk about a question, the steps' progress and voice notes stay here.
  questions: 'project',
  steps: 'project',
  attachments: 'project',
  status: 'local',
  live: 'local',
  progress: 'local',
  waiting: 'local',
  activity: 'local',
  squad: 'local',
  sessions: 'local',
  worktree: 'local',
  baseCommit: 'local',
  hookOwed: 'project',
  hookFixTried: 'local',
  tries: 'local',
  fails: 'local',
  proofRound: 'local',
  retryPhase: 'local',
  capRaise: 'local',
  createKey: 'local',
  stopRequested: 'local',
  lead: 'local',
  split: 'project',
  ...REVIEW_HOME,
  localSetup: 'local',
  setupTrouble: 'local',
  setupFor: 'local',
  setupOwed: 'local',
  parts: 'project',
  storyDir: 'local',
  copies: 'local',
  replanFor: 'local',
  interrupted: 'local',
  selfAccept: 'local',
  quiet: 'local',
  quietSnoozedUntil: 'local',
  trackerQueue: 'local',
  trackerRetry: 'local',
  checksContinued: 'local',
  oldTests: 'project',
  waitsToStart: 'local',
  onMain: 'local',
  weakenedContinued: 'local',
  addedSkipped: 'local',
  testSuggestion: 'local',
  testChange: 'local',
  testDecided: 'local',
  builtPlan: 'local',
  notesSeen: 'local',
  takenOver: 'local',
  outside: 'project',
  stuck: 'local',
  // With the clash card it belongs to, and what this computer last heard from the code host.
  clashedPr: 'local',
  prClosed: 'local',
  contribution: 'local',
  changeRequest: 'local',
  agentQuestion: 'local',
  chat: 'local',
  planReview: 'local',
  usage: 'local',
  history: 'local',
  quality: 'local',
  budgetOk: 'local',
  clock: 'local',
  stageTimes: 'local',
  retryOnStop: 'local',
  deleting: 'local',
  baseWanted: 'local',
  seenOn: 'local',
  ownerDeleted: 'local',
} as const satisfies Record<keyof Ticket, 'project' | 'local'>;

/** The live part of a ticket on this computer, plus the parts of split fields that stay here. */
interface TicketState extends Partial<Ticket> {
  stepState?: Omit<Step, 'title'>[];
  questionState?: Record<string, Pick<Question, 'thread' | 'thinking'>>;
  localFiles?: string[];
}

export function ticketDir(bp: BoardPaths, id: string): string {
  return path.join(bp.ticketsDir, id.toUpperCase());
}

/** Where people's attached files go: images and documents with the project, voice and video notes on this computer. */
export function ticketFilesDir(bp: BoardPaths, id: string): string {
  return path.join(ticketDir(bp, id), 'files');
}

export function ticketMediaDir(bp: BoardPaths, id: string): string {
  return path.join(bp.mediaDir, id.toUpperCase());
}

const DOC_FILES = ['ticket.md', 'spec.md', 'questions.md', 'design.md', 'notes.md', 'proof.md', 'review.md'];

function stateFile(bp: BoardPaths, id: string): string {
  return path.join(bp.stateDir, `${id.toUpperCase()}.yaml`);
}

/** A ticket's live state on this computer. A delete cut off half-way may leave only this. */
export function ticketStateFile(bp: BoardPaths, id: string): string {
  return stateFile(bp, id);
}

function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function splitTicket(bp: BoardPaths, t: Ticket): { docs: Record<string, string>; state: TicketState } {
  const folder = ticketDir(bp, t.id);
  const project: Record<string, unknown> = {};
  const state: TicketState = {};
  for (const [key, home] of Object.entries(TICKET_HOME) as [keyof Ticket, 'project' | 'local'][]) {
    if (t[key] === undefined) continue;
    if (home === 'project') project[key] = t[key];
    else (state as Record<string, unknown>)[key] = t[key];
  }
  if (t.steps) state.stepState = t.steps.map(({ title: _title, ...rest }) => rest);
  const talk = Object.fromEntries(
    (t.questions ?? [])
      .filter((q) => q.thread !== undefined || q.thinking !== undefined)
      .map((q) => [q.id, { ...(q.thread !== undefined ? { thread: q.thread } : {}), ...(q.thinking !== undefined ? { thinking: q.thinking } : {}) }]),
  );
  if (Object.keys(talk).length) state.questionState = talk;
  const files = (t.attachments ?? []).filter((f) => inside(folder, f)).map((f) => path.relative(folder, f));
  const localFiles = (t.attachments ?? []).filter((f) => !inside(folder, f));
  if (localFiles.length) state.localFiles = localFiles;
  delete project.attachments;
  if (t.mockup) project.mockup = inside(folder, t.mockup) ? path.relative(folder, t.mockup) : t.mockup;
  const input = { ...project, ...(files.length ? { files } : {}) } as TicketDocInput;
  return { docs: ticketDocs(input), state };
}

function joinTicket(bp: BoardPaths, id: string, docs: Record<string, string>, state: TicketState): Ticket {
  const folder = ticketDir(bp, id);
  const p = readTicketDocs(docs) as TicketDocInput & { files?: string[] };
  const { stepState, questionState, localFiles, ...live } = state;
  const t = { ...p, ...live } as Ticket & { files?: string[] };
  if (p.steps) t.steps = p.steps.map((s, i) => ({ ...s, ...(stepState?.[i] ?? {}) }));
  if (p.questions) t.questions = p.questions.map((q) => ({ ...q, ...(questionState?.[q.id] ?? {}) }));
  const files = [...(p.files ?? []).map((f) => path.join(folder, f)), ...(localFiles ?? [])];
  delete t.files;
  if (files.length) t.attachments = files;
  if (t.mockup && !path.isAbsolute(t.mockup)) t.mockup = path.join(folder, t.mockup);
  t.activity ??= [];
  t.waiting ??= null;
  t.status ??= '';
  // A stop from before the three verdicts: "not met" is what is now called broken.
  if ((t.stuck?.kind as string | undefined) === 'not-met') t.stuck!.kind = 'broken';
  // A ticket past review never shows a stop from before it; the next save drops it for good.
  if (oldStop(t)) clearStaleStop(t);
  // Worked on outside: its files say which step it is at.
  if (t.takenOver?.free) showOutsideStep(t);
  dropOldChecked(t);
  return t;
}

/** A ticket folder holds a ticket file, and that file cannot be read. Its words are the ones the person sees. */
export class UnreadableTicket extends Error {
  constructor(
    readonly id: string,
    /** The exact reason, for engineers. */
    readonly detail: string,
    /** The file in the ticket's folder that holds the trouble. */
    readonly file = 'ticket.md',
  ) {
    super(`${id} could not be read: its file is damaged, so it is not on the board. Nothing is lost. An engineer can look at it.`);
    this.name = 'UnreadableTicket';
  }
}

const STAGES = new Set<string>([...BOARD_STAGES, 'done']);

/** The project's part of a ticket, as pages read it: a tool may write any of these in the wrong type. */
const TICKET_FIELDS: Record<string, FieldShape> = {
  kind: 'text',
  priority: 'text',
  track: 'text',
  owner: 'text',
  builder: 'text',
  reviewer: 'text',
  repo: 'text',
  branch: 'text',
  release: 'text',
  foundIn: 'text',
  severity: 'text',
  mergedAt: 'text',
  changeOf: 'text',
  mockup: 'text',
  parts: 'texts',
  follows: 'texts',
  dependsOn: 'texts',
  alsoChanged: 'texts',
  oldTests: 'texts',
  decided: 'objects',
  added: 'objects',
  overrides: 'objects',
  outdated: 'objects',
  work: 'object',
  gates: 'object',
  brief: 'object',
  pr: 'object',
  specApproved: 'object',
  dependency: 'object',
  breakdown: 'object',
  handedOver: 'object',
  outside: 'object',
  archived: 'object',
  setsUp: 'yes-no',
  hookOwed: 'yes-no',
  noNewTests: 'yes-no',
};

/** What squad-kit needs from a ticket file for the ticket to show at all, or why it does not have it. */
function shapeProblem(t: Partial<Ticket>, id: string): string | null {
  for (const key of ['id', 'title', 'createdAt', 'createdBy'] as const) if (typeof t[key] !== 'string' || !t[key]) return `It has no ${key}.`;
  if (t.id!.toUpperCase() !== id.toUpperCase()) return `Its id says ${t.id}, in the folder of ${id.toUpperCase()}.`;
  if (!STAGES.has(String(t.stage))) return `"${String(t.stage)}" is not a stage.`;
  if (typeof t.source?.type !== 'string') return 'It does not say where it came from.';
  return wrongField(t as Record<string, unknown>, TICKET_FIELDS);
}

/** A file of the ticket squad-kit cannot make sense of. The next save would write over it and lose what it holds. */
function docProblem(docs: Record<string, string>, t: Partial<Ticket>): { file: string; detail: string } | null {
  for (const [file, text] of Object.entries(docs)) if (hasMergeMarks(text)) return { file, detail: 'It still has the marks of a merge in it.' };
  const says: Record<string, () => boolean> = {
    'spec.md': () => t.story !== undefined || t.criteria !== undefined || t.releaseNote !== undefined || t.changes !== undefined,
    'questions.md': () => Boolean(t.questions?.length),
    'design.md': () => Boolean(t.decision || t.steps),
    'notes.md': () => Boolean(t.notes?.length),
    'proof.md': () => Boolean(t.proof?.length),
    'review.md': () => Boolean(t.review),
  };
  // Only its title is fine: an empty proof is written that way.
  for (const [file, read] of Object.entries(says)) if (docs[file]?.replace(/^# .*$/m, '').trim() && !read()) return { file, detail: 'It holds none of the parts squad-kit reads from that file.' };
  return null;
}

/** Why one of a ticket's files could not be read, with the file it was. */
class TicketFileProblem extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(detail);
  }
}

function readTicketFiles(bp: BoardPaths, id: string): Ticket | null {
  const folder = ticketDir(bp, id);
  const files = [...DOC_FILES.map((f) => path.join(folder, f)), stateFile(bp, id)];
  if (!fs.existsSync(files[0]!)) return null;
  try {
    return cached(`ticket:${folder}`, files, () => {
      // A tool on another system may end its lines differently: the words are the same.
      const docs = Object.fromEntries(DOC_FILES.map((f) => [f, readText(path.join(folder, f))?.replace(/\r\n/g, '\n')]).filter(([, v]) => v !== undefined)) as Record<string, string>;
      const t = joinTicket(bp, id.toUpperCase(), docs, readYaml<TicketState>(stateFile(bp, id)) ?? {});
      const wrong = shapeProblem(t, id);
      if (wrong) throw new Error(wrong);
      const doc = docProblem(docs, t);
      if (doc) throw new TicketFileProblem(doc.file, doc.detail);
      return t;
    });
  } catch (err) {
    throw new UnreadableTicket(id.toUpperCase(), (err as Error).message, err instanceof TicketFileProblem ? err.file : undefined);
  }
}

function idNumber(id: string): number {
  return Number(id.replace(/^\D+/, '').replace(/\D.*$/, '')) || 0;
}

export function listTickets(bp: BoardPaths): Ticket[] {
  if (!fs.existsSync(bp.ticketsDir)) return [];
  return fs
    .readdirSync(bp.ticketsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readableTicket(bp, d.name))
    .filter((t): t is Ticket => Boolean(t))
    .sort((a, b) => idNumber(a.id) - idNumber(b.id) || a.id.localeCompare(b.id));
}

export function readTicket(bp: BoardPaths, id: string): Ticket | null {
  return readTicketFiles(bp, id);
}

/** The ticket, or null when it is not there or its file cannot be read: for a list that goes on with the others. */
export function readableTicket(bp: BoardPaths, id: string): Ticket | null {
  try {
    return readTicketFiles(bp, id);
  } catch {
    return null;
  }
}

/** The plain words when this ticket's file cannot be read, else null. */
export function ticketProblem(bp: BoardPaths, id: string): string | null {
  try {
    readTicketFiles(bp, id);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** A ticket the board cannot show: the person's words, and for engineers the file and why. */
export interface BrokenTicket {
  id: string;
  problem: string;
  file: string;
  detail: string;
}

/**
 * The ticket folders that hold a ticket file which cannot be read, so they are never silently gone from the board. A
 * folder with no ticket file is not a ticket, and stays out of this. `listed`: the tickets read already, not read twice.
 */
export function brokenTickets(bp: BoardPaths, listed: Ticket[] = listTickets(bp)): BrokenTicket[] {
  if (!fs.existsSync(bp.ticketsDir)) return [];
  const read = new Set(listed.map((t) => t.id));
  const out: BrokenTicket[] = [];
  for (const d of fs.readdirSync(bp.ticketsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || read.has(d.name.toUpperCase())) continue;
    try {
      readTicketFiles(bp, d.name);
    } catch (err) {
      const e = err as UnreadableTicket;
      out.push({ id: e.id, problem: e.message, file: path.relative(bp.root, path.join(ticketDir(bp, e.id), e.file)), detail: e.detail });
    }
  }
  return out.sort((a, b) => idNumber(a.id) - idNumber(b.id) || a.id.localeCompare(b.id));
}

export function requireTicket(bp: BoardPaths, id: string): Ticket {
  const ticket = readTicket(bp, id);
  if (!ticket) throw new Error(`No ticket ${id.toUpperCase()} on this board.`);
  return ticket;
}

export function writeTicket(bp: BoardPaths, ticket: Ticket): void {
  const folder = ticketDir(bp, ticket.id);
  const { docs, state } = splitTicket(bp, ticket);
  for (const f of DOC_FILES) {
    const file = path.join(folder, f);
    if (docs[f] !== undefined) writeFile(file, docs[f]);
    else if (fs.existsSync(file)) fs.rmSync(file);
  }
  writeFile(stateFile(bp, ticket.id), dumpYaml(state));
}

/**
 * Read, change and save one ticket. The time it spends in each stage is kept as it moves, and its step's clock stands
 * still while it waits.
 */
export function updateTicket(bp: BoardPaths, id: string, change: (t: Ticket) => void): Ticket {
  const ticket = requireTicket(bp, id);
  const stage = ticket.stage;
  change(ticket);
  trackStage(ticket, stage);
  if (waitsNow(ticket)) pauseClock(ticket);
  writeTicket(bp, ticket);
  return ticket;
}

/** Removes a ticket from both homes. */
export function removeTicket(bp: BoardPaths, id: string): void {
  fs.rmSync(ticketDir(bp, id), { recursive: true, force: true });
  fs.rmSync(stateFile(bp, id), { force: true });
  fs.rmSync(ticketMediaDir(bp, id), { recursive: true, force: true });
}

/** The tickets with a branch here or on a remote, as last fetched: "sk-12" for squad/sk-12. */
function branchNumbers(bp: BoardPaths): Set<string> {
  if (!fs.existsSync(path.join(bp.root, '.git'))) return new Set();
  const refs = git(bp.root, ['for-each-ref', '--format=%(refname)', 'refs/heads/squad', 'refs/remotes/*/squad/*'], { allowFail: true });
  return new Set(refs.split('\n').map((r) => r.split('/squad/')[1] ?? '').filter(Boolean));
}

/** The name of a ticket made on the board, for a project with no tracker: the project key and a number. */
export function nextTicketId(bp: BoardPaths): string {
  const meta = readMeta(bp);
  let id = `${meta.key}-${meta.nextNumber}`;
  // A teammate's ticket that reached a remote holds its number too: each computer counts on its own.
  const taken = branchNumbers(bp);
  while (fs.existsSync(ticketDir(bp, id)) || taken.has(id.toLowerCase())) {
    meta.nextNumber += 1;
    id = `${meta.key}-${meta.nextNumber}`;
  }
  meta.nextNumber += 1;
  writeMeta(bp, meta);
  return id;
}

export function addActivity(ticket: Ticket, who: Actor, text: string): void {
  ticket.activity.unshift({ at: now(), who, text });
}

/* ── Decisions ──────────────────────────────────────────── */

/** A decision, a release or a breakdown whose file cannot be read: the person's words, and for engineers the file and why. */
export interface BrokenRecord {
  kind: 'decision' | 'release' | 'breakdown';
  id: string;
  problem: string;
  file: string;
  detail: string;
}

const RECORD_WORD: Record<BrokenRecord['kind'], string> = { decision: 'Decision', release: 'Release', breakdown: 'Breakdown' };

/** What the person reads about a record that cannot be read. */
export function recordProblemWords(kind: BrokenRecord['kind'], id: string): string {
  return `${RECORD_WORD[kind]} ${id} could not be read: its file is damaged, so it is not shown here. Nothing is lost. An engineer can look at it.`;
}

interface DocKind<T> {
  kind: 'decision' | 'release';
  parse(text: string): T;
  /** What is wrong with it, for engineers; `name` is its file's name. */
  problem(x: T, name: string): string | null;
  /** The name squad-kit gives such a file. */
  named: RegExp;
  /** Words only a file of this kind holds, whatever it is called. */
  claims: RegExp;
}

interface DocRead<T> {
  value: T | null;
  /** Why this record cannot be read. Null with no value: not one of the board's records. */
  detail: string | null;
}

/**
 * One file in the board's folders. A project may keep its own notes there too (an older squad-kit wrote release notes
 * into releases/): a file that is neither named nor written as a record is left alone, not shown. One that is, and
 * cannot be read, is a plain problem the person sees.
 */
function readDoc<T>(file: string, kind: DocKind<T>): DocRead<T> {
  return cached(`doc:${file}`, [file], (): DocRead<T> => {
    const text = fs.readFileSync(file, 'utf8');
    const name = path.basename(file, '.md');
    let detail: string | null;
    let x: T | null = null;
    try {
      detail = hasMergeMarks(text) ? 'It still has the marks of a merge in it.' : null;
      x = kind.parse(text);
      detail ??= kind.problem(x, name);
    } catch (err) {
      detail = (err as Error).message;
    }
    if (!detail) return { value: x, detail: null };
    return { value: null, detail: kind.named.test(name) || kind.claims.test(text) ? detail : null };
  });
}

function docFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)) : [];
}

function listDocs<T>(dir: string, kind: DocKind<T>): T[] {
  return docFiles(dir).map((f) => readDoc(f, kind).value).filter((x): x is T => x !== null);
}

function brokenDocs<T>(bp: BoardPaths, dir: string, kind: DocKind<T>): BrokenRecord[] {
  return docFiles(dir).flatMap((f) => {
    const { detail } = readDoc(f, kind);
    const id = path.basename(f, '.md');
    return detail ? [{ kind: kind.kind, id, problem: recordProblemWords(kind.kind, id), file: path.relative(bp.root, f), detail }] : [];
  });
}

/** A date a tool wrote without quotes reads back as a date, not as words. */
function dayText(d: unknown): unknown {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

const DECISION_FIELDS: Record<string, FieldShape> = { from: 'text', approvedBy: 'text', date: 'text', area: 'text', replaces: 'text', replacedBy: 'text', tickets: 'texts', buildsOn: 'texts', proposed: 'yes-no' };

const DECISION_DOC: DocKind<Decision> = {
  kind: 'decision',
  parse(text) {
    const d = parseDecisionDoc(text);
    d.date = dayText(d.date) as string;
    if (typeof d.id === 'string' && typeof d.title === 'string') Object.assign(d, { tickets: d.tickets ?? [], from: d.from ?? '', approvedBy: d.approvedBy ?? '', date: d.date ?? '', checkedBy: d.checkedBy ?? null });
    return d;
  },
  problem(d, name) {
    if (typeof d.id !== 'string' || !/^[\w.-]+$/.test(d.id)) return 'It has no id.';
    if (typeof d.title !== 'string' || !d.title) return 'It has no title.';
    if (DECISION_DOC.named.test(name) && d.id !== name) return `Its id says ${d.id}, in the file of ${name}.`;
    if (d.checkedBy !== null && (typeof d.checkedBy !== 'object' || Array.isArray(d.checkedBy))) return '"checkedBy" is not in the right form.';
    return wrongField(d as unknown as Record<string, unknown>, DECISION_FIELDS);
  },
  named: /^([A-Za-z][\w-]*\.\d+|ADR-\d+)$/,
  claims: /^(id: |## Chosen$)/m,
};

/** Newest first: by date, then by name. */
export function listDecisions(bp: BoardPaths): Decision[] {
  return listDocs(bp.decisionsDir, DECISION_DOC).sort((a, b) => String(b.date).localeCompare(String(a.date)) || idNumber(b.id) - idNumber(a.id) || b.id.localeCompare(a.id));
}

/** Decisions whose file cannot be read, so they are never silently gone. */
export function brokenDecisions(bp: BoardPaths): BrokenRecord[] {
  return brokenDocs(bp, bp.decisionsDir, DECISION_DOC);
}

export function writeDecision(bp: BoardPaths, decision: Decision): void {
  writeFile(path.join(bp.decisionsDir, `${decision.id}.md`), decisionDoc(decision));
}

/**
 * A new decision's name (ADR-001): the ticket that made it and a number, like AB-80.1, so two people never make the
 * same name. A decision found in the existing code, made by no ticket, is STACK.1, STACK.2.
 */
export function nextDecisionId(bp: BoardPaths, ticketId?: string): string {
  const prefix = ticketId ? ticketId.toUpperCase() : 'STACK';
  // A file that cannot be read holds its name too, and is never written over.
  const taken = new Set([...listDecisions(bp).map((d) => d.id), ...brokenDecisions(bp).map((d) => d.id)]);
  let n = 1;
  while (taken.has(`${prefix}.${n}`)) n += 1;
  return `${prefix}.${n}`;
}

/* ── Releases ───────────────────────────────────────────── */

function versionKey(v: string): number[] {
  return v.replace(/^v/, '').split('.').map(Number);
}

/** What a release did on this computer (its log) stays here; the rest is the project's. */
function releaseStateFile(bp: BoardPaths, version: string): string {
  return path.join(bp.stateDir, 'releases', `${version}.yaml`);
}

/** A damaged file here only loses what the release did on this computer, never the release. */
function withReleaseState(bp: BoardPaths, r: Release): Release {
  let state: Pick<Release, 'log' | 'unpushed'> | undefined;
  try {
    state = readYaml<Pick<Release, 'log' | 'unpushed'>>(releaseStateFile(bp, r.version));
  } catch {
    state = undefined;
  }
  return { ...r, ...(Array.isArray(state?.log) ? { log: state.log } : {}), ...(Array.isArray(state?.unpushed) && state.unpushed.length ? { unpushed: state.unpushed } : {}) };
}

const RELEASE_FIELDS: Record<string, FieldShape> = { from: 'text', date: 'text', whatsappDraft: 'text', tickets: 'texts', bugs: 'texts', out: 'texts', addons: 'object', titles: 'object', gateStop: 'objects' };

const RELEASE_DOC: DocKind<Release> = {
  kind: 'release',
  parse(text) {
    const r = parseReleaseDoc(text);
    r.date = dayText(r.date) as string | undefined;
    if (r.date === undefined) delete r.date;
    if (typeof r.version === 'string') Object.assign(r, { tickets: r.tickets ?? [], from: r.from ?? '', addons: r.addons ?? { changelog: true, tag: true, pipeline: true, whatsapp: true } });
    return r;
  },
  problem(r, name) {
    if (typeof r.version !== 'string' || !/^v\d+\.\d+\.\d+[\w.-]*$/.test(r.version)) return 'It has no version.';
    if (r.status !== 'draft' && r.status !== 'released') return `"${String(r.status)}" is not a release's state.`;
    if (RELEASE_DOC.named.test(name) && r.version !== name) return `Its version says ${r.version}, in the file of ${name}.`;
    return wrongField(r as unknown as Record<string, unknown>, RELEASE_FIELDS);
  },
  named: /^v\d+\.\d+\.\d+[\w.-]*$/,
  claims: /^(version: |## Notes$)/m,
};

export function listReleases(bp: BoardPaths): Release[] {
  return listDocs(bp.releasesDir, RELEASE_DOC).map((r) => withReleaseState(bp, r)).sort((a, b) => {
    const [x, y] = [versionKey(a.version), versionKey(b.version)];
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
}

/** Releases whose file cannot be read, so they are never silently gone. */
export function brokenReleases(bp: BoardPaths): BrokenRecord[] {
  return brokenDocs(bp, bp.releasesDir, RELEASE_DOC);
}

/** A release's file that cannot be read says so, in the same plain words as the page. */
export function readRelease(bp: BoardPaths, version: string): Release | null {
  const v = version.startsWith('v') ? version : `v${version}`;
  const file = path.join(bp.releasesDir, `${v}.md`);
  if (!fs.existsSync(file)) return null;
  const { value, detail } = readDoc(file, RELEASE_DOC);
  if (detail) throw new Error(recordProblemWords('release', v));
  return value ? withReleaseState(bp, value) : null;
}

export function writeRelease(bp: BoardPaths, release: Release): void {
  writeFile(path.join(bp.releasesDir, `${release.version}.md`), releaseDoc(release));
  if (release.log || release.unpushed?.length) {
    writeFile(releaseStateFile(bp, release.version), dumpYaml({ ...(release.log ? { log: release.log } : {}), ...(release.unpushed?.length ? { unpushed: release.unpushed } : {}) }));
  } else fs.rmSync(releaseStateFile(bp, release.version), { force: true });
}

/** A draft that is folded into another one: its file goes. */
export function removeRelease(bp: BoardPaths, version: string): void {
  fs.rmSync(path.join(bp.releasesDir, `${version}.md`), { force: true });
  fs.rmSync(releaseStateFile(bp, version), { force: true });
}

export function draftRelease(bp: BoardPaths): Release | null {
  return listReleases(bp).find((r) => r.status === 'draft') ?? null;
}

export function latestRelease(bp: BoardPaths): Release | null {
  return listReleases(bp).find((r) => r.status === 'released') ?? null;
}

/** The code on the base changed: queue a fresh read, unless one is already waiting or running. */
export function codeChanged(bp: BoardPaths): BoardMeta['blueprint'] {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') return undefined;
  if (meta.blueprint?.status === 'pending' || meta.blueprint?.status === 'running') return meta.blueprint;
  meta.blueprint = { stack: [], patterns: [], ...meta.blueprint, status: 'pending' };
  writeMeta(bp, meta);
  return meta.blueprint;
}

/** A decision was approved: the Architect checks the tickets planned before it. */
export function queueImpactCheck(bp: BoardPaths, adr: string): void {
  const meta = readMeta(bp);
  if (meta.engine !== 'live' || meta.impactChecks?.some((c) => c.adr === adr)) return;
  writeMeta(bp, { ...meta, impactChecks: [...(meta.impactChecks ?? []), { adr, status: 'pending' }] });
}

/** Empties the board in both homes (the demo board starts fresh this way). */
export function clearBoard(bp: BoardPaths): void {
  for (const dir of [bp.ticketsDir, bp.decisionsDir, bp.releasesDir, bp.rulesDir, bp.knowledgeDir, bp.localDir]) fs.rmSync(dir, { recursive: true, force: true });
}

/** A fresh id for a new project's settings. */
export function newProjectId(name: string): string {
  return `${name.replace(/[^\w.-]+/g, '-').toLowerCase() || 'project'}-${randomUUID().slice(0, 8)}`;
}

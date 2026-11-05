import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { squadHome } from '../core/home.js';
import { readInstalledPackage } from '../core/package-info.js';
import { recentLines, writeLog } from '../core/app-log.js';
import { isSecretFile, knownSecrets, scrubSecrets } from '../core/scrub.js';
import { zip, type ZipEntry } from '../core/zip.js';
import { gitEnv } from './git.js';
import { boardExists, listTickets, readMeta, readTicket, type BoardPaths } from '../board/store.js';
import { withProblem } from '../board/problem.js';
import type { Ticket } from '../board/types.js';
import { AI_TOOLS } from '../modules/registry.js';
import { CONVERSATIONS, readConversation } from './conversations.js';
import { readPause } from './usage-limit.js';

/**
 * Report a problem (phase 10): one .zip a person sends to whoever helps them with squad-kit. It holds the ticket's
 * state, its conversations, squad-kit's own log for the last 24 hours and the versions, with a README.txt that says
 * what is inside. It never holds secrets.yaml, console.json, tokens or .env files: nothing is copied by folder, every
 * text is scrubbed, and the zip refuses a secret file's name.
 */

export interface Versions {
  squadKit: string;
  node: string;
  git: string | null;
  system: string;
  /** Each AI tool squad-kit can run, with its installed version. */
  tools: { name: string; version: string | null }[];
}

export interface ReportInput {
  /** The project it is about; left out for the app as a whole. */
  bp?: BoardPaths;
  ticket?: string;
  /** What happened, in the person's words. */
  note?: string;
  /** The projects in the app, for a report about the app as a whole. */
  projects?: { id: string; name: string; root: string; open: boolean; why?: string; tickets?: number; waiting?: number }[];
  /** Where the file goes; the person's Downloads folder by default. */
  dir?: string;
  now?: number;
  /** Versions already known, so a test does not run the real tools. */
  versions?: Versions;
}

export interface ReportPlan {
  name: string;
  folder: string;
  /** What the file holds, in the words the dialog shows. */
  holds: string[];
  never: string;
  command: string;
}

export interface ReportResult extends ReportPlan {
  file: string;
  bytes: number;
}

const DAY = 86_400_000;
const NEVER = 'Never included: your tokens, passwords, secrets.yaml, console.json or .env files.';
/** One conversation keeps its last 3 MB; the oldest updates go first. */
const MAX_CONVERSATION = 3 * 1024 * 1024;

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, ...(cmd === 'git' ? { env: gitEnv() } : {}) }).trim() || null;
  } catch {
    return null;
  }
}

/** squad-kit, Node, git, the system and each AI tool's version, as this computer has them. */
export function versions(): Versions {
  const mac = process.platform === 'darwin' ? run('sw_vers', ['-productVersion']) : null;
  return {
    squadKit: readInstalledPackage().version,
    node: process.version,
    git: run('git', ['--version']),
    system: `${mac ? `macOS ${mac}` : os.type()} (${os.platform()} ${os.release()}, ${os.arch()})`,
    tools: AI_TOOLS.filter((t) => t.canRun).map((t) => ({ name: t.label, version: t.version?.() ?? null })),
  };
}

/**
 * Where reports are saved: the person's Downloads folder, where people look for a file to send. A squad-kit moved
 * with SQUAD_KIT_HOME (tests, a second copy) keeps them in its own folder.
 */
export function reportFolder(): string {
  if (process.env.SQUAD_KIT_HOME?.trim()) return path.join(squadHome(), 'reports');
  const downloads = path.join(os.homedir(), 'Downloads');
  return fs.existsSync(downloads) ? downloads : path.join(squadHome(), 'reports');
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function projectOf(bp: BoardPaths | undefined): string | undefined {
  if (!bp) return undefined;
  try {
    return boardExists(bp) ? readMeta(bp).project || path.basename(bp.root) : path.basename(bp.root);
  } catch {
    return path.basename(bp.root);
  }
}

/** "roomflow-RO-7-report.zip", "roomflow-report.zip", "squad-kit-report.zip". */
export function reportName(project?: string, ticket?: string): string {
  if (!project) return 'squad-kit-report.zip';
  return `${slug(project)}${ticket ? `-${ticket.toUpperCase()}` : ''}-report.zip`;
}

/** What a report will hold, before it is made: the dialog lists it. */
export function planReport(input: ReportInput): ReportPlan {
  const project = projectOf(input.bp);
  const ticket = input.ticket?.toUpperCase();
  const tools = AI_TOOLS.filter((t) => t.canRun).map((t) => t.label);
  const holds = [
    ...(ticket ? [`${ticket}'s timeline, status and each step's time`, 'The agent conversations for this ticket'] : []),
    ...(project && !ticket ? [`How ${project}'s tickets stand, and its settings on the board`] : []),
    ...(!project ? ['The projects in squad-kit and how each one stands'] : []),
    "squad-kit's own log for the last 24 hours",
    `Versions: squad-kit, ${tools.join(', ')}${tools.length ? ', ' : ''}Node, git, the system`,
  ];
  return {
    name: reportName(project, ticket),
    folder: input.dir ?? reportFolder(),
    holds,
    never: NEVER,
    command: `squad report${ticket ? ` ${ticket}` : ''}`,
  };
}

/** A conversation's updates as JSON lines, with pictures and recordings left out (they stay on this computer). */
function conversationLines(updates: unknown[]): string {
  const lines = updates.map((u) =>
    JSON.stringify(u, (key, value) => (key === 'data' && typeof value === 'string' && value.length > 200 ? `[${value.length} characters of a picture or file left out]` : value)),
  );
  let bytes = 0;
  let from = lines.length;
  while (from > 0 && bytes + lines[from - 1]!.length + 1 <= MAX_CONVERSATION) bytes += lines[--from]!.length + 1;
  return `${from > 0 ? `${JSON.stringify({ note: `The first ${from} updates were left out to keep the file small.` })}\n` : ''}${lines.slice(from).join('\n')}\n`;
}

/** The ticket's conversations: one per role, and the talk beside the work. */
function conversations(bp: BoardPaths, t: Ticket): { name: string; text: string }[] {
  const ids = [
    ...CONVERSATIONS.map((c) => ({ key: c.key, id: t.sessions?.[c.key] })),
    { key: 'chat', id: t.chat?.side },
  ].filter((x): x is { key: string; id: string } => Boolean(x.id));
  const out: { name: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const { key, id } of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const conv = readConversation(id, 100_000, undefined, bp.chatsDir);
    if (!conv) continue;
    out.push({ name: `conversations/${key}-${id.slice(0, 8)}.jsonl`, text: conversationLines(conv.updates) });
  }
  return out;
}

function dump(v: unknown): string {
  return yaml.dump(v, { lineWidth: 120, noRefs: true, skipInvalid: true });
}

/** The project's board settings, without who the person is. */
function projectSettings(bp: BoardPaths): string {
  try {
    const { user: _user, usage: _usage, ...meta } = readMeta(bp);
    return dump({ folder: bp.root, id: bp.projectId, ...meta });
  } catch (err) {
    return `The board settings could not be read: ${(err as Error).message}\n`;
  }
}

function ticketLines(bp: BoardPaths): string {
  try {
    const rows = listTickets(bp).map((t) => `${t.id}  ${t.stage.padEnd(9)} ${t.waiting ? `waits: ${t.waiting.kind.padEnd(9)} ` : ''}${t.status}`);
    return rows.length ? `${rows.join('\n')}\n` : 'No tickets yet.\n';
  } catch (err) {
    return `The tickets could not be read: ${(err as Error).message}\n`;
  }
}

function versionText(v: Versions): string {
  const rows: [string, string][] = [
    ['squad-kit', v.squadKit],
    ['Node', v.node],
    ['git', v.git ?? 'not found'],
    ['System', v.system],
    ...v.tools.map((t): [string, string] => [t.name, t.version ?? 'not installed']),
  ];
  const width = Math.max(...rows.map(([k]) => k.length)) + 2;
  return rows.map(([k, val]) => `${k.padEnd(width)}${val}`).join('\n') + '\n';
}

/** Every file the report holds, scrubbed, README.txt first. */
export function reportEntries(input: ReportInput): ZipEntry[] {
  const now = input.now ?? Date.now();
  const at = new Date(now);
  const v = input.versions ?? versions();
  const known = knownSecrets(input.bp ? [input.bp.secretsFile, path.join(input.bp.squadDir, 'secrets.yaml'), input.bp.consoleFile] : []);
  const files: { name: string; text: string; what: string }[] = [];
  const add = (name: string, text: string, what: string) => files.push({ name, text, what });
  const bp = input.bp;
  const project = projectOf(bp);
  const id = input.ticket?.toUpperCase();

  add('versions.txt', versionText(v), 'squad-kit, Node, git, the system and the AI tools');
  if (bp && id) {
    const t = readTicket(bp, id);
    if (!t) throw new Error(`No ticket ${id} in ${project}.`);
    add(`ticket/${id}.yaml`, dump(withProblem(t)), `${id}: its timeline (activity), status, steps with their times, gates and any stuck card with the exact error`);
    for (const c of conversations(bp, t)) add(c.name, c.text, `an agent conversation of ${id}, in the Agent Client Protocol format`);
  }
  if (bp) {
    add('project/settings.yaml', projectSettings(bp), `${project}'s settings on the board: commands, repos, the Architect's read`);
    add('project/tickets.txt', ticketLines(bp), `every ticket of ${project} with its stage and status`);
  }
  if (input.projects) {
    const rows = input.projects.map(
      (p) => `${p.name}  (${p.id})  ${p.root}\n  ${p.open ? `open: ${p.tickets ?? 0} tickets, ${p.waiting ?? 0} waiting for you` : `could not open: ${p.why ?? ''}`}`,
    );
    add('projects.txt', rows.length ? `${rows.join('\n')}\n` : 'No projects yet.\n', 'the projects in squad-kit and how each one stands');
  }
  const pause = readPause();
  if (pause) add('usage-limit.json', `${JSON.stringify({ ...pause, endedOrDue: Date.parse(pause.until) <= now }, null, 2)}\n`, 'the last usage-limit wait');
  const lines = recentLines(DAY, now);
  add('log/squad-kit.log', lines.length ? `${lines.join('\n')}\n` : 'Nothing was logged in the last 24 hours.\n', "squad-kit's own log for the last 24 hours");

  const note = input.note?.trim();
  const readme = [
    'squad-kit problem report',
    '',
    `Made ${at.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} (${at.toISOString()}) by squad-kit ${v.squadKit}.`,
    project ? `Project: ${project}${id ? `, ticket ${id}` : ''}.` : 'About squad-kit as a whole, not one project.',
    '',
    'What happened, in the words of the person who sent it:',
    note ? note.split('\n').map((l) => `  ${l}`).join('\n') : '  (nothing written)',
    '',
    'What is inside:',
    '  README.txt  this list',
    ...files.map((f) => `  ${f.name}  ${f.what}`),
    '',
    'Never included: tokens, passwords, secrets.yaml, console.json or .env files. Anything in the files above that',
    'looked like a key, a token or a password was taken out and shows as [removed], [token removed] or [secret removed].',
    '',
  ].join('\n');

  const entries: ZipEntry[] = [readme, ...files.map((f) => f.text)].map((text, i) => ({
    name: i === 0 ? 'README.txt' : files[i - 1]!.name,
    data: scrubSecrets(text, known),
    date: at,
  }));
  for (const e of entries) if (isSecretFile(e.name)) throw new Error(`A report never holds ${e.name}.`);
  return entries;
}

/** Makes the report and saves it, with a number added when a file of that name is there already. */
export function writeReport(input: ReportInput): ReportResult {
  const plan = planReport(input);
  const data = zip(reportEntries(input));
  // Downloads may refuse (a Mac's privacy settings, a full disk): squad-kit's own folder then holds it, and the answer says where.
  const folders = [...new Set([plan.folder, path.join(squadHome(), 'reports')])];
  for (const folder of folders) {
    try {
      fs.mkdirSync(folder, { recursive: true });
      let name = plan.name;
      for (let n = 2; fs.existsSync(path.join(folder, name)); n += 1) name = plan.name.replace(/\.zip$/, `-${n}.zip`);
      const file = path.join(folder, name);
      fs.writeFileSync(file, data);
      return { ...plan, folder, name, file, bytes: data.length };
    } catch (err) {
      if (folder === folders.at(-1)) {
        // Where it tried and why are for engineers: the person gets what to do.
        writeLog({ level: 'error', text: `Could not save a problem report in ${folders.join(' or in ')}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` });
        throw new Error('squad-kit could not save the report. Check that the disk has room, then try again. An engineer can see why in squad-kit\'s log.');
      }
    }
  }
  throw new Error('squad-kit could not save the report.');
}

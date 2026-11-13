import {
  addActivity,
  latestRelease,
  listTickets,
  nextTicketId,
  now,
  readMeta,
  readRelease,
  updateTicket,
  writeRelease,
  writeTicket,
  type BoardPaths,
  readTicket,
  ticketFilesDir,
  ticketMediaDir,
} from '../store.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ProofKind, Ticket, Criterion, Track } from '../types.js';
import { scheduleSquad } from '../schedule.js';
import { NO_DOCS, leaveForOutside } from '../outside-step.js';
import { plainWords } from '../../core/for-people.js';
import { buildPaths } from '../../core/paths.js';
import { freeName } from '../../core/file-names.js';
import { loadConfig } from '../../core/config.js';
import { loadSecrets } from '../../core/secrets.js';
import { clientFor, overlayTrackerEnv } from '../../tracker/index.js';
import { trackerFor, trackerModule } from '../../modules/registry.js';
import type { Tracker } from '../../modules/tracker/types.js';
import { syncWiki } from '../../engine/sync.js';
import type { Decided } from '../requirements-types.js';
import { isMediaNote } from '../../engine/media.js';
import { BoardActionError, tellLater } from './errors.js';
import { openChat } from './chat.js';

export interface NewTicketInput {
  /** The ticket's name when it comes from a tracker (AB-80); otherwise the project key and a number. */
  id?: string;
  title: string;
  ask?: string;
  priority?: Ticket['priority'];
  kind?: Ticket['kind'];
  /** How bad a bug is. Only kept on bugs. */
  severity?: Ticket['severity'];
  track?: Track;
  /** Talk it through with the Analyst first, before any questions or spec. */
  talkFirst?: boolean;
  /** "Write new tests" off: the Builder writes no new tests, on any track. Refused where an engineer keeps it on. */
  noNewTests?: boolean;
  /** Made by a conversation outside squad-kit: the squad keeps off it until it comes back. */
  outside?: boolean;
  source?: Ticket['source'];
  criteria?: string[];
  /** How each "done when" will be proved, in the same order: a Squad lead draft says so. */
  proofs?: ProofKind[];
  rules?: string[];
  edgeCases?: string[];
  files?: UploadedFile[];
  /** A one-time key from the page: the same Create sent again (a lost reply, Try again) gets the ticket it made. */
  key?: string;
  /** Builds by itself: the breakdown story it builds, with its story and done-when, approved with the breakdown. */
  fromBreakdown?: { id: string; item: string; story: string; criteria: Criterion[]; approvedBy: string; decided?: Decided[]; setsUp?: boolean };
  /** Made by squad-kit itself, not the person: the first line of its activity, saying why. */
  bySquad?: string;
  /** The old tests it fixes, which fail on main (engine/old-tests.ts). */
  oldTests?: string[];
  /** It waits on the board until the person starts it (startTicket): no step runs and nothing is spent before. */
  waitsToStart?: boolean;
  /** On a workspace of several repos: the repo it changes. */
  repo?: string;
  /** Its size was judged before it was made, and what the person chose (board/split.ts). */
  split?: Ticket['split'];
}

/** A file the person added to a ticket, sent as base64 so the board and the terminal send it the same way. */
export interface UploadedFile {
  name: string;
  data: string;
}

export const MAX_UPLOADS = 10;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function cleanList(items: string[] | undefined): string[] {
  return (items ?? []).map((x) => x.trim()).filter(Boolean);
}

/** Saves uploaded files into a folder, with safe names, and returns their paths. */
/** A ticket's uploads: images and documents go with the project, voice and video notes stay on this computer (ADR-001). */
export function saveTicketUploads(bp: BoardPaths, id: string, files: UploadedFile[]): string[] {
  const media = files.filter((f) => isMediaNote(f.name));
  return [...saveUploads(ticketFilesDir(bp, id), files.filter((f) => !isMediaNote(f.name))), ...saveUploads(ticketMediaDir(bp, id), media)];
}

export function saveUploads(dir: string, files: UploadedFile[]): string[] {
  if (files.length > MAX_UPLOADS) throw new BoardActionError(`Add at most ${MAX_UPLOADS} files.`);
  const decoded = files.map((f) => ({ name: path.basename(f.name).replace(/[^\p{L}\p{M}\p{N}_.\- ]+/gu, '_').slice(-120) || 'file', data: Buffer.from(f.data, 'base64') }));
  const big = decoded.find((f) => f.data.length > MAX_UPLOAD_BYTES);
  if (big) throw new BoardActionError(`${big.name} is larger than 10 MB.`);
  if (!decoded.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  return decoded.map((f) => {
    let name = f.name;
    for (let i = 2; used.has(name.toLowerCase()) || fs.existsSync(path.join(dir, name)); i += 1) name = f.name.replace(/(\.[^.]*)?$/, (ext) => `-${i}${ext}`);
    used.add(name.toLowerCase());
    const file = path.join(dir, name);
    fs.writeFileSync(file, f.data);
    return file;
  });
}

export function createTicket(bp: BoardPaths, input: NewTicketInput): Ticket {
  const title = input.title.trim();
  if (!title) throw new BoardActionError('A ticket needs a title.');
  const made = input.key ? listTickets(bp).find((t) => t.createKey === input.key && t.title === title) : undefined;
  if (made) return made;
  const meta = readMeta(bp);
  const id = input.id ?? nextTicketId(bp);
  if (input.id && readTicket(bp, input.id)) throw new BoardActionError(`${input.id} is already on the board.`);
  const kept = (input.criteria ?? []).map((x, i) => ({ text: x.trim(), proof: input.proofs?.[i] })).filter((x) => x.text);
  const proofs = kept.length && kept.every((x) => x.proof) ? { proofs: kept.map((x) => x.proof!) } : {};
  const brief = { criteria: cleanList(input.criteria), rules: cleanList(input.rules), edgeCases: cleanList(input.edgeCases), ...proofs };
  if (input.noNewTests && meta.alwaysNewTests) throw new BoardActionError(NEW_TESTS_ALWAYS);
  const attachments = input.files?.length ? saveTicketUploads(bp, id, input.files) : [];
  const ticket: Ticket = {
    id,
    title,
    ask: input.ask?.trim() || title,
    kind: input.kind ?? 'feature',
    track: input.fromBreakdown ? 'auto' : input.track === 'express' ? 'express' : 'full',
    ...(input.noNewTests ? { noNewTests: true } : {}),
    source: input.source ?? { type: 'manual' },
    priority: input.priority ?? 'normal',
    stage: 'tickets',
    status: 'Analyst is reading the ticket',
    live: true,
    waiting: null,
    createdAt: now(),
    createdBy: meta.user.name,
    owner: meta.user.name,
    ...(input.key ? { createKey: input.key } : {}),
    builder: meta.roles.builder,
    reviewer: meta.roles.reviewer,
    activity: [],
    ...(brief.criteria.length || brief.rules.length || brief.edgeCases.length ? { brief } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(input.kind === 'bug' && input.severity ? { severity: input.severity } : {}),
    ...(input.oldTests?.length ? { oldTests: input.oldTests } : {}),
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.split ? { split: input.split } : {}),
    ...(input.fromBreakdown
      ? {
          breakdown: { id: input.fromBreakdown.id, item: input.fromBreakdown.item },
          story: input.fromBreakdown.story,
          criteria: input.fromBreakdown.criteria,
          specApproved: { by: input.fromBreakdown.approvedBy, at: now() },
          ...(input.fromBreakdown.decided?.length ? { decided: input.fromBreakdown.decided } : {}),
          ...(input.fromBreakdown.setsUp ? { setsUp: true } : {}),
        }
      : {}),
  };
  const from = input.source && input.source.type !== 'manual' ? (trackerModule(input.source.type)?.label ?? input.source.type) : '';
  if (input.bySquad) addActivity(ticket, 'squad', input.bySquad);
  else addActivity(ticket, 'you', from ? `Pulled ${input.source!.ref} from ${from}` : 'Created the ticket');
  if (ticket.track === 'express') addActivity(ticket, 'you', 'Chose the Express track: no questions, the plan is approved on its own');
  if (ticket.noNewTests) addActivity(ticket, 'you', "Chose to build it without new tests: the project's own checks, the review and the proof still run");
  if (input.fromBreakdown) addActivity(ticket, 'squad', `Started from ${input.fromBreakdown.id} › ${input.fromBreakdown.item}: the story and done-when were approved with the breakdown`);
  if (attachments.length) addActivity(ticket, 'you', `Added ${attachments.length === 1 ? '1 file' : `${attachments.length} files`}`);
  if (input.outside) {
    // Made by a conversation outside squad-kit: the squad never starts on it. If it comes back as it is, it reads it then.
    scheduleSquad(ticket, 'analyst-read', 0, 1);
    ticket.live = false;
    leaveForOutside(ticket, meta.user.name, ticket.createdAt, { docs: NO_DOCS, work: 'none' });
    addActivity(ticket, 'you', 'Started it in a conversation outside squad-kit');
  } else if (input.talkFirst && ticket.track === 'full') {
    openChat(ticket, 'analyst', { waiting: null, phase: 'analyst-read' });
    addActivity(ticket, 'you', 'Chose to talk it through with the Analyst first');
  } else if (input.waitsToStart) {
    // Nothing runs until the person starts it: no step is set, so the squad never picks it up by itself.
    ticket.live = false;
    ticket.waitsToStart = true;
    ticket.status = WAITS_TO_START;
  } else scheduleSquad(ticket, 'analyst-read', 4, meta.speed);
  writeTicket(bp, ticket);
  return ticket;
}

/** A waiting story's line on its card. */
export const WAITS_TO_START = 'Waits for you to start it';

/** A story without new tests, asked for on a project where an engineer keeps them on every story. */
export const NEW_TESTS_ALWAYS = 'Every story in this project writes new tests: an engineer chose that in Settings, so this one cannot be built without them.';

/** "Start" on a story that waits on the board: the Analyst reads it, as on any new story. */
export function startTicket(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (!t.waitsToStart) throw new BoardActionError(`${t.id} does not wait to be started.`);
    delete t.waitsToStart;
    t.live = true;
    t.status = 'Analyst is reading the ticket';
    addActivity(t, 'you', 'Started it');
    scheduleSquad(t, 'analyst-read', 1, meta.speed);
  });
}

/** Work items a demo board knows how to "pull". Anything else gets a plain title. */
const AZURE_ITEMS: Record<string, { title: string; ask: string }> = {
  '4133': {
    title: 'Show hearing time in local time',
    ask: 'Judges in other regions see hearing times in Riyadh time. Show each person their local time.',
  },
  '4141': {
    title: 'Bulk assign cases to a clerk',
    ask: 'Team leads assign cases one by one. Let them select many cases and assign them in one step.',
  },
};

export async function pullTicket(bp: BoardPaths, ref: string): Promise<Ticket> {
  const clean = ref.replace(/^AB#/i, '').trim();
  if (!clean) throw new BoardActionError('Give a work item number, for example AB#4133.');
  if (readMeta(bp).engine === 'demo') {
    const item = AZURE_ITEMS[clean] ?? { title: `Azure work item ${clean}`, ask: `Pulled from Azure DevOps work item ${clean}.` };
    return createTicket(bp, { ...item, source: { type: 'azure', ref: `AB#${clean}` } });
  }
  return pullFromTracker(bp, clean);
}

/** Fetch a real work item with the tracker set up in .squad/ (the same one `squad new-story --id` uses). */
async function pullFromTracker(bp: BoardPaths, id: string): Promise<Ticket> {
  const tracker = trackerFor(bp);
  if (tracker) return startFromTracker(bp, tracker, id);
  const paths = buildPaths(bp.root);
  const config = loadConfig(paths.configFile);
  if (config.tracker.type === 'none') {
    throw new BoardActionError('No tracker is set up for this project. Add one in Settings.');
  }
  const { client, error } = clientFor(config, overlayTrackerEnv(loadSecrets(paths.secretsFile)));
  if (!client) throw new BoardActionError(`${error?.message ?? 'The tracker is not ready.'} ${error?.detail ?? ''}`.trim());
  let issue;
  try {
    issue = await client.fetchIssue(id);
  } catch (err) {
    throw new BoardActionError(`Could not fetch ${id}: ${plainWords(err, 'Pulling from the tracker', 'something technical stopped it. Try again.')}`);
  }
  const ask = [issue.description, issue.acceptanceCriteria && `Acceptance criteria:\n${issue.acceptanceCriteria}`].filter(Boolean).join('\n\n');
  const ticket = createTicket(bp, {
    title: issue.title,
    ask: ask || issue.title,
    priority: 'normal',
    source: { type: config.tracker.type, ref: issue.id },
  });
  if (issue.attachments.length) {
    const dir = ticketFilesDir(bp, ticket.id);
    fs.mkdirSync(dir, { recursive: true });
    const saved = await client.downloadAttachments(issue.attachments, dir).catch(() => []);
    const files = saved.filter((a) => a.outcome === 'written' && a.absolutePath).map((a) => a.absolutePath!);
    if (files.length) {
      return updateTicket(bp, ticket.id, (t) => {
        t.attachments = files;
        addActivity(t, 'you', `Pulled ${files.length} attachments with it`);
      });
    }
  }
  return ticket;
}

/**
 * An item from the tracker becomes a ticket with everything the squad needs: the story, its acceptance criteria,
 * the feature and epic it belongs to, the items it depends on, and its attachments.
 */
export async function startFromTracker(bp: BoardPaths, tracker: Tracker, ref: string): Promise<Ticket> {
  const id = tracker.parseRef(ref);
  if (!id) throw new BoardActionError(`"${ref}" is not a ${tracker.label} item.`);
  const existing = listTickets(bp).find((t) => t.source.type === tracker.name && (t.source.id === id || t.source.ref === tracker.refOf(id)));
  if (existing) throw new BoardActionError(`${tracker.refOf(id)} is already on the board as ${existing.id}.`);
  let w;
  try {
    w = await tracker.get(id);
  } catch (err) {
    throw new BoardActionError(`Could not fetch ${tracker.refOf(id)}: ${plainWords(err, 'Pulling from the tracker', 'something technical stopped it. Try again.')}`);
  }
  const ask = [
    w.description,
    w.reproSteps && `Steps to reproduce:\n${w.reproSteps}`,
    w.acceptanceCriteria && `Acceptance criteria:\n${w.acceptanceCriteria}`,
    w.parents.length ? `Part of: ${w.parents.map((p) => `${p.type} "${p.title}"`).join(', in ')}` : '',
    w.dependsOn.length ? `Builds on: ${w.dependsOn.map((d) => `${d.ref} ${d.title} (${d.state})`).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const meta = readMeta(bp);
  await syncWiki(bp, tracker);
  const ticket = createTicket(bp, {
    // Named by the tracker (ADR-001), so two people pulling different items never make the same name.
    id: tracker.ticketName?.(w.id) ?? w.ref.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase(),
    title: w.title,
    ask: ask || w.title,
    priority: w.priority === 1 ? 'high' : w.priority === 4 ? 'low' : 'normal',
    source: { type: tracker.name, ref: w.ref, id: w.id, url: w.url, itemType: w.type },
  });
  const files: string[] = [];
  if (w.attachments.length) {
    const dir = ticketFilesDir(bp, ticket.id);
    fs.mkdirSync(dir, { recursive: true });
    const taken = new Set<string>();
    for (const a of w.attachments.filter((x) => x.size <= 10 * 1024 * 1024)) {
      // Letters and digits of any language stay, and two with one name are both kept.
      const name = a.name.replace(/[^\p{L}\p{M}\p{N}_.\- ]+/gu, '_').replace(/^\.+/, '').slice(-80) || 'file';
      const file = await tracker.download(a.url, path.join(dir, freeName(name, taken))).catch(() => null);
      if (file) files.push(file);
    }
  }
  return updateTicket(bp, ticket.id, (t) => {
    if (w.isBug) t.kind = 'bug';
    if (files.length) {
      t.attachments = files;
      addActivity(t, 'you', `Pulled ${files.length} attachments with it`);
    }
    tellLater(t, meta.engine, { kind: 'started' });
  });
}

export interface BugInput {
  what: string;
  how?: string;
  expected?: string;
  severity?: Ticket['severity'];
  foundIn?: string;
}

export function reportBug(bp: BoardPaths, input: BugInput): Ticket {
  const what = input.what.trim();
  if (!what) throw new BoardActionError('Say what happened.');
  const meta = readMeta(bp);
  const foundIn = input.foundIn ?? latestRelease(bp)?.version;
  const ticket: Ticket = {
    id: nextTicketId(bp),
    title: what,
    ask: [what, input.how && `How to see it: ${input.how}`, input.expected && `Expected: ${input.expected}`]
      .filter(Boolean)
      .join('\n'),
    kind: 'bug',
    source: { type: 'manual' },
    priority: input.severity === 'stops-work' ? 'high' : 'normal',
    stage: 'bugs',
    status: 'Triage is sorting the bug',
    live: true,
    waiting: null,
    createdAt: now(),
    createdBy: meta.user.name,
    owner: meta.user.name,
    builder: meta.roles.builder,
    reviewer: meta.roles.reviewer,
    severity: input.severity ?? 'annoying',
    ...(foundIn ? { foundIn } : {}),
    activity: [],
  };
  addActivity(ticket, 'you', foundIn ? `Reported a bug found in ${foundIn}` : 'Reported a bug');
  scheduleSquad(ticket, 'triage', 3, meta.speed);
  tellLater(ticket, meta.engine, { kind: 'file-bug' });
  writeTicket(bp, ticket);
  if (foundIn) {
    const release = readRelease(bp, foundIn);
    if (release) {
      release.bugs = [...(release.bugs ?? []), ticket.id];
      writeRelease(bp, release);
    }
  }
  return ticket;
}

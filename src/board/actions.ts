import {
  addActivity,
  draftRelease,
  latestRelease,
  listTickets,
  nextDecisionId,
  nextTicketId,
  now,
  readMeta,
  readRelease,
  requireTicket,
  updateTicket,
  writeDecision,
  writeRelease,
  writeTicket,
  writeMeta,
  type BoardPaths,
} from './store.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Release, Ticket } from './types.js';
import { scheduleSquad } from './schedule.js';
import { commitTicket, liveRelease } from '../engine/release.js';
import { git } from '../engine/git.js';
import { reposOf } from '../engine/repos.js';
import { buildPaths } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { loadSecrets } from '../core/secrets.js';
import { clientFor, overlayTrackerEnv } from '../tracker/index.js';
import { azureFor, type Azure } from '../engine/azure.js';
import { mergeLocally, opensPullRequest, syncWiki } from '../engine/sync.js';
import type { TrackerEvent } from './types.js';
import { endProcessTree } from '../engine/watchdog.js';

/** Every person-facing action lives here, so the board and the terminal do exactly the same thing. */

export class BoardActionError extends Error {}

/** Queue an update for the tracker. The live squad sends it, so this never waits on the network. */
function tellLater(t: Ticket, engine: string, event: TrackerEvent): void {
  if (engine !== 'live') return;
  if (event.kind !== 'file-bug' && t.source.type !== 'azure') return;
  t.trackerQueue = [...(t.trackerQueue ?? []), event];
}

export interface NewTicketInput {
  title: string;
  ask?: string;
  priority?: Ticket['priority'];
  kind?: Ticket['kind'];
  source?: Ticket['source'];
  criteria?: string[];
  rules?: string[];
  edgeCases?: string[];
  files?: UploadedFile[];
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
export function saveUploads(dir: string, files: UploadedFile[]): string[] {
  if (files.length > MAX_UPLOADS) throw new BoardActionError(`Add at most ${MAX_UPLOADS} files.`);
  const decoded = files.map((f) => ({ name: path.basename(f.name).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file', data: Buffer.from(f.data, 'base64') }));
  const big = decoded.find((f) => f.data.length > MAX_UPLOAD_BYTES);
  if (big) throw new BoardActionError(`${big.name} is larger than 10 MB.`);
  if (!decoded.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  return decoded.map((f) => {
    let name = f.name;
    for (let i = 2; used.has(name.toLowerCase()); i += 1) name = f.name.replace(/(\.[^.]*)?$/, (ext) => `-${i}${ext}`);
    used.add(name.toLowerCase());
    const file = path.join(dir, name);
    fs.writeFileSync(file, f.data);
    return file;
  });
}

export function createTicket(bp: BoardPaths, input: NewTicketInput): Ticket {
  const title = input.title.trim();
  if (!title) throw new BoardActionError('A ticket needs a title.');
  const meta = readMeta(bp);
  const id = nextTicketId(bp);
  const brief = { criteria: cleanList(input.criteria), rules: cleanList(input.rules), edgeCases: cleanList(input.edgeCases) };
  const attachments = input.files?.length ? saveUploads(path.join(bp.dir, 'attachments', id), input.files) : [];
  const ticket: Ticket = {
    id,
    title,
    ask: input.ask?.trim() || title,
    kind: input.kind ?? 'feature',
    source: input.source ?? { type: 'manual' },
    priority: input.priority ?? 'normal',
    stage: 'tickets',
    status: 'Analyst is reading the ticket',
    live: true,
    waiting: null,
    createdAt: now(),
    createdBy: meta.user.name,
    builder: meta.roles.builder,
    reviewer: meta.roles.reviewer,
    activity: [],
    ...(brief.criteria.length || brief.rules.length || brief.edgeCases.length ? { brief } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
  addActivity(ticket, 'you', input.source?.type === 'azure' ? `Pulled ${input.source.ref} from Azure DevOps` : 'Created the ticket');
  if (attachments.length) addActivity(ticket, 'you', `Added ${attachments.length === 1 ? '1 file' : `${attachments.length} files`}`);
  scheduleSquad(ticket, 'analyst-read', 4, meta.speed);
  writeTicket(bp, ticket);
  return ticket;
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
  const az = azureFor(bp);
  if (az) return startFromAzure(bp, az, id);
  const paths = buildPaths(path.dirname(path.dirname(bp.dir)));
  const config = loadConfig(paths.configFile);
  if (config.tracker.type === 'none') {
    throw new BoardActionError('No tracker is set up for this project. Run: squad config set tracker');
  }
  const { client, error } = clientFor(config, overlayTrackerEnv(loadSecrets(paths.secretsFile)));
  if (!client) throw new BoardActionError(`${error?.message ?? 'The tracker is not ready.'} ${error?.detail ?? ''}`.trim());
  let issue;
  try {
    issue = await client.fetchIssue(id);
  } catch (err) {
    throw new BoardActionError(`Could not fetch ${id}: ${(err as Error).message}`);
  }
  const ask = [issue.description, issue.acceptanceCriteria && `Acceptance criteria:\n${issue.acceptanceCriteria}`].filter(Boolean).join('\n\n');
  const ticket = createTicket(bp, {
    title: issue.title,
    ask: ask || issue.title,
    priority: 'normal',
    source: { type: config.tracker.type === 'azure' ? 'azure' : config.tracker.type, ref: config.tracker.type === 'azure' ? `AB#${issue.id}` : issue.id },
  });
  if (issue.attachments.length) {
    const dir = path.join(bp.dir, 'attachments', ticket.id);
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

export interface AnswerInput {
  choice: string;
  value?: string;
}

/**
 * A work item from Azure Boards becomes a ticket with everything the squad needs: the story, its acceptance criteria,
 * the feature and epic it belongs to, the stories it depends on, and its attachments.
 */
export async function startFromAzure(bp: BoardPaths, az: Azure, ref: string): Promise<Ticket> {
  const id = Number(ref.replace(/^AB#/i, ''));
  if (!Number.isInteger(id) || id <= 0) throw new BoardActionError(`"${ref}" is not a work item number.`);
  const existing = listTickets(bp).find((t) => t.source.type === 'azure' && (t.source.id === String(id) || t.source.ref === `AB#${id}`));
  if (existing) throw new BoardActionError(`AB#${id} is already on the board as ${existing.id}.`);
  let w;
  try {
    w = await az.getWorkItem(id);
  } catch (err) {
    throw new BoardActionError(`Could not fetch AB#${id}: ${(err as Error).message}`);
  }
  const ask = [
    w.description,
    w.reproSteps && `Steps to reproduce:\n${w.reproSteps}`,
    w.acceptanceCriteria && `Acceptance criteria:\n${w.acceptanceCriteria}`,
    w.parents.length ? `Part of: ${w.parents.map((p) => `${p.type} "${p.title}"`).join(', in ')}` : '',
    w.dependsOn.length ? `Builds on: ${w.dependsOn.map((d) => `AB#${d.id} ${d.title} (${d.state})`).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const meta = readMeta(bp);
  await syncWiki(bp, az);
  const ticket = createTicket(bp, {
    title: w.title,
    ask: ask || w.title,
    priority: w.priority === 1 ? 'high' : w.priority === 4 ? 'low' : 'normal',
    source: { type: 'azure', ref: `AB#${w.id}`, id: String(w.id), url: w.url, itemType: w.type },
  });
  const files: string[] = [];
  if (w.attachments.length) {
    const dir = path.join(bp.dir, 'attachments', ticket.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const a of w.attachments.filter((x) => x.size <= 10 * 1024 * 1024)) {
      const file = await az.download(a.url, path.join(dir, a.name.replace(/[^\w.\- ]+/g, '_'))).catch(() => null);
      if (file) files.push(file);
    }
  }
  return updateTicket(bp, ticket.id, (t) => {
    if (w.type === 'Bug') t.kind = 'bug';
    if (files.length) {
      t.attachments = files;
      addActivity(t, 'you', `Pulled ${files.length} attachments with it`);
    }
    tellLater(t, meta.engine, { kind: 'started' });
  });
}

export function answerQuestions(bp: BoardPaths, id: string, answers: Record<string, AnswerInput>): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'questions' || !t.questions) {
      throw new BoardActionError(`${t.id} has no open questions.`);
    }
    for (const q of t.questions) {
      const a = answers[q.id] ?? (q.answer ? q.answer : undefined);
      if (!a || !a.choice) throw new BoardActionError(`Question "${q.text}" still needs an answer.`);
      if (!q.options.includes(a.choice) && a.choice !== 'Other') {
        throw new BoardActionError(`"${a.choice}" is not a choice for "${q.text}".`);
      }
      q.answer = { choice: a.choice, ...(a.value ? { value: a.value.trim() } : {}) };
    }
    t.waiting = null;
    t.live = true;
    t.status = 'Architect is choosing the design';
    addActivity(t, 'you', `Answered ${t.questions.length} questions`);
    scheduleSquad(t, 'plan-write', 2, meta.speed);
    tellLater(t, meta.engine, { kind: 'answered' });
  });
}

/** "Skip, let the squad guess": the squad takes its own first choice and marks it as a guess. */
export function skipQuestions(bp: BoardPaths, id: string): Ticket {
  const ticket = requireTicket(bp, id);
  const answers: Record<string, AnswerInput> = {};
  for (const q of ticket.questions ?? []) answers[q.id] = q.answer ?? { choice: q.options[0]!, value: undefined };
  updateTicket(bp, id, (t) => {
    for (const q of t.questions ?? []) {
      if (!q.answer) q.thread = [...(q.thread ?? []), { who: 'squad', text: `Guessed "${q.options[0]}". You can change it in the plan.`, at: now() }];
    }
  });
  return answerQuestions(bp, id, answers);
}

export function askAbout(bp: BoardPaths, id: string, questionId: string, text: string): Ticket {
  const ask = text.trim();
  if (!ask) throw new BoardActionError('Write what you want to ask.');
  return updateTicket(bp, id, (t) => {
    const q = t.questions?.find((x) => x.id === questionId);
    if (!q) throw new BoardActionError(`${t.id} has no question ${questionId}.`);
    q.thread = [...(q.thread ?? []), { who: 'you', text: ask, at: now() }];
    q.thinking = true;
  });
}

/** Approves whatever the ticket is waiting on: the plan or the proof. */
export function approve(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  const ticket = requireTicket(bp, id);
  const kind = ticket.waiting?.kind;
  if (kind === 'plan') return approvePlan(bp, ticket, meta.speed);
  if (kind === 'proof') return acceptProof(bp, ticket);
  if (kind === 'questions') throw new BoardActionError(`${ticket.id} needs answers first. Run: squad answer ${ticket.id}`);
  if (kind === 'stuck') throw new BoardActionError(`${ticket.id} needs a decision. Run: squad decide ${ticket.id}`);
  throw new BoardActionError(`${ticket.id} is not waiting for an approval right now.`);
}

function approvePlan(bp: BoardPaths, ticket: Ticket, speed: number): Ticket {
  const meta = readMeta(bp);
  let adr: string | undefined;
  if (ticket.decision && !ticket.decision.adr) {
    adr = nextDecisionId(bp);
    const chosen = ticket.decision.options.find((o) => o.chosen) ?? ticket.decision.options[0];
    writeDecision(bp, {
      id: adr,
      title: ticket.decision.title,
      why: ticket.decision.why,
      options: ticket.decision.options.map((o) => o.name),
      chosen: chosen?.name ?? '',
      from: ticket.id,
      approvedBy: meta.user.name,
      date: now(),
      checkedBy: { kind: 'test', name: testNameFor(ticket), passing: false },
      tickets: [ticket.id],
    });
  }
  return updateTicket(bp, ticket.id, (t) => {
    if (t.decision && adr) t.decision.adr = adr;
    t.waiting = null;
    t.stage = 'implement';
    t.live = true;
    t.progress = 0;
    t.status = `Step 1 of ${t.steps?.length ?? 1} with ${t.builder ?? 'the Builder'}`;
    t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    addActivity(t, 'you', adr ? `Approved the plan. Decision saved as ${adr}` : 'Approved the plan');
    scheduleSquad(t, 'build', 2, speed, 0);
    tellLater(t, meta.engine, { kind: 'planned' });
  });
}

function testNameFor(ticket: Ticket): string {
  return `${ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.spec.ts`;
}

function acceptProof(bp: BoardPaths, ticket: Ticket): Ticket {
  let commit: string | null = null;
  if (readMeta(bp).engine === 'live') {
    try {
      commit = commitTicket(ticket);
    } catch (err) {
      throw new BoardActionError(`Could not save the change in git: ${(err as Error).message}`);
    }
  }
  const release = ensureDraftRelease(bp, ticket.kind === 'bug' ? 'patch' : 'minor');
  if (!release.tickets.includes(ticket.id)) release.tickets.push(ticket.id);
  writeRelease(bp, release);
  const openPr = !ticket.pr && opensPullRequest(bp, ticket);
  // Merge on accept: without a pull request host the branch merges into the base right here, so the next tickets
  // build on it. With Azure Repos the live squad opens the PR and merges it.
  let merged: ReturnType<typeof mergeLocally> = null;
  if (readMeta(bp).engine === 'live' && !openPr && !ticket.mergedAt) {
    try {
      merged = mergeLocally(bp, ticket);
    } catch (err) {
      throw new BoardActionError(`${ticket.id} is saved as a commit, but it ${(err as Error).message.replace(/^squad\/\S+ /, '')} Send it back to the Builder with "Ask for a change" to update it.`);
    }
  }
  return updateTicket(bp, ticket.id, (t) => {
    t.waiting = null;
    t.stage = 'release';
    t.live = openPr;
    t.progress = undefined;
    t.release = release.version;
    t.status = openPr ? 'Opening the pull request' : merged ? `Merged into ${merged.base} · goes out in ${release.version}` : `Ready for ${release.version}`;
    if (merged) t.mergedAt = now();
    t.squad = openPr ? { phase: 'publish', nextAt: now() } : null;
    addActivity(t, 'you', 'Checked the proof. Looks right');
    if (commit) addActivity(t, 'release', `Saved the change as commit ${commit} on ${t.branch}`);
    if (merged) addActivity(t, 'release', `Merged into ${merged.base}${merged.note ? `. ${merged.note}` : ''}`);
    addActivity(t, 'release', `Added to release ${release.version}`);
  });
}

/** "Change something" on a plan, or "Something's wrong" on the proof. */
export function requestChange(bp: BoardPaths, id: string, text: string): Ticket {
  const note = text.trim();
  if (!note) throw new BoardActionError('Say in one line what should change.');
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const kind = t.waiting?.kind;
    if (kind !== 'plan' && kind !== 'proof') throw new BoardActionError(`${t.id} has no plan or proof waiting for you.`);
    t.changeRequest = note;
    t.waiting = null;
    t.live = true;
    addActivity(t, 'you', `Asked for a change: ${note}`);
    if (kind === 'plan') {
      t.status = 'Spec writer is updating the plan';
      scheduleSquad(t, 'plan-rewrite', 2, meta.speed);
    } else {
      t.stage = 'implement';
      t.status = 'Builder is fixing what you found';
      t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      scheduleSquad(t, 'fix', 2, meta.speed);
    }
  });
}

export function decideStuck(bp: BoardPaths, id: string, choice: number): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'stuck' || !t.stuck) throw new BoardActionError(`${t.id} is not stuck.`);
    const option = t.stuck.options[choice];
    if (!option) throw new BoardActionError(`Pick a choice between 1 and ${t.stuck.options.length}.`);
    t.stuck.options.forEach((o, i) => (o.chosen = i === choice));
    t.waiting = null;
    t.live = true;
    addActivity(t, 'you', `Decided: ${option.name}`);
    if (meta.engine !== 'live') {
      t.status = 'Builder is trying your choice';
      scheduleSquad(t, 'unstick', 2, meta.speed);
      return;
    }
    // Live squad: the first choice runs the stopped step again, the second goes back to the plan.
    if (t.retryPhase === 'publish' && choice === 1) {
      t.live = false;
      t.status = `Ready for ${t.release ?? 'the next release'}`;
    } else if (choice === 0) {
      t.tries = 0;
      t.status = 'Trying again';
      scheduleSquad(t, t.retryPhase ?? 'analyst-read', 0.5, 1);
    } else {
      t.changeRequest = `The squad got stuck: ${t.stuck.question}`;
      t.stage = 'specs';
      t.status = 'Spec writer is updating the plan';
      scheduleSquad(t, t.story ? 'plan-rewrite' : 'analyst-read', 0.5, 1);
    }
    t.retryPhase = undefined;
  });
}

function bump(version: string, part: 'minor' | 'patch'): string {
  const [maj = 0, min = 0, pat = 0] = version.replace(/^v/, '').split('.').map(Number);
  return part === 'minor' ? `v${maj}.${min + 1}.0` : `v${maj}.${min}.${pat + 1}`;
}

export function ensureDraftRelease(bp: BoardPaths, part: 'minor' | 'patch'): Release {
  const draft = draftRelease(bp);
  if (draft) return draft;
  const meta = readMeta(bp);
  const live = meta.engine === 'live';
  const last = latestRelease(bp);
  // The first release on a live board continues the project's own version, not 0.0.0.
  const from = last?.version ?? (live ? projectVersion(path.dirname(path.dirname(bp.dir)), meta) : 'v0.0.0');
  const release: Release = {
    version: bump(from, part),
    status: 'draft',
    from,
    tickets: [],
    notes: '',
    addons: {
      changelog: true,
      tag: true,
      pipeline: live ? reposOf(meta).some((r) => r.commands.deploy) || Boolean(meta.commands?.deploy) : true,
      whatsapp: true,
    },
  };
  writeRelease(bp, release);
  return release;
}

function versionKey(v: string): number[] {
  return v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
}

function newer(a: string, b: string): string {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b;
  return a;
}

/** The highest version a project already has: a git tag like v2.3.1, or package.json. */
function projectVersion(root: string, meta: ReturnType<typeof readMeta>): string {
  let best = 'v0.0.0';
  for (const repo of reposOf(meta)) {
    const dir = path.join(root, repo.path);
    for (const tag of git(dir, ['tag', '--list', 'v*'], { allowFail: true }).split('\n')) {
      if (/^v\d+\.\d+\.\d+$/.test(tag.trim())) best = newer(best, tag.trim());
    }
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const v = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: string }).version;
        if (v && /^\d+\.\d+\.\d+/.test(v)) best = newer(best, `v${v.split('-')[0]}`);
      } catch {
        // A broken package.json says nothing about the version.
      }
    }
  }
  return best;
}

/** Release notes written from the tickets inside, in plain words. */
export function composeNotes(bp: BoardPaths, release: Release): string {
  const tickets = listTickets(bp).filter((t) => release.tickets.includes(t.id));
  const lines = tickets.map((t) => `- ${t.releaseNote ?? `**${t.title}.**`}`);
  return [`### What's new in ${release.version.replace(/^v/, '')}`, '', ...lines].join('\n');
}

export function saveReleaseNotes(bp: BoardPaths, version: string, notes: string): Release {
  const release = readRelease(bp, version);
  if (!release || release.status !== 'draft') throw new BoardActionError(`${version} is not a draft release.`);
  release.notes = notes;
  writeRelease(bp, release);
  return release;
}

export async function releaseVersion(bp: BoardPaths, version?: string): Promise<Release> {
  const release = version ? readRelease(bp, version) : draftRelease(bp);
  if (!release || release.status !== 'draft') throw new BoardActionError('There is no release ready to go out.');
  if (release.tickets.length === 0) throw new BoardActionError(`${release.version} has no tickets yet.`);
  const meta = readMeta(bp);
  if (!release.notes.trim()) release.notes = composeNotes(bp, release);
  const tickets = listTickets(bp).filter((t) => release.tickets.includes(t.id));
  if (meta.engine === 'live') {
    try {
      release.log = await liveRelease(bp, release, tickets);
      if (meta.scan?.empty) writeMeta(bp, { ...readMeta(bp), scan: { ...meta.scan, empty: false } });
    } catch (err) {
      throw new BoardActionError(`The release did not go out: ${(err as Error).message}`);
    }
  }
  release.status = 'released';
  release.date = now();
  release.whatsappDraft = [
    `Hello, version ${release.version.replace(/^v/, '')} of ${meta.project} is now live.`,
    '',
    "What's new:",
    ...tickets.map((t) => `- ${t.title}`),
    '',
    'Release notes are in the changelog.',
  ].join('\n');
  writeRelease(bp, release);
  for (const t of tickets) {
    updateTicket(bp, t.id, (x) => {
      x.stage = 'done';
      x.status = `Released in ${release.version}`;
      x.live = false;
      addActivity(x, 'release', `Released in ${release.version}`);
      tellLater(x, meta.engine, { kind: 'released', version: release.version });
    });
  }
  return release;
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

export function stopTicket(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    if (!t.live && !t.squad) throw new BoardActionError(`${t.id} is not running right now.`);
    t.stopRequested = true;
    t.status = 'Stopping…';
    addActivity(t, 'you', 'Pressed Stop');
  });
}

/**
 * The watchdog says a step looks stuck on a command: end that command (and what it started). The role gets an error
 * back and carries on, with its conversation intact.
 */
export function endStuckCommand(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    if (!t.quiet?.pid) throw new BoardActionError(`${t.id} has no stuck command to end.`);
    endProcessTree(t.quiet.pid);
    addActivity(t, 'you', `Ended the stuck command: ${t.quiet.command ?? 'a command'}`);
    delete t.quiet;
  });
}

/** "Keep waiting": the step is slow but fine. The watchdog stays quiet about it for 10 minutes. */
export function keepWaiting(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    if (!t.quiet) throw new BoardActionError(`${t.id} is not quiet right now.`);
    t.quietSnoozedUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    addActivity(t, 'you', 'Chose to keep waiting');
    delete t.quiet;
  });
}

/** Everything that needs the person: open questions, plans, proof, decisions, and steps that look stuck. */
export function inbox(bp: BoardPaths): Ticket[] {
  return listTickets(bp).filter((t) => t.waiting || t.quiet?.kind === 'stuck');
}

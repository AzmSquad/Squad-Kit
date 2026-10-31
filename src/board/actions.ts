import {
  addActivity,
  draftRelease,
  latestRelease,
  listDecisions,
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
  listReleases,
  writeTicket,
  writeMeta,
  codeChanged,
  queueImpactCheck,
  type BoardPaths,
} from './store.js';
import fs from 'node:fs';
import path from 'node:path';
import type { BoardMeta, Decision, ImpactCheck, Release, TechDraft, Ticket } from './types.js';
import { detectStack } from './stack.js';
import { scheduleSquad } from './schedule.js';
import { PullRequestClash, commitTicket, liveRelease } from '../engine/release.js';
import { git } from '../engine/git.js';
import { repoFor, reposOf } from '../engine/repos.js';
import { buildPaths } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { loadSecrets } from '../core/secrets.js';
import { clientFor, overlayTrackerEnv } from '../tracker/index.js';
import { azureFor, type Azure } from '../engine/azure.js';
import { localSetupFor, mergeLocally, opensPullRequest, syncWiki } from '../engine/sync.js';
import type { AgentChat, AgentName, Criterion, PlanComment, PlanEdit, PlanPart, PlanSnapshot, StuckChoice, StuckOption, TicketNote, Track, TrackerEvent, WayOut } from './types.js';
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
  /** How bad a bug is. Only kept on bugs. */
  severity?: Ticket['severity'];
  track?: Track;
  /** Talk it through with the Analyst first, before any questions or spec. */
  talkFirst?: boolean;
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
  const meta = readMeta(bp);
  const id = nextTicketId(bp);
  const brief = { criteria: cleanList(input.criteria), rules: cleanList(input.rules), edgeCases: cleanList(input.edgeCases) };
  const attachments = input.files?.length ? saveUploads(path.join(bp.dir, 'attachments', id), input.files) : [];
  const ticket: Ticket = {
    id,
    title,
    ask: input.ask?.trim() || title,
    kind: input.kind ?? 'feature',
    track: input.track === 'express' ? 'express' : 'full',
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
    ...(input.kind === 'bug' && input.severity ? { severity: input.severity } : {}),
  };
  addActivity(ticket, 'you', input.source?.type === 'azure' ? `Pulled ${input.source.ref} from Azure DevOps` : 'Created the ticket');
  if (ticket.track === 'express') addActivity(ticket, 'you', 'Chose the Express track: no questions, the plan is approved on its own');
  if (attachments.length) addActivity(ticket, 'you', `Added ${attachments.length === 1 ? '1 file' : `${attachments.length} files`}`);
  if (input.talkFirst && ticket.track !== 'express') {
    openChat(ticket, 'analyst', { waiting: null, phase: 'analyst-read' });
    addActivity(ticket, 'you', 'Chose to talk it through with the Analyst first');
  } else scheduleSquad(ticket, 'analyst-read', 4, meta.speed);
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
  if (kind === 'spec') return approveSpec(bp, ticket, meta.speed);
  if (kind === 'plan') return approvePlan(bp, ticket, meta.speed);
  if (kind === 'proof') return acceptProof(bp, ticket);
  if (kind === 'questions') throw new BoardActionError(`${ticket.id} needs answers first. Run: squad answer ${ticket.id}`);
  if (kind === 'stuck') throw new BoardActionError(`${ticket.id} needs a decision. Run: squad decide ${ticket.id}`);
  throw new BoardActionError(`${ticket.id} is not waiting for an approval right now.`);
}

/** Express track: the plan is approved on its own. You still see it; nothing waits for you. */
export function approveExpress(bp: BoardPaths, id: string): Ticket {
  const ticket = requireTicket(bp, id);
  if (ticket.track !== 'express') throw new BoardActionError(`${ticket.id} is on the Full track.`);
  return approvePlan(bp, { ...ticket, waiting: { kind: 'plan', summary: '' } }, readMeta(bp).speed, true);
}

/** True when the Full track still needs the spec approved before the Architect designs. */
export function needsSpec(t: Ticket): boolean {
  return t.track !== 'express' && !t.specApproved;
}

/** Full track: you approve the what. Then the Architect designs the how from it, and you approve that too. */
function approveSpec(bp: BoardPaths, ticket: Ticket, speed: number): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, ticket.id, (t) => {
    t.specApproved = { by: meta.user.name, at: now() };
    t.planReview = undefined;
    t.waiting = null;
    t.stage = 'specs';
    t.live = true;
    t.status = 'Architect is choosing the design';
    addActivity(t, 'you', 'Approved the spec');
    scheduleSquad(t, 'plan-write', 2, speed, 0);
    tellLater(t, meta.engine, { kind: 'note', text: `Spec approved by ${meta.user.name}: ${t.story ?? ''}`, noteKind: 'note' });
  });
}

function approvePlan(bp: BoardPaths, ticket: Ticket, speed: number, express = false): Ticket {
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
      approvedBy: express ? `${meta.user.name} (Express track)` : meta.user.name,
      date: now(),
      checkedBy: { kind: 'test', name: testNameFor(ticket), passing: false },
      tickets: [ticket.id],
      ...(ticket.decision.area ? { area: ticket.decision.area } : {}),
      ...(ticket.follows?.length ? { buildsOn: ticket.follows } : {}),
      ...(ticket.decision.replaces ? { replaces: ticket.decision.replaces } : {}),
    });
  }
  linkDecisions(bp, ticket, adr);
  if (adr) queueImpactCheck(bp, adr);
  return updateTicket(bp, ticket.id, (t) => {
    t.planReview = undefined;
    if (t.decision && adr) t.decision.adr = adr;
    t.waiting = null;
    t.stage = 'implement';
    t.live = true;
    t.progress = 0;
    t.status = `Step 1 of ${t.steps?.length ?? 1} with ${t.builder ?? 'the Builder'}`;
    t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    const approved = express ? 'Express track: approved the plan on its own' : t.specApproved ? 'Approved the design' : 'Approved the plan';
    addActivity(t, express ? 'squad' : 'you', adr ? `${approved}. Decision saved as ${adr}${t.decision?.replaces ? `, replacing ${t.decision.replaces}` : ''}` : approved);
    scheduleSquad(t, 'build', 2, speed, 0);
    tellLater(t, meta.engine, { kind: 'planned' });
  });
}

/** Each decision the design followed lists the ticket; the one a new decision replaces stops being a rule. */
function linkDecisions(bp: BoardPaths, ticket: Ticket, adr: string | undefined): void {
  const all = listDecisions(bp);
  for (const id of ticket.follows ?? []) {
    const d = all.find((x) => x.id === id);
    if (d && !d.tickets.includes(ticket.id)) writeDecision(bp, { ...d, tickets: [...d.tickets, ticket.id] });
  }
  const old = adr && ticket.decision?.replaces ? all.find((x) => x.id === ticket.decision!.replaces) : undefined;
  if (old && adr && old.id !== adr) {
    const fresh = listDecisions(bp).find((x) => x.id === old.id) ?? old;
    writeDecision(bp, { ...fresh, replacedBy: adr, tickets: fresh.tickets.includes(ticket.id) ? fresh.tickets : [...fresh.tickets, ticket.id] });
  }
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
  const openPr = !ticket.pr && opensPullRequest(bp, ticket);
  // Merge on accept: without a pull request host the branch merges into the base right here, so the next tickets
  // build on it. With Azure Repos the live squad opens the PR and merges it.
  let merged: ReturnType<typeof mergeLocally> = null;
  if (readMeta(bp).engine === 'live' && !openPr && !ticket.mergedAt) {
    try {
      merged = mergeLocally(bp, ticket);
    } catch (err) {
      return clashed(bp, ticket.id, commit, (err as Error).message);
    }
  }
  const release = ensureDraftRelease(bp, ticket.kind === 'bug' ? 'patch' : 'minor');
  if (!release.tickets.includes(ticket.id)) release.tickets.push(ticket.id);
  writeRelease(bp, release);
  // New code on the base: the architecture page reads it again.
  if (merged?.moved) codeChanged(bp);
  return updateTicket(bp, ticket.id, (t) => {
    t.waiting = null;
    t.stage = 'release';
    t.live = openPr;
    t.progress = undefined;
    t.release = release.version;
    const into = merged?.moved ? merged : null;
    t.status = openPr
      ? 'Opening the pull request'
      : into
        ? `Merged into ${into.base} · goes out in ${release.version}`
        : merged
          ? `Ready for ${release.version} · ${merged.base} not moved yet`
          : `Ready for ${release.version}`;
    if (into) {
      t.mergedAt = now();
      const ls = localSetupFor(bp, t);
      if (ls) t.localSetup = ls;
    }
    t.squad = openPr ? { phase: 'publish', nextAt: now() } : null;
    addActivity(t, 'you', 'Checked the proof. Looks right');
    if (commit) addActivity(t, 'release', `Saved the change as commit ${commit} on ${t.branch}`);
    if (merged) addActivity(t, 'release', merged.moved ? `Merged into ${merged.base}` : `Could not move ${merged.base} yet. ${merged.note ?? ''}`.trim());
    addActivity(t, 'release', `Added to release ${release.version}`);
  });
}

/** The accepted branch clashes with the base: not a dead end, a stuck card with ways out. */
function clashed(bp: BoardPaths, id: string, commit: string | null, error: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const base = repoFor(meta, t).base;
    clashCard(t, base, `The change is saved, but it cannot go into ${base}: someone changed the same lines there since this ticket started. ${error.replace(/^squad\/\S+ /, '')}`.trim());
    addActivity(t, 'you', 'Checked the proof. Looks right');
    if (commit) addActivity(t, 'release', `Saved the change as commit ${commit} on ${t.branch}`);
    addActivity(t, 'release', `Could not merge into ${base}: it clashes with newer changes there`);
  });
}

function clashCard(t: Ticket, base: string, question: string): void {
  t.waiting = { kind: 'stuck', summary: `Clashes with ${base} and needs one decision` };
  t.live = false;
  t.squad = null;
  t.status = `Clashes with ${base}`;
  t.retryPhase = 'update-base';
  t.stuck = { gate: 'merge', question, options: wayOptions({ gate: 'merge', base, copy: Boolean(t.worktree && fs.existsSync(t.worktree)) }) };
}

/**
 * Azure cannot merge the ticket's pull request: newer changes in the base clash with it. Instead of waiting there and
 * stopping the release, the ticket leaves the draft release with the clash card; accepting it again updates the same
 * pull request.
 */
export function pullRequestClashed(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  const draft = listReleases(bp).find((r) => r.status !== 'released' && r.tickets.includes(id));
  if (draft) writeRelease(bp, { ...draft, tickets: draft.tickets.filter((x) => x !== id) });
  return updateTicket(bp, id, (t) => {
    const base = repoFor(meta, t).base;
    const pr = t.pr?.id;
    clashCard(t, base, `Pull request ${pr} cannot go into ${base}: someone changed the same lines there since this ticket started.`);
    t.stage = 'review';
    // Found again by its branch when the ticket is accepted the next time.
    t.pr = undefined;
    t.release = undefined;
    addActivity(t, 'release', `Pull request ${pr} clashes with newer changes in ${base}, so it left ${draft?.version ?? 'the release'}`);
  });
}

/** Answers a question the Builder or Reviewer asked mid-work. "Decide yourself" is always a way out. */
export function answerAgent(bp: BoardPaths, id: string, text: string): Ticket {
  const answer = text.trim();
  if (!answer) throw new BoardActionError('Write your answer, or pick one of the choices.');
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const q = t.agentQuestion;
    if (t.waiting?.kind !== 'ask' || !q) throw new BoardActionError(`${t.id} has no question waiting for you.`);
    q.answer = answer;
    t.waiting = null;
    t.live = true;
    const who = { architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer' }[q.from];
    t.status = q.from === 'builder' ? 'Builder is carrying on with your answer' : q.from === 'architect' ? 'Architect is writing the design with your answer' : 'Reviewer is finishing with your answer';
    addActivity(t, 'you', `Answered the ${who}: ${answer}`);
    scheduleSquad(t, `answered-${q.from}`, 1, meta.speed);
  });
}

export const DECIDE_YOURSELF = 'Decide yourself: take the simplest choice that fits the plan, and say what you chose';

const NOTE_LABEL = { note: 'a note', criterion: 'an acceptance criterion', rule: 'a business rule' } as const;

/** A note, rule or acceptance criterion added at any time, or a message to one agent. Running agents get it at their next step. */
export function addNote(bp: BoardPaths, id: string, input: { text: string; kind?: TicketNote['kind']; to?: AgentName }): Ticket {
  const text = input.text?.trim();
  if (!text) throw new BoardActionError(input.to ? 'Write the message first.' : 'Write the note first.');
  const kind = input.kind && input.kind in NOTE_LABEL ? input.kind : 'note';
  const to = input.to && AGENT_LABEL[input.to] ? input.to : undefined;
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (t.stage === 'done') throw new BoardActionError(`${t.id} is released. Add a new ticket instead.`);
    t.notes = [...(t.notes ?? []), { at: now(), by: meta.user.name, kind, text, ...(to ? { to } : {}) }];
    addActivity(t, 'you', to ? `Message to the ${AGENT_LABEL[to]}: ${text}` : `Added ${NOTE_LABEL[kind]}: ${text}`);
    tellLater(t, meta.engine, { kind: 'note', text: to ? `To the ${AGENT_LABEL[to]}: ${text}` : text, noteKind: kind });
  });
}

const AGENT_LABEL: Record<AgentName, string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' };

/**
 * Take over: the squad stops on this ticket and you work in the Builder's own Claude Code session, in the ticket's
 * copy. Nothing runs until you give it back, so you and the squad never edit at the same time.
 */
export function takeOver(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (t.takenOver) throw new BoardActionError(`${t.id} is already yours. Give it back when you are done.`);
    if (t.stage === 'release' || t.stage === 'done') throw new BoardActionError(`${t.id} is accepted already. Report a bug or add a new ticket instead.`);
    const demo = meta.engine !== 'live';
    const building = ['implement', 'test', 'review'].includes(t.stage);
    const session = t.sessions?.build ?? (demo && building ? 'demo-session' : undefined);
    const cwd = t.worktree ?? (demo ? path.dirname(path.dirname(bp.dir)) : undefined);
    if (!session || !cwd || (!demo && !fs.existsSync(cwd))) {
      throw new BoardActionError(`${t.id} has no code yet. You can take over once the Builder has started.`);
    }
    if (t.live && !demo) t.stopRequested = true;
    t.takenOver = { by: meta.user.name, at: now(), session, cwd };
    t.live = false;
    t.squad = null;
    t.waiting = { kind: 'yours', summary: 'You took it over. Give it back when you are done' };
    t.status = `${meta.user.name} is working on it in Claude Code`;
    addActivity(t, 'you', 'Took it over in Claude Code. The squad waits');
  });
}

/** Give back: the squad picks up from your changes, and the checks, review and proof run again on them. */
export function giveBack(bp: BoardPaths, id: string, note?: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (!t.takenOver) throw new BoardActionError(`${t.id} is not taken over.`);
    const text = note?.trim();
    if (text) {
      t.notes = [...(t.notes ?? []), { at: now(), by: meta.user.name, kind: 'note', text }];
      tellLater(t, meta.engine, { kind: 'note', text, noteKind: 'note' });
    }
    t.takenOver = undefined;
    t.stopRequested = undefined;
    t.waiting = null;
    t.stuck = undefined;
    t.agentQuestion = undefined;
    t.retryPhase = undefined;
    t.live = true;
    t.tries = 0;
    t.reviewRound = 0;
    t.reviewNotes = undefined;
    t.proof = undefined;
    t.mergedAt = undefined;
    t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
    t.stage = 'test';
    t.status = 'Running the project checks on your changes';
    addActivity(t, 'you', text ? `Gave it back: ${text}` : 'Gave it back');
    scheduleSquad(t, 'test', meta.engine === 'live' ? 0.2 : 2, meta.engine === 'live' ? 1 : meta.speed);
  });
}

/** "Change something" on a spec or plan, or "Something's wrong" on the proof. */
export function requestChange(bp: BoardPaths, id: string, text: string): Ticket {
  const note = text.trim();
  if (!note) throw new BoardActionError('Say in one line what should change.');
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const kind = t.waiting?.kind;
    if (kind !== 'spec' && kind !== 'plan' && kind !== 'proof') throw new BoardActionError(`${t.id} has no spec, plan or proof waiting for you.`);
    t.changeRequest = note;
    t.waiting = null;
    t.live = true;
    addActivity(t, 'you', `Asked for a change: ${note}`);
    if (kind === 'spec') {
      t.status = 'Analyst is updating the spec';
      scheduleSquad(t, 'spec-rewrite', 2, meta.speed);
    } else if (kind === 'plan') {
      t.status = t.specApproved ? 'Architect is updating the design' : 'Spec writer is updating the plan';
      scheduleSquad(t, 'plan-rewrite', 2, meta.speed);
    } else {
      t.stage = 'implement';
      t.status = 'Builder is fixing what you found';
      t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
      scheduleSquad(t, 'fix', 2, meta.speed);
    }
  });
}

/* ── Talk it through with an agent ────────────────────── */

const AGENT_TITLE: Record<AgentName, string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' };

/** The session each agent talks in: its own Claude Code conversation on the ticket. */
export const CHAT_SESSION: Record<AgentName, 'intake' | 'build' | 'review' | 'tester'> = {
  analyst: 'intake',
  architect: 'intake',
  builder: 'build',
  reviewer: 'review',
  tester: 'tester',
};

function openChat(t: Ticket, agent: AgentName, before: AgentChat['before']): void {
  const keep = t.chat?.with === agent ? t.chat.messages : [];
  t.chat = { with: agent, open: true, messages: keep, thinking: true, before };
  t.waiting = { kind: 'chat', summary: `Talking it through with the ${AGENT_TITLE[agent]}` };
  t.live = false;
  t.squad = null;
  t.status = `Talking with the ${AGENT_TITLE[agent]}`;
}

/**
 * Talk it through: open a chat with any agent on the ticket. Its work pauses until you are done, so the two of you
 * never pull the ticket in different directions. The agent opens with where it is and what it is unsure of.
 */
export function startChat(bp: BoardPaths, id: string, agent: AgentName): Ticket {
  const meta = readMeta(bp);
  if (!AGENT_TITLE[agent]) throw new BoardActionError('Pick an agent: analyst, architect, builder, reviewer or tester.');
  return updateTicket(bp, id, (t) => {
    if (t.chat?.open) throw new BoardActionError(`${t.id} already has a chat open with the ${AGENT_TITLE[t.chat.with]}.`);
    if (t.takenOver) throw new BoardActionError(`${t.id} is taken over. Give it back first.`);
    if (t.stage === 'release' || t.stage === 'done') throw new BoardActionError(`${t.id} is accepted already. Report a bug or add a new ticket instead.`);
    const later = agent === 'builder' || agent === 'reviewer' || agent === 'tester';
    if (later && meta.engine === 'live' && !t.sessions?.[CHAT_SESSION[agent]]) {
      throw new BoardActionError(`The ${AGENT_TITLE[agent]} has not worked on ${t.id} yet, so there is nothing to talk through with it.`);
    }
    if (t.live && meta.engine === 'live') t.stopRequested = true;
    openChat(t, agent, { waiting: t.waiting, ...(t.squad?.phase ? { phase: t.squad.phase } : {}) });
    addActivity(t, 'you', `Started talking it through with the ${AGENT_TITLE[agent]}`);
  });
}

/** Your message in the chat, with screenshots, files or voice notes if you add them. */
export function sendChat(bp: BoardPaths, id: string, text: string, uploads: UploadedFile[] = []): Ticket {
  const msg = text?.trim() ?? '';
  if (!msg && !uploads.length) throw new BoardActionError('Write your message first.');
  const t0 = requireTicket(bp, id);
  if (!t0.chat?.open) throw new BoardActionError(`${t0.id} has no chat open.`);
  if (t0.chat.thinking) throw new BoardActionError(`The ${AGENT_TITLE[t0.chat.with]} is still answering. Wait a moment.`);
  const files = saveUploads(path.join(bp.dir, 'attachments', t0.id), uploads);
  return updateTicket(bp, id, (t) => {
    const c = t.chat!;
    c.messages.push({ who: 'you', text: msg, at: now(), ...(files.length ? { files } : {}) });
    if (files.length) t.attachments = [...(t.attachments ?? []), ...files];
    c.thinking = true;
  });
}

/**
 * Write (or update) the spec or the design from the talk. The chat closes, and the new version comes to you as
 * usual, with what changed. Reopen the chat from there to keep talking.
 */
export function chatWrite(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c?.open) throw new BoardActionError(`${t.id} has no chat open.`);
    if (c.thinking) throw new BoardActionError(`The ${AGENT_TITLE[c.with]} is still answering. Wait a moment.`);
    if (c.with === 'architect' ? !t.specApproved : c.with !== 'analyst') {
      throw new BoardActionError(c.with === 'architect' ? 'The Architect writes the design once the spec is approved.' : `The ${AGENT_TITLE[c.with]} does not write the spec or design.`);
    }
    const design = c.with === 'architect';
    if (design ? t.steps : t.story) t.planReview = { before: planSnapshot(t), sent: [] };
    c.open = false;
    t.waiting = null;
    t.live = true;
    t.stage = 'specs';
    t.status = design ? (t.steps ? 'Architect is updating the design from your talk' : 'Architect is writing the design from your talk') : t.story ? 'Analyst is updating the spec from your talk' : 'Analyst is writing the spec from your talk';
    addActivity(t, 'you', `Asked the ${AGENT_TITLE[c.with]} to ${(design ? t.steps : t.story) ? 'update' : 'write'} the ${design ? 'design' : 'spec'} from your talk`);
    scheduleSquad(t, design ? 'chat-design' : 'chat-spec', meta.engine === 'live' ? 0.2 : 2, meta.engine === 'live' ? 1 : meta.speed);
  });
}

/**
 * Done talking. The Builder, Reviewer and Tester carry on from what you agreed (the talk is in their session). The
 * Analyst and Architect leave the ticket where it was; to change the spec or design, use chatWrite instead.
 */
export function chatDone(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c?.open) throw new BoardActionError(`${t.id} has no chat open.`);
    if (c.thinking) throw new BoardActionError(`The ${AGENT_TITLE[c.with]} is still answering. Wait a moment.`);
    c.open = false;
    t.stopRequested = undefined;
    addActivity(t, 'you', `Done talking with the ${AGENT_TITLE[c.with]}`);
    const live = meta.engine === 'live';
    const later = c.with === 'builder' || c.with === 'reviewer' || c.with === 'tester';
    if (later && c.messages.some((m) => m.who === 'you')) {
      t.waiting = null;
      t.live = true;
      t.status = `${AGENT_TITLE[c.with]} is carrying on with what you agreed`;
      scheduleSquad(t, `chat-carry-${c.with}`, live ? 0.2 : 2, live ? 1 : meta.speed);
      return;
    }
    t.waiting = c.before.waiting;
    if (c.before.phase) {
      t.live = true;
      t.status = 'Carrying on';
      scheduleSquad(t, c.before.phase, live ? 0.2 : 2, live ? 1 : meta.speed);
    } else {
      t.live = false;
      t.status = c.before.waiting ? c.before.waiting.summary : t.status;
    }
  });
}

/* ── Review a plan like a document ─────────────────────── */

const PART_NAME = { story: 'the story', criterion: 'done when', decision: 'the decision', step: 'step' } as const;

function partLabel(p: PlanPart): string {
  return p.part === 'criterion' || p.part === 'step' ? `${PART_NAME[p.part]} ${(p.index ?? 0) + 1}` : PART_NAME[p.part];
}

function criterionText(c: Criterion): string {
  return `Given ${c.given}, when ${c.when}, then ${c.then}.`;
}

/** The words a part has now, to quote it back to the agent. */
function partText(t: Ticket, p: PlanPart): string {
  if (p.part === 'story') return t.story ?? '';
  if (p.part === 'decision') return t.decision ? `${t.decision.title}. ${t.decision.why}` : '';
  if (p.part === 'criterion') return t.criteria?.[p.index ?? 0] ? criterionText(t.criteria[p.index ?? 0]!) : '';
  return t.steps?.[p.index ?? 0]?.title ?? '';
}

export function planSnapshot(t: Ticket): PlanSnapshot {
  return {
    ...(t.story ? { story: t.story } : {}),
    ...(t.criteria ? { criteria: t.criteria.map((c) => ({ ...c })) } : {}),
    ...(t.decision ? { decision: `${t.decision.title}: ${t.decision.options.find((o) => o.chosen)?.name ?? ''}` } : {}),
    ...(t.steps ? { steps: t.steps.map((s) => s.title) } : {}),
  };
}

/** Which parts the person may change on the card that waits: the spec's what, or the design's how. */
function editable(t: Ticket, p: PlanPart): boolean {
  if (t.waiting?.kind === 'spec') return p.part === 'story' || p.part === 'criterion';
  if (t.waiting?.kind === 'plan') return p.part === 'step' || (!t.specApproved && (p.part === 'story' || p.part === 'criterion'));
  return false;
}

/** Puts the person's own wording back after a rewrite: their edits win. */
export function applyPlanEdits(t: Ticket): void {
  for (const e of t.planReview?.edits ?? []) {
    const i = e.index ?? 0;
    if (e.part === 'story' && e.text) t.story = e.text;
    if (e.part === 'criterion' && e.criterion && t.criteria?.[i]) t.criteria[i] = { ...e.criterion };
    if (e.part === 'step' && e.text && t.steps?.[i]) t.steps[i] = { ...t.steps[i]!, title: e.text };
  }
}

/** Edit a part of the spec or design yourself. It takes effect at once; Approve keeps it, a rewrite keeps it too. */
export function editPlan(bp: BoardPaths, id: string, edit: PlanEdit): Ticket {
  return updateTicket(bp, id, (t) => {
    if (!editable(t, edit)) throw new BoardActionError(`That part of ${t.id} cannot be edited now.`);
    const i = edit.index ?? 0;
    const text = edit.text?.trim();
    if (edit.part === 'criterion') {
      const c = edit.criterion;
      if (!c?.given.trim() || !c.when.trim() || !c.then.trim()) throw new BoardActionError('Fill in Given, When and Then.');
      if (!t.criteria?.[i]) throw new BoardActionError('That "done when" item is gone. Reload the ticket.');
      t.criteria[i] = { given: c.given.trim(), when: c.when.trim(), then: c.then.trim() };
    } else {
      if (!text) throw new BoardActionError('Write the new text first.');
      if (edit.part === 'story') t.story = text;
      else if (t.steps?.[i]) t.steps[i] = { ...t.steps[i]!, title: text };
      else throw new BoardActionError('That step is gone. Reload the ticket.');
    }
    const saved: PlanEdit = edit.part === 'criterion' ? { part: 'criterion', index: i, criterion: t.criteria![i]! } : { part: edit.part, ...(edit.part === 'step' ? { index: i } : {}), text };
    const others = (t.planReview?.edits ?? []).filter((e) => !(e.part === saved.part && (e.index ?? 0) === i));
    t.planReview = { ...t.planReview, edits: [...others, saved] };
    addActivity(t, 'you', `Edited ${partLabel(edit)}`);
  });
}

/** The comments and edits, written for the agent that rewrites. */
export function reviewText(t: Ticket, comments: PlanComment[]): string {
  const lines = comments.map((c) => {
    const quote = partText(t, c);
    return `- On ${partLabel(c)}${quote ? ` ("${quote.slice(0, 200)}")` : ''}: ${c.text.trim()}`;
  });
  const edits = (t.planReview?.edits ?? []).map((e) => `- ${partLabel(e)}: "${e.part === 'criterion' && e.criterion ? criterionText(e.criterion) : (e.text ?? '')}"`);
  return [
    'The person reviewed it and left these comments:',
    ...lines,
    ...(edits.length ? ['They also rewrote these parts themselves. Keep their wording exactly:', ...edits] : []),
  ].join('\n');
}

function toWriter(t: Ticket, note: string, speed: number, status?: string): void {
  const spec = t.waiting?.kind === 'spec';
  t.changeRequest = note;
  t.waiting = null;
  t.live = true;
  t.status = status ?? (spec ? 'Analyst is updating the spec' : t.specApproved ? 'Architect is updating the design' : 'Spec writer is updating the plan');
  scheduleSquad(t, spec ? 'spec-rewrite' : 'plan-rewrite', 2, speed);
}

/** One short line for the activity: the change itself, or what kind of review it was. */
export function changeSummary(change: string | undefined): string {
  if (!change) return 'your change';
  if (change.startsWith('Start over')) return 'started over with your new direction';
  if (change.includes('\n')) {
    const n = change.split('\n').filter((l) => l.startsWith('- On ')).length;
    return `with your ${n} ${n === 1 ? 'comment' : 'comments'}`;
  }
  return change;
}

/** Send back: every comment at once. The next version shows what changed. */
export function sendBack(bp: BoardPaths, id: string, comments: PlanComment[]): Ticket {
  const meta = readMeta(bp);
  const clean = (comments ?? []).filter((c) => c?.text?.trim() && ['story', 'criterion', 'decision', 'step'].includes(c.part));
  if (!clean.length) throw new BoardActionError('Add at least one comment first.');
  return updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'spec' && t.waiting?.kind !== 'plan') throw new BoardActionError(`${t.id} has no spec or design waiting for you.`);
    const sent = clean.map((c) => ({ part: c.part, ...(c.index !== undefined ? { index: c.index } : {}), text: c.text.trim() }));
    const note = reviewText(t, sent);
    t.planReview = { ...t.planReview, before: planSnapshot(t), sent };
    addActivity(t, 'you', `Sent back with ${sent.length} ${sent.length === 1 ? 'comment' : 'comments'}`);
    toWriter(t, note, meta.speed);
  });
}

/** Start over: the whole idea was wrong. The agent writes it again from zero, with your new direction. */
export function startOver(bp: BoardPaths, id: string, direction: string): Ticket {
  const meta = readMeta(bp);
  const text = direction?.trim();
  if (!text) throw new BoardActionError('Say in a line or two what the new direction is.');
  return updateTicket(bp, id, (t) => {
    const kind = t.waiting?.kind;
    if (kind !== 'spec' && kind !== 'plan') throw new BoardActionError(`${t.id} has no spec or design waiting for you.`);
    const design = kind === 'plan' && t.specApproved;
    if (!design) {
      delete t.story;
      delete t.criteria;
      delete t.releaseNote;
    }
    delete t.decision;
    delete t.steps;
    delete t.work;
    delete t.mockup;
    t.planReview = undefined;
    addActivity(t, 'you', `Started over: ${text}`);
    toWriter(
      t,
      `Start over from zero. Drop your earlier version completely; the person's new direction is:\n${text}`,
      meta.speed,
      kind === 'spec' ? 'Analyst is writing a new spec' : design ? 'Architect is writing a new design' : 'Spec writer is writing a new plan',
    );
  });
}

/** The choices on a stuck card. Every stop has a way out: try again, do it yourself, go around it, or back to the plan. */
export function wayOptions(stop: { gate?: StuckChoice['gate']; publish?: boolean; copy?: boolean; base?: string }): StuckOption[] {
  if (stop.publish) {
    return [
      { do: 'retry', name: 'Try again', note: 'Push the branch and open the pull request again.' },
      { do: 'skip-pr', name: 'Skip the pull request', note: 'Release merges this branch directly instead.' },
    ];
  }
  const retry: StuckOption =
    stop.gate === 'checks'
      ? { do: 'retry', name: 'Let the Builder try 3 more times', note: 'It gets the full error and tries again.' }
      : stop.gate === 'review'
        ? { do: 'retry', name: 'Let the Builder fix the notes', note: 'Then the Reviewer gets two more rounds.' }
        : stop.gate === 'proof'
          ? { do: 'retry', name: 'Take the screenshots again', note: 'Only the proof runs again. Nothing is rebuilt. You can add a note for the Tester.' }
          : stop.gate === 'merge'
          ? { do: 'retry', name: `Let the Builder bring in the latest ${stop.base ?? 'base'}`, note: 'It merges it into this ticket, fixes the clash, and the checks run again.' }
          : { do: 'retry', name: 'Try again', note: 'Run the same step again. You can add a note for the squad.' };
  const out: StuckOption[] = [retry];
  if (stop.copy && stop.gate !== 'proof') {
    out.push({
      do: 'yourself',
      name: stop.gate === 'merge' ? 'Fix the clash yourself' : 'Fix it yourself',
      note: 'Open the ticket\'s copy in your editor and fix it. Then the checks, review and proof run again.',
    });
  }
  if (stop.gate === 'checks' || stop.gate === 'review' || stop.gate === 'proof') {
    const what = { checks: 'with the checks failing', review: 'with the review notes open', proof: 'without screenshots' }[stop.gate];
    out.push({ do: 'continue', name: 'Continue anyway', note: `Go on ${what}. Write why: it shows on the ticket, the pull request and the release notes.` });
  }
  out.push({ do: 'plan', name: 'Send it back to the plan', note: 'The Spec writer rewrites the plan with what went wrong.' });
  return out;
}

/** Older stuck cards have no `do` on their options: the first tried again, the second went to the plan or skipped the PR. */
function wayOf(t: Ticket, option: StuckOption, choice: number): WayOut {
  if (option.do) return option.do;
  if (choice === 0) return 'retry';
  return t.retryPhase === 'publish' ? 'skip-pr' : 'plan';
}

export function decideStuck(bp: BoardPaths, id: string, choice: number, input: { note?: string; reason?: string } = {}): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'stuck' || !t.stuck) throw new BoardActionError(`${t.id} is not stuck.`);
    const option = t.stuck.options[choice];
    if (!option) throw new BoardActionError(`Pick a choice between 1 and ${t.stuck.options.length}.`);
    const way = wayOf(t, option, choice);
    const gate = t.stuck.gate;
    const reason = input.reason?.trim();
    const note = input.note?.trim();
    if (way === 'continue') {
      if (gate !== 'checks' && gate !== 'review' && gate !== 'proof') throw new BoardActionError('Only a failed check, review or proof can be continued past.');
      if (!reason) throw new BoardActionError('Write why you continue anyway. It shows on the ticket, the pull request and the release notes.');
    }
    if (way === 'yourself' && meta.engine === 'live' && !(t.worktree && fs.existsSync(t.worktree))) {
      throw new BoardActionError(`${t.id} has no copy of the code to fix. Try again or send it back to the plan.`);
    }
    t.stuck.options.forEach((o, i) => (o.chosen = i === choice));
    t.waiting = null;
    t.live = true;
    addActivity(t, 'you', `Decided: ${option.name}${way === 'continue' ? `. Why: ${reason}` : ''}`);
    if (note) {
      t.notes = [...(t.notes ?? []), { at: now(), by: meta.user.name, kind: 'note', text: note }];
      addActivity(t, 'you', `Added a note: ${note}`);
      tellLater(t, meta.engine, { kind: 'note', text: note, noteKind: 'note' });
    }
    if (way === 'continue') {
      t.overrides = [...(t.overrides ?? []), { gate: gate as 'checks' | 'review' | 'proof', reason: reason!, by: meta.user.name, at: now() }];
      t.gates = { ...(t.gates ?? { checks: 'pending', review: 'pending', proof: 'pending' }), [gate as string]: 'skipped' };
      tellLater(t, meta.engine, { kind: 'note', text: `Continued anyway past the failed ${gate}: ${reason}`, noteKind: 'note' });
    }
    if (meta.engine !== 'live') {
      t.status = 'Builder is trying your choice';
      scheduleSquad(t, 'unstick', 2, meta.speed);
      return;
    }
    const retryPhase = t.retryPhase;
    t.retryPhase = undefined;
    switch (way) {
      case 'skip-pr':
        t.live = false;
        t.status = `Ready for ${t.release ?? 'the next release'}`;
        return;
      case 'retry':
        t.tries = 0;
        if (gate === 'review') {
          t.reviewRound = 0;
          t.stage = 'implement';
          t.status = 'Builder is fixing the review notes';
          scheduleSquad(t, 'review-fix', 0.5, 1);
        } else if (gate === 'merge') {
          t.stage = 'implement';
          t.status = 'Builder is bringing in the latest changes';
          scheduleSquad(t, 'update-base', 0.5, 1);
        } else {
          t.status = 'Trying again';
          scheduleSquad(t, retryPhase ?? 'analyst-read', 0.5, 1);
        }
        return;
      case 'yourself':
        t.tries = 0;
        t.reviewRound = 0;
        t.reviewNotes = undefined;
        t.proof = undefined;
        t.mergedAt = undefined;
        t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
        t.stage = 'test';
        t.status = 'Running the project checks on your fix';
        addActivity(t, 'you', 'Fixed it myself in the ticket\'s copy');
        scheduleSquad(t, 'test', 0.2, 1);
        return;
      case 'continue':
        if (gate === 'checks') {
          t.stage = 'review';
          t.status = 'Reviewer is reading the changes';
          scheduleSquad(t, 'review', 0.2, 1);
        } else if (gate === 'proof') {
          // No screenshots, on the record: you still check the work and press Looks right.
          t.live = false;
          t.stage = 'review';
          t.status = 'Proof ready to check';
          t.waiting = { kind: 'proof', summary: 'Ready for you to check, without screenshots' };
        } else {
          t.reviewNotes = undefined;
          t.status = 'Recording the proof';
          scheduleSquad(t, 'proof', 0.2, 1);
        }
        return;
      case 'plan':
        t.changeRequest = `The squad got stuck: ${t.stuck.question}`;
        t.stage = 'specs';
        t.status = 'Spec writer is updating the plan';
        scheduleSquad(t, t.story ? 'plan-rewrite' : 'analyst-read', 0.5, 1);
        return;
    }
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
  const skipped = tickets.flatMap((t) => (t.overrides ?? []).map((o) => `- ${t.id} ${t.title}: went out with ${o.gate === 'checks' ? 'failing checks' : o.gate === 'proof' ? 'no screenshots' : 'open review notes'}. ${o.by}: ${o.reason}`));
  return [`### What's new in ${release.version.replace(/^v/, '')}`, '', ...lines, ...(skipped.length ? ['', '### Continued anyway', '', ...skipped] : [])].join('\n');
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
      if (err instanceof PullRequestClash) {
        // Nothing changed yet: the clashing tickets leave the release with a way out, and the rest can go.
        for (const id of err.tickets) pullRequestClashed(bp, id);
        const one = err.tickets.length === 1;
        const left = readRelease(bp, release.version)?.tickets.length ?? 0;
        throw new BoardActionError(
          `The release did not go out: the pull request of ${err.tickets.join(', ')} clashes with newer changes in ${err.base}. ${one ? 'It' : 'They'} left ${release.version} and ${one ? 'waits' : 'wait'} for you with ways out.${left ? ' Press Release again to send the rest.' : ''}`,
        );
      }
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
  return listTickets(bp).filter((t) => t.waiting || t.quiet?.kind === 'stuck' || t.outdated?.length);
}

/** Ask the Architect to read the code again for the architecture page: the stack, the patterns and the project map. */
export function readCodeAgain(bp: BoardPaths): BoardMeta['blueprint'] {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') throw new BoardActionError('Reading the code needs the live squad.');
  return codeChanged(bp) ?? meta.blueprint;
}

/** Ask the Architect to write a decision for a technology that was picked without one. */
export function draftTechDecision(bp: BoardPaths, tech: string): TechDraft {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') throw new BoardActionError('Writing a decision needs the live squad.');
  if (!detectStack(path.dirname(path.dirname(bp.dir)), meta).some((t) => t.name === tech)) throw new BoardActionError(`${tech} is not in the code.`);
  const drafts = (meta.techDrafts ?? []).filter((d) => d.tech !== tech || d.status !== 'failed');
  const open = drafts.find((d) => d.tech === tech);
  if (open) return open;
  const draft: TechDraft = { tech, status: 'writing' };
  writeMeta(bp, { ...meta, techDrafts: [...drafts, draft] });
  return draft;
}

/** The person approves the Architect's draft: it becomes a saved decision, and a rule from now on. */
export function approveTechDecision(bp: BoardPaths, tech: string): Decision {
  const meta = readMeta(bp);
  const draft = meta.techDrafts?.find((d) => d.tech === tech);
  if (draft?.status !== 'ready' || !draft.decision) throw new BoardActionError(`There is no decision for ${tech} to approve yet.`);
  const known = new Set(listDecisions(bp).map((d) => d.id));
  const d = draft.decision;
  const decision: Decision = {
    id: nextDecisionId(bp),
    title: d.title,
    why: d.why,
    options: d.options,
    // The choice must name the technology, so the stack links to it.
    chosen: d.chosen.toLowerCase().includes(tech.toLowerCase()) ? d.chosen : `${tech}: ${d.chosen}`,
    from: 'Code review',
    approvedBy: meta.user.name,
    date: now(),
    checkedBy: null,
    tickets: [],
    area: d.area,
    ...(d.buildsOn.filter((x) => known.has(x)).length ? { buildsOn: d.buildsOn.filter((x) => known.has(x)) } : {}),
  };
  writeDecision(bp, decision);
  writeMeta(bp, { ...readMeta(bp), techDrafts: meta.techDrafts!.filter((x) => x.tech !== tech) });
  queueImpactCheck(bp, decision.id);
  return decision;
}

export function discardTechDecision(bp: BoardPaths, tech: string): void {
  const meta = readMeta(bp);
  writeMeta(bp, { ...meta, techDrafts: (meta.techDrafts ?? []).filter((x) => x.tech !== tech) });
}

/** Run the setup again in the person's own checkout, for example after it failed. */
export function setUpLocalCopy(bp: BoardPaths, id: string): Ticket {
  const t = requireTicket(bp, id);
  if (t.localSetup?.status === 'pending' || t.localSetup?.status === 'running') return t;
  const ls = t.localSetup ?? localSetupFor(bp, t);
  if (!ls) throw new BoardActionError('There is no setup command, or your checkout is on another branch.');
  return updateTicket(bp, id, (x) => {
    x.localSetup = { dir: ls.dir, command: ls.command, status: 'pending' };
  });
}

/**
 * A newer decision changes this ticket. Not merged yet: the Architect redoes the design to follow it, and a ticket
 * that was already being built brings in the latest base before the Builder redoes the work. Merged already: its code
 * is in the base, so a follow-up ticket brings it in line.
 */
export function updateForDecision(bp: BoardPaths, id: string, adr: string): Ticket {
  const meta = readMeta(bp);
  const t0 = requireTicket(bp, id);
  const hit = t0.outdated?.find((o) => o.adr === adr);
  if (!hit) throw new BoardActionError(`${id} has nothing to update for ${adr}.`);
  const rest = (t0.outdated ?? []).filter((o) => o.adr !== adr);
  if (t0.mergedAt || t0.stage === 'done') {
    const d = listDecisions(bp).find((x) => x.id === adr);
    const follow = createTicket(bp, {
      title: `Bring "${t0.title}" in line with ${adr}`,
      ask: `${t0.id} (${t0.title}) was built before ${adr}${d ? ` (${d.title})` : ''} was approved. ${hit.change}`,
      priority: t0.priority,
    });
    updateTicket(bp, id, (t) => {
      t.outdated = rest.length ? rest : undefined;
      addActivity(t, 'you', `Made ${follow.id} to bring it in line with ${adr}`);
    });
    return follow;
  }
  if (t0.takenOver) throw new BoardActionError(`${id} is taken over. Give it back first.`);
  if (t0.chat?.open) throw new BoardActionError(`${id} has a chat open. Finish it first.`);
  if (t0.live && meta.engine === 'live') throw new BoardActionError(`${id} is working right now. Press Stop first, then update the plan.`);
  // Accepted but not merged (its pull request could not merge): it leaves the draft release until it is accepted again.
  const draft = listReleases(bp).find((r) => r.status !== 'released' && r.tickets.includes(id));
  if (draft) writeRelease(bp, { ...draft, tickets: draft.tickets.filter((x) => x !== id) });
  return updateTicket(bp, id, (t) => {
    // Its open pull request is found again by branch when it is accepted the next time.
    t.pr = undefined;
    t.release = undefined;
    t.outdated = rest.length ? rest : undefined;
    t.changeRequest = `Follow ${adr}: ${hit.change}`;
    t.waiting = null;
    t.stuck = undefined;
    t.retryPhase = undefined;
    t.live = true;
    t.stage = 'specs';
    t.status = 'Architect is updating the design';
    if (t.worktree) t.replanFor = adr;
    addActivity(t, 'you', `Asked to update the plan to follow ${adr}`);
    scheduleSquad(t, 'plan-rewrite', 2, meta.speed);
  });
}

/** The person keeps the plan as it is, and says why. The reason stays on the ticket. */
export function keepPlan(bp: BoardPaths, id: string, adr: string, reason: string): Ticket {
  const why = reason.trim();
  if (!why) throw new BoardActionError('Say in one line why the plan stays as it is.');
  return updateTicket(bp, id, (t) => {
    if (!t.outdated?.some((o) => o.adr === adr)) throw new BoardActionError(`${id} has nothing to update for ${adr}.`);
    t.outdated = t.outdated.filter((o) => o.adr !== adr);
    if (!t.outdated.length) t.outdated = undefined;
    addActivity(t, 'you', `Kept the plan with ${adr}: ${why}`);
  });
}

/** Check the open tickets against a saved decision again, or for the first time on one approved before checks. */
export function checkTicketsAgainst(bp: BoardPaths, adr: string): ImpactCheck {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') throw new BoardActionError('Checking tickets needs the live squad.');
  if (!listDecisions(bp).some((d) => d.id === adr)) throw new BoardActionError(`${adr} is not a saved decision.`);
  const now = meta.impactChecks?.find((c) => c.adr === adr);
  if (now?.status === 'pending' || now?.status === 'running') return now;
  const check: ImpactCheck = { adr, status: 'pending' };
  writeMeta(bp, { ...meta, impactChecks: [...(meta.impactChecks ?? []).filter((c) => c.adr !== adr), check] });
  return check;
}


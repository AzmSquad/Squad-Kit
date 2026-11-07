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
  removeRelease,
  listReleases,
  writeTicket,
  writeMeta,
  codeChanged,
  queueImpactCheck,
  type BoardPaths,
} from './store.js';
import fs from 'node:fs';
import path from 'node:path';
import type { BoardMeta, Decision, ImpactCheck, Release, TechDraft, Ticket, UnpushedRelease } from './types.js';
import { detectStack } from './stack.js';
import { scheduleSquad } from './schedule.js';
import { PullRequestClash, commitTicket, commitWithoutCheck, hooksStillOwed, liveRelease, onTheRemote, pushAgain } from '../engine/release.js';
import { CommitStopped, HookRefused, MergeClash, addWorktree, mergeWouldClash, cutOffWords, git, pushedBranch, repairCopyLink, settleCopy, type HookRun } from '../engine/git.js';
import { guardSupport, ticketGuard } from '../engine/project-guard.js';
import { holdRelease, releaseGoingOut } from './lock.js';
import { repoFor, reposOf } from '../engine/repos.js';
import { buildPaths } from '../core/paths.js';
import { writeLog } from '../core/app-log.js';
import { freeName } from '../core/file-names.js';
import { loadConfig } from '../core/config.js';
import { loadSecrets } from '../core/secrets.js';
import { clientFor, overlayTrackerEnv } from '../tracker/index.js';
import { aiTool, trackerFor, trackerModule } from '../modules/registry.js';
import { readAgent } from '../engine/agents.js';
import type { Tracker } from '../modules/tracker/types.js';
import { alsoChangedLine } from './also-changed.js';
import { localSetupFor, mapAfterMerge, mergeLocally, opensPullRequest, syncWiki } from '../engine/sync.js';
import type { AgentChat, AgentName, ChangePart, Criterion, PlanComment, PlanEdit, PlanPart, PlanSnapshot, SpecChange, StuckChoice, StuckOption, TicketNote, Track, TrackerEvent, WayOut } from './types.js';
import type { Decided } from './requirements-types.js';
import { criterionText } from './docs.js';
import { changeLines } from '../engine/prompts.js';
import { endProcessTree } from '../engine/watchdog.js';
import { readTicket, ticketFilesDir, ticketMediaDir } from './store.js';
import { isMediaNote } from '../engine/media.js';
import { leaveProjectFiles, stageTicketDocs } from '../engine/project-git.js';
import { pushHandOver, type HandOverPush } from '../engine/handover.js';
import { firstCodeMerged } from './first-story.js';
import { isMine, ownerOf, sameName } from './owner.js';
import { holdForDependency, refuseBeforeDependency } from './depends.js';
import { afterRelease, settleRelease } from './release-tidy.js';
import { askAgent, squadWorks, waitsAtReview, whereItStands } from './at-review.js';
import { clearJournal, readJournal } from '../engine/release-resume.js';
import { clearStaleStop } from './stale-stop.js';
import { copyViews } from '../engine/copies.js';
import { HARNESS_FILE_GATE } from './additions.js';
import { noteGates, releaseGatesDue, runGatesAt, runReleaseGates } from '../engine/gate-run.js';
import { repoLabel } from './parts.js';

/** Every person-facing action lives here, so the board and the terminal do exactly the same thing. */

export class BoardActionError extends Error {}

/** A button failed on something technical: the person reads the plain words, and the exact error goes to the log. */
function actionFailed(bp: BoardPaths, id: string, plain: string, err: unknown): BoardActionError {
  writeLog({ level: 'error', project: readMeta(bp).project, ticket: id, text: `${plain} ${(err as Error).message}` });
  return new BoardActionError(plain);
}

/** Queue an update for the tracker. The live squad sends it, so this never waits on the network. */
function tellLater(t: Ticket, engine: string, event: TrackerEvent): void {
  if (engine !== 'live') return;
  if (event.kind !== 'file-bug' && !trackerModule(t.source.type)) return;
  t.trackerQueue = [...(t.trackerQueue ?? []), event];
}

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
  source?: Ticket['source'];
  criteria?: string[];
  rules?: string[];
  edgeCases?: string[];
  files?: UploadedFile[];
  /** Builds by itself: the breakdown story it builds, with its story and done-when, approved with the breakdown. */
  fromBreakdown?: { id: string; item: string; story: string; criteria: Criterion[]; approvedBy: string; decided?: Decided[]; setsUp?: boolean };
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
  const meta = readMeta(bp);
  const id = input.id ?? nextTicketId(bp);
  if (input.id && readTicket(bp, input.id)) throw new BoardActionError(`${input.id} is already on the board.`);
  const brief = { criteria: cleanList(input.criteria), rules: cleanList(input.rules), edgeCases: cleanList(input.edgeCases) };
  const attachments = input.files?.length ? saveTicketUploads(bp, id, input.files) : [];
  const ticket: Ticket = {
    id,
    title,
    ask: input.ask?.trim() || title,
    kind: input.kind ?? 'feature',
    track: input.fromBreakdown ? 'auto' : input.track === 'express' ? 'express' : 'full',
    source: input.source ?? { type: 'manual' },
    priority: input.priority ?? 'normal',
    stage: 'tickets',
    status: 'Analyst is reading the ticket',
    live: true,
    waiting: null,
    createdAt: now(),
    createdBy: meta.user.name,
    owner: meta.user.name,
    builder: meta.roles.builder,
    reviewer: meta.roles.reviewer,
    activity: [],
    ...(brief.criteria.length || brief.rules.length || brief.edgeCases.length ? { brief } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(input.kind === 'bug' && input.severity ? { severity: input.severity } : {}),
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
  addActivity(ticket, 'you', from ? `Pulled ${input.source!.ref} from ${from}` : 'Created the ticket');
  if (ticket.track === 'express') addActivity(ticket, 'you', 'Chose the Express track: no questions, the plan is approved on its own');
  if (input.fromBreakdown) addActivity(ticket, 'squad', `Started from ${input.fromBreakdown.id} › ${input.fromBreakdown.item}: the story and done-when were approved with the breakdown`);
  if (attachments.length) addActivity(ticket, 'you', `Added ${attachments.length === 1 ? '1 file' : `${attachments.length} files`}`);
  if (input.talkFirst && ticket.track === 'full') {
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
    throw new BoardActionError(`Could not fetch ${id}: ${(err as Error).message}`);
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

export interface AnswerInput {
  choice: string;
  value?: string;
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
    throw new BoardActionError(`Could not fetch ${tracker.refOf(id)}: ${(err as Error).message}`);
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
    id: w.ref.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase(),
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
  if (kind === 'proof') {
    // The proof does not show a change that is still open, so it cannot be accepted yet.
    const c = openChange(ticket);
    if (c) throw new BoardActionError(`Change ${c.id} is still open. ${c.status === 'proposed' || c.status === 'failed' ? 'Approve or decline it first.' : 'The squad builds it first, then the proof comes again.'}`);
    refuseBeforeDependency(bp, ticket);
    return acceptProof(bp, ticket);
  }
  if (kind === 'change') return approveChange(bp, ticket.id);
  if (kind === 'questions') throw new BoardActionError(`${ticket.id} needs answers first.`);
  if (kind === 'stuck') throw new BoardActionError(`${ticket.id} needs a decision first.`);
  throw new BoardActionError(`${ticket.id} is not waiting for an approval right now.`);
}

/** Express and Builds by itself: the plan is approved on its own. You still see it; nothing waits for you. */
export function approveExpress(bp: BoardPaths, id: string): Ticket {
  const ticket = requireTicket(bp, id);
  if (ticket.track !== 'express' && ticket.track !== 'auto') throw new BoardActionError(`${ticket.id} is on the Full track.`);
  return approvePlan(bp, { ...ticket, waiting: { kind: 'plan', summary: '' } }, readMeta(bp).speed, ticket.track);
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

/** `self`: the track that approves the plan on its own (Express, Builds by itself); otherwise the person approves it. */
function approvePlan(bp: BoardPaths, ticket: Ticket, speed: number, self?: 'express' | 'auto'): Ticket {
  const meta = readMeta(bp);
  let adr: string | undefined;
  if (ticket.decision && !ticket.decision.adr) {
    adr = nextDecisionId(bp, ticket.id);
    const chosen = ticket.decision.options.find((o) => o.chosen) ?? ticket.decision.options[0];
    writeDecision(bp, {
      id: adr,
      title: ticket.decision.title,
      why: ticket.decision.why,
      options: ticket.decision.options.map((o) => o.name),
      chosen: chosen?.name ?? '',
      from: ticket.id,
      approvedBy: self ? `${meta.user.name} (${self === 'auto' ? 'Builds by itself' : 'Express track'})` : meta.user.name,
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
    const approved =
      self === 'auto' ? 'Builds by itself: approved the plan on its own' : self ? 'Express track: approved the plan on its own' : t.specApproved ? 'Approved the design' : 'Approved the plan';
    addActivity(t, self ? 'squad' : 'you', adr ? `${approved}. Decision saved as ${adr}${t.decision?.replaces ? `, replacing ${t.decision.replaces}` : ''}` : approved);
    scheduleSquad(t, 'build', 2, speed, 0);
    // A ticket it depends on is not merged yet: the build waits for the person's choice (board/depends.ts).
    holdForDependency(bp, t);
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

/** A merge that could not move the person's own checkout of the base: it goes in once that copy is free. */
export const CHECKOUT_WAITS = 'Waits to merge: your own copy of the code has changes in the same files';

const CHECKOUT_LATER = 'It goes in once your own copy of the code is free of changes in the same files. squad-kit tries again every few minutes';

/**
 * Looks right: commit, merge or pull request, and the draft release. `byItself` is the squad's own accept on the
 * Builds by itself track (board/auto.ts): the same steps, with the squad as the actor and this line on the record.
 */
export function acceptProof(bp: BoardPaths, ticket: Ticket, byItself?: string, opts: { noHooks?: boolean } = {}): Ticket {
  let commit: string | null = null;
  const release = ensureDraftRelease(bp, ticket.kind === 'bug' ? 'patch' : 'minor');
  const views = copyViews(readMeta(bp), ticket);
  if (readMeta(bp).engine === 'live') {
    try {
      for (const view of views) {
        repairCopy(bp, view);
        // The accepted ticket's documents go in the same commit as its code, when the project keeps them in git.
        leaveProjectFiles(bp, view, repoFor(readMeta(bp), view).base);
        stageTicketDocs(bp, { ...view, stage: 'release', release: release.version, waiting: null, hookOwed: undefined });
        // The hooks run in one place, beside everything else (saveBeside). Past here they had their say, or the person went past them.
        const saved = takeSaved(bp, ticket.id, views.length > 1 ? view.repo : undefined);
        if (saved === undefined && !opts.noHooks && hooksStillOwed(view)) throw new BoardActionError(`The project's own check has not looked at ${ticket.id} yet, so it cannot be accepted. Press Looks right.`);
        commit = commitWithoutCheck(view) ?? saved ?? commit;
      }
    } catch (err) {
      if (err instanceof BoardActionError) throw err;
      throw actionFailed(bp, ticket.id, 'squad-kit could not save the change, so the proof stays as it is. Press Looks right to try again.', err);
    }
  }
  const openPr = !ticket.pr && opensPullRequest(bp, ticket);
  // Merge on accept: without a pull request host the branch merges into the base right here, so the next tickets
  // build on it. With a code host module the live squad opens the PR and merges it.
  let merged: ReturnType<typeof mergeLocally> = null;
  if (readMeta(bp).engine === 'live' && !openPr && !ticket.mergedAt) {
    const meta = readMeta(bp);
    try {
      // Across parts, every merge is tried first: if one clashes, nothing moves in any of them.
      if (views.length > 1) {
        for (const view of views) {
          const repo = repoFor(meta, view);
          if (view.branch && mergeWouldClash(path.join(bp.root, repo.path), repo.base, view.branch)) throw new MergeClash(`In ${repoLabel(meta, repo.path) ?? repo.path}: ${view.branch} clashes with changes already in ${repo.base}.`);
        }
      }
      for (const view of views) {
        const one = mergeLocally(bp, view);
        // Moved only when every one of them moved. A merge already in is skipped next time, so Try again finishes the rest.
        merged = !merged || !one ? (merged ?? one) : { ...one, moved: merged.moved && one.moved, ...(merged.note ? { note: merged.note } : {}) };
      }
    } catch (err) {
      // Only a real clash is a clash card. Anything else (an older git) leaves the proof waiting, with git's reason.
      if (err instanceof MergeClash) return clashed(bp, ticket.id, commit, err.message, byItself);
      throw actionFailed(bp, ticket.id, 'The change is saved, but it could not be merged, so the proof stays as it is. An engineer can see why in squad-kit\'s log.', err);
    }
  }
  if (!release.tickets.includes(ticket.id)) release.tickets.push(ticket.id);
  writeRelease(bp, release);
  // New code on the base: the architecture page reads it again.
  if (merged?.moved) mapAfterMerge(bp);
  // The exact words are for engineers. The squad tries again by itself (engine/sync.ts recheckMerge).
  else if (merged?.note) writeLog({ level: 'warn', project: readMeta(bp).project, ticket: ticket.id, text: merged.note });
  return updateTicket(bp, ticket.id, (t) => {
    t.waiting = null;
    // Accepted: a stop it went past is over.
    clearStaleStop(t);
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
          ? CHECKOUT_WAITS
          : `Ready for ${release.version}`;
    if (into) {
      t.mergedAt = now();
      const ls = localSetupFor(bp, t);
      if (ls) t.localSetup = ls;
    }
    t.squad = openPr ? { phase: 'publish', nextAt: now() } : null;
    if (byItself) addActivity(t, 'squad', byItself);
    else addActivity(t, 'you', 'Checked the proof. Looks right');
    if (commit) addActivity(t, 'release', 'Saved the change');
    if (merged) addActivity(t, 'release', merged.moved ? `Merged into ${merged.base}` : CHECKOUT_LATER);
    addActivity(t, 'release', `Added to release ${release.version}`);
  });
}

/**
 * A project folder that moved leaves the ticket's copy with a dead link to its repo: mended before git works there, with
 * whatever a crash left in it.
 */
function repairCopy(bp: BoardPaths, t: Ticket): void {
  if (!t.worktree || !repairCopyLink(path.join(bp.root, repoFor(readMeta(bp), t).path), t.worktree)) return;
  const onDisk = settleCopy(t.worktree);
  if (onDisk) updateTicket(bp, t.id, (x) => addActivity(x, 'squad', cutOffWords(onDisk)));
}

/* ── The project's own commit hooks ──────────────────── */

/** The project's commit hook said no: the ticket has a stop card with ways out, and this says so. */
export class HookStopped extends BoardActionError {}

/** Tickets whose change is being saved, each with what ends its hook, and the commit each got: null when it had nothing to save. */
const savingNow = new Map<string, AbortController>();
const savedCommits = new Map<string, string | null>();
const saveKey = (bp: BoardPaths, id: string) => `${bp.squadDir}\0${id}`;

/** The hooks' say on this ticket, for the accept right after them. Undefined when they had none. */
function takeSaved(bp: BoardPaths, id: string, repo?: string): string | null | undefined {
  const key = `${saveKey(bp, id)}${repo ? `\0${repo}` : ''}`;
  const commit = savedCommits.get(key);
  savedCommits.delete(key);
  return commit;
}

/** The board is closing, or the terminal command was stopped: a hook running on a save ends, and nothing is merged. */
export function endSaves(bp: BoardPaths): void {
  for (const [key, stop] of savingNow) if (key.startsWith(`${bp.squadDir}\0`)) stop.abort();
}

/** How the project's commit hooks run for a ticket: in the project's guard, where this computer has one. */
function hookRun(bp: BoardPaths, t: Ticket): HookRun {
  if (!t.worktree || !guardSupport().on) return {};
  const allow = readMeta(bp).guard;
  return { guard: ticketGuard(bp, { cwd: t.worktree, id: t.id, ...(allow ? { allow } : {}) }) };
}

/** The Builder went round once and it still says no: what is left is the person's or an engineer's. */
const HOOK_STILL_NO = " The Builder tried, and it still says no. If the check itself is what needs changing, that is for you or an engineer: change it in the ticket's copy, or save without it and say why.";

/** The stop for a hook that said no. Only the person can go past it, with a reason on the record. */
function hookStopped(bp: BoardPaths, id: string, err: HookRefused, byItself?: string, gate?: { id: string; name: string }): HookStopped {
  const words = gate ? `Your team's check "${gate.name}" runs on every save, and it said no. The change is not saved yet. It is safe in the ticket's copy.` : err.timedOut
    ? `This project has its own check that runs on every save. It did not finish in ${Math.round(err.limitMs / 60_000)} minutes, so the change is not saved yet. It is safe in the ticket's copy.`
    : "This project has its own check that runs on every save, and it said no. The change is not saved yet. It is safe in the ticket's copy.";
  const plain = `${words}${requireTicket(bp, id).hookFixTried ? HOOK_STILL_NO : ''}`;
  writeLog({ level: 'warn', project: readMeta(bp).project, ticket: id, text: `${plain} ${err.said}` });
  updateTicket(bp, id, (t) => {
    t.waiting = { kind: 'stuck', summary: "The project's own check said no and needs one decision" };
    t.live = false;
    t.squad = null;
    t.status = "Stopped: the project's own check said no";
    t.stuck = { kind: 'hook', ...(gate ? { added: [gate] } : {}), question: plain, ...(err.said ? { detail: `${gate ? gate.name : 'A commit hook'} said no:\n${err.said}` } : {}), options: wayOptions({ kind: 'hook', copy: Boolean(t.worktree && fs.existsSync(t.worktree)) }) };
    if (byItself) addActivity(t, 'squad', `Not accepted by itself: the project's own check said no`);
    else addActivity(t, 'you', 'Checked the proof. Looks right');
    addActivity(t, 'release', "The project's own check said no, so the change is not saved yet");
  });
  return new HookStopped(`${plain} See the ways out on the ticket.`);
}

/**
 * Work the hooks still owe a look (hookOwed) with no copy of the code left: they would have nothing to look at, and the
 * branch would merge unseen. The copy is made again from the branch; with no branch either, it is a stop card.
 */
function copyForTheHooks(bp: BoardPaths, ticket: Ticket): Ticket {
  if (!ticket.hookOwed || (ticket.worktree && fs.existsSync(ticket.worktree))) return ticket;
  const repo = repoFor(readMeta(bp), ticket);
  const root = path.join(bp.root, repo.path);
  const branch = ticket.branch ?? `squad/${ticket.id.toLowerCase()}`;
  if (!git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true }) && !pushedBranch(root, branch)) {
    throw new HookRefused("The ticket's copy of the code and its branch are gone, so the project's own check has nothing to look at.", false, 0);
  }
  const wt = addWorktree(root, ticket.id, repo.base);
  return updateTicket(bp, ticket.id, (t) => {
    t.worktree = wt.dir;
    t.branch = wt.branch;
    addActivity(t, 'squad', "This ticket's copy of the code was gone, so squad-kit made it again for the project's own check");
  });
}

/** The team's gates before a save, in the copy about to be saved. Failing takes the road of a refused hook, the same card. */
async function gatesBeforeSave(bp: BoardPaths, ticket: Ticket, copy: Ticket, label: string | undefined, byItself: string | undefined, signal: AbortSignal): Promise<void> {
  const meta = readMeta(bp);
  const place = { dir: copy.worktree!, repo: repoFor(meta, copy).path, ...(label ? { label } : {}) };
  const done = await runGatesAt(bp, 'merge', [place], requireTicket(bp, ticket.id).addedSkipped ?? [], (dir) => ({ signal, ...hookRun(bp, { ...copy, worktree: dir }) }));
  if (signal.aborted) throw new CommitStopped();
  if (!done.length) return;
  updateTicket(bp, ticket.id, (x) => noteGates(x, done, (text) => addActivity(x, 'release', text)));
  const failed = done.find((d) => d.stops && d.result === 'failed');
  if (failed) throw hookStopped(bp, ticket.id, new HookRefused(failed.output, false, 0), byItself, { id: failed.id, name: failed.name });
  const cant = done.filter((d) => d.stops && d.result === 'cant-run');
  if (!cant.length) return;
  const words = gateCantRunCard(cant, { auto: ticket.track === 'auto', save: true });
  updateTicket(bp, ticket.id, (t) => {
    t.waiting = { kind: 'stuck', summary: 'A check of your team could not run and needs one decision' };
    t.live = false;
    t.squad = null;
    t.status = 'Stopped: a check could not run';
    t.stuck = words;
    for (const c of cant) addActivity(t, 'release', `"${c.name}" could not run: ${c.why} Not a failed try`);
  });
  throw new HookStopped(`${words.question} See the ways out on the ticket.`);
}

/** Saves the accepted change with the hooks running beside everything else, so a slow hook never holds up the board. */
async function saveBeside(bp: BoardPaths, ticket: Ticket, byItself?: string, signal?: AbortSignal): Promise<void> {
  const key = saveKey(bp, ticket.id);
  if (savingNow.has(key)) throw new BoardActionError(`${ticket.id} is being saved: the project's own check is still running.`);
  const closing = new AbortController();
  savingNow.set(key, closing);
  try {
    const release = ensureDraftRelease(bp, ticket.kind === 'bug' ? 'patch' : 'minor');
    const views = copyViews(readMeta(bp), ticket);
    // Every copy is saved, with the project's own check on each, before anything goes in.
    for (const view of views) {
      const copy = views.length === 1 ? copyForTheHooks(bp, view) : view;
      repairCopy(bp, copy);
      await gatesBeforeSave(bp, ticket, copy, views.length > 1 ? copy.repo : undefined, byItself, signal ? AbortSignal.any([signal, closing.signal]) : closing.signal);
      leaveProjectFiles(bp, copy, repoFor(readMeta(bp), copy).base);
      stageTicketDocs(bp, { ...copy, stage: 'release', release: release.version, waiting: null, hookOwed: undefined });
      const saved = await commitTicket(copy, { ...hookRun(bp, copy), signal: signal ? AbortSignal.any([signal, closing.signal]) : closing.signal });
      savedCommits.set(views.length === 1 ? key : `${key}\0${view.repo}`, saved);
    }
    if (ticket.hookOwed) updateTicket(bp, ticket.id, (t) => delete t.hookOwed);
  } catch (err) {
    // A merge was finished before the hooks looked at it: no later save would show it to them.
    if ((err instanceof CommitStopped || err instanceof HookRefused) && err.owed) updateTicket(bp, ticket.id, (t) => (t.hookOwed = true));
    if (err instanceof CommitStopped || err instanceof HookStopped) throw err;
    if (err instanceof HookRefused) throw hookStopped(bp, ticket.id, err, byItself);
    throw actionFailed(bp, ticket.id, `squad-kit could not save the change. It is safe in the ticket's copy, and an engineer can see why in squad-kit's log. ${byItself ? 'Press Try again.' : 'Press Looks right to try again.'}`, err);
  } finally {
    savingNow.delete(key);
  }
}

/** Looks right from the board or the squad: `approve`, with the project's hooks running beside everything else. */
export async function approveBeside(bp: BoardPaths, id: string): Promise<Ticket> {
  const ticket = requireTicket(bp, id);
  if (ticket.waiting?.kind === 'proof' && readMeta(bp).engine === 'live' && !openChange(ticket)) {
    refuseBeforeDependency(bp, ticket);
    await saveBeside(bp, ticket);
  }
  return approve(bp, id);
}

/** `decideStuck`, with "Try the save again" running the project's hooks beside everything else. */
export async function decideStuckBeside(bp: BoardPaths, id: string, choice: number, input: { note?: string; reason?: string } = {}): Promise<Ticket> {
  const ticket = requireTicket(bp, id);
  const stuck = ticket.waiting?.kind === 'stuck' ? ticket.stuck : undefined;
  const way = stuck?.options[choice]?.do;
  if (way === 'save-again') await saveBeside(bp, ticket);
  // Past a gate of the team's: the project's own hooks still get their say, on the save that follows.
  if (way === 'skip-hooks' && stuck?.added?.length) {
    const why = input.reason?.trim();
    if (!why) throw new BoardActionError('Write why you go on without this check. It shows on the story, the pull request and the release notes.');
    const by = readMeta(bp).user.name;
    updateTicket(bp, id, (t) => {
      t.overrides = [...(t.overrides ?? []), ...stuck.added!.map((g) => ({ gate: 'hooks' as const, added: g.name, reason: why, by, at: now() }))];
      t.addedSkipped = [...new Set([...(t.addedSkipped ?? []), ...stuck.added!.map((g) => g.id)])];
      tellLater(t, readMeta(bp).engine, { kind: 'note', text: `Saved without your team's check: ${why}`, noteKind: 'note' });
    });
    await saveBeside(bp, requireTicket(bp, id));
  }
  return decideStuck(bp, id, choice, input);
}

/**
 * The Builds by itself step: its commit, with the hooks beside everything else, before the accept. A refusal leaves its
 * card. The step's Stop ends a hook that is running (CommitStopped goes on up, to the step's own Stop handling).
 */
export async function saveBeforeAccept(bp: BoardPaths, id: string, signal?: AbortSignal): Promise<boolean> {
  const ticket = requireTicket(bp, id);
  try {
    await saveBeside(bp, ticket, 'the squad', signal);
    return true;
  } catch (err) {
    if (err instanceof HookStopped) return false;
    throw err;
  }
}

/** The way out of a hook card that saves: back to the proof, with the hooks on, or off with a reason on the record. */
function saveFromHookCard(bp: BoardPaths, id: string, choice: number, way: 'save-again' | 'skip-hooks', reason?: string): Ticket {
  const meta = readMeta(bp);
  const noHooks = way === 'skip-hooks' && !requireTicket(bp, id).stuck?.added?.length;
  const why = reason?.trim();
  if (way === 'skip-hooks' && !why) throw new BoardActionError('Write why you save it without the check. It shows on the ticket, the pull request and the release notes.');
  const ticket = updateTicket(bp, id, (t) => {
    const option = t.stuck!.options[choice]!;
    t.stuck!.options.forEach((o, i) => (o.chosen = i === choice));
    addActivity(t, 'you', `Decided: ${option.name}${why ? `. Why: ${why}` : ''}`);
    if (way === 'skip-hooks' && !t.stuck!.added?.length) {
      t.overrides = [...(t.overrides ?? []), { gate: 'hooks', reason: why!, by: meta.user.name, at: now() }];
      delete t.hookOwed;
      tellLater(t, meta.engine, { kind: 'note', text: `Saved without the project's own check: ${why}`, noteKind: 'note' });
    }
    t.waiting = { kind: 'proof', summary: 'The proof is ready for you to check' };
    t.status = 'Proof ready to check';
  });
  return acceptProof(bp, ticket, undefined, { noHooks });
}

/** The accepted branch clashes with the base: not a dead end, a stuck card with ways out. */
function clashed(bp: BoardPaths, id: string, commit: string | null, error: string, byItself?: string): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const base = repoFor(meta, t).base;
    clashCard(t, base, `The change is saved, but it cannot go into ${base} yet: newer work changed the same lines.`, error);
    if (byItself) addActivity(t, 'squad', byItself);
    else addActivity(t, 'you', 'Checked the proof. Looks right');
    if (commit) addActivity(t, 'release', 'Saved the change');
    // git's own words are for the activity and the engineer details, never the sentence above.
    addActivity(t, 'release', `Could not merge into ${base}: ${error}`);
  });
}

function clashCard(t: Ticket, base: string, question: string, detail?: string): void {
  t.waiting = { kind: 'stuck', summary: `Clashes with ${base} and needs one decision` };
  t.live = false;
  t.squad = null;
  t.status = `Clashes with ${base}`;
  t.retryPhase = 'update-base';
  t.stuck = { gate: 'merge', question, ...(detail ? { detail } : {}), options: wayOptions({ gate: 'merge', base, copy: Boolean(t.worktree && fs.existsSync(t.worktree)) }) };
}

/**
 * The code host cannot merge the ticket's pull request: newer changes in the base clash with it. Instead of waiting there and
 * stopping the release, the ticket leaves the draft release with the clash card; accepting it again updates the same
 * pull request.
 */
export function pullRequestClashed(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  const draft = listReleases(bp).find((r) => r.status !== 'released' && r.tickets.includes(id));
  if (draft) writeRelease(bp, { ...draft, tickets: draft.tickets.filter((x) => x !== id) });
  return updateTicket(bp, id, (t) => {
    const base = repoFor(meta, t).base;
    // With no pull request (a merge tried again here), the change itself.
    const what = t.pr ? `Pull request ${t.pr.id}` : 'The change';
    clashCard(t, base, `${what} cannot go into ${base} yet: newer work changed the same lines.`);
    t.stage = 'review';
    // Found again by its branch when the ticket is accepted the next time.
    t.pr = undefined;
    t.release = undefined;
    addActivity(t, 'release', `${what} clashes with newer changes in ${base}, so it left ${draft?.version ?? 'the release'}`);
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
 * Take over: the squad stops on this ticket and you work in the Builder's own AI tool session, in the ticket's
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
    const cwd = t.storyDir ?? t.worktree ?? (demo ? bp.root : undefined);
    if (!session || !cwd || (!demo && !fs.existsSync(cwd))) {
      throw new BoardActionError(`${t.id} has no code yet. You can take over once the Builder has started.`);
    }
    if (t.live && !demo) t.stopRequested = true;
    t.takenOver = { by: meta.user.name, at: now(), session, cwd };
    t.live = false;
    t.squad = null;
    t.waiting = { kind: 'yours', summary: 'You took it over. Give it back when you are done' };
    const tool = aiTool(readAgent(bp, 'builder').tool)?.label ?? 'the AI tool';
    t.status = `${meta.user.name} is working on it in ${tool}`;
    addActivity(t, 'you', `Took it over in ${tool}. The squad waits`);
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

/* ── Hand over ─────────────────────────────────────────── */

export interface HandOverInput {
  /** The new owner's name, as their own board shows it. */
  to: string;
  /** A note for them. Every agent on the ticket reads it too. */
  note?: string;
}

/**
 * Hand over: the ticket goes to a teammate. squad-kit saves the work so far and the ticket's documents on its branch,
 * pushes it, and names the new owner. Their squad carries on from that branch; this computer's squad stops working
 * on it. Live progress, agent chats and screenshots stay on this computer.
 */
export async function handOver(bp: BoardPaths, id: string, input: HandOverInput): Promise<Ticket> {
  const meta = readMeta(bp);
  const to = (input.to ?? '').trim().replace(/\s+/g, ' ');
  const t = requireTicket(bp, id);
  if (!to) throw new BoardActionError('Write the name of the person who takes it over.');
  if (!isMine(t, meta)) throw new BoardActionError(`${t.id} is ${ownerOf(t)}'s. Only they can hand it over.`);
  if (sameName(to, meta.user.name)) throw new BoardActionError(`${t.id} is yours already. Pick someone else.`);
  if (t.stage === 'release' || t.stage === 'done') throw new BoardActionError(`${t.id} is accepted already. It goes out with the release.`);
  if (t.takenOver) throw new BoardActionError(`${t.id} is taken over. Give it back first.`);
  if (t.chat?.open) throw new BoardActionError(`${t.id} has a chat open. Finish the talk first.`);
  // A running step would go on writing here after the push: it finishes its step, or you stop it first.
  if (t.live || t.squad || t.stopRequested || t.questions?.some((q) => q.thinking)) {
    throw new BoardActionError(`${t.id} is working right now. Wait until it needs you, or press Stop first.`);
  }
  const at = now();
  const handedOver = { from: meta.user.name, to, at };
  const note = input.note?.trim();
  const notes = note ? [...(t.notes ?? []), { at, by: meta.user.name, kind: 'note' as const, text: note }] : t.notes;
  let pushed: HandOverPush | null = null;
  if (meta.engine === 'live') {
    try {
      pushed = await pushHandOver(bp, { ...t, owner: to, handedOver, ...(notes ? { notes } : {}) });
    } catch (err) {
      throw actionFailed(bp, t.id, `Could not hand ${t.id} over. An engineer can see why in squad-kit's log.`, err);
    }
  }
  return updateTicket(bp, id, (x) => {
    x.owner = to;
    x.handedOver = handedOver;
    if (notes) x.notes = notes;
    if (pushed) {
      x.branch = pushed.branch;
      x.baseCommit = x.baseCommit ?? pushed.baseCommit;
      if (pushed.hookOwed) x.hookOwed = true;
    }
    x.live = false;
    x.squad = null;
    x.waiting = null;
    x.stuck = undefined;
    x.retryPhase = undefined;
    x.agentQuestion = undefined;
    x.quiet = undefined;
    x.status = `With ${to}`;
    addActivity(x, 'you', `Handed it over to ${to}${note ? `: ${note}` : ''}`);
    if (pushed) {
      addActivity(x, 'squad', `Saved the work so far and the documents on ${pushed.branch} (commit ${pushed.commit}) and pushed it to ${pushed.remote}${pushed.carried.length ? ', with the project settings, rules and knowledge, since the base has none yet' : ''}`);
    }
    tellLater(x, meta.engine, { kind: 'note', text: `Handed over to ${to} by ${meta.user.name}.`, noteKind: 'note' });
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

/** The session each agent talks in: its own AI tool conversation on the ticket. */
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
 * Talk it through: open a chat with any agent on the ticket. Asking never stops the work: while the squad works on the
 * ticket, the chat runs beside it and changes nothing; a change goes through the spec instead (proposeChange). A
 * ticket that waits for you stays with you while you talk, so the two of you never pull it in different directions.
 * An accepted or released ticket answers questions only, and so does one that waits for your check at review: it
 * stays waiting for Looks right, and Something's wrong is the way to ask for a change. The agent opens with where it
 * is and what it is unsure of. `ask` is Ask a question: questions only in every state, taken over too, and the ticket
 * stays exactly where it is (askQuestion).
 */
export function startChat(bp: BoardPaths, id: string, agent: AgentName, opts: { ask?: boolean } = {}): Ticket {
  const meta = readMeta(bp);
  if (!AGENT_TITLE[agent]) throw new BoardActionError('Pick an agent: analyst, architect, builder, reviewer or tester.');
  return updateTicket(bp, id, (t) => {
    if (t.chat?.open) throw new BoardActionError(`${t.id} already has a chat open with the ${AGENT_TITLE[t.chat.with]}.`);
    if (t.takenOver && !opts.ask) throw new BoardActionError(`${t.id} is taken over. Give it back first.`);
    const later = agent === 'builder' || agent === 'reviewer' || agent === 'tester';
    if (later && meta.engine === 'live' && !t.sessions?.[CHAT_SESSION[agent]]) {
      throw new BoardActionError(`The ${AGENT_TITLE[agent]} has not worked on ${t.id} yet, so there is nothing to talk through with it.`);
    }
    const done = shipped(t);
    const review = !done && waitsAtReview(t);
    if (opts.ask || done || review || t.live || t.squad) {
      // Beside the work. Talking to the same agent again keeps the earlier messages; the agent starts a fresh side
      // conversation that reads them, so what it knows about the ticket is never out of date.
      const again = t.chat?.with === agent && t.chat.beside ? t.chat : undefined;
      t.chat = { with: agent, open: true, messages: again?.messages ?? [], thinking: true, before: { waiting: t.waiting }, beside: true };
      const line = opts.ask
        ? `Questions only: ${whereItStands(t)}`
        : done
          ? 'Questions only: the accepted work stays as it is'
          : review
            ? 'Questions only: it still waits for your check'
            : 'The work goes on';
      addActivity(t, 'you', `Started ${opts.ask ? 'asking' : 'talking with'} the ${AGENT_TITLE[agent]}. ${line}`);
      return;
    }
    openChat(t, agent, { waiting: t.waiting });
    addActivity(t, 'you', `Started talking it through with the ${AGENT_TITLE[agent]}`);
  });
}

/**
 * Ask a question, in every state: a questions-only chat with whoever knows the story best (askAgent), or the agent
 * named. The ticket stays exactly where it was: the same stage, wait, queue place and work, and a running squad goes
 * on. With a chat open already, that chat is the one to ask in, so nothing changes.
 */
export function askQuestion(bp: BoardPaths, id: string, agent?: AgentName): Ticket {
  const t = requireTicket(bp, id);
  if (t.chat?.open) return t;
  return startChat(bp, t.id, agent ?? askAgent(t, readMeta(bp).engine === 'live'), { ask: true });
}

/** Your message in the chat, with screenshots, files or voice notes if you add them. */
export function sendChat(bp: BoardPaths, id: string, text: string, uploads: UploadedFile[] = []): Ticket {
  const msg = text?.trim() ?? '';
  if (!msg && !uploads.length) throw new BoardActionError('Write your message first.');
  const t0 = requireTicket(bp, id);
  if (!t0.chat?.open) throw new BoardActionError(`${t0.id} has no chat open.`);
  if (t0.chat.thinking) throw new BoardActionError(`The ${AGENT_TITLE[t0.chat.with]} is still answering. Wait a moment.`);
  const files = saveTicketUploads(bp, t0.id, uploads);
  return updateTicket(bp, id, (t) => {
    const c = t.chat!;
    c.messages.push({ who: 'you', text: msg, at: now(), ...(files.length ? { files } : {}) });
    if (files.length) t.attachments = [...(t.attachments ?? []), ...files];
    c.thinking = true;
    c.stopping = undefined;
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
    if (c.beside) {
      throw new BoardActionError(
        shipped(t)
          ? `${t.id} is ${t.stage === 'done' ? 'released' : 'accepted'}, so this chat answers questions only. For a change, make a new linked ticket or report a bug.`
          : waitsAtReview(t)
            ? `${t.id} waits for your check, so this chat answers questions only. ${t.waiting?.kind === 'proof' ? "To ask for a change, press Something's wrong and say what." : 'To go on, pick one of the ways out on its card.'}`
            : squadWorks(t)
              ? 'The squad is working on this ticket, so this talk is for questions. To change the spec, propose a change: the Analyst writes it and you approve it.'
              : `${whereItStands(t)}. This chat answers questions only: to change something, use the ticket's own buttons.`,
      );
    }
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
    if (c.thinking && !c.beside) throw new BoardActionError(`The ${AGENT_TITLE[c.with]} is still answering. Wait a moment.`);
    c.open = false;
    // Beside the work nothing was paused, so nothing goes back: the ticket is wherever the squad took it. An answer
    // still being written is stopped.
    if (c.beside) {
      if (c.thinking) c.stopping = true;
      addActivity(t, 'you', `Done talking with the ${AGENT_TITLE[c.with]}`);
      return;
    }
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

/* ── A change goes through the spec ───────────────────── */

/** Accepted (merged, or waiting for its release) or released: the work is for questions only. */
export function shipped(t: Ticket): boolean {
  return t.stage === 'release' || t.stage === 'done';
}

/** Thrown for a change asked on accepted work. It becomes a new linked ticket or a bug report instead. */
export class ReleasedError extends BoardActionError {}

function releasedLine(t: Ticket): string {
  const when = t.stage === 'done' ? `released${t.release ? ` in ${t.release}` : ''}` : `accepted${t.release ? ` and goes out in ${t.release}` : ''}`;
  return `${t.id} is ${when}, so it only answers questions. Make the change a new linked ticket or report a bug.`;
}

/** The change still open on a ticket, if any. There is at most one. */
export function openChange(t: Ticket): SpecChange | undefined {
  const c = t.changes?.at(-1);
  return c && c.status !== 'done' && c.status !== 'declined' ? c : undefined;
}

/** A change the person must look at: the Analyst's proposal, or a proposal that could not be written. */
export function changeNeedsYou(t: Ticket): boolean {
  const s = openChange(t)?.status;
  return s === 'proposed' || s === 'failed' || s === 'design-ready';
}

/** The Builder has started on the ticket's copy: from now on a change reaches the work through the Builder. */
export function buildStarted(t: Ticket): boolean {
  return Boolean(t.sessions?.build);
}

/**
 * What an open change needs from the squad next: the Architect's design update (a big one), the Builder, or nothing
 * yet. Only once the build has started; before that, the change lives in the spec and the design alone.
 */
export function changeWork(t: Ticket): 'design' | 'build' | null {
  const c = openChange(t);
  if (!c || !buildStarted(t)) return null;
  if (c.size === 'big') return c.status === 'approved' || c.status === 'designing' ? 'design' : c.status === 'building' ? 'build' : null;
  return c.status === 'approved' || c.status === 'building' ? 'build' : null;
}

/** The Analyst or the Architect is writing the spec or the design right now. */
function writerNow(t: Ticket): string | null {
  if (!t.live || (t.stage !== 'tickets' && t.stage !== 'specs')) return null;
  return t.specApproved ? 'Architect is writing the design' : 'Analyst is writing the spec';
}

const SPEC_CHANGED = 'The spec changed';

/** Puts the change's new wording into the spec. New "done when" items go at the end, so the others keep their numbers. */
function applyChange(t: Ticket, c: SpecChange): void {
  const criteria = [...(t.criteria ?? [])];
  const gone = new Set<number>();
  for (const p of c.parts ?? []) {
    if (p.part === 'story') t.story = p.after;
    else if (p.index === undefined) {
      if (p.criterion) criteria.push({ ...p.criterion });
    } else if (p.criterion) criteria[p.index] = { ...p.criterion };
    else gone.add(p.index);
  }
  t.criteria = criteria.filter((_, i) => !gone.has(i));
}

/** The Analyst's answer when it writes a change into the spec. */
export interface ChangeAnswer {
  summary: string;
  size: 'small' | 'big';
  why: string;
  /** The whole new story, or empty when the change does not touch it. */
  story: string;
  criteria: { number: number; action: 'change' | 'add' | 'remove'; given?: string; when?: string; then?: string }[];
}

/** Turns the Analyst's answer into old and new wording. The old words come from the ticket itself, never from the agent. */
export function changeParts(t: Ticket, out: ChangeAnswer): ChangePart[] {
  const parts: ChangePart[] = [];
  const story = out.story?.trim();
  if (story && story !== t.story?.trim()) parts.push({ part: 'story', before: t.story ?? '', after: story });
  const criteria = t.criteria ?? [];
  const used = new Set<number>();
  for (const x of out.criteria ?? []) {
    const c = { given: x.given?.trim() ?? '', when: x.when?.trim() ?? '', then: x.then?.trim() ?? '' };
    const i = Math.round(x.number) - 1;
    const old = criteria[i];
    if (x.action === 'remove') {
      if (old && !used.has(i)) parts.push({ part: 'criterion', index: i, before: criterionText(old), after: '' });
      used.add(i);
      continue;
    }
    if (!c.then) continue;
    if (x.action === 'change' && old && !used.has(i)) {
      if (criterionText(old) !== criterionText(c)) parts.push({ part: 'criterion', index: i, before: criterionText(old), after: criterionText(c), criterion: c });
      used.add(i);
    } else parts.push({ part: 'criterion', before: '', after: criterionText(c), criterion: c });
  }
  return parts;
}

/**
 * The person proposes a change, from the ticket or from a message in a chat. The Analyst writes it into the spec
 * beside the work: the old and new wording, and whether it is small or big. Nothing changes until the person approves.
 */
export function proposeChange(bp: BoardPaths, id: string, text: string, from?: AgentName): Ticket {
  const ask = text?.trim();
  if (!ask) throw new BoardActionError('Say in a line or two what should change.');
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    if (shipped(t)) throw new ReleasedError(releasedLine(t));
    const open = openChange(t);
    if (open) throw new BoardActionError(`${t.id} already has change ${open.id} open. Approve or decline it first: one change at a time.`);
    if (t.takenOver) throw new BoardActionError(`${t.id} is taken over. Give it back first.`);
    // Before its approval the spec is changed right on its card, with comments, edits or a talk.
    if (!t.specApproved && !['implement', 'test', 'review'].includes(t.stage)) {
      throw new BoardActionError(
        t.story
          ? `The spec of ${t.id} still waits for your approval. Change it right there: comment on it, edit it or talk it through.`
          : `The spec of ${t.id} is not written yet. Add a note or tell the Analyst, and it goes into the spec.`,
      );
    }
    const c: SpecChange = { id: `c${(t.changes?.length ?? 0) + 1}`, ask, by: meta.user.name, at: now(), status: 'writing', ...(from && AGENT_TITLE[from] ? { from } : {}) };
    t.changes = [...(t.changes ?? []), c];
    addActivity(t, 'you', `Proposed change ${c.id}: ${ask}`);
  });
}

/** The Analyst could not write the change: it tries again. */
export function retryChange(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    const c = openChange(t);
    if (c?.status !== 'failed') throw new BoardActionError(`${t.id} has no change to try again.`);
    c.status = 'writing';
    delete c.error;
    addActivity(t, 'you', `Asked the Analyst to write change ${c.id} again`);
  });
}

/**
 * Approves the change that waits: the Analyst's proposal, or the Architect's design update for a big one. Before the
 * build the change simply goes into the spec (and a big one back to the Architect's design, approved as usual). Once
 * the Builder works: a small change goes into the spec now and reaches the Builder at the end of its current step; a
 * big one pauses the Builder after that step, while the Architect updates the design.
 */
export function approveChange(bp: BoardPaths, id: string): Ticket {
  const meta = readMeta(bp);
  const live = meta.engine === 'live';
  return updateTicket(bp, id, (t) => {
    const c = openChange(t);
    if (shipped(t)) throw new ReleasedError(releasedLine(t));
    if (c?.status === 'design-ready') return approveChangeDesign(t, c, live ? 0.2 : 2, live ? 1 : meta.speed);
    if (c?.status !== 'proposed') throw new BoardActionError(`${t.id} has no change waiting for you.`);
    const busy = writerNow(t);
    if (busy) throw new BoardActionError(`The ${busy} right now. Approve the change once it is ready for you.`);
    c.decided = { by: meta.user.name, at: now(), approved: true };
    const big = c.size === 'big';
    const what = (c.summary ?? c.ask).replace(/\.+$/, '');
    tellLater(t, meta.engine, { kind: 'note', text: `Change ${c.id} to the spec, approved by ${meta.user.name}: ${c.summary ?? c.ask}`, noteKind: 'note' });
    if (!buildStarted(t)) {
      const before = planSnapshot(t);
      applyChange(t, c);
      c.status = 'done';
      if (big && t.steps) {
        // The design was written from the old spec: the Architect updates it, and you approve it as any design.
        t.planReview = { before, sent: [] };
        t.changeRequest = `${SPEC_CHANGED} (change ${c.id}): ${c.summary ?? c.ask}\n${changeLines(c)}\nUpdate the design so it builds the new spec.`;
        t.waiting = null;
        t.live = true;
        t.stage = 'specs';
        t.status = 'Architect is updating the design for your change';
        scheduleSquad(t, 'plan-rewrite', 2, meta.speed);
        addActivity(t, 'you', `Approved change ${c.id} (big): ${what}. The spec says it now, and the Architect updates the design`);
      } else addActivity(t, 'you', `Approved change ${c.id}: ${what}. The spec says it now`);
      return;
    }
    c.status = 'approved';
    if (big) {
      addActivity(t, 'you', `Approved change ${c.id} (big): ${what}. The Builder pauses after its current step, and the Architect updates the design`);
      return;
    }
    // Kept so the change can still be withdrawn until the Builder takes it.
    c.specBefore = { ...(t.story !== undefined ? { story: t.story } : {}), ...(t.criteria ? { criteria: t.criteria.map((x) => ({ ...x })) } : {}) };
    applyChange(t, c);
    addActivity(t, 'you', `Approved change ${c.id} (small): ${what}. The spec says it now; it reaches the Builder at the end of its current step`);
  });
}

/**
 * Withdraws an approved change the squad has not built yet: a small one before the Builder takes it into a step, a
 * big one before its design update is ready. The spec goes back to how it was, and the ticket goes back to what it
 * did before the change came in. Once the Builder works on it, a new change undoes it instead.
 */
export function withdrawChange(bp: BoardPaths, id: string, reason?: string): Ticket {
  const meta = readMeta(bp);
  const live = meta.engine === 'live';
  return updateTicket(bp, id, (t) => {
    const c = openChange(t);
    if (c?.status === 'building') throw new BoardActionError(`The Builder is making change ${c.id} already. Once it is done, propose a new change to undo it.`);
    if (c?.status !== 'approved' && c?.status !== 'designing') throw new BoardActionError(`${t.id} has no approved change to withdraw.`);
    const why = reason?.trim();
    const back = Boolean(c.specBefore);
    if (c.specBefore) {
      if (c.specBefore.story !== undefined) t.story = c.specBefore.story;
      else delete t.story;
      if (c.specBefore.criteria) t.criteria = c.specBefore.criteria;
      else delete t.criteria;
      delete c.specBefore;
    }
    c.status = 'declined';
    c.decided = { by: meta.user.name, at: now(), approved: false, withdrawn: true, ...(why ? { reason: why } : {}) };
    addActivity(t, 'you', `Withdrew change ${c.id}${back ? '; the spec is back to how it was' : ''}${why ? `: ${why}` : ''}`);
    tellLater(t, meta.engine, { kind: 'note', text: `Change ${c.id} to the spec was withdrawn by ${meta.user.name}${why ? `: ${why}` : ''}`, noteKind: 'note' });
    // What the ticket did before the change came in: what waited for you, or the step it paused after.
    const paused = c.paused;
    delete c.paused;
    if (paused?.waiting) {
      t.waiting = paused.waiting;
      t.live = false;
      t.squad = null;
      t.status = paused.waiting.summary;
    } else if (paused?.phase) {
      t.live = true;
      t.status = 'Carrying on';
      scheduleSquad(t, paused.phase, live ? 0.2 : 2, live ? 1 : meta.speed);
    } else if (t.squad?.phase.startsWith('change-')) {
      t.squad = null;
      t.live = false;
    }
  });
}

/** The design update for a big change: the spec and the design change together, and the Builder redoes only what changed. */
function approveChangeDesign(t: Ticket, c: SpecChange, seconds: number, speed: number): void {
  const design = c.design!;
  applyChange(t, c);
  const old = t.steps ?? [];
  t.steps = design.steps.map((s) => {
    const kept = s.change === 'same' ? old.find((o) => o.title === s.title) : undefined;
    return { title: s.title, status: kept ? (kept.status === 'done' ? 'done' : 'todo') : s.change === 'same' ? 'done' : 'todo' };
  });
  if (t.work) t.work = { ...t.work, steps: t.steps.length };
  const redo = t.steps.flatMap((s, i) => (s.status === 'done' ? [] : [i + 1]));
  c.status = 'building';
  delete c.paused;
  t.waiting = null;
  t.live = true;
  t.stage = 'implement';
  t.status = `Builder is redoing ${redo.length === 1 ? 'step' : 'steps'} ${redo.join(', ')} for change ${c.id}`;
  addActivity(t, 'you', `Approved the design update for change ${c.id}. The Builder redoes only ${redo.length === 1 ? 'step' : 'steps'} ${redo.join(', ') || 'none'}`);
  scheduleSquad(t, 'change-build', seconds, speed);
}

/**
 * Declines the change that waits. Declining a proposal changes nothing. Declining a big change's design update keeps
 * the spec as it was, and the work carries on from where it paused.
 */
export function declineChange(bp: BoardPaths, id: string, reason?: string): Ticket {
  const meta = readMeta(bp);
  const live = meta.engine === 'live';
  return updateTicket(bp, id, (t) => {
    const c = openChange(t);
    if (!c || (c.status !== 'proposed' && c.status !== 'design-ready' && c.status !== 'failed')) throw new BoardActionError(`${t.id} has no change waiting for you.`);
    const why = reason?.trim();
    const design = c.status === 'design-ready';
    c.status = 'declined';
    c.decided = { by: meta.user.name, at: now(), approved: false, ...(why ? { reason: why } : {}) };
    addActivity(t, 'you', `Declined ${design ? `the design update for change ${c.id}; the spec stays as it was` : `change ${c.id}`}${why ? `: ${why}` : ''}`);
    if (!design) return;
    const paused = c.paused;
    delete c.paused;
    t.waiting = paused?.waiting ?? null;
    if (t.waiting) {
      t.live = false;
      t.status = t.waiting.summary;
      return;
    }
    t.live = true;
    t.status = 'Carrying on';
    scheduleSquad(t, paused?.phase ?? 'test', live ? 0.2 : 2, live ? 1 : meta.speed);
  });
}

/**
 * A change asked for after the ticket is accepted or released: it becomes a new ticket linked to it, or a bug report
 * found in its release. The released ticket itself stays as it is.
 */
export function changeAfterRelease(bp: BoardPaths, id: string, text: string, as: 'ticket' | 'bug'): Ticket {
  const ask = text?.trim();
  if (!ask) throw new BoardActionError('Say in a line or two what should change.');
  const t0 = requireTicket(bp, id);
  if (!shipped(t0)) throw new BoardActionError(`${t0.id} is not accepted yet. Propose the change on it instead.`);
  const line = ask.split('\n')[0]!.trim();
  const title = line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line;
  const link = `A change to ${t0.id} "${t0.title}"${t0.release ? `, ${t0.stage === 'done' ? 'released in' : 'going out in'} ${t0.release}` : ''}.`;
  const made = as === 'bug' ? reportBug(bp, { what: title, ...(t0.release && t0.stage === 'done' ? { foundIn: t0.release } : {}) }) : createTicket(bp, { title, ask: `${ask}\n\n${link}`, priority: t0.priority });
  updateTicket(bp, t0.id, (x) => addActivity(x, 'you', `Asked for a change after release. It became ${as === 'bug' ? 'bug' : 'ticket'} ${made.id}: ${title}`));
  return updateTicket(bp, made.id, (x) => {
    x.changeOf = t0.id;
    if (as === 'bug') x.ask = `${ask}\n\n${link}`;
  });
}

/* ── Stop and try again on a chat answer ─────────────── */

/** Stop the answer the agent is writing. The talk stays open; what was said so far is kept. */
export function chatStop(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c?.open || !c.thinking) throw new BoardActionError(`${t.id} has no answer being written.`);
    c.stopping = true;
  });
}

/** Ask the last question again, after a stop or an answer that failed. */
export function chatRetry(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    const c = t.chat;
    if (!c?.open) throw new BoardActionError(`${t.id} has no chat open.`);
    if (c.thinking) throw new BoardActionError(`The ${AGENT_TITLE[c.with]} is still answering. Wait a moment.`);
    while (c.messages.at(-1)?.who === 'squad') c.messages.pop();
    c.thinking = true;
    c.stopping = undefined;
  });
}

/* ── Review a plan like a document ─────────────────────── */

const PART_NAME = { story: 'the story', criterion: 'done when', decision: 'the decision', step: 'step' } as const;

function partLabel(p: PlanPart): string {
  return p.part === 'criterion' || p.part === 'step' ? `${PART_NAME[p.part]} ${(p.index ?? 0) + 1}` : PART_NAME[p.part];
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
  if (change.startsWith(SPEC_CHANGED)) return 'for the change to the spec';
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

/** The card for gates that could not run. `save`: they stopped the save of an accepted change, not the checks. */
export function gateCantRunCard(cant: { id: string; name: string; why?: string; output?: string }[], opts: { auto: boolean; save?: boolean }): StuckChoice {
  const one = cant.length === 1 ? cant[0]! : null;
  const said = one ? (one.id === HARNESS_FILE_GATE ? one.why : `Your team's check "${one.name}" could not run. ${one.why}`) : `${cant.length} of your team's checks could not run.`;
  const detail = cant.filter((c) => c.output).map((c) => `${c.name}:\n${c.output}`).join('\n\n').slice(-6000);
  return {
    ...(opts.save ? {} : { gate: 'checks' as const }),
    kind: 'gate-cant-run',
    added: cant.map((c) => ({ id: c.id, name: c.name })),
    checks: cant.map((c) => c.id),
    question: `${said} This does not count against the story.`,
    ...(one ? {} : { points: cant.map((c) => `${c.name}: ${c.why}`) }),
    ...(detail ? { detail } : {}),
    options: wayOptions({ kind: 'gate-cant-run', auto: opts.auto, ...(opts.save ? { save: true } : {}) }),
  };
}

/** The choices on a stuck card. Every stop has a way out: try again, do it yourself, go around it, or back to the plan. */
export function wayOptions(stop: { gate?: StuckChoice['gate']; kind?: StuckChoice['kind']; publish?: boolean; copy?: boolean; base?: string; test?: string; auto?: boolean; save?: boolean }): StuckOption[] {
  // A gate of the team's could not run. Nothing here counts against the story. On Builds by itself it waits for a person.
  if (stop.kind === 'gate-cant-run') {
    return [
      { do: stop.save ? 'save-again' : 'retry', name: 'Try again', note: 'squad-kit runs it once more. Use this after an engineer fixed it, or when it was a one-off.' },
      { do: 'engineer', name: 'Let an engineer look', note: 'The story waits here, and what it printed is in the details.' },
      ...(stop.auto ? [] : [{ do: (stop.save ? 'skip-hooks' : 'continue') as WayOut, name: 'Go on without this check', note: 'This once, on this story. Write why: it shows on the story, the pull request and the release notes.' }]),
    ];
  }
  // No tests: asked once per project. The Builder adds tests, go on without them, or check again once an engineer added some.
  if (stop.kind === 'no-tests') {
    return [
      ...(stop.test ? [{ do: 'add-test' as const, name: 'Have the Builder add tests', note: 'The Builder writes the tests, and the checks run again.' }] : []),
      { do: 'no-tests', name: 'Go on without tests', note: 'This ticket and later ones show "Not checked" instead of a pass. squad-kit asks once per project.' },
      { do: 'retry', name: 'Check again', note: 'After an engineer adds tests to the project.' },
    ];
  }
  // The project's own commit hook said no. Its words go to the Builder or an engineer; only the person can go past it.
  if (stop.kind === 'hook') {
    return [
      { do: 'retry', name: 'Let the Builder fix it', note: "It gets the check's words and fixes the code. Then the checks, the review and the proof run again. It cannot change the check itself: that stays with you or an engineer." },
      ...(stop.copy ? [{ do: 'yourself' as const, name: 'Fix it yourself', note: "Open the ticket's copy in your editor and fix it. Then the checks, review and proof run again." }] : []),
      { do: 'save-again', name: 'Try the save again', note: 'After an engineer fixed the check, or when it was a one-off.' },
      { do: 'skip-hooks', name: 'Save without this check', note: "Go on without the project's own check, this once. Write why: it shows on the ticket, the pull request and the release notes." },
      { do: 'plan', name: 'Send it back to the plan', note: 'The Spec writer rewrites the plan with what went wrong.' },
    ];
  }
  if (stop.publish) {
    return [
      { do: 'retry', name: 'Try again', note: 'Push the branch and open the pull request again.' },
      { do: 'skip-pr', name: 'Skip the pull request', note: 'Release merges this branch directly instead.' },
    ];
  }
  const retry: StuckOption =
    stop.kind === 'weakened'
      ? { do: 'retry', name: 'Send it back to the Builder', note: 'It puts the tests back as they were, then the checks run again.' }
      : stop.gate === 'checks'
      ? { do: 'retry', name: 'Let the Builder try 3 more times', note: 'It gets the full error and tries again.' }
      : stop.gate === 'review'
        ? { do: 'retry', name: 'Let the Builder fix the notes', note: 'Then the Reviewer gets two more rounds.' }
        : stop.gate === 'proof' && stop.kind === 'broken'
          ? { do: 'retry', name: 'Let the Builder try again', note: 'It gets what the screenshots show. Then the checks, the review and the screenshots run again.' }
        : stop.gate === 'proof'
          ? { do: 'retry', name: 'Take the screenshots again', note: 'Only the proof runs again. Nothing is rebuilt. You can add a note for the Tester.' }
          : stop.gate === 'merge'
          ? { do: 'retry', name: `Let the Builder bring in the latest ${stop.base ?? 'base'}`, note: 'It brings the newer work into this ticket and fixes the clash. Then the checks run again.' }
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
    const what =
      stop.kind === 'weakened'
        ? 'with the tests as they are now; the checks still run'
        : stop.kind === 'bad-proof'
          ? 'with the screenshots as they are'
          : stop.kind === 'broken'
            ? 'with a "done when" not working yet'
          : stop.kind === 'not-shown'
            ? 'with a "done when" not shown yet'
          : { checks: 'with the checks failing', review: 'with the review notes open', proof: 'without screenshots' }[stop.gate];
    out.push({ do: 'continue', name: 'Continue anyway', note: `Go on ${what}. Write why: it shows on the ticket, the pull request and the release notes.` });
  }
  out.push({ do: 'plan', name: 'Send it back to the plan', note: 'The Spec writer rewrites the plan with what went wrong.' });
  return out;
}

/** The project's test command, in the settings of the ticket's repo (the first one, or the project's own). */
export function saveTestCommand(bp: BoardPaths, meta: BoardMeta, repoPath: string | undefined, command: string): void {
  const repo = meta.repos?.find((r) => r.path === repoPath) ?? meta.repos?.[0];
  writeMeta(bp, repo ? { ...meta, repos: meta.repos!.map((r) => (r === repo ? { ...r, commands: { ...r.commands, test: command } } : r)) } : { ...meta, commands: { ...(meta.commands ?? {}), test: command } });
}

/**
 * squad-kit settles a change to the test command itself by trying it (engine/test-change.ts). Only when it cannot tell
 * does the person choose, and an engineer can always choose from the terminal. Use saves the new one in the settings
 * of the ticket's repo, Keep drops it. Either way the checks from now on run the command chosen. The commands go to the
 * Developer tab and the log, not the activity.
 */
export function decideTestCommand(bp: BoardPaths, id: string, use: boolean): Ticket {
  const meta = readMeta(bp);
  return updateTicket(bp, id, (t) => {
    const c = t.testChange;
    if (!c) throw new BoardActionError(`${t.id} has no change to the test command waiting.`);
    if (use) saveTestCommand(bp, meta, c.repo ?? t.repo, c.to);
    addActivity(t, 'you', use ? 'Chose the new way of testing this project' : 'Kept the current way of testing this project');
    writeLog({ level: 'info', project: meta.project, ticket: t.id, text: `The test command stays "${use ? c.to : c.from}", as the person chose (from "${c.from}", to "${c.to}")` });
    t.testDecided = { from: c.from, to: c.to, kept: use ? 'new' : 'current', by: 'you', ...(c.ran ? { ran: c.ran } : {}), at: now() };
    delete t.testChange;
  });
}

/** Older stuck cards have no `do` on their options: the first tried again, the second went to the plan or skipped the PR. */
function wayOf(t: Ticket, option: StuckOption, choice: number): WayOut {
  if (option.do) return option.do;
  if (choice === 0) return 'retry';
  return t.retryPhase === 'publish' ? 'skip-pr' : 'plan';
}

export function decideStuck(bp: BoardPaths, id: string, choice: number, input: { note?: string; reason?: string } = {}): Ticket {
  const meta = readMeta(bp);
  const before = requireTicket(bp, id);
  const save = before.waiting?.kind === 'stuck' ? before.stuck?.options[choice]?.do : undefined;
  if (save === 'save-again' || save === 'skip-hooks') return saveFromHookCard(bp, id, choice, save, input.reason);
  return updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'stuck' || !t.stuck) throw new BoardActionError(`${t.id} is not stuck.`);
    const option = t.stuck.options[choice];
    if (!option) throw new BoardActionError(`Pick a choice between 1 and ${t.stuck.options.length}.`);
    const way = wayOf(t, option, choice);
    // Nothing moves: the card stays, for the engineer and for whoever decides after.
    if (way === 'engineer') {
      addActivity(t, 'you', 'Asked an engineer to look');
      t.status = 'Waiting for an engineer';
      t.waiting = { kind: 'stuck', summary: 'Waiting for an engineer to look at it' };
      return;
    }
    const gate = t.stuck.gate;
    const reason = input.reason?.trim();
    const note = input.note?.trim();
    const kind = t.stuck.kind;
    if (way === 'continue') {
      if (gate !== 'checks' && gate !== 'review' && gate !== 'proof') throw new BoardActionError('Only a failed check, review or proof can be continued past.');
      if (!reason) throw new BoardActionError('Write why you continue anyway. It shows on the ticket, the pull request and the release notes.');
    }
    if ((way === 'more' || way === 'stop') && gate !== 'cap') throw new BoardActionError('Only a step paused at its limit can be given more or stopped here.');
    if (way === 'yourself' && meta.engine === 'live' && !(t.worktree && fs.existsSync(t.worktree))) {
      throw new BoardActionError(`${t.id} has no copy of the code to fix. Try again or send it back to the plan.`);
    }
    t.stuck.options.forEach((o, i) => (o.chosen = i === choice));
    t.waiting = null;
    t.live = true;
    // Whatever comes next is a new run, with a clock of its own.
    delete t.clock;
    addActivity(t, 'you', `Decided: ${option.name}${way === 'continue' ? `. Why: ${reason}` : ''}`);
    if (note) {
      t.notes = [...(t.notes ?? []), { at: now(), by: meta.user.name, kind: 'note', text: note }];
      addActivity(t, 'you', `Added a note: ${note}`);
      tellLater(t, meta.engine, { kind: 'note', text: note, noteKind: 'note' });
    }
    if (way === 'continue') {
      const weakened = kind === 'weakened' ? (t.stuck.points ?? []) : [];
      const named = kind === 'gate-cant-run' ? { added: (t.stuck.added ?? []).map((g) => g.name).join(', ') } : {};
      t.overrides = [...(t.overrides ?? []), { gate: gate as 'checks' | 'review' | 'proof', ...(weakened.length ? { weakened } : {}), ...named, reason: reason!, by: meta.user.name, at: now() }];
      t.gates = { ...(t.gates ?? { checks: 'pending', review: 'pending', proof: 'pending' }), [gate as string]: 'skipped' };
      if (kind === 'weakened') {
        // Remembered: only tests weakened again, in a new way, stop the ticket again.
        t.weakenedContinued = [...new Set([...(t.weakenedContinued ?? []), ...(t.stuck.checks ?? [])])];
      } else if (kind === 'gate-cant-run') {
        t.addedSkipped = [...new Set([...(t.addedSkipped ?? []), ...(t.stuck.checks ?? [])])];
      } else if (gate === 'checks') {
        // Remembered: a later round where only these checks fail again goes on, instead of stopping on them once more.
        // Cards from before this was kept name the failed checks only in the gate's line: "lint, test failed".
        const failed = t.stuck.checks ?? (t.gates.checksText?.replace(/ failed$/, '').split(', ').filter(Boolean) ?? []);
        t.checksContinued = [...new Set([...(t.checksContinued ?? []), ...failed])];
        t.tries = 0;
      }
      tellLater(t, meta.engine, { kind: 'note', text: `Continued anyway past ${kind === 'weakened' ? 'the weakened tests' : kind === 'gate-cant-run' ? 'a check that could not run' : `the failed ${gate}`}: ${reason}`, noteKind: 'note' });
    }
    // No tests: the person's answer is the project's, so later tickets never ask again.
    if (way === 'add-test') {
      const command = t.testSuggestion?.trim();
      if (!command) throw new BoardActionError(`${t.id} has no suggested test command. Add one in Settings, then press Check again.`);
      saveTestCommand(bp, meta, t.repo, command);
      t.testSuggestion = undefined;
      // The exact command is for engineers: here, and in the Developer tab once the checks ran it.
      writeLog({ level: 'info', project: meta.project, ticket: t.id, text: `Saved the test command "${command}"` });
      addActivity(t, 'squad', 'Found how to test this project');
    }
    if (way === 'no-tests') {
      writeMeta(bp, { ...meta, noTests: { by: meta.user.name, at: now(), ticket: t.id } });
      t.gates = { ...(t.gates ?? { checks: 'pending', review: 'pending', proof: 'pending' }), checks: 'unchecked' };
      addActivity(t, 'you', 'Going on without tests in this project: the checks show "Not checked" from now on');
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
        } else if (kind === 'hook') {
          // The hook's own words go to the Builder. The first line names the step on the card.
          t.changeRequest = `Fix what the project's own check found\nsquad-kit tried to save this change and the project's own commit hook refused it. Fix what it says in the code. Do not change or remove the hook or its settings: squad-kit puts them back. If only a change to the hook itself could fix this, leave it and say so in your summary: that is for the person or an engineer to decide. Do not commit: squad-kit does the git. What the hook said:\n${t.stuck.detail ?? '(it said nothing)'}`;
          t.hookFixTried = true;
          t.stage = 'implement';
          t.status = "Builder is fixing what the project's own check found";
          t.gates = { checks: 'pending', review: 'pending', proof: 'pending' };
          scheduleSquad(t, 'fix', 0.5, 1);
        } else if (gate === 'merge') {
          // The person asked for this one: on a track that merges by itself the count starts over, with this try first.
          if (t.selfAccept?.baseTried) t.selfAccept.baseTries = 1;
          t.stage = 'implement';
          t.status = 'Builder is bringing in the latest changes';
          scheduleSquad(t, 'update-base', 0.5, 1);
        } else {
          // The screenshots still showed a "done when" not working: the Builder gets two more rounds.
          if (gate === 'proof') t.proofRound = undefined;
          t.status = 'Trying again';
          scheduleSquad(t, retryPhase ?? 'analyst-read', 0.5, 1);
        }
        return;
      case 'more':
        // The same step goes on in its own conversation, with twice the caps each time.
        t.capRaise = { role: t.capRaise?.role ?? '', step: t.capRaise?.step ?? '', times: (t.capRaise?.times ?? 0) + 1 };
        t.status = 'Carrying on with more room';
        scheduleSquad(t, retryPhase ?? 'analyst-read', 0.2, 1);
        return;
      case 'stop':
        // As if the person pressed Stop: the card says so and offers carrying on later, fixing it, or the plan.
        t.live = false;
        t.retryPhase = retryPhase;
        t.capRaise = undefined;
        t.status = 'Stopped, needs you';
        t.stuck = {
          question: 'You stopped the squad. Nothing was lost; the work so far is kept.',
          options: [
            { do: 'retry', name: 'Carry on', note: 'Run the stopped step again.' },
            ...wayOptions({ copy: Boolean(t.worktree && fs.existsSync(t.worktree)) && ['implement', 'test', 'review'].includes(t.stage) }).slice(1),
          ],
        };
        t.waiting = { kind: 'stuck', summary: 'The squad stopped and needs you' };
        return;
      case 'yourself':
        t.tries = 0;
        t.checksContinued = undefined;
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
      case 'add-test':
        t.tries = 0;
        t.stage = 'test';
        t.status = 'Running the project checks with the new test command';
        scheduleSquad(t, 'test', 0.2, 1);
        return;
      case 'no-tests':
        t.tries = 0;
        t.stage = 'review';
        t.status = 'Reviewer is reading the changes';
        scheduleSquad(t, 'review', 0.2, 1);
        return;
      case 'continue':
        if (kind === 'weakened' || kind === 'gate-cant-run') {
          // Past the weakened tests, the checks themselves still run.
          t.stage = 'test';
          t.status = 'Running the project checks';
          scheduleSquad(t, 'test', 0.2, 1);
        } else if (gate === 'checks') {
          t.stage = 'review';
          t.status = 'Reviewer is reading the changes';
          scheduleSquad(t, 'review', 0.2, 1);
        } else if (gate === 'proof') {
          // No screenshots, on the record: you still check the work and press Looks right. Rows with no after go.
          t.live = false;
          t.stage = 'review';
          t.status = 'Proof ready to check';
          if (t.proof) t.proof = t.proof.filter((p) => p.after);
          t.waiting = {
            kind: 'proof',
            summary:
              kind === 'bad-proof'
                ? 'Ready for you to check: the screenshots did not pass the check'
                : kind === 'broken'
                  ? 'Ready for you to check: a "done when" is not working yet'
                  : kind === 'not-shown'
                    ? 'Ready for you to check: a "done when" is not shown yet'
                    : 'Ready for you to check, without screenshots',
          };
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
  // The release going out takes no more tickets: what is accepted meanwhile goes into the one after it.
  const going = releaseGoingOut(bp);
  const draft = listReleases(bp).find((r) => r.status === 'draft' && r.version !== going);
  if (draft) return draft;
  const meta = readMeta(bp);
  const live = meta.engine === 'live';
  const last = latestRelease(bp);
  // The first release on a live board continues the project's own version, not 0.0.0.
  const done = last?.version ?? (live ? projectVersion(bp.root, meta) : 'v0.0.0');
  const from = going ? newer(going, done) : done;
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
  const lines = tickets.map((t) => `- ${[t.releaseNote ?? `**${t.title}.**`, alsoChangedLine(t.alsoChanged)].filter(Boolean).join(' ')}`);
  const skipped = tickets.flatMap((t) =>
    (t.overrides ?? []).filter((o) => !o.release).map((o) => `- ${t.id} ${t.title}: went out ${o.added ? `without your team's check "${o.added}"` : o.weakened?.length ? 'with weakened tests' : o.gate === 'checks' ? 'with failing checks' : o.gate === 'proof' ? 'with an unfinished proof' : o.gate === 'hooks' ? "without the project's own check" : 'with open review notes'}. ${o.by}: ${o.reason}`),
  );
  return [`### What's new in ${release.version.replace(/^v/, '')}`, '', ...lines, ...(skipped.length ? ['', '### Continued anyway', '', ...skipped] : [])].join('\n');
}

export function saveReleaseNotes(bp: BoardPaths, version: string, notes: string): Release {
  const release = readRelease(bp, version);
  if (!release || release.status !== 'draft') throw new BoardActionError(`${version} is not a draft release.`);
  if (releaseGoingOut(bp) === release.version) throw new BoardActionError(`${release.version} is going out right now with the notes it had. Edit the notes of the next release instead.`);
  release.notes = notes;
  writeRelease(bp, release);
  return release;
}

/**
 * The team's release gates, on squad-kit's own copy of what is about to go out, before anything changes. What holds the
 * release back stays on it for the page, with its ways out: Try again, or go on with a reason.
 */
async function gatesBeforeRelease(bp: BoardPaths, release: Release, tickets: Ticket[], reason?: string): Promise<void> {
  const done = await runReleaseGates(bp, tickets);
  for (const t of tickets) updateTicket(bp, t.id, (x) => noteGates(x, done, (text) => addActivity(x, 'release', text)));
  const stops = done.filter((d) => d.stops && d.result !== 'passed');
  const saved = readRelease(bp, release.version)!;
  delete saved.gateStop;
  if (stops.length && !reason) {
    saved.gateStop = stops.map((d) => ({ id: d.id, name: d.name, result: d.result as 'failed' | 'cant-run', ...(d.why ? { why: d.why } : {}), ...(d.output ? { output: d.output } : {}) }));
    writeRelease(bp, saved);
    throw new BoardActionError(`${release.version} did not go out: ${stops.map((d) => `"${d.name}"`).join(' and ')} ${stops.some((d) => d.result === 'failed') ? 'did not pass' : 'could not run'}. Nothing changed.`);
  }
  if (stops.length) {
    const by = readMeta(bp).user.name;
    const at = now();
    const lines = stops.map((d) => `- Went out without your team's check "${d.name}". ${by}: ${reason}`);
    release.notes = `${release.notes.trim()}\n\n### Continued anyway\n\n${lines.join('\n')}`;
    saved.notes = release.notes;
    for (const t of tickets) updateTicket(bp, t.id, (x) => (x.overrides = [...(x.overrides ?? []), ...stops.map((d) => ({ gate: 'checks' as const, added: d.name, release: release.version, reason: reason!, by, at }))]));
  }
  delete release.gateStop;
  writeRelease(bp, saved);
}

export async function releaseVersion(bp: BoardPaths, version?: string, goOn?: string): Promise<Release> {
  const release = version ? readRelease(bp, version) : draftRelease(bp);
  if (!release || release.status !== 'draft') throw new BoardActionError('There is no release ready to go out.');
  if (release.tickets.length === 0) throw new BoardActionError(`${release.version} has no tickets yet.`);
  // One release at a time, and "Looks right" meanwhile knows this one takes no more tickets.
  let free: () => void;
  try {
    free = holdRelease(bp, release.version);
  } catch (err) {
    throw new BoardActionError((err as Error).message);
  }
  try {
    // A release cut off by a restart is finished or undone first (board/release-tidy.ts).
    if (readJournal(bp)) {
      const cut = await settleRelease(bp, `${readJournal(bp)!.version} was cut off while it went out (the app closed or the computer restarted).`);
      if (cut?.version === release.version && cut.status === 'released') return cut;
    }
    // What it sends is read once the lock is held: a ticket accepted just before still goes with it.
    return await sendRelease(bp, readRelease(bp, release.version) ?? release, goOn?.trim());
  } finally {
    free();
  }
}

async function sendRelease(bp: BoardPaths, release: Release, goOn?: string): Promise<Release> {
  const meta = readMeta(bp);
  if (!release.notes.trim()) release.notes = composeNotes(bp, release);
  const tickets = listTickets(bp).filter((t) => release.tickets.includes(t.id));
  // No gate due, no wait: nothing changes for a project with none.
  if (meta.engine === 'live' && (release.gateStop || releaseGatesDue(bp))) await gatesBeforeRelease(bp, release, tickets, goOn);
  // Set before it goes out, so the release commit carries the release as the board will keep it.
  release.date = now();
  release.whatsappDraft = [
    `Hello, version ${release.version.replace(/^v/, '')} of ${meta.project} is now live.`,
    '',
    "What's new:",
    ...tickets.map((t) => `- ${t.title}`),
    '',
    'Release notes are in the changelog.',
  ].join('\n');
  let unpushed: UnpushedRelease[] = [];
  if (meta.engine === 'live') {
    try {
      const done = await liveRelease(bp, release, tickets);
      release.log = done.log;
      unpushed = done.unpushed;
      // A pull request merged only now, as the release went out: the first code came in this way.
      firstCodeMerged(bp);
    } catch (err) {
      // Stopped half-way: what reached the remote is finished, the rest undone, so nothing stays half-done.
      const settled = await settleRelease(bp, `The release stopped: ${(err as Error).message}`).catch(() => null);
      if (settled?.status === 'released') return settled;
      foldNewerDrafts(bp, release.version);
      if (err instanceof PullRequestClash) {
        // Nothing changed yet: the clashing tickets leave the release with a way out, and the rest can go.
        const withPr = err.tickets.every((id) => readTicket(bp, id)?.pr);
        for (const id of err.tickets) pullRequestClashed(bp, id);
        const one = err.tickets.length === 1;
        const left = readRelease(bp, release.version)?.tickets.length ?? 0;
        throw new BoardActionError(
          `The release did not go out: ${withPr ? 'the pull request of ' : ''}${err.tickets.join(', ')} ${one || withPr ? 'clashes' : 'clash'} with newer changes in ${err.base}. ${one ? 'It' : 'They'} left ${release.version} and ${one ? 'waits' : 'wait'} for you with ways out.${left ? ' Press Release again to send the rest.' : ''}`,
        );
      }
      throw new BoardActionError(`The release did not go out: ${(err as Error).message}`);
    }
  }
  // Read again before saving: a ticket that joined the file while the release went out is not in it, so it waits for
  // the next release instead of being dropped or marked released.
  const later = (readRelease(bp, release.version)?.tickets ?? []).filter((id) => !release.tickets.includes(id));
  release.status = 'released';
  if (unpushed.length) release.unpushed = unpushed;
  else delete release.unpushed;
  writeRelease(bp, release);
  if (later.length) joinNextRelease(bp, later);
  closeReleased(bp, release);
  clearJournal(bp);
  afterRelease(bp, release);
  return release;
}

/**
 * The release's tickets close once their repo has the release, and the tracker hears it then. A repo whose push
 * failed keeps its tickets open, waiting for Push again.
 */
export function closeReleased(bp: BoardPaths, release: Release): void {
  const meta = readMeta(bp);
  for (const id of release.tickets) {
    const t = readTicket(bp, id);
    if (!t || t.stage === 'done') continue;
    const waits = release.unpushed?.length ? release.unpushed.find((u) => copyViews(meta, t).some((v) => repoFor(meta, v).path === u.repo)) : undefined;
    updateTicket(bp, id, (x) => {
      x.live = false;
      if (waits) {
        const status = `In ${release.version} · not pushed to ${waits.remote} yet`;
        if (x.status === status) return;
        x.status = status;
        addActivity(x, 'release', `Released in ${release.version} on this computer only: the push to ${waits.remote} failed. Push again sends it`);
        return;
      }
      x.stage = 'done';
      x.status = `Released in ${release.version}`;
      addActivity(x, 'release', `Released in ${release.version}`);
      tellLater(x, meta.engine, { kind: 'released', version: release.version });
    });
  }
}

/** Tickets accepted while a release went out: they go into the next draft, which says so on each of them. */
export function joinNextRelease(bp: BoardPaths, ids: string[]): void {
  const tickets = ids.map((id) => readTicket(bp, id)).filter((t): t is Ticket => Boolean(t));
  if (!tickets.length) return;
  const next = ensureDraftRelease(bp, tickets.every((t) => t.kind === 'bug') ? 'patch' : 'minor');
  writeRelease(bp, { ...next, tickets: [...new Set([...next.tickets, ...tickets.map((t) => t.id)])] });
  for (const t of tickets) moveToRelease(bp, t.id, t.release, next.version);
}

function moveToRelease(bp: BoardPaths, id: string, from: string | undefined, to: string): void {
  updateTicket(bp, id, (x) => {
    x.release = to;
    if (from && from !== to) x.status = x.status.split(from).join(to);
    addActivity(x, 'release', `Moved to release ${to}`);
  });
}

/**
 * A release that did not go out takes back the tickets accepted while it was going: they went into a newer draft,
 * which is folded into this one, so there is only one release to send.
 */
function foldNewerDrafts(bp: BoardPaths, version: string): void {
  for (const d of listReleases(bp).filter((r) => r.status === 'draft' && r.version !== version && newer(r.version, version) === r.version)) {
    const into = readRelease(bp, version);
    if (!into) return;
    writeRelease(bp, { ...into, tickets: [...new Set([...into.tickets, ...d.tickets])] });
    removeRelease(bp, d.version);
    for (const id of d.tickets) moveToRelease(bp, id, d.version, version);
  }
}

/**
 * "Push again" on a release whose push failed: the release commits and tags go to their remotes now, and the
 * tickets of every repo that got them close.
 */
export async function pushReleaseAgain(bp: BoardPaths, version: string): Promise<Release> {
  const release = readRelease(bp, version);
  if (!release) throw new BoardActionError(`There is no release ${version}.`);
  if (!release.unpushed?.length) throw new BoardActionError(`${release.version} is pushed already. Nothing is left to send.`);
  let free: () => void;
  try {
    free = holdRelease(bp, release.version);
  } catch (err) {
    throw new BoardActionError((err as Error).message);
  }
  try {
    const done = await pushAgain(bp, release);
    release.log = [...(release.log ?? []), ...done.log];
    if (done.unpushed.length) release.unpushed = done.unpushed;
    else delete release.unpushed;
    writeRelease(bp, release);
    closeReleased(bp, release);
    return release;
  } finally {
    free();
  }
}

/** squad-kit looked, and the release is not on its remote, or it could not ask: it goes only on a second, clear yes. */
export class SentNotSure extends BoardActionError {}

/**
 * "It reached the remote another way": an engineer merged the release by hand, or squashed it, so Push again can never
 * see it. Its tickets close, and nothing checks after this, so the person says why, and squad-kit looks on the
 * remote first. Not there, or no answer: it says so, and only `anyway` goes on. The release's log keeps who said it,
 * why, and what squad-kit found.
 */
export async function markReleaseSent(bp: BoardPaths, version: string, input: { reason?: string; anyway?: boolean } = {}): Promise<Release> {
  const first = readRelease(bp, version);
  if (!first) throw new BoardActionError(`There is no release ${version}.`);
  if (!first.unpushed?.length) throw new BoardActionError(`${first.version} is pushed already. Nothing is left to send.`);
  const why = input.reason?.trim();
  if (!why) throw new BoardActionError("Write how it got there. It stays in the release's log, and its tickets close.");
  let free: () => void;
  try {
    free = holdRelease(bp, first.version);
  } catch (err) {
    throw new BoardActionError((err as Error).message);
  }
  try {
    const looks = await Promise.all(first.unpushed.map(async (u) => ({ u, ...(await onTheRemote(bp, u)) })));
    const absent = looks.filter((l) => l.there === 'no');
    const silent = looks.filter((l) => l.there === 'no-answer');
    if ((absent.length || silent.length) && !input.anyway) {
      throw new SentNotSure(
        silent.length
          ? `squad-kit could not reach your team's shared copy of the code, so it cannot check that ${first.version} is there. Its tickets close if you mark it. Do that only if you are sure.`
          : `squad-kit looked in your team's shared copy of the code and did not find ${first.version} there. A merge by hand can look like this too, so you can still mark it. Its tickets close if you do.`,
      );
    }
    const found = silent.length ? ' squad-kit could not check that' : absent.length ? ' squad-kit did not find it there' : ' squad-kit found it there';
    const meta = readMeta(bp);
    const release = readRelease(bp, version)!;
    // Marking it sends nothing: a version tag made here stays here until someone sends it, and the record says so.
    const tags = first.unpushed.filter((u) => u.tag);
    release.log = [
      ...(release.log ?? []),
      { ok: true, text: `${meta.user.name} said it reached the shared copy of the code another way: ${why}.${found}` },
      ...(tags.length ? [{ ok: false, text: `Its version tag is only on this computer: squad-kit sent nothing. An engineer can send it: ${tags.map((u) => `git push ${u.remote} ${u.tag}`).join(' ; ')}` }] : []),
    ];
    delete release.unpushed;
    writeRelease(bp, release);
    closeReleased(bp, release);
    return release;
  } finally {
    free();
  }
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
    writeLog({ level: 'info', project: readMeta(bp).project, ticket: t.id, text: `Ended the stuck command: ${t.quiet.command ?? 'a command'} (process ${t.quiet.pid})` });
    addActivity(t, 'you', 'Ended the stuck command');
    delete t.quiet;
  });
}

/**
 * "Give it 10 more minutes": the step is slow but fine. squad-kit stays quiet about it for that long, then asks again
 * if it is still slow. The step's hard limit stays.
 */
export function keepWaiting(bp: BoardPaths, id: string, minutes = 10): Ticket {
  const m = Math.round(minutes);
  if (!Number.isFinite(m) || m < 1 || m > 120) throw new BoardActionError('Give it between 1 and 120 more minutes.');
  return updateTicket(bp, id, (t) => {
    if (!t.quiet && !(t.live || t.squad)) throw new BoardActionError(`${t.id} is not running right now.`);
    t.quietSnoozedUntil = new Date(Date.now() + m * 60_000).toISOString();
    addActivity(t, 'you', `Gave it ${m} more minute${m === 1 ? '' : 's'}`);
    delete t.quiet;
  });
}

/** "Stop and try again": the running step stops, then starts again at once. The work so far is kept. */
export function restartStep(bp: BoardPaths, id: string): Ticket {
  return updateTicket(bp, id, (t) => {
    if (!t.live && !t.squad) throw new BoardActionError(`${t.id} is not running right now.`);
    if (t.waiting) throw new BoardActionError(`${t.id} waits for you, so no step is running to try again.`);
    t.stopRequested = true;
    t.retryOnStop = true;
    t.status = 'Stopping, then trying again…';
    addActivity(t, 'you', 'Pressed Stop and try again');
  });
}

/** Everything that needs the person: open questions, plans, proof, decisions, changes, and steps that look stuck. */
export function inbox(bp: BoardPaths): Ticket[] {
  return listTickets(bp).filter((t) => t.waiting || t.quiet?.kind === 'stuck' || t.outdated?.length || changeNeedsYou(t) || t.testChange?.ask);
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
  // In a package file, or seen in the code by the Architect (a project without package files).
  const inCode = detectStack(bp.root, meta).some((t) => t.name === tech) || Boolean(meta.blueprint?.stack.some((n) => n.role && n.name === tech));
  if (!inCode) throw new BoardActionError(`${tech} is not in the code.`);
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
  if (t0.chat?.open && !t0.chat.beside) throw new BoardActionError(`${id} has a chat open. Finish it first.`);
  const open = openChange(t0);
  if (open) throw new BoardActionError(`${id} has change ${open.id} open. Finish it first: one change at a time.`);
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


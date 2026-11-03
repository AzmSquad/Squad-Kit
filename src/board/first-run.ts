import fs from 'node:fs';
import path from 'node:path';
import { BoardActionError, createTicket } from './actions.js';
import { listDecisions, listTickets, now, readMeta, readTicket, writeDecision, writeMeta, type BoardPaths } from './store.js';
import type { BoardMeta, Decision, Quality, Ticket } from './types.js';
import { readOverview, writeOverview, type CodePart, type PartLink, type TicketIdea } from './overview.js';
import {
  SETUP_STEPS,
  currentStep,
  resetFrom,
  setupOver,
  setupUsual,
  stepOf,
  usualText,
  type FolderKind,
  type OverviewTalk,
  type SetupProof,
  type SetupStepId,
  type SetupStepState,
} from './setup-state.js';
import { aiTool } from '../modules/registry.js';
import { readAgent } from '../engine/agents.js';
import { dropSetupCopies } from '../engine/onboard.js';
import { DEFAULT_QUALITY, parseQuality } from '../engine/levels.js';

/**
 * The first run and the Overview, as the board, the terminal and REST see them: the setup's steps in plain words with
 * their times, the overview the Architect wrote, and the person's moves on it: approve it ("Looks right, start
 * working"), make a ticket from an idea, talk to the Architect when something is wrong, read it again, stop, and the
 * Quality question asked once. Every move is one call here.
 */

/* ── The setup, in words ───────────────────────────────── */

const LABEL: Record<SetupStepId, (tool: string, state: SetupStepState) => string> = {
  files: () => 'Project memory created',
  tool: (t, s) => (s === 'done' ? `${t} is ready` : s === 'failed' ? `${t} is not ready` : `Checking ${t}`),
  read: (_t, s) => (s === 'done' ? 'The Architect read your code' : s === 'now' ? 'The Architect is reading your code' : 'The Architect reads your code'),
  commands: () => 'Finding how to test and run it',
  tests: () => 'Trying the tests',
  app: () => 'Opening the app once',
  overview: () => 'Your project overview',
};

/** What a step does, before it has its own words. */
const HINT: Record<SetupStepId, string> = {
  files: 'A .squad folder in your project. Your code is not changed.',
  tool: 'The AI tool the squad works with',
  read: 'What the project is, its parts and the rules it follows',
  commands: "In squad-kit's own copy. Your folder is not touched.",
  tests: 'squad-kit runs your tests once',
  app: 'squad-kit opens your app once, with a screenshot',
  overview: 'What squad-kit understood, for you to check',
};

/** A way on from a step that failed, stopped or was skipped. Each one is a button and a command. */
export type SetupWay = { do: 'again'; step: SetupStepId; label: string; command: string } | { do: 'output'; label: string } | { do: 'settings'; label: string };

export interface SetupStepView {
  id: SetupStepId;
  label: string;
  state: SetupStepState;
  note?: string;
  error?: string;
  output?: string;
  since?: string;
  seconds?: number;
  /** "usually 2 to 5 min". */
  usual: string;
  ways: SetupWay[];
}

export interface SetupView {
  project: string;
  engine: BoardMeta['engine'];
  kind: FolderKind;
  startedAt: string;
  steps: SetupStepView[];
  done: number;
  total: number;
  current?: SetupStepId;
  /** Every step is over: the overview can be checked. */
  ready: boolean;
  approved: boolean;
  stopping: boolean;
  /** The last few things the Architect read. */
  reads: string[];
  quality: Quality;
  /** The Quality question was answered here; it is asked once. */
  qualityAsked: boolean;
  tool: string;
  empty: boolean;
}

const again = (step: SetupStepId, label = 'Try again'): SetupWay => ({ do: 'again', step, label, command: `squad setup --again ${step}` });

function waysOf(id: SetupStepId, state: SetupStepState, output?: string): SetupWay[] {
  if (state === 'stopped') return [again(id === 'tool' ? 'read' : id, 'Start again')];
  const seeOutput: SetupWay[] = output ? [{ do: 'output', label: 'See what failed' }] : [];
  if (state === 'failed') {
    if (id === 'tool' || id === 'read') return [again('read')];
    if (id === 'app') return [again('app'), { do: 'settings', label: 'Set how it starts' }];
    return [again(id), ...seeOutput];
  }
  if (state === 'skipped' && id === 'app') return [{ do: 'settings', label: 'Set how it starts' }];
  return [];
}

function toolLabel(bp: BoardPaths): string {
  try {
    return aiTool(readAgent(bp, 'architect').tool)?.label ?? 'The AI tool';
  } catch {
    return 'The AI tool';
  }
}

/**
 * The setup as people see it, or null when the project has none (it was set up before 1.2, and nothing is being read).
 * A read started from Settings on such a project shows as the read step alone.
 */
export function setupView(bp: BoardPaths): SetupView | null {
  const meta = readMeta(bp);
  const tool = toolLabel(bp);
  let s = meta.setup;
  if (!s) {
    if (!meta.scan || meta.scan.status === 'done') return null;
    const read = meta.scan.status === 'running' ? 'now' : meta.scan.status === 'failed' ? 'failed' : 'todo';
    s = {
      kind: 'repo',
      startedAt: meta.scan.at ?? now(),
      steps: [
        { id: 'files', state: 'done' },
        { id: 'read', state: read, ...(meta.scan.now ? { note: meta.scan.now } : {}), ...(meta.scan.error ? { error: meta.scan.error } : {}), ...(meta.scan.at ? { since: meta.scan.at } : {}) },
      ],
    };
  }
  const steps: SetupStepView[] = s.steps
    .filter((st) => SETUP_STEPS.includes(st.id))
    .map((st) => ({
      id: st.id,
      label: LABEL[st.id](tool, st.state),
      state: st.state,
      note: st.note ?? (st.state === 'todo' || st.id === 'files' ? HINT[st.id] : undefined),
      ...(st.error ? { error: st.error } : {}),
      ...(st.output ? { output: st.output } : {}),
      ...(st.since ? { since: st.since } : {}),
      ...(st.seconds !== undefined ? { seconds: st.seconds } : {}),
      usual: usualText(setupUsual(bp, st.id)),
      ways: waysOf(st.id, st.state, st.output),
    }));
  const over = setupOver(s);
  return {
    project: meta.project,
    engine: meta.engine,
    kind: s.kind,
    startedAt: s.startedAt,
    steps,
    done: s.steps.filter((x) => x.state !== 'todo' && x.state !== 'now' && x.state !== 'stopped').length,
    total: steps.length,
    ...(currentStep(s) ? { current: currentStep(s)!.id } : {}),
    ready: over && Boolean(meta.setup),
    approved: Boolean(s.approvedAt),
    stopping: Boolean(s.stopping),
    reads: s.reads ?? [],
    quality: meta.quality ?? DEFAULT_QUALITY,
    qualityAsked: Boolean(s.qualityAt),
    tool,
    empty: Boolean(meta.scan?.empty),
  };
}

/** One line for a card or the terminal: "Getting to know the project: step 3 of 7, the Architect is reading your code". */
export function setupLine(v: SetupView): string {
  if (v.approved) return 'Set up';
  if (v.ready) return 'Your project overview is ready to check';
  const cur = v.steps.find((x) => x.id === v.current);
  if (cur?.state === 'stopped') return `Stopped at: ${cur.label.toLowerCase()}`;
  if (cur?.state === 'failed') return `${cur.label}: ${cur.error ?? 'it did not work'}`;
  const n = v.steps.findIndex((x) => x.id === v.current) + 1;
  return `Getting to know the project: step ${n} of ${v.total}${cur ? ` · ${cur.label}` : ''}`;
}

/* ── The person's moves on the setup ───────────────────── */

function requireSetup(bp: BoardPaths): BoardMeta & { setup: NonNullable<BoardMeta['setup']> } {
  const meta = readMeta(bp);
  if (!meta.setup) throw new BoardActionError('This project has no setup running. To read it again, press Read it again on the Overview.');
  return meta as BoardMeta & { setup: NonNullable<BoardMeta['setup']> };
}

/** Stop: the step running now ends, and nothing new starts until Start again. */
export function stopSetup(bp: BoardPaths): SetupView {
  const meta = requireSetup(bp);
  if (setupOver(meta.setup)) throw new BoardActionError('The setup is over: there is nothing to stop.');
  meta.setup.stopping = true;
  // Nothing runs yet: the waiting steps stop at once.
  const running = meta.setup.steps.some((x) => x.state === 'now');
  if (!running) {
    const next = currentStep(meta.setup);
    if (next) {
      next.state = 'stopped';
      next.note = 'You stopped it.';
    }
    if (next?.id === 'read' && meta.scan?.status === 'pending') meta.scan = { status: 'failed', at: now(), error: 'You stopped it. Press Start again when you are ready.' };
    delete meta.setup.stopping;
  }
  writeMeta(bp, meta);
  return setupView(bp)!;
}

/**
 * Try again or Start again, from one step: it and the steps after it run again. From the read (or the AI tool) the
 * Architect reads the whole project again, and the overview waits for approval again. A project with no setup yet
 * gets one, so Read it again on the Overview shows every step too.
 */
export function setupAgain(bp: BoardPaths, step: SetupStepId = 'read'): SetupView {
  if (!SETUP_STEPS.includes(step) || step === 'files') throw new BoardActionError(`"${step}" is not a step to run again. Use tool, read, commands, tests or app.`);
  const meta = readMeta(bp);
  const from: SetupStepId = step === 'tool' ? 'read' : step;
  if (!meta.setup) {
    if (from !== 'read') throw new BoardActionError('This project has no setup yet. Read it again first.');
    meta.setup = { kind: 'project', startedAt: now(), steps: SETUP_STEPS.map((id) => ({ id, state: id === 'files' ? 'done' : 'todo' })) };
  }
  if (meta.setup.steps.some((x) => x.state === 'now')) throw new BoardActionError('A step is still running. Wait for it, or press Stop first.');
  resetFrom(meta.setup, from);
  if (from === 'read') {
    // The AI tool is looked at again too: it may be installed now.
    stepOf(meta.setup, 'tool').state = 'todo';
    meta.scan = { status: 'pending' };
    if (meta.engine === 'live') dropSetupCopies(bp);
  }
  writeMeta(bp, meta);
  return setupView(bp)!;
}

/** The Quality question, asked once during the setup. The same setting as `squad config set quality`. */
export function setupQuality(bp: BoardPaths, value: string): SetupView | null {
  const q = parseQuality(value);
  if (!q) throw new BoardActionError(`"${value}" is not a Quality setting. Use best, balanced or thrifty.`);
  const meta = readMeta(bp);
  meta.quality = q;
  if (meta.setup) meta.setup.qualityAt = now();
  writeMeta(bp, meta);
  return setupView(bp);
}

/* ── The overview ──────────────────────────────────────── */

export type Handover = 'reading' | 'ready' | 'approved' | 'none';

export interface OverviewView {
  project: string;
  engine: BoardMeta['engine'];
  user: string;
  summary?: string;
  readAt?: string;
  refreshedAt?: string;
  users?: string;
  can: string[];
  worth: string[];
  ideas: TicketIdea[];
  parts: CodePart[];
  links: PartLink[];
  /** The project map, for a project read before overviews existed. */
  map: BoardMeta['map'];
  rules: { id: string; title: string; chosen: string; why: string; proposed: boolean; fromScan: boolean }[];
  /** Rules found by the read and not approved yet. */
  proposed: number;
  proof?: SetupProof;
  /** reading: the setup still runs; ready: it waits for the person; approved: it is the project's home. */
  handover: Handover;
  approved?: { by: string; at: string };
  /** Tickets merged since the read: what the project can do now that it could not then. */
  since: { id: string; title: string; at: string }[];
  setup?: { done: number; total: number; line: string };
  talk?: OverviewTalk;
  empty: boolean;
  /** Read by an older squad-kit: who uses it, what it can do and the rest come with the next read. */
  old: boolean;
  /** The terminal command for this page. */
  command: string;
}

function mergedAt(t: Ticket): string | undefined {
  if (t.mergedAt) return t.mergedAt;
  // The sample squad merges nothing: an accepted or released ticket stands in.
  return t.stage === 'release' || t.stage === 'done' ? (t.activity[0]?.at ?? t.createdAt) : undefined;
}

export function overviewView(bp: BoardPaths): OverviewView {
  const meta = readMeta(bp);
  const o = readOverview(bp);
  // In the order they were found and made: STACK.1 before STACK.2.
  const num = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  const decisions = listDecisions(bp)
    .filter((d) => !d.replacedBy)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || num(a.id) - num(b.id));
  // The rules the read found first, then the ones tickets made.
  const rules = [...decisions.filter((d) => d.from === 'Project scan'), ...decisions.filter((d) => d.from !== 'Project scan')].map((d) => ({
    id: d.id,
    title: d.title,
    chosen: d.chosen,
    why: d.why,
    proposed: Boolean(d.proposed),
    fromScan: d.from === 'Project scan',
  }));
  const proposed = rules.filter((r) => r.proposed).length;
  const sv = setupView(bp);
  const s = meta.setup;
  const handover: Handover =
    s && !s.approvedAt ? (setupOver(s) ? 'ready' : 'reading') : proposed ? 'ready' : o.approved || s?.approvedAt ? 'approved' : sv ? 'reading' : 'none';
  const readAt = o.readAt ?? meta.scan?.at;
  const since = listTickets(bp)
    .map((t) => ({ id: t.id, title: t.title, at: mergedAt(t) }))
    .filter((x): x is { id: string; title: string; at: string } => Boolean(x.at) && (!readAt || x.at! > readAt))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);
  const talk = readTalk(bp);
  return {
    project: meta.project,
    engine: meta.engine,
    user: meta.user.name,
    ...(meta.scan?.summary ? { summary: meta.scan.summary } : {}),
    ...(readAt ? { readAt } : {}),
    ...(o.refreshedAt ? { refreshedAt: o.refreshedAt } : {}),
    ...(o.users ? { users: o.users } : {}),
    can: o.can,
    worth: o.worth,
    ideas: o.ideas,
    parts: o.parts,
    links: o.links,
    map: meta.map,
    rules,
    proposed,
    ...(s?.proof ? { proof: s.proof } : {}),
    handover,
    ...(o.approved ? { approved: o.approved } : s?.approvedAt ? { approved: { by: meta.user.name, at: s.approvedAt } } : {}),
    since,
    ...(sv && !sv.ready && !sv.approved ? { setup: { done: sv.done, total: sv.total, line: setupLine(sv) } } : {}),
    ...(talk ? { talk } : {}),
    empty: Boolean(meta.scan?.empty),
    old: !fs.existsSync(path.join(bp.knowledgeDir, 'overview.md')) && meta.scan?.status === 'done',
    command: 'squad overview',
  };
}

/**
 * "Looks right, start working": the rules the read found become the rules every agent follows, approved by the
 * person, and the overview becomes the project's home. squad-kit's copies for the setup go.
 */
export function approveOverview(bp: BoardPaths): OverviewView {
  const meta = readMeta(bp);
  if (meta.setup && !meta.setup.approvedAt && !setupOver(meta.setup)) {
    throw new BoardActionError('squad-kit is still getting to know the project. Approve it once the overview is ready.');
  }
  const by = meta.user.name;
  const at = now();
  for (const d of listDecisions(bp).filter((x) => x.proposed)) {
    const { proposed: _p, ...rule } = d;
    writeDecision(bp, { ...rule, approvedBy: by, date: at } as Decision);
  }
  writeOverview(bp, { ...readOverview(bp), approved: { by, at } });
  if (meta.setup) {
    meta.setup.approvedAt = at;
    writeMeta(bp, meta);
  }
  const talk = readTalk(bp);
  if (talk?.open) writeTalk(bp, { ...talk, open: false, thinking: false });
  if (meta.engine === 'live') dropSetupCopies(bp);
  return overviewView(bp);
}

/** One of the three ticket ideas becomes a ticket, with one click. Pressed again, it gives the same ticket. */
export function ticketFromIdea(bp: BoardPaths, n: number): Ticket {
  const o = readOverview(bp);
  const idea = o.ideas[n - 1];
  if (!idea) throw new BoardActionError(`There is no idea ${n}. The overview has ${o.ideas.length}.`);
  const made = idea.ticket ? readTicket(bp, idea.ticket) : null;
  if (made) return made;
  const t = createTicket(bp, { title: idea.title, ask: idea.why ? `${idea.title}.\n\n${idea.why}` : idea.title });
  writeOverview(bp, { ...readOverview(bp), ideas: o.ideas.map((x, i) => (i === n - 1 ? { ...x, ticket: t.id } : x)) });
  return t;
}

/* ── Something is wrong: a talk with the Architect ─────── */

function talkFile(bp: BoardPaths): string {
  return path.join(bp.localDir, 'overview-talk.json');
}

export function readTalk(bp: BoardPaths): OverviewTalk | null {
  try {
    const t = JSON.parse(fs.readFileSync(talkFile(bp), 'utf8')) as OverviewTalk;
    return Array.isArray(t.messages) ? t : null;
  } catch {
    return null;
  }
}

export function writeTalk(bp: BoardPaths, t: OverviewTalk): void {
  fs.mkdirSync(path.dirname(talkFile(bp)), { recursive: true });
  const tmp = `${talkFile(bp)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(t, null, 1)}\n`);
  fs.renameSync(tmp, talkFile(bp));
}

/** "Something is wrong": the talk opens, and the Architect asks what it got wrong. Your first words may come with it. */
export function startTalk(bp: BoardPaths, text?: string): OverviewTalk {
  const was = readTalk(bp);
  const t: OverviewTalk = was?.open ? was : { open: true, thinking: true, messages: was?.messages ?? [] };
  if (text?.trim()) return sendTalk(bp, text, t);
  writeTalk(bp, t);
  return t;
}

export function sendTalk(bp: BoardPaths, text: string, open?: OverviewTalk): OverviewTalk {
  const msg = text.trim();
  if (!msg) throw new BoardActionError('Write what is wrong first.');
  const t = open ?? readTalk(bp);
  if (!t?.open) throw new BoardActionError('Open the talk first: press Something is wrong.');
  if (t.thinking && t.messages.length) throw new BoardActionError('The Architect is still answering. Wait a moment.');
  const next: OverviewTalk = { ...t, open: true, thinking: true, messages: [...t.messages, { who: 'you', text: msg, at: now() }] };
  delete next.stopping;
  writeTalk(bp, next);
  return next;
}

/** Stop on the Architect's answer: the talk stays open. */
export function stopTalk(bp: BoardPaths): OverviewTalk {
  const t = readTalk(bp);
  if (!t?.open) throw new BoardActionError('There is no talk open.');
  const next = { ...t, stopping: true };
  writeTalk(bp, next);
  return next;
}

export function closeTalk(bp: BoardPaths): OverviewTalk | null {
  const t = readTalk(bp);
  if (!t) return null;
  const next = { ...t, open: false, thinking: false };
  writeTalk(bp, next);
  return next;
}

/** What the person said in the talk, for the next read. */
export function corrections(t: OverviewTalk | null): string {
  return (t?.messages ?? [])
    .filter((m) => m.who === 'you')
    .map((m) => `- ${m.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

/** "Read it again with this": the Architect reads the whole project again, with what the person said. */
export function readAgainWithTalk(bp: BoardPaths): SetupView {
  const t = readTalk(bp);
  if (!t?.messages.some((m) => m.who === 'you')) throw new BoardActionError('Tell the Architect what is wrong first.');
  if (t.thinking) throw new BoardActionError('The Architect is still answering. Wait a moment.');
  writeTalk(bp, { ...t, open: false, thinking: false, reread: true });
  return setupAgain(bp, 'read');
}

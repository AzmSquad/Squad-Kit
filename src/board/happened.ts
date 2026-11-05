import path from 'node:path';
import { readConversation, type Conversation } from '../engine/conversations.js';
import type { BoardPaths } from './store.js';
import type { Activity, AgentName, StepRun, Ticket, TicketSessions, TimedStep } from './types.js';
import { WHO } from './clock.js';

/**
 * "What happened" on a ticket, step by step: one card per step with its time, a line on what it did and what it handed
 * in, drawn as the real thing (the questions, the spec, the design, the changed files, the verdict, the screenshots).
 * Built from what the engine keeps already: the steps' history on the ticket, its activity, its state now and the
 * saved conversations. Steps from before the history was kept come from the activity, without their time.
 */

export type HandedIn =
  | { kind: 'questions'; items: { from: 'analyst' | 'architect'; text: string; answer?: string }[] }
  | { kind: 'spec'; story?: string; criteria: string[] }
  | { kind: 'design'; title?: string; chosen?: string; steps: string[]; mockup: boolean; follows: string[]; adr?: string }
  | { kind: 'files'; added: string[]; changed: string[]; removed: string[]; steps: string[] }
  | { kind: 'checks'; ok: boolean; text: string }
  | { kind: 'verdict'; approved: boolean; notes: string[] }
  | { kind: 'shots'; shots: { criterion: string; file: string }[] };

export type SessionKey = keyof TicketSessions;

export interface HappenedStep {
  who: AgentName | 'squad';
  step: TimedStep;
  /** "Analyst · Questions". */
  name: string;
  from?: string;
  /** When it ended; a running step has none. */
  to?: string;
  seconds?: number;
  running?: boolean;
  /** One line: what it did. */
  summary: string;
  /** Only on the latest run of each kind of step: earlier runs were replaced by it. */
  handedIn?: HandedIn;
  /** The tab that shows what it handed in, in full. */
  tab?: 'plan' | 'changes' | 'proof';
  /** Short notes beside the time: "you approved", "a second, separate session". */
  notes: string[];
  /** The conversation behind it, for the Full log. */
  session?: SessionKey;
  /** What the agent did in its conversation in this step: its tool calls, and the ones squad-kit did not allow. */
  actions?: number;
  skipped?: number;
}

export interface Happened {
  steps: HappenedStep[];
  /** The squad's own time, every step added up. */
  seconds: number;
}

const STEP_NAME: Record<TimedStep, string> = {
  questions: 'Questions',
  spec: 'Spec',
  design: 'Design',
  build: 'Build',
  fix: 'Fixes',
  checks: 'Checks',
  review: 'Review',
  proof: 'Proof',
};

const SESSION: Record<TimedStep, SessionKey | undefined> = {
  questions: 'intake',
  spec: 'intake',
  design: 'intake',
  build: 'build',
  fix: 'build',
  checks: undefined,
  review: 'review',
  proof: 'tester',
};

/** The activity line each step writes when it ends well, in the live squad and the sample one. */
const ENDS: { step: TimedStep; who: AgentName | 'squad'; by: Activity['who'][]; re: RegExp }[] = [
  { step: 'questions', who: 'analyst', by: ['analyst'], re: /^Asked \d+ questions?$/ },
  { step: 'spec', who: 'analyst', by: ['analyst'], re: /^(Wrote|Updated) the spec\b/ },
  { step: 'design', who: 'architect', by: ['architect', 'spec'], re: /^(Wrote|Updated) the (design|plan)\b/ },
  { step: 'build', who: 'builder', by: ['builder'], re: /^Finished all steps$/ },
  { step: 'fix', who: 'builder', by: ['builder'], re: /^Fixed (the|what)\b/ },
  { step: 'checks', who: 'squad', by: ['tester'], re: /^(All (\d+ )?checks pass|Checks failed|Checks still fail|No test, lint or build commands)/ },
  { step: 'review', who: 'reviewer', by: ['reviewer'], re: /^(Approved\b|Asked for \d+ fix|Still asks for)/ },
  { step: 'proof', who: 'tester', by: ['tester'], re: /^(Saved \d+ screenshots?|No screenshots were taken|No screens to show|No screens change)/ },
];

/** What the person did after a step, shown beside it. */
const AFTER: Partial<Record<TimedStep, { re: RegExp; who: Activity['who'][]; note: string }[]>> = {
  questions: [{ re: /^Answered \d+ questions/, who: ['you'], note: 'you answered' }],
  spec: [{ re: /^Approved the spec/, who: ['you'], note: 'you approved' }],
  design: [
    { re: /^Approved the (design|plan)/, who: ['you'], note: 'you approved' },
    { re: /^Express track: approved the plan on its own/, who: ['squad'], note: 'approved on its own (Express track)' },
    { re: /^Builds by itself: approved the plan on its own/, who: ['squad'], note: 'approved on its own (Builds by itself)' },
  ],
  proof: [
    { re: /^Checked the proof\. Looks right/, who: ['you'], note: 'you checked it: Looks right' },
    { re: /^(.+ passed: a|A)ccepted by itself/, who: ['squad'], note: 'accepted by itself' },
  ],
};

/** Lines the watcher writes for tool calls, and squad-kit's own notes: never a step's summary. */
const TOOLISH = /^(Reading|Running|Editing|Writing|Looking|Searching|Listing|Runs on|Asked|Started|Finished|squad-kit|The answer was not complete)\b/;

/** How agents say a call was not allowed (the same rule as the board's Full log). */
const REFUSED = /User refused permission to run tool|^Permission denied: |haven't granted it yet/i;

const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);

interface Run {
  who: AgentName | 'squad';
  step: TimedStep;
  from?: string;
  to: string;
  /** The activity line that marks its end, when known. */
  line?: Activity;
}

/** Activity oldest first. */
function oldestFirst(t: Ticket): Activity[] {
  return [...t.activity].sort((a, b) => a.at.localeCompare(b.at));
}

/** The steps that ran: the history, and before it the steps the activity says ended. */
function runsOf(t: Ticket, log: Activity[]): Run[] {
  const history: StepRun[] = t.history ?? [];
  const first = history.length ? ms(history[0]!.from) : Infinity;
  const fromLog: Run[] = [];
  for (const a of log) {
    if (ms(a.at) >= first) break;
    const end = ENDS.find((e) => e.by.includes(a.who) && e.re.test(a.text));
    if (end) fromLog.push({ who: end.who, step: end.step, to: a.at, line: a });
  }
  const timed: Run[] = history.map((h) => ({ ...h, line: endLine(log, h) }));
  return [...fromLog, ...timed];
}

/** The line a step wrote as it ended: the first of its kind from its start to a minute after its end. */
function endLine(log: Activity[], h: Pick<StepRun, 'step' | 'from' | 'to'>): Activity | undefined {
  const end = ENDS.find((e) => e.step === h.step)!;
  const lo = ms(h.from) - 1000;
  const hi = ms(h.to) + 60_000;
  return log.find((a) => ms(a.at) >= lo && ms(a.at) <= hi && end.by.includes(a.who) && end.re.test(a.text));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The Analyst's own summary of what it read, written just before its questions. */
function analystSummary(log: Activity[], run: Run): string | undefined {
  const end = ms(run.line?.at ?? run.to);
  const near = log.filter((a) => a.who === 'analyst' && Math.abs(ms(a.at) - end) <= 5000 && a !== run.line && !TOOLISH.test(a.text));
  return near.at(-1)?.text;
}

function summaryOf(t: Ticket, run: Run, log: Activity[]): string {
  const line = run.line?.text ?? '';
  switch (run.step) {
    case 'questions': {
      const n = t.questions?.length ?? Number(/^Asked (\d+)/.exec(line)?.[1] ?? 0);
      const read = analystSummary(log, run);
      const asked = n ? `asked you ${plural(n, 'question')}` : 'had no questions';
      return read ? `${read.replace(/\.?$/, '.')} Then ${asked}.` : `Read the ticket and ${asked}.`;
    }
    case 'spec': {
      if (/^Updated the spec: /.test(line)) return line.replace(/\.?$/, '.');
      const answers = (t.questions ?? []).filter((q) => q.answer).length;
      const points = t.criteria?.length ?? 0;
      const fromWhat = /from your talk/.test(line) ? ' from your talk' : answers ? ` from your ${plural(answers, 'answer')}` : '';
      return `Wrote the spec${fromWhat}${points ? `, with ${plural(points, '"done when" point')}` : ''}.`;
    }
    case 'design': {
      if (/^Updated the (design|plan): /.test(line)) return line.replace(/\.?$/, '.');
      const steps = t.steps?.length ?? 0;
      const chosen = t.decision?.options.find((o) => o.chosen)?.name;
      // "Chose a search box", not "Chose A search box"; names like "Angular Material" keep their capital.
      const said = chosen?.replace(/^(A|An|The|One|Its|Their|Our|Your)\b/, (w) => w.toLowerCase());
      const parts = [said ? `Chose ${said}` : 'Wrote the design', steps ? `planned ${plural(steps, 'step')} to build` : '', t.mockup ? 'made a mockup' : ''].filter(Boolean);
      return `${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}.`;
    }
    case 'build': {
      const steps = t.steps?.length ?? 0;
      return steps ? `Did the ${plural(steps, 'step')} of the design.` : 'Built the change.';
    }
    case 'fix':
      return line ? line.replace(/\.?$/, '.') : 'Fixed what the checks or the review found.';
    case 'checks':
      if (/^All/.test(line)) return `squad-kit ran the project's checks: ${line.replace(/^All /, 'all ').replace(/\.?$/, '.')}`;
      return line ? `squad-kit ran the project's checks. ${line.replace(/\.?$/, '.')}` : "squad-kit ran the project's checks.";
    case 'review':
      if (/^Approved: /.test(line)) return line.replace(/\.?$/, '.');
      if (/^Approved/.test(line)) return 'Approved the changes.';
      return line ? `${line.split(':')[0]}.` : 'Read the changes.';
    case 'proof': {
      const n = t.proof?.length ?? 0;
      const pictures = (t.proof ?? []).reduce((sum, p) => sum + 1 + (p.more?.length ?? 0), 0);
      if (pictures > n) return `Opened the app and took ${plural(pictures, 'screenshot')} of the ${plural(n, '"done when" point')} it could show.`;
      if (n) return `Opened the app and took ${plural(n, 'screenshot')}, one for each "done when" point it could show.`;
      return line ? line.replace(/\.?$/, '.') : 'Checked the change.';
    }
  }
}

function filesFrom(conv: Conversation | null, cwd: string | undefined, from?: string, to?: string): { added: string[]; changed: string[] } {
  const added = new Set<string>();
  const changed = new Set<string>();
  if (!conv) return { added: [], changed: [] };
  const lo = ms(from);
  const hi = ms(to);
  const rel = (p: string) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : path.basename(p));
  for (const e of conv.updates) {
    const at = ms(e.at);
    if (Number.isFinite(lo) && Number.isFinite(at) && (at < lo || at > hi)) continue;
    const u = e.update as { sessionUpdate: string; content?: { type: string; path?: string; oldText?: string | null }[] | null };
    if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') continue;
    for (const c of u.content ?? []) {
      if (c.type !== 'diff' || !c.path) continue;
      const p = rel(c.path);
      if (c.oldText == null && !changed.has(p)) added.add(p);
      else if (!added.has(p)) changed.add(p);
    }
  }
  return { added: [...added], changed: [...changed] };
}

function handedIn(t: Ticket, run: Run, files: FileList | null, conv: Conversation | null): HandedIn | undefined {
  switch (run.step) {
    case 'questions':
      return t.questions?.length
        ? { kind: 'questions', items: t.questions.map((q) => ({ from: q.from, text: q.text, ...(q.answer ? { answer: q.answer.value ? `${q.answer.choice.replace(/:$/, '')}: ${q.answer.value}` : q.answer.choice } : {}) })) }
        : undefined;
    case 'spec':
      return t.story || t.criteria?.length ? { kind: 'spec', ...(t.story ? { story: t.story } : {}), criteria: (t.criteria ?? []).map((c) => c.then) } : undefined;
    case 'design': {
      if (!t.decision && !t.steps?.length) return undefined;
      const chosen = t.decision?.options.find((o) => o.chosen)?.name;
      return {
        kind: 'design',
        ...(t.decision ? { title: t.decision.title } : {}),
        ...(chosen ? { chosen } : {}),
        ...(t.decision?.adr ? { adr: t.decision.adr } : {}),
        steps: (t.steps ?? []).map((s) => s.title),
        mockup: Boolean(t.mockup),
        follows: t.follows ?? [],
      };
    }
    case 'build':
    case 'fix': {
      const mine = run.step === 'fix' || !files ? filesFrom(conv, conv?.cwd, run.from, run.to) : null;
      const got = mine ? { ...mine, removed: [] as string[] } : files!;
      const steps = run.step === 'build' ? (t.steps ?? []).filter((s) => s.status === 'done').map((s) => s.title) : [];
      if (!got.added.length && !got.changed.length && !got.removed.length && !steps.length) return undefined;
      return { kind: 'files', added: got.added, changed: got.changed, removed: got.removed, steps };
    }
    case 'checks':
      return t.gates?.checks && t.gates.checks !== 'pending'
        ? { kind: 'checks', ok: t.gates.checks === 'pass' || t.gates.checks === 'skipped', text: t.gates.checksText ?? (t.gates.checks === 'pass' ? 'All checks pass' : 'Some checks failed') }
        : undefined;
    case 'review': {
      const line = run.line?.text ?? '';
      const approved = /^Approved/.test(line) || (!line && t.gates?.review === 'pass');
      const notes = approved ? [] : (t.reviewNotes?.length ? t.reviewNotes : line.includes(': ') ? [line.slice(line.indexOf(': ') + 2)] : []);
      return { kind: 'verdict', approved, notes };
    }
    case 'proof':
      return t.proof?.length ? { kind: 'shots', shots: t.proof.flatMap((p) => [p.after, ...(p.more ?? []).map((m) => m.after)].map((file) => ({ criterion: p.criterion, file }))) } : undefined;
  }
}

const TAB: Partial<Record<TimedStep, HappenedStep['tab']>> = { spec: 'plan', design: 'plan', build: 'changes', fix: 'changes', checks: 'proof', proof: 'proof' };

/** The files the ticket changed against its base, from its copy or its branch. */
export interface FileList {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface HappenedSources {
  /** The ticket's changed files (git), when it has a copy or a branch. */
  files?: () => FileList | null;
  /** A saved conversation by its session id. */
  conversation?: (sessionId: string) => Conversation | null;
  now?: number;
}

function counts(conv: Conversation | null, from?: string, to?: string): { actions: number; skipped: number } | null {
  if (!conv || !from) return null;
  const lo = ms(from);
  const hi = to ? ms(to) : Infinity;
  const inside = (at?: string) => {
    const x = ms(at);
    return Number.isFinite(x) && x >= lo - 1000 && x <= hi + 1000;
  };
  let actions = 0;
  let skipped = 0;
  for (const e of conv.updates) {
    if (!inside(e.at)) continue;
    const u = e.update as { sessionUpdate: string; status?: string | null; content?: { type: string; content?: { type: string; text?: string } }[] | null };
    if (u.sessionUpdate === 'tool_call') actions += 1;
    if (u.sessionUpdate === 'tool_call_update' && u.status === 'failed' && (u.content ?? []).some((c) => c.type === 'content' && c.content?.type === 'text' && REFUSED.test(c.content.text ?? ''))) skipped += 1;
  }
  return { actions, skipped };
}

/** The cards of "What happened", oldest first, with the step running now last. */
export function whatHappened(bp: BoardPaths, t: Ticket, src: HappenedSources = {}): Happened {
  const now = src.now ?? Date.now();
  const log = oldestFirst(t);
  const runs = runsOf(t, log);
  const read = src.conversation ?? ((id: string) => readConversation(id, 3000, undefined, bp.chatsDir));
  const convs = new Map<string, Conversation | null>();
  const conv = (key: SessionKey | undefined) => {
    const id = key ? t.sessions?.[key] : undefined;
    if (!id) return null;
    if (!convs.has(id)) {
      try {
        convs.set(id, read(id));
      } catch {
        convs.set(id, null);
      }
    }
    return convs.get(id) ?? null;
  };
  let files: FileList | null | undefined;
  const ticketFiles = () => {
    if (files === undefined) {
      try {
        files = src.files?.() ?? null;
      } catch {
        files = null;
      }
      if (files && !files.added.length && !files.changed.length && !files.removed.length) files = null;
    }
    return files;
  };
  const latest = new Map<TimedStep, number>();
  runs.forEach((r, i) => latest.set(r.step, i));
  const reviews = runs.filter((r) => r.step === 'review').length;

  const steps: HappenedStep[] = runs.map((run, i) => {
    const next = runs[i + 1];
    const session = SESSION[run.step];
    const c = conv(session);
    const isLatest = latest.get(run.step) === i;
    const seconds = run.from ? Math.max(0, (ms(run.to) - ms(run.from)) / 1000) : undefined;
    const notes: string[] = [];
    // What the person did after it, before the squad's next step.
    const until = next ? ms(next.from ?? next.to) : Infinity;
    for (const a of AFTER[run.step] ?? []) {
      if (log.some((l) => a.who.includes(l.who) && a.re.test(l.text) && ms(l.at) >= ms(run.to) - 1000 && ms(l.at) <= until)) notes.push(a.note);
    }
    if (run.step === 'review') {
      notes.push(reviews > 1 ? `round ${runs.slice(0, i + 1).filter((r) => r.step === 'review').length} of ${reviews}, a fresh session` : 'a second, separate session');
    }
    const got = isLatest ? handedIn(t, run, run.step === 'build' ? ticketFiles() : null, c) : undefined;
    const changed = got?.kind === 'files' ? got.added.length + got.changed.length + got.removed.length : 0;
    const n = counts(c, run.from, run.to);
    const tab = TAB[run.step];
    return {
      who: run.who,
      step: run.step,
      name: `${WHO[run.who]} · ${STEP_NAME[run.step]}`,
      ...(run.from ? { from: run.from } : {}),
      to: run.to,
      ...(seconds !== undefined ? { seconds } : {}),
      summary: run.step === 'build' && changed ? summaryOf(t, run, log).replace(/\.$/, ` and changed ${plural(changed, 'file')}.`) : summaryOf(t, run, log),
      ...(got ? { handedIn: got } : {}),
      ...(got && tab ? { tab } : {}),
      notes,
      ...(session && t.sessions?.[session] ? { session } : {}),
      ...(n ? { actions: n.actions, skipped: n.skipped } : {}),
    };
  });

  const ck = t.clock;
  if (ck && !t.waiting) {
    const from = ck.began ?? ck.since;
    const session = SESSION[ck.step];
    const n = counts(conv(session), from);
    const part = ck.step === 'build' && ck.part && t.steps?.length ? ` Step ${ck.part} of ${t.steps.length}.` : '';
    steps.push({
      who: ck.who,
      step: ck.step,
      name: `${WHO[ck.who]} · ${STEP_NAME[ck.step]}`,
      from,
      seconds: Math.max(0, (now - ms(from)) / 1000),
      running: true,
      summary: `${(ck.doing ?? t.status) || 'Working on it'}${ck.doing ? '.' : ''}${part}`.replace(/\.\./g, '.'),
      notes: [],
      ...(session && t.sessions?.[session] ? { session } : {}),
      ...(n ? { actions: n.actions, skipped: n.skipped } : {}),
    });
  }
  return { steps, seconds: steps.reduce((s, x) => s + (x.seconds ?? 0), 0) };
}

import { changesScreens } from './outside-step.js';
import type { AgentName, QuietPort, Stage, StepClock, Ticket, TimedStep, WaitingKind } from './types.js';
import { WHO, stepSeconds } from './clock.js';
import { durationWords, middle, minutesWords, rangeWords, usualOf, usualWords, type Usual, type UsualBook } from './usual.js';

/**
 * What is happening on a ticket right now, in plain words, worked out from the ticket's own record and the project's
 * usual times. The board's card, the Now tab, `squad show` and the Ask box all say the same thing from this.
 */

/**
 * working: an agent or a check runs. queued: ready, waiting for a free place. you: waiting for the person. stopping:
 * Stop was pressed. idle: nothing runs and nothing waits. ready: accepted, goes out with a release. done: released.
 */
export type NowState = 'working' | 'queued' | 'you' | 'stopping' | 'idle' | 'ready' | 'done';

export interface SlowCard {
  kind: 'long' | 'stuck';
  title: string;
  /** "RO-7 · step 4 of 6". */
  where: string;
  text: string;
  facts: { label: string; value: string }[];
  /** What happens at the hard limit. */
  limit?: string;
  /** The command it waits on can be ended. */
  canEnd: boolean;
  /** A program squad-kit started holds up the app: "Stop it and try again" stops it, after a confirm. */
  freePort?: { port: number; what: string };
  /** The command, the port and the process, for engineers. */
  detail?: string;
}

/** "your app shop", or what squad-kit started. The program and its process are for engineers (portDetail). */
function portHolder(p: QuietPort): string {
  return p.app ? `your app ${p.app}` : 'a program squad-kit started earlier';
}

/** The card's line about what holds the app up, in plain words; for a program of the person's own, what to do. */
export function portWords(p: QuietPort): string {
  if (p.ours) return `${upperFirst(portHolder(p))} is in the way, so the app does not answer.`;
  return 'Another program on this computer is in the way, so the app does not answer. squad-kit leaves it alone. Close that program, then press Stop and try again.';
}

/** The same, for engineers: the port, the program and its process. */
export function portDetail(p: QuietPort): string {
  return `${p.program || 'A program'}${p.pid ? ` (process ${p.pid})` : ''} listens on port ${p.port}, the port in the app's address${p.app ? `: your app ${p.app}, which squad-kit runs from Your apps` : p.ours ? ', and squad-kit started it' : ''}.`;
}

/** The port's line and action, for the card. */
function portParts(q: NonNullable<Ticket['quiet']>): Pick<SlowCard, 'freePort'> & { fact?: SlowCard['facts'][number] } {
  if (!q.port) return {};
  return { fact: { label: 'What is in the way', value: portWords(q.port) }, ...(q.port.ours ? { freePort: { port: q.port.port, what: portHolder(q.port) } } : {}) };
}

/** What a quiet step waits on, for engineers: the command and its process, and what holds the app's port. */
function slowDetail(q: NonNullable<Ticket['quiet']>): string | undefined {
  const lines = [q.command ? `Waiting on: ${q.command}${q.pid ? ` (process ${q.pid})` : ''}` : '', q.port ? portDetail(q.port) : ''].filter(Boolean);
  return lines.length ? lines.join('\n') : undefined;
}

export interface LiveNow {
  state: NowState;
  /** Who works now: "Builder", "squad-kit". */
  who?: string;
  role?: AgentName | 'squad';
  step?: TimedStep;
  /** The Builder's plan step. */
  part?: { n: number; of: number };
  /** The latest action, short: "editing booking.tsx". */
  doing?: string;
  /** The card's first line: "Builder · step 3 of 6 · editing booking.tsx". */
  line: string;
  /** The card's second line: "2 min · usually 2 to 4 min". */
  time?: string;
  /** The step bar under the card. */
  bar?: ('done' | 'now' | 'todo')[];
  /** One plain sentence of what is happening. */
  sentence: string;
  /** "Step 3 of 6 · 2 min so far · this step usually takes 2 to 4 min". */
  detail?: string;
  /** What comes next, and when the ticket needs the person. */
  next?: string;
  /** What comes next on its own, without when. */
  then?: string;
  since?: string;
  seconds?: number;
  usual?: Usual;
  /** The step's last progress. */
  lastAt?: string;
  /** About how long until the ticket needs the person, in seconds, and for what. */
  readyIn?: { seconds: number; what: string };
  /** What the tracker says under each stage: how long a finished one took, "now · 2 min", "about 2 min". */
  stages: { stage: Stage; note: string }[];
  /** When a note sent now is read. */
  noteWhen: string;
  /** The "Taking longer than usual" or "Looks stuck" card. */
  slow?: SlowCard;
}

/** Said on the card and the Now tab while a step carries on after a restart, until its first new action. */
export const RESUMED = 'resumed after a restart';

/** The queued card: "Next in line: starts when a slot is free (2 of 2 busy)". */
export const QUEUED = 'Next in line';

export function queuedLine(busy: number, limit: number): string {
  return `${QUEUED}: starts when a slot is free (${busy} of ${limit} busy)`;
}

const TRACK: Stage[] = ['tickets', 'specs', 'implement', 'test', 'review', 'release'];

/** The person's part when a ticket waits, for "after you …". */
export const YOUR_PART: Record<WaitingKind, string> = {
  questions: 'answer the questions',
  spec: 'approve the spec',
  plan: 'approve the design',
  proof: 'check the proof',
  stuck: 'pick a way out',
  release: 'release it',
  ask: 'answer the question',
  yours: 'give it back',
  chat: 'finish the talk',
  change: 'decide on the design update',
  depends: 'choose how to build it',
};

function lowerFirst(s: string): string {
  // A ticket name or an abbreviation keeps its capitals: "SK-152 needs SK-146", "PDF".
  return /^[A-Z][A-Z0-9]+\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A tool line, short for a card: paths become file names, "Editing" becomes "editing". */
export function shortDoing(line: string): string {
  const s = line.replace(/(?:[\w.@~-]*\/)+([\w.@-]+)/g, '$1').replace(/\s+/g, ' ').trim();
  return lowerFirst(s.length > 56 ? `${s.slice(0, 55)}…` : s);
}

function stateOf(t: Ticket): NowState {
  if (t.stage === 'done') return 'done';
  if (t.waiting || t.takenOver) return 'you';
  if (t.stopRequested) return 'stopping';
  if (t.status.startsWith(QUEUED)) return 'queued';
  if (t.stage === 'release') return 'ready';
  if (t.squad || t.live) return 'working';
  return 'idle';
}

/** No clock on the ticket (a step from before clocks, or the sample board's own squad): the stage and the line say who. */
function guessClock(t: Ticket): Omit<StepClock, 'since'> {
  const s = t.status;
  const doing = t.steps?.findIndex((x) => x.status === 'doing') ?? -1;
  switch (t.stage) {
    case 'tickets':
    case 'bugs':
      return { who: 'analyst', step: 'questions' };
    case 'specs':
      return /^Analyst/.test(s) || (t.track !== 'express' && !t.specApproved) ? { who: 'analyst', step: 'spec' } : { who: 'architect', step: 'design' };
    case 'implement':
      return doing >= 0 ? { who: 'builder', step: 'build', part: doing + 1 } : { who: 'builder', step: /fix/i.test(s) ? 'fix' : 'build' };
    case 'test':
      return /Tester|screen|screenshot/i.test(s) ? { who: 'tester', step: 'proof' } : /Builder/.test(s) ? { who: 'builder', step: 'fix' } : { who: 'squad', step: 'checks' };
    default:
      return /Builder/.test(s) ? { who: 'builder', step: 'fix' } : /Tester|proof|screen/i.test(s) ? { who: 'tester', step: 'proof' } : { who: 'reviewer', step: 'review' };
  }
}

const SENTENCE: Record<TimedStep, (t: Ticket) => string> = {
  questions: () => 'The Analyst is reading the ticket to see what it needs to ask you.',
  spec: (t) => (t.questions?.some((q) => q.answer) ? 'The Analyst is writing the spec from your answers.' : 'The Analyst is writing the spec: the story and the "done when" list.'),
  design: (t) =>
    t.track === 'express'
      ? 'The Architect is writing the plan.'
      : t.track === 'auto'
        ? 'The Architect is reading the part of the BRD and the code, and writing the design.'
        : 'The Architect is choosing how to build it and writing the design.',
  build: () => 'The Builder is writing the code.',
  fix: () => 'The Builder is fixing what the checks or the Reviewer found.',
  checks: () => "squad-kit is running the project's own checks, so the squad never grades its own work.",
  review: () => 'The Reviewer, a fresh agent, is reading the changes.',
  proof: () => 'The Tester is opening the app and taking a screenshot for each "done when".',
};

function screens(t: Ticket): boolean {
  return changesScreens(t);
}

/** Builds by itself: what it needs from the person at the end of the steps. Nothing: it merges by itself. */
export const MERGES_BY_ITSELF = 'nothing: it is accepted and merged by itself';

/** The steps still to come after this one before the ticket needs the person, and what it then needs them for. */
function ahead(t: Ticket, step: TimedStep, part?: { n: number; of: number }): { steps: TimedStep[]; builds: number; what: string } {
  const after = ['review', ...(screens(t) ? ['proof' as const] : [])] as TimedStep[];
  const proof = { what: t.track === 'auto' ? MERGES_BY_ITSELF : 'check the proof' };
  switch (step) {
    case 'questions':
      return { steps: [], builds: 0, what: 'answer its questions, or approve the spec' };
    case 'spec':
      return { steps: [], builds: 0, what: 'approve the spec' };
    case 'design':
      if (t.track !== 'express' && t.track !== 'auto') return { steps: [], builds: 0, what: 'approve the design' };
      return { steps: ['checks', ...after], builds: t.work?.steps ?? t.steps?.length ?? 0, ...proof };
    case 'build':
      return { steps: ['checks', ...after], builds: part ? part.of - part.n : 0, ...proof };
    case 'fix':
      return { steps: ['checks', ...after], builds: 0, ...proof };
    case 'checks':
      return { steps: after, builds: 0, ...proof };
    case 'review':
      return { steps: screens(t) ? ['proof'] : [], builds: 0, ...proof };
    case 'proof':
      return { steps: [], builds: 0, ...proof };
  }
}

function nextWords(t: Ticket, step: TimedStep, part?: { n: number; of: number }): string {
  const shots = screens(t) ? ', then the Tester takes a screenshot for each "done when"' : '';
  const ready = t.track === 'auto' ? 'The squad accepts it by itself and merges it.' : 'The proof is ready for you to check.';
  switch (step) {
    case 'questions':
      return 'The Analyst asks you what it needs to know, or writes the spec straight away.';
    case 'spec':
      return 'You read the spec and approve it. Then the Architect writes the design.';
    case 'design':
      return t.track === 'express'
        ? 'Express track: the plan is approved on its own, then the Builder starts and the checks and the Reviewer follow.'
        : t.track === 'auto'
          ? 'Builds by itself: the plan is approved on its own, then the Builder starts and the checks and the Reviewer follow.'
          : 'You read the design and approve it. Then the Builder starts.';
    case 'build':
      return part && part.n < part.of
        ? `The Builder goes on with step ${part.n + 1} of ${part.of}. Then the checks run on their own, a fresh Reviewer reads the work${shots}.`
        : `The checks run on their own, a fresh Reviewer reads the work${shots}.`;
    case 'fix':
      return `The checks run again on their own, then the Reviewer reads the work${shots}.`;
    case 'checks':
      return `The Reviewer, a fresh agent, reads the changes${shots}.`;
    case 'review':
      return screens(t) ? 'The Tester takes a screenshot for each "done when".' : ready;
    case 'proof':
      return ready;
  }
}

/** "in about 6 minutes", "in about a minute". */
export function inAbout(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m <= 1 ? 'in about a minute' : `in about ${m} minutes`;
}

/** The step bar: the Builder's plan steps, or the steps around this one. */
function barOf(t: Ticket, step: TimedStep, part?: { n: number; of: number }): LiveNow['bar'] {
  if (part) return Array.from({ length: part.of }, (_, i) => (i + 1 < part.n ? 'done' : i + 1 === part.n ? 'now' : 'todo'));
  const group: TimedStep[] = ['questions', 'spec', 'design'].includes(step)
    ? t.track === 'express' || t.track === 'auto'
      ? ['design']
      : ['questions', 'spec', 'design']
    : ['checks', 'review', ...(screens(t) ? ['proof' as const] : [])];
  const at = group.indexOf(step === 'fix' || step === 'build' ? 'checks' : step);
  return group.map((_, i) => (i < at ? 'done' : i === at ? 'now' : 'todo'));
}

function stageNotes(t: Ticket, state: NowState, book: UsualBook, at: number): LiveNow['stages'] {
  const stage = t.stage === 'bugs' ? 'tickets' : t.stage;
  const cur = stage === 'done' ? TRACK.length : TRACK.indexOf(stage);
  const st = t.stageTimes;
  const usual = (who: AgentName | 'squad', step: TimedStep) => middle(usualOf(book, who, step, t.track));
  const about = (s: number) => (s > 0 ? `about ${Math.max(1, Math.round(s / 60))} min` : '');
  return TRACK.map((s, i) => {
    let note = '';
    if (i < cur) {
      const spent = st?.spent[s];
      const yours = t.track !== 'express' && t.track !== 'auto' && t.specApproved;
      note = spent !== undefined ? `${durationWords(spent)}${s === 'specs' && yours ? ', you approved' : ''}` : '';
    } else if (i === cur) {
      const inStage = st?.stage === t.stage ? (at - Date.parse(st.since)) / 1000 : undefined;
      if (state === 'you') note = 'your turn';
      else if (state === 'ready') note = t.release ? `in ${t.release}` : 'accepted';
      else if (state === 'queued') note = 'next in line';
      else if (state === 'working' || state === 'stopping') note = inStage !== undefined ? `now · ${durationWords(inStage)}` : 'now';
    } else if (s === 'review') note = t.track === 'auto' ? 'accepted by itself' : 'you check proof';
    else if (s === 'release') note = t.track === 'auto' ? 'merges by itself' : 'on Looks right';
    else if (s === 'specs') note = about(t.track === 'express' || t.track === 'auto' ? usual('architect', 'design') : usual('analyst', 'spec') + usual('architect', 'design'));
    else if (s === 'implement') note = about((t.work?.steps ?? t.steps?.length ?? 0) * usual('builder', 'build'));
    else if (s === 'test') note = about(usual('squad', 'checks'));
    return { stage: s, note };
  });
}

/** When a note sent now is read, in a sentence. */
export function noteWhenWords(t: Ticket, now: Pick<LiveNow, 'state' | 'role' | 'who' | 'seconds' | 'usual'>): string {
  switch (now.state) {
    case 'working': {
      const left = now.usual ? Math.max(60, middle(now.usual) - (now.seconds ?? 0)) : 60;
      if (now.role === 'squad') return `squad-kit is running the checks. The next agent reads it when its step starts, ${inAbout(left)}.`;
      return `The ${now.who} reads it when its next step starts, ${inAbout(left)}.`;
    }
    case 'you':
      return `No agent is running now, so nobody reads it yet. The squad reads it when it carries on, after you ${t.waiting ? YOUR_PART[t.waiting.kind] : 'give it back'}.`;
    case 'queued':
      return 'No agent is running now, so nobody reads it yet. It is next in line: the squad reads it when a slot is free and its step starts.';
    case 'stopping':
      return 'The squad is stopping. It reads it when the work carries on.';
    case 'ready':
    case 'done':
      return 'The work is accepted, so no agent works on it any more. The note stays on the ticket for the record.';
    default:
      return 'No agent is running now, so nobody reads it yet. The squad reads it when work on the ticket starts.';
  }
}

function slowCard(t: Ticket, c: Omit<StepClock, 'since'> & { since?: string }, part: LiveNow['part'], lastAt: string | undefined, at: number): SlowCard | undefined {
  const q = t.quiet;
  if (!q) return undefined;
  const who = WHO[c.who];
  const where = `${t.id} · ${part ? `step ${part.n} of ${part.of}` : who}`;
  const limit = c.limit ? `If you do nothing, squad-kit stops this step at ${c.limit} minutes. All work is kept.` : undefined;
  const port = portParts(q);
  const detail = slowDetail(q);
  if (q.kind === 'stuck') {
    const quiet = Math.max(0, (at - Date.parse(q.since)) / 1000);
    return {
      kind: 'stuck',
      title: 'Looks stuck',
      where,
      text: `No progress for ${minutesWords(quiet)}.${c.doing ? ` ${c.who === 'squad' ? 'squad-kit' : `The ${who}`} was ${lowerFirst(c.doing)}.` : ''}`,
      facts: [{ label: 'What we checked', value: q.detail }, ...(port.fact ? [port.fact] : []), { label: 'Your work', value: 'Safe. Everything done so far is kept.' }],
      ...(limit ? { limit } : {}),
      canEnd: Boolean(q.pid),
      ...(port.freePort ? { freePort: port.freePort } : {}),
      ...(detail ? { detail } : {}),
    };
  }
  const facts: SlowCard['facts'] = [];
  if (c.doing) facts.push({ label: 'Doing now', value: upperFirst(c.doing) });
  if (lastAt) {
    const ago = Math.max(0, (at - Date.parse(lastAt)) / 1000);
    facts.push({ label: 'Last progress', value: ago < 180 ? `${minutesWords(ago)} ago, so it is still working` : `${minutesWords(ago)} ago` });
  }
  if ((t.tries ?? 0) > 0) facts.push({ label: 'Why it may be slow', value: `The checks failed ${t.tries === 1 ? 'once' : `${t.tries} times`}, so the Builder is fixing them (try ${(t.tries ?? 0) + 1} of 3).` });
  else if ((t.reviewRound ?? 0) > 1) facts.push({ label: 'Why it may be slow', value: `The Reviewer asked for changes, so this is round ${t.reviewRound} of 2.` });
  if (port.fact) facts.push(port.fact);
  return { kind: 'long', title: 'Taking longer than usual', where, text: q.detail, facts, ...(limit ? { limit } : {}), canEnd: Boolean(q.pid), ...(port.freePort ? { freePort: port.freePort } : {}), ...(detail ? { detail } : {}) };
}

/** What is happening on the ticket now. `at` is the time to read it at, for tests. */
export function liveNow(t: Ticket, book: UsualBook, at = Date.now()): LiveNow {
  const state = stateOf(t);
  const stages = stageNotes(t, state, book, at);
  const base = { state, stages };
  if (state === 'done') return { ...base, line: t.status || 'Released', sentence: `It is released${t.release ? ` in ${t.release}` : ''}.`, noteWhen: noteWhenWords(t, { state }) };
  if (state === 'ready') return { ...base, line: t.status, sentence: `It is accepted and goes out with ${t.release ?? 'the next release'}. Nothing is needed from you until then.`, noteWhen: noteWhenWords(t, { state }) };
  if (state === 'you') {
    const summary = t.waiting?.summary ?? 'You took it over. Give it back when you are done';
    return { ...base, line: t.status, sentence: `It waits for you: ${lowerFirst(summary)}.`, next: `The squad carries on after you ${t.waiting ? YOUR_PART[t.waiting.kind] : 'give it back'}.`, noteWhen: noteWhenWords(t, { state }) };
  }
  if (state === 'queued') {
    const m = /\((\d+) of (\d+) busy\)/.exec(t.status);
    return {
      ...base,
      line: t.status,
      sentence: `It is next in line. It starts when a slot is free${m ? ` (${m[1]} of ${m[2]} busy)` : ''}.`,
      next: 'Nothing is needed from you now.',
      noteWhen: noteWhenWords(t, { state }),
    };
  }
  if (state === 'idle') return { ...base, line: t.status, sentence: t.stage === 'bugs' ? 'It is a reported bug, waiting for the squad.' : 'Nothing runs on it now.', noteWhen: noteWhenWords(t, { state }) };

  // Working, or stopping.
  const c = t.clock ?? guessClock(t);
  const since = t.clock?.since;
  const who = WHO[c.who];
  const steps = t.steps ?? [];
  const part = c.who === 'builder' && c.step === 'build' && c.part && steps.length ? { n: Math.min(c.part, steps.length), of: steps.length } : undefined;
  const usual = usualOf(book, c.who, c.step, t.track);
  const seconds = since ? stepSeconds({ ...c, since }, at) : undefined;
  const fromStatus = t.status.startsWith(`${who} is `) ? t.status.slice(who.length + 4) : /^Step \d+ of \d+/.test(t.status) || !t.status ? '' : t.status;
  const said = t.clock?.doing ?? (part ? steps[part.n - 1]?.live : undefined) ?? fromStatus;
  // "Reviewer is checking the session handling" on the Reviewer's card reads "checking the session handling".
  const raw = said.startsWith(`${who} is `) ? said.slice(who.length + 4) : said;
  // Carried on after a restart: the card says so, instead of the last action from before it, until a new one.
  const resumed = t.clock?.resumed && !(t.clock.doingAt && Date.parse(t.clock.doingAt) > Date.parse(t.clock.resumed));
  const doing = resumed ? RESUMED : raw ? shortDoing(raw) : undefined;
  const lastAt = t.clock?.doingAt ?? since;
  if (state === 'stopping') return { ...base, who, role: c.who, step: c.step, line: 'Stopping…', sentence: `The ${who} is stopping. The work so far is kept.`, noteWhen: noteWhenWords(t, { state }) };

  const line = [who, part ? `step ${part.n} of ${part.of}` : '', doing].filter(Boolean).join(' · ');
  const time = seconds !== undefined ? `${durationWords(seconds)} · ${usualWords(usual)}` : usualWords(usual);
  const title = part ? steps[part.n - 1]?.title : undefined;
  const sentence = part && title ? `The ${who} is on step ${part.n} of ${part.of}: ${lowerFirst(title.replace(/\.$/, ''))}.` : t.status.startsWith(`${who} is `) && c.who !== 'squad' ? `The ${t.status.replace(/\.$/, '')}.` : SENTENCE[c.step](t);
  const detail = [part ? `Step ${part.n} of ${part.of}` : '', seconds !== undefined ? `${durationWords(seconds)} so far` : '', resumed ? RESUMED : '', `this step usually takes ${rangeWords(usual)}`].filter(Boolean).join(' · ');

  // What is left before the ticket needs the person: the rest of this step, then each step after it, at their usual times.
  const go = ahead(t, c.step, part);
  const left = Math.max(0, middle(usual) - (seconds ?? 0)) + go.builds * middle(usualOf(book, 'builder', 'build', t.track)) + go.steps.reduce((n, s) => n + middle(usualOf(book, s === 'checks' ? 'squad' : s === 'review' ? 'reviewer' : 'tester', s, t.track)), 0);
  const then = nextWords(t, c.step, part);
  const next = t.track === 'auto' ? `${then} It is accepted and merged by itself ${inAbout(left)}. Nothing is needed from you now.` : `${then} You will be asked to ${go.what} ${inAbout(left)}. Nothing is needed from you now.`;
  const now: LiveNow = {
    ...base,
    who,
    role: c.who,
    step: c.step,
    ...(part ? { part } : {}),
    ...(doing ? { doing } : {}),
    line,
    time,
    bar: barOf(t, c.step, part),
    sentence,
    detail,
    next,
    then,
    ...(since ? { since } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    usual,
    ...(lastAt ? { lastAt } : {}),
    readyIn: { seconds: left, what: go.what },
    noteWhen: '',
  };
  now.noteWhen = noteWhenWords(t, now);
  const slow = slowCard(t, t.clock ?? { ...c, doing: raw || undefined }, part, lastAt, at);
  if (slow) now.slow = slow;
  return now;
}

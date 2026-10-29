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
  type BoardPaths,
} from './store.js';
import type { Release, Ticket } from './types.js';
import { scheduleSquad } from './schedule.js';

/** Every person-facing action lives here, so the board and the terminal do exactly the same thing. */

export class BoardActionError extends Error {}

export interface NewTicketInput {
  title: string;
  ask?: string;
  priority?: Ticket['priority'];
  source?: Ticket['source'];
}

export function createTicket(bp: BoardPaths, input: NewTicketInput): Ticket {
  const title = input.title.trim();
  if (!title) throw new BoardActionError('A ticket needs a title.');
  const meta = readMeta(bp);
  const ticket: Ticket = {
    id: nextTicketId(bp),
    title,
    ask: input.ask?.trim() || title,
    kind: 'feature',
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
  };
  addActivity(ticket, 'you', input.source?.type === 'azure' ? `Pulled ${input.source.ref} from Azure DevOps` : 'Created the ticket');
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

export function pullTicket(bp: BoardPaths, ref: string): Ticket {
  const clean = ref.replace(/^AB#/i, '').trim();
  if (!clean) throw new BoardActionError('Give a work item number, for example AB#4133.');
  const item = AZURE_ITEMS[clean] ?? { title: `Azure work item ${clean}`, ask: `Pulled from Azure DevOps work item ${clean}.` };
  return createTicket(bp, { ...item, source: { type: 'azure', ref: `AB#${clean}` } });
}

export interface AnswerInput {
  choice: string;
  value?: string;
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
  });
}

function testNameFor(ticket: Ticket): string {
  return `${ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.spec.ts`;
}

function acceptProof(bp: BoardPaths, ticket: Ticket): Ticket {
  const release = ensureDraftRelease(bp, ticket.kind === 'bug' ? 'patch' : 'minor');
  if (!release.tickets.includes(ticket.id)) release.tickets.push(ticket.id);
  writeRelease(bp, release);
  return updateTicket(bp, ticket.id, (t) => {
    t.waiting = null;
    t.stage = 'release';
    t.live = false;
    t.progress = undefined;
    t.release = release.version;
    t.status = `Ready for ${release.version}`;
    t.squad = null;
    addActivity(t, 'you', 'Checked the proof. Looks right');
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
    t.status = 'Builder is trying your choice';
    addActivity(t, 'you', `Decided: ${option.name}`);
    scheduleSquad(t, 'unstick', 2, meta.speed);
  });
}

function bump(version: string, part: 'minor' | 'patch'): string {
  const [maj = 0, min = 0, pat = 0] = version.replace(/^v/, '').split('.').map(Number);
  return part === 'minor' ? `v${maj}.${min + 1}.0` : `v${maj}.${min}.${pat + 1}`;
}

export function ensureDraftRelease(bp: BoardPaths, part: 'minor' | 'patch'): Release {
  const draft = draftRelease(bp);
  if (draft) return draft;
  const last = latestRelease(bp);
  const from = last?.version ?? 'v0.0.0';
  const release: Release = {
    version: bump(from, part),
    status: 'draft',
    from,
    tickets: [],
    notes: '',
    addons: { changelog: true, tag: true, pipeline: true, whatsapp: true },
  };
  writeRelease(bp, release);
  return release;
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

export function releaseVersion(bp: BoardPaths, version?: string): Release {
  const release = version ? readRelease(bp, version) : draftRelease(bp);
  if (!release || release.status !== 'draft') throw new BoardActionError('There is no release ready to go out.');
  if (release.tickets.length === 0) throw new BoardActionError(`${release.version} has no tickets yet.`);
  const meta = readMeta(bp);
  if (!release.notes.trim()) release.notes = composeNotes(bp, release);
  const tickets = listTickets(bp).filter((t) => release.tickets.includes(t.id));
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

export function inbox(bp: BoardPaths): Ticket[] {
  return listTickets(bp).filter((t) => t.waiting);
}

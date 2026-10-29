import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { confirm, input, select, Separator } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { buildPaths, findSquadRoot, requireSquadRoot } from '../core/paths.js';
import { DEFAULT_CONFIG, saveConfig } from '../core/config.js';
import {
  answerQuestions,
  approve,
  askAbout,
  composeNotes,
  createTicket,
  decideStuck,
  inbox,
  pullTicket,
  releaseVersion,
  reportBug,
  requestChange,
  skipQuestions,
  type AnswerInput,
} from '../board/actions.js';
import { tick } from '../board/engine.js';
import { squadRunsElsewhere } from '../board/lock.js';
import { seedDemoBoard } from '../board/demo.js';
import {
  boardExists,
  boardPaths,
  draftRelease,
  listTickets,
  readMeta,
  readTicket,
  requireTicket,
  type BoardPaths,
} from '../board/store.js';
import type { Stage, Ticket } from '../board/types.js';
import { runConsole } from './console.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const id = (s: string) => kleur.bold(s);
const amber = (s: string) => kleur.yellow(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STAGE_NAME: Record<Stage, string> = {
  tickets: 'Tickets',
  specs: 'Specs',
  implement: 'Implement',
  test: 'Test',
  review: 'Review',
  release: 'Release',
  bugs: 'Bugs',
  done: 'Released',
};
const TRACK: Stage[] = ['tickets', 'specs', 'implement', 'test', 'review', 'release'];

function board(): BoardPaths {
  const bp = boardPaths(buildPaths(requireSquadRoot()).squadDir);
  if (!boardExists(bp)) {
    throw new Error('This project has no board yet. Run `squad demo` to try squad-kit v1 with a sample board.');
  }
  return bp;
}

/** When no console is open, the terminal runs the squad itself while it waits. */
function stepSquad(bp: BoardPaths): void {
  if (!squadRunsElsewhere(bp)) tick(bp);
}

function nextCommand(t: Ticket): string {
  switch (t.waiting?.kind) {
    case 'questions':
      return `squad answer ${t.id}`;
    case 'plan':
      return `squad show ${t.id}   then   squad approve ${t.id}`;
    case 'proof':
      return `squad show ${t.id}   then   squad approve ${t.id}`;
    case 'stuck':
      return `squad decide ${t.id}`;
    default:
      return `squad watch ${t.id}`;
  }
}

function trackLine(t: Ticket): string {
  if (t.stage === 'bugs') return amber('● Bugs') + kleur.gray('  then the same 6 steps as any ticket');
  const at = TRACK.indexOf(t.stage);
  return TRACK.map((s, i) => {
    if (i < at || t.stage === 'done') return kleur.green(`✓ ${STAGE_NAME[s]}`);
    if (i === at) return (t.waiting ? amber : kleur.green)(`● ${STAGE_NAME[s]}`) + (t.waiting ? amber(' your turn') : kleur.gray(' working'));
    return kleur.gray(`○ ${STAGE_NAME[s]}`);
  }).join(kleur.gray(' ─ '));
}

export async function runInbox(): Promise<void> {
  const bp = board();
  const items = inbox(bp);
  out();
  out(`  ${kleur.bold('Waiting for you')} ${amber(`(${items.length})`)}`);
  out();
  if (items.length === 0) {
    out(kleur.gray('  Nothing needs you right now. The squad is working.'));
    out();
    return;
  }
  const w = Math.max(...items.map((t) => t.title.length));
  for (const t of items) {
    out(`  ${id(t.id)}  ${t.title.padEnd(w)}   ${amber(t.waiting!.summary)}`);
    out(`  ${' '.repeat(t.id.length)}  ${cmd(nextCommand(t))}`);
  }
  out();
}

export async function runBoard(): Promise<void> {
  const bp = board();
  const meta = readMeta(bp);
  const tickets = listTickets(bp).filter((t) => t.stage !== 'done');
  out();
  out(`  ${kleur.bold(meta.project)}  ${kleur.gray(`${tickets.length} open tickets`)}`);
  for (const stage of ['tickets', 'specs', 'implement', 'test', 'review', 'release', 'bugs'] as Stage[]) {
    const here = tickets.filter((t) => t.stage === stage);
    out();
    out(`  ${kleur.bold(STAGE_NAME[stage])} ${kleur.gray(String(here.length))}`);
    for (const t of here) {
      const mark = t.waiting ? amber('● you') : t.live ? kleur.green('● ') + kleur.gray('   ') : kleur.gray('○    ');
      out(`    ${mark} ${id(t.id)}  ${t.title}  ${kleur.gray(t.status)}`);
    }
  }
  out();
}

export async function runShow(ticketId: string): Promise<void> {
  const bp = board();
  const t = requireTicket(bp, ticketId);
  out();
  out(`  ${id(t.id)}  ${kleur.bold(t.title)}${t.priority === 'high' ? kleur.red('  High priority') : ''}`);
  out(`  ${trackLine(t)}`);
  out(`  ${kleur.gray(t.status)}`);
  if (t.waiting) {
    out();
    out(`  ${amber('Waiting for you:')} ${t.waiting.summary}`);
  }
  if (t.story) {
    out();
    out(`  ${kleur.bold('The story')}`);
    out(`  ${t.story}`);
  }
  if (t.criteria?.length) {
    out();
    out(`  ${kleur.bold('Done when')}`);
    t.criteria.forEach((c, i) =>
      out(`  ${i + 1}. ${kleur.green('Given')} ${c.given}, ${kleur.green('when')} ${c.when}, ${kleur.green('then')} ${c.then}.`),
    );
  }
  if (t.decision) {
    out();
    out(`  ${kleur.bold("The Architect's decision")}${t.decision.adr ? kleur.gray(`  saved as ${t.decision.adr}`) : ''}`);
    out(`  ${t.decision.title}`);
    for (const o of t.decision.options) out(`    ${o.chosen ? kleur.green('✓') : kleur.gray('·')} ${o.name}  ${kleur.gray(o.note)}`);
    out(`  ${kleur.gray('Why:')} ${t.decision.why}`);
    if (t.decision.clientCheck) out(`  ${kleur.gray("Client's choice:")} ${t.decision.clientCheck}`);
  }
  if (t.steps?.length && t.waiting?.kind !== 'plan') {
    out();
    out(`  ${kleur.bold('Steps')}`);
    for (const s of t.steps) {
      const mark = s.status === 'done' ? kleur.green('✓') : s.status === 'doing' ? kleur.green('●') : kleur.gray('○');
      out(`    ${mark} ${s.status === 'todo' ? kleur.gray(s.title) : s.title}${s.live ? kleur.gray(`  ${s.live}`) : ''}`);
    }
  } else if (t.work && t.waiting?.kind === 'plan') {
    out();
    out(`  ${kleur.bold('The work')}  ${t.work.steps} small steps, ${t.work.tests} new tests, ${t.work.screens} before and after screens`);
  }
  if (t.gates) {
    const g = (ok: string, label: string) => (ok === 'pass' ? kleur.green(`✓ ${label}`) : kleur.gray(`○ ${label}`));
    out();
    out(`  ${kleur.bold('Gates')}  ${g(t.gates.checks, t.gates.checksText ?? 'All checks pass')}   ${g(t.gates.review, 'Review approved')}   ${g(t.gates.proof, 'Proof made')}`);
  }
  if (t.waiting?.kind === 'proof' && t.proof?.length) {
    out();
    out(`  ${kleur.bold('Proof')}  ${kleur.gray('before and after screens, open them on the board or here:')}`);
    for (const p of t.proof) {
      out(`    ${kleur.green('✓')} ${p.criterion}`);
      out(kleur.gray(`      ${path.join(bp.proofDir, p.before)}  →  ${path.join(bp.proofDir, p.after)}`));
    }
  }
  if (t.stuck && t.waiting?.kind === 'stuck') {
    out();
    out(`  ${kleur.bold('The squad is stuck')}`);
    out(`  ${t.stuck.question}`);
    t.stuck.options.forEach((o, i) => out(`    ${i + 1}. ${o.name}  ${kleur.gray(o.note)}`));
  }
  out();
  out(`  ${kleur.bold('Latest')}`);
  for (const a of t.activity.slice(0, 4)) out(`    ${kleur.gray(time(a.at))}  ${a.text}`);
  out();
  out(`  ${kleur.gray('Next:')} ${cmd(nextCommand(t))}`);
  out();
}

function time(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

export async function runAnswer(ticketId: string, opts: { skip?: boolean }): Promise<void> {
  const bp = board();
  if (opts.skip) {
    const t = skipQuestions(bp, ticketId);
    ui.success(`The squad made its own guesses for ${t.id}. You'll see them in the plan.`);
    return;
  }
  const t = requireTicket(bp, ticketId);
  if (t.waiting?.kind !== 'questions' || !t.questions) throw new Error(`${t.id} has no open questions.`);
  out();
  out(`  ${id(t.id)}  ${kleur.bold(t.title)}  ${amber(`${t.questions.length} questions`)}`);
  const answers: Record<string, AnswerInput> = {};
  for (const q of t.questions) {
    out();
    out(kleur.gray(`  From the ${q.from === 'analyst' ? 'Analyst, what to build' : 'Architect, how to build'}`));
    for (;;) {
      const choice = await select({
        message: q.text,
        choices: [
          ...q.options.map((o) => ({ name: o === q.inputOption ? `${o} (type it)` : o, value: o })),
          { name: 'Other (type your own)', value: '__other' },
          new Separator(),
          { name: 'Ask about this', value: '__ask' },
        ],
      });
      if (choice === '__ask') {
        const text = await input({ message: 'Your question:' });
        if (!text.trim()) continue;
        askAbout(bp, t.id, q.id, text);
        const reply = await waitForReply(bp, t.id, q.id);
        out(`  ${kleur.green(q.from === 'analyst' ? 'Analyst:' : 'Architect:')} ${reply}`);
        continue;
      }
      if (choice === '__other') {
        answers[q.id] = { choice: 'Other', value: await input({ message: 'Your answer:' }) };
      } else if (choice === q.inputOption) {
        answers[q.id] = { choice, value: await input({ message: choice.replace(/:$/, '') + ', which one?' }) };
      } else {
        answers[q.id] = { choice };
      }
      break;
    }
  }
  answerQuestions(bp, t.id, answers);
  out();
  ui.success('Answers sent. The Architect is choosing the design.');
  ui.info(`Follow it live: squad watch ${t.id}`);
}

async function waitForReply(bp: BoardPaths, ticketId: string, qid: string): Promise<string> {
  const spin = ui.spinner('Thinking…');
  for (let i = 0; i < 60; i += 1) {
    stepSquad(bp);
    const q = readTicket(bp, ticketId)?.questions?.find((x) => x.id === qid);
    if (q && !q.thinking) {
      spin.stop();
      return q.thread?.[q.thread.length - 1]?.text ?? '';
    }
    await sleep(400);
  }
  spin.stop();
  return 'The squad has not answered yet. Check the board in a moment.';
}

export async function runApprove(ticketId: string): Promise<void> {
  const bp = board();
  const t = approve(bp, ticketId);
  if (t.stage === 'implement') {
    ui.success(`Plan approved${t.decision?.adr ? `. Decision saved as ${t.decision.adr}` : ''}. The Builder started.`);
    ui.info(`Follow it live: squad watch ${t.id}`);
  } else {
    ui.success(`Proof accepted. ${t.id} is ready for ${t.release}.`);
    ui.info('Release it when you are ready: squad release');
  }
}

export async function runChange(ticketId: string, words: string[]): Promise<void> {
  const bp = board();
  const text = words.join(' ') || (await input({ message: 'What should change?' }));
  const t = requestChange(bp, ticketId, text);
  ui.success(t.stage === 'implement' ? 'Sent back to the Builder with your note.' : 'Sent to the Spec writer to update the plan.');
}

export async function runDecide(ticketId: string, choice?: string): Promise<void> {
  const bp = board();
  const t = requireTicket(bp, ticketId);
  if (!t.stuck || t.waiting?.kind !== 'stuck') throw new Error(`${t.id} is not stuck.`);
  let index = choice ? Number(choice) - 1 : NaN;
  if (Number.isNaN(index)) {
    out();
    out(`  ${t.stuck.question}`);
    index = await select({
      message: 'What should happen?',
      choices: t.stuck.options.map((o, i) => ({ name: `${o.name}  ${kleur.gray(o.note)}`, value: i })),
    });
  }
  decideStuck(bp, t.id, index);
  ui.success(`Decided. The Builder is trying "${t.stuck.options[index]?.name}".`);
}

export async function runWatch(ticketId: string): Promise<void> {
  const bp = board();
  let t = requireTicket(bp, ticketId);
  out();
  out(`  ${id(t.id)}  ${kleur.bold(t.title)}`);
  out(kleur.gray('  Watching live. Press Ctrl-C to stop.'));
  out();
  const seen = new Set(t.activity.map((a) => a.at + a.text));
  let live = '';
  for (const a of [...t.activity].slice(0, 3).reverse()) out(`  ${kleur.gray(time(a.at))}  ${a.text}`);
  for (;;) {
    if (t.waiting || t.stage === 'done') break;
    await sleep(400);
    stepSquad(bp);
    t = requireTicket(bp, ticketId);
    for (const a of [...t.activity].reverse()) {
      const key = a.at + a.text;
      if (seen.has(key)) continue;
      seen.add(key);
      out(`  ${kleur.gray(time(a.at))}  ${roleLabel(a.who)}${a.text}`);
    }
    const now = t.steps?.find((s) => s.status === 'doing')?.live ?? '';
    if (now && now !== live) {
      live = now;
      out(kleur.gray(`         ${kleur.green('●')} ${now}`));
    }
  }
  out();
  if (t.waiting) {
    out(`  ${amber('Your turn:')} ${t.waiting.summary}`);
    out(`  ${cmd(nextCommand(t))}`);
  } else {
    out(`  ${kleur.green('✓')} ${t.status}`);
  }
  out();
}

function roleLabel(who: string): string {
  const names: Record<string, string> = {
    analyst: 'Analyst', architect: 'Architect', spec: 'Spec writer', builder: 'Builder',
    tester: 'Tester', reviewer: 'Reviewer', release: 'Release', triage: 'Triage', you: 'You',
  };
  return kleur.bold(`${names[who] ?? 'Squad'}  `);
}

export async function runRelease(version: string | undefined, opts: { yes?: boolean }): Promise<void> {
  const bp = board();
  const draft = draftRelease(bp);
  if (!draft || (version && draft.version !== (version.startsWith('v') ? version : `v${version}`))) {
    throw new Error('There is no release ready to go out.');
  }
  const tickets = listTickets(bp).filter((t) => draft.tickets.includes(t.id));
  out();
  out(`  ${kleur.bold(`Release ${draft.version}`)}  ${kleur.gray(`${draft.from} → ${draft.version}`)}`);
  out();
  for (const t of tickets) out(`    ${kleur.green('✓')} ${id(t.id)}  ${t.title}`);
  out();
  for (const l of (draft.notes.trim() || composeNotes(bp, draft)).split('\n')) out(`  ${kleur.gray(l.replace(/\*\*/g, ''))}`);
  out();
  if (!opts.yes && !(await confirm({ message: `Release ${draft.version} now?`, default: false }))) {
    ui.info('Not released.');
    return;
  }
  const r = releaseVersion(bp, draft.version);
  const demo = readMeta(bp).engine === 'demo';
  ui.success(`Released ${r.version}.`);
  const tag = demo ? kleur.gray(' (shown, not run, on a demo board)') : '';
  if (r.addons.changelog) ui.success(`Changelog updated${tag}`);
  if (r.addons.tag) ui.success(`Tagged ${r.version} in git${tag}`);
  if (r.addons.pipeline) ui.success(`Azure pipeline started${tag}`);
  if (r.addons.whatsapp && r.whatsappDraft) {
    out();
    out(kleur.gray('  WhatsApp note for your manager. Copy it and send it yourself:'));
    out();
    for (const l of r.whatsappDraft.split('\n')) out(`  ${l}`);
    out();
  }
}

export async function runBug(words: string[], opts: { in?: string; severity?: string; how?: string; expected?: string }): Promise<void> {
  const bp = board();
  const what = words.join(' ') || (await input({ message: 'What happened?' }));
  const severity = (['stops-work', 'annoying', 'small'].includes(opts.severity ?? '') ? opts.severity : 'annoying') as Ticket['severity'];
  const t = reportBug(bp, { what, how: opts.how, expected: opts.expected, severity, foundIn: opts.in });
  ui.success(`${t.id} created${t.foundIn ? `, linked to ${t.foundIn}` : ''}. Triage is sorting it.`);
}

export async function runNew(words: string[], opts: { ask?: string; priority?: Ticket['priority'] }): Promise<void> {
  const bp = board();
  const title = words.join(' ') || (await input({ message: 'Ticket title:' }));
  const t = createTicket(bp, { title, ask: opts.ask, priority: opts.priority });
  ui.success(`${t.id} created. The Analyst is reading it.`);
}

export async function runPull(ref: string): Promise<void> {
  const bp = board();
  const t = pullTicket(bp, ref);
  ui.success(`${t.id} pulled from ${t.source.ref}: ${t.title}`);
}

export interface DemoOptions {
  speed?: number;
  project?: string;
  port?: number;
  open?: boolean;
  keep?: boolean;
  token?: string;
}

/** Sets up a sample board (and a minimal .squad/ if needed), then opens the console. */
export async function runDemo(opts: DemoOptions): Promise<void> {
  let root = findSquadRoot();
  if (!root) {
    root = process.cwd();
    const paths = buildPaths(root);
    fs.mkdirSync(paths.squadDir, { recursive: true });
    saveConfig(paths.configFile, { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: opts.project ?? 'Case portal' } });
  }
  const bp = boardPaths(buildPaths(root).squadDir);
  if (!opts.keep || !boardExists(bp)) {
    seedDemoBoard(bp, { speed: opts.speed, project: opts.project });
    ui.success('Sample board ready: 11 tickets, 4 releases and 5 saved decisions.');
  }
  await runConsole({ port: opts.port, open: opts.open, token: opts.token });
}

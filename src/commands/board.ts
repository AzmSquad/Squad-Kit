import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { confirm, input, select, Separator } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { whereItStands } from '../board/at-review.js';
import { alsoChangedLine } from '../board/also-changed.js';
import { buildPaths, findSquadRoot, requireSquadRoot } from '../core/paths.js';
import { DEFAULT_CONFIG, saveConfig } from '../core/config.js';
import {
  answerQuestions,
  approveBeside,
  askAbout,
  composeNotes,
  createTicket,
  decideStuckBeside,
  decideTestCommand,
  endSaves,
  inbox,
  pullTicket,
  pushReleaseAgain,
  markReleaseSent,
  SentNotSure,
  releaseVersion,
  reportBug,
  requestChange,
  addNote,
  answerAgent,
  giveBack,
  takeOver,
  handOver,
  chatDone,
  chatRetry,
  chatStop,
  chatWrite,
  sendChat,
  startChat,
  askQuestion,
  editPlan,
  sendBack,
  startOver,
  DECIDE_YOURSELF,
  skipQuestions,
  stopTicket,
  restartStep,
  endStuckCommand,
  keepWaiting,
  proposeChange,
  approveChange,
  declineChange,
  withdrawChange,
  retryChange,
  changeAfterRelease,
  changeNeedsYou,
  openChange,
  ReleasedError,
  type AnswerInput,
  type NewTicketInput,
} from '../board/actions.js';
import { tick } from '../board/engine.js';
import { squadRunsElsewhere } from '../board/lock.js';
import { demoFolder, seedDemoBoard } from '../board/demo.js';
import { repoFor } from '../engine/repos.js';
import { projectApps } from '../board/apps.js';
import { trackerFor } from '../modules/registry.js';
import { openInEditor, ticketChanges } from '../engine/changes.js';
import { AGENTS, STEPS, readAgent, writeAgent, type AgentRole } from '../engine/agents.js';
import { corePrompts } from '../engine/core-prompts.js';
import { draftTicket } from '../engine/draft.js';
import {
  boardExists,
  brokenDecisions,
  brokenReleases,
  brokenTickets,
  boardPaths,
  draftRelease,
  listReleases,
  readRelease,
  listTickets,
  readMeta,
  readTicket,
  requireTicket,
  settingsProblem,
  writeMeta,
  type BoardPaths,
} from '../board/store.js';
import { DEFAULT_QUALITY, QUALITIES, QUALITY_NOTE, parseQuality } from '../engine/levels.js';
import type { AgentName, PlanPart, Stage, Ticket, UsageLine, UsageTotal } from '../board/types.js';
import { boardUsage, byRole, costWords, stepWords, tokenWords, totalOf } from '../board/usage.js';
import { runConsole } from './console.js';
import { openBoard } from '../board/move.js';
import { projectName, readProjects } from '../core/projects.js';
import { isMine, ownerOf } from '../board/owner.js';
import { liveNow } from '../board/now.js';
import { readUsual } from '../board/usual.js';
import { nowLines } from './now.js';
import { problemOf } from '../board/problem.js';
import { shellArg, shellQuote, withoutComments } from '../utils/text.js';
import { freePortAndRetry } from '../engine/free-port.js';
import { putBackInRelease, takeOutOfRelease } from '../board/release-tidy.js';
import { takeBack } from '../engine/handover.js';
import { costLines, happenedLines } from './cost.js';
import { ticketCost } from '../board/cost.js';
import { howPaid } from '../board/payment.js';
import { breakdownWaits, brokenBreakdowns } from '../board/requirements.js';

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

export function board(): BoardPaths {
  const { bp, moved } = openBoard(buildPaths(requireSquadRoot()).squadDir);
  if (moved) ui.success(`Moved this board to the new layout first (${moved.tickets} tickets, all checked). A copy of the old files: ${moved.backup}`);
  if (!boardExists(bp)) {
    throw new Error(settingsProblem(bp) ?? 'This project has no board yet. Run `squad demo` to try squad-kit v1 with a sample board.');
  }
  return bp;
}

/** On a demo board with no console open, the terminal plays the squad itself while it waits. */
function stepSquad(bp: BoardPaths): void {
  if (squadRunsElsewhere(bp)) return;
  if (readMeta(bp).engine === 'demo') tick(bp);
}

function warnIfNoSquad(bp: BoardPaths): void {
  if (readMeta(bp).engine === 'live' && !squadRunsElsewhere(bp)) {
    ui.warning('The squad works while the board is open. Run `squad console` in another tab.');
  }
}

function nextCommand(t: Ticket): string {
  if (!t.waiting && t.quiet) return `${t.quiet.pid ? `squad unstick ${t.id}   or   ` : ''}squad wait ${t.id} --more 10m   or   squad stop ${t.id} --again`;
  if (!t.waiting && changeNeedsYou(t)) return `squad show ${t.id}   then   squad propose ${t.id} --approve   or   --decline`;
  if (!t.waiting && t.testChange?.ask) return `squad test-command ${t.id} --use   or   --keep`;
  switch (t.waiting?.kind) {
    case 'depends':
      return `squad build ${t.id} --on-branch   or   --anyway   or   --wait`;
    case 'change':
      return `squad show ${t.id}   then   squad approve ${t.id}   or   squad propose ${t.id} --decline`;
    case 'questions':
      return `squad answer ${t.id}`;
    case 'spec':
    case 'plan':
      return `squad show ${t.id}   then   squad approve ${t.id}`;
    case 'proof':
      return `squad show ${t.id}   then   squad approve ${t.id}`;
    case 'stuck':
      return `squad decide ${t.id}`;
    case 'yours':
      if (t.takenOver?.free) return `squad outside back ${t.id}`;
      return `cd ${shellQuote(t.takenOver?.cwd ?? '')} && claude --resume ${t.takenOver?.session}   then   squad give-back ${t.id}`;
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

/** The tickets, decisions, releases and breakdowns whose file cannot be read: never silently gone from what the person sees. */
function brokenLines(bp: BoardPaths): void {
  for (const b of [...brokenTickets(bp), ...brokenDecisions(bp), ...brokenReleases(bp), ...brokenBreakdowns(bp)]) {
    out();
    out(`  ${amber(b.problem)}`);
    out(kleur.gray(`  For an engineer: ${b.file}: ${b.detail}`));
  }
}

export async function runInbox(): Promise<void> {
  // Outside a project folder: one Waiting for you list across every project in squad-kit.
  if (!findSquadRoot()) return inboxEverywhere();
  const bp = board();
  const items = inbox(bp);
  // A breakdown whose Analyst has questions waits for you too.
  const brds = breakdownWaits(bp);
  brokenLines(bp);
  out();
  out(`  ${kleur.bold('Waiting for you')} ${amber(`(${items.length + brds.length})`)}`);
  out();
  if (items.length + brds.length === 0) {
    out(kleur.gray('  Nothing needs you right now. The squad is working.'));
    out();
    return;
  }
  const w = Math.max(...items.map((t) => t.title.length), ...brds.map((b) => b.title.length));
  for (const b of brds) {
    out(`  ${id(b.id)}  ${b.title.padEnd(w)}   ${amber(`The Analyst has ${b.questions} ${b.questions === 1 ? 'question' : 'questions'}`)}`);
    out(`  ${' '.repeat(b.id.length)}  ${cmd(`squad requirements answer ${b.id}`)}`);
  }
  for (const t of items) {
    out(`  ${id(t.id)}  ${t.title.padEnd(w)}   ${amber(inboxLine(t))}`);
    out(`  ${' '.repeat(t.id.length)}  ${cmd(nextCommand(t))}`);
  }
  out();
}

/** Why a ticket waits for you, in one line: the same reasons, in the same order, as the board's banner. */
export function inboxLine(t: Ticket): string {
  if (t.waiting?.summary) return t.waiting.summary;
  const change = openChange(t);
  if (changeNeedsYou(t) && change) return `Change ${change.id} to the spec: ${change.summary ?? change.ask}`;
  if (t.testChange?.ask) return testChangeLine(t.testChange);
  const o = t.outdated ?? [];
  if (o.length) return o.length === 1 ? `${o[0]!.adr} came after this plan and changes it` : `${o.map((x) => x.adr).join(' and ')} came after this plan and change it`;
  return `Looks stuck: ${t.quiet?.detail ?? 'no progress'}`;
}

function inboxEverywhere(): void {
  const groups = readProjects()
    .map((p) => ({ root: p.root, bp: boardPaths(path.join(p.root, '.squad')) }))
    .filter((p) => fs.existsSync(p.bp.configFile) && boardExists(p.bp))
    .map((p) => ({ name: readMeta(p.bp).project || projectName(p.root), items: inbox(p.bp) }));
  if (!groups.length) throw new Error('No projects in squad-kit yet. Open a terminal in a project folder (or a new, empty one) and run: squad console');
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  out();
  out(`  ${kleur.bold('Waiting for you')} ${amber(`(${total})`)} ${kleur.gray(`in ${groups.length} ${groups.length === 1 ? 'project' : 'projects'}`)}`);
  if (total === 0) {
    out();
    out(kleur.gray('  Nothing needs you right now. The squads are working.'));
  }
  for (const g of groups.filter((x) => x.items.length)) {
    const ref = shellArg(g.name);
    const w = Math.max(...g.items.map((t) => t.title.length));
    out();
    out(`  ${kleur.bold(g.name)}`);
    for (const t of g.items) {
      out(`  ${id(t.id)}  ${t.title.padEnd(w)}   ${amber(inboxLine(t))}`);
      out(`  ${' '.repeat(t.id.length)}  ${cmd(nextCommand(t).replace(/\bsquad ([a-z-]+) (\S+)/g, (_m, verb: string, arg: string) => `squad ${verb} ${arg} --project ${ref}`))}`);
    }
  }
  out();
}

export async function runBoard(opts: { archived?: boolean } = {}): Promise<void> {
  const bp = board();
  const meta = readMeta(bp);
  const open = listTickets(bp).filter((t) => t.stage !== 'done');
  const tickets = open.filter((t) => opts.archived || !t.archived);
  out();
  const used = boardUsage(bp).total;
  out(`  ${kleur.bold(meta.project)}  ${kleur.gray(`${tickets.length} open tickets`)}${used.runs ? kleur.gray(`  ·  used ${costWords(used) ?? 'an unknown amount'} at API prices`) : ''}`);
  for (const stage of ['tickets', 'specs', 'implement', 'test', 'review', 'release', 'bugs'] as Stage[]) {
    const here = tickets.filter((t) => t.stage === stage);
    out();
    out(`  ${kleur.bold(STAGE_NAME[stage])} ${kleur.gray(String(here.length))}`);
    for (const t of here) {
      const mark = t.waiting ? amber('● you') : t.live ? kleur.green('● ') + kleur.gray('   ') : kleur.gray('○    ');
      out(`    ${mark} ${id(t.id)}  ${t.title}  ${kleur.gray(t.status)}${isMine(t, meta) ? '' : kleur.gray(`  (${ownerOf(t)})`)}${t.archived ? kleur.gray('  (archived)') : ''}`);
    }
  }
  const hidden = open.length - tickets.length;
  if (hidden) {
    out();
    out(kleur.gray(`  ${hidden} archived ${hidden === 1 ? 'ticket is' : 'tickets are'} not shown. Show them: squad board --archived`));
  }
  brokenLines(bp);
  out();
}

export async function runShow(ticketId: string): Promise<void> {
  const bp = board();
  const t = requireTicket(bp, ticketId);
  out();
  out(`  ${id(t.id)}  ${kleur.bold(t.title)}${t.priority === 'high' ? kleur.red('  High priority') : ''}`);
  out(`  ${trackLine(t)}`);
  const usual = readUsual(bp);
  for (const l of nowLines(t, liveNow(t, usual))) out(l);
  out(`  ${kleur.gray('Owner:')} ${ownerOf(t)}${isMine(t, readMeta(bp)) ? kleur.gray(' (you)') : kleur.gray('. Their squad works on it; you see their work when they push')}`);
  if (t.waiting) {
    out();
    out(`  ${amber('Waiting for you:')} ${t.waiting.summary}`);
  }
  if (t.dependsOn?.length) out(`  ${kleur.gray('Depends on:')} ${t.dependsOn.join(', ')}${t.dependency ? kleur.gray(`  (${t.dependency.way === 'branch' ? 'built on its branch' : t.dependency.way === 'anyway' ? 'built without it' : 'waits for it'})`) : ''}  ${cmd(`squad depends ${t.id}`)}`);
  if (t.deleting) out(`  ${amber(t.deleting.error ? `Delete did not finish: ${t.deleting.error}.` : 'Being deleted.')} ${cmd(`squad delete ${t.id}`)}`);
  if (t.archived) out(`  ${kleur.gray(`Archived by ${t.archived.by}. Bring it back:`)} ${cmd(`squad archive ${t.id} --undo`)}`);
  const change = openChange(t);
  if (change) {
    out();
    out(`  ${amber(`Change ${change.id}${change.size ? ` (${change.size})` : ''}:`)} ${change.summary ?? change.ask}  ${kleur.gray(change.status)}`);
    for (const p of change.parts ?? []) {
      const name = p.part === 'story' ? 'Story' : p.index === undefined ? 'New done when' : `Done when ${p.index + 1}`;
      if (p.before) out(`    ${kleur.gray(`${name}, was:`)} ${p.before}`);
      out(`    ${kleur.gray(`${name}, ${p.before ? 'now' : 'new'}:`)} ${p.after || kleur.gray('(goes)')}`);
    }
    for (const [i, s] of (change.design?.steps ?? []).entries()) out(`    ${kleur.gray(`Step ${i + 1}, ${s.change}:`)} ${s.title}`);
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
    const g = (ok: string, label: string) => (ok === 'pass' ? kleur.green(`✓ ${label}`) : ok === 'unchecked' ? kleur.yellow(`! Not checked: ${label}`) : kleur.gray(`○ ${label}`));
    out();
    if (t.outside && !t.outside.checked && [t.gates.checks, t.gates.review, t.gates.proof].every((s) => s === 'pending')) out(`  ${kleur.bold('Gates')}  ${kleur.gray('○ Not checked by squad-kit')}`);
    else out(`  ${kleur.bold('Gates')}  ${g(t.gates.checks, t.gates.checksText ?? 'All checks pass')}   ${g(t.gates.review, 'Review approved')}   ${g(t.gates.proof, 'Proof made')}`);
  }
  if ((t.waiting?.kind === 'proof' || t.stuck?.gate === 'proof') && t.proof?.length) {
    out();
    out(`  ${kleur.bold('Proof')}  ${kleur.gray('before and after screens, open them on the board or here:')}`);
    for (const p of t.proof) {
      // Met, Not working yet, Not shown yet or Not on a screen: the Tester's verdict and squad-kit's own check of the picture.
      const open = p.shows === 'broken' || p.shows === 'not-shown' || p.shows === 'off-screen';
      const paint = p.shows === 'broken' ? kleur.red : p.shows === 'off-screen' ? kleur.gray : kleur.yellow;
      out(`    ${p.shows === 'broken' ? kleur.red('✗') : p.shows === 'not-shown' ? kleur.yellow('?') : p.shows === 'off-screen' ? kleur.gray('-') : kleur.green('✓')} ${p.criterion}${p.shows ? `  ${open ? paint(p.shows === 'broken' ? 'Not working yet' : p.shows === 'off-screen' ? 'Not on a screen' : 'Not shown yet') : kleur.green('Met')}` : ''}`);
      if (open && p.why) out(`      ${p.why}`);
      out(kleur.gray(`      ${path.join(bp.proofDir, p.before)}  →  ${path.join(bp.proofDir, p.after)}`));
      for (const m of p.more ?? []) out(kleur.gray(`      ${path.join(bp.proofDir, m.after)}${m.note ? `  ${m.note}` : ''}`));
    }
    for (const o of t.offScreen ?? []) out(kleur.gray(`    - ${o.criterion}: not on a screen. ${o.why}`));
  }
  if (t.alsoChanged?.length) {
    out();
    out(`  ${amber(alsoChangedLine(t.alsoChanged))}`);
  }
  if (t.testChange) {
    out();
    out(`  ${amber(`${testChangeLine(t.testChange)}.`)} ${kleur.gray(t.testChange.ask ? `squad-kit cannot tell (${t.testChange.ran ?? 'it tried both'}), so the checks keep the current one until you choose.` : 'squad-kit tries it at the next checks and keeps what works. You can choose now.')}`);
    out(`  ${cmd(`squad test-command ${t.id} --use`)}   or   ${cmd(`squad test-command ${t.id} --keep`)}`);
  }
  if (t.stuck && t.waiting?.kind === 'stuck') {
    const problem = problemOf(t)!;
    out();
    out(`  ${kleur.bold(problem.title)}`);
    out(`  ${problem.what}`);
    for (const line of t.stuck.points ?? []) out(`  - ${line}`);
    for (const line of problem.safe) out(`  ${kleur.green('✓')} ${line}`);
    t.stuck.options.forEach((o, i) => out(`    ${i + 1}. ${o.name}  ${kleur.gray(o.note)}`));
    if (problem.detail) out(kleur.gray(`  The exact error: ${problem.detail.split('\n')[0]!.slice(0, 300)}`));
    out(kleur.gray(`  Need help? ${cmd(`squad report ${t.id}`)} saves one file to send.`));
  }
  const happened = await happenedLines(bp, t);
  if (happened.length) {
    out();
    for (const l of happened) out(l);
  }
  if (t.usage?.length) {
    out();
    for (const l of costLines(ticketCost(bp, t, await howPaid(bp)))) out(l);
    out(kleur.gray(`  Each role: ${usedWords(totalOf(t.usage))}`));
    for (const row of usageRows(t.usage)) out(row);
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

/** "$1.23 at API prices, 9 runs": what it would cost at the AI company's API prices. */
function usedWords(t: UsageTotal): string {
  const cost = costWords(t);
  return `${cost ? `${cost} at API prices` : 'cost not reported'}${kleur.gray(`, ${t.runs} ${t.runs === 1 ? 'run' : 'runs'}`)}`;
}

/** One row per role and model level: its cost, its steps, its runs and tokens. */
function usageRows(lines: UsageLine[]): string[] {
  return byRole(lines).flatMap((r) =>
    r.levels.map((l, i) => {
      const name = i ? '' : (AGENTS.find((a) => a.role === r.role)?.name ?? r.role);
      const model = l.model ? `${l.model} (${l.level})` : `${l.level} level`;
      const what = [l.steps.map((s) => stepWords(r.role, s)).join(', '), `${l.total.runs} ${l.total.runs === 1 ? 'run' : 'runs'}`, tokenWords(l.total)].filter(Boolean).join(' · ');
      return `    ${name.padEnd(10)} ${model.padEnd(20)} ${(costWords(l.total) ?? 'not reported').padEnd(12)} ${kleur.gray(what)}`;
    }),
  );
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
  warnIfNoSquad(bp);
  const spin = ui.spinner('Thinking…');
  for (let i = 0; i < 400; i += 1) {
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

/** Ctrl-C while the project's own check runs: it ends with the command, and nothing is merged. */
async function endingSaves<T>(bp: BoardPaths, run: () => Promise<T>): Promise<T> {
  const end = () => endSaves(bp);
  process.once('SIGINT', end);
  process.once('SIGTERM', end);
  try {
    return await run();
  } finally {
    process.off('SIGINT', end);
    process.off('SIGTERM', end);
  }
}

export async function runApprove(ticketId: string): Promise<void> {
  const bp = board();
  const was = requireTicket(bp, ticketId).waiting?.kind;
  const t = await endingSaves(bp, () => approveBeside(bp, ticketId));
  if (was === 'spec') {
    ui.success('Spec approved. The Architect is designing how to build it; you approve that next.');
    ui.info(`Follow it live: squad watch ${t.id}`);
  } else if (t.stage === 'implement') {
    ui.success(`Plan approved${t.decision?.adr ? `. Decision saved as ${t.decision.adr}` : ''}. The Builder started.`);
    ui.info(`Follow it live: squad watch ${t.id}`);
  } else if (t.waiting?.kind === 'stuck') {
    ui.warning(`${t.id} is saved, but it clashes with newer changes. Run: squad decide ${t.id}`);
  } else {
    ui.success(`Proof accepted. ${t.id} is ready for ${t.release}.`);
    const repo = repoFor(readMeta(bp), t);
    const app = t.mergedAt ? projectApps(readMeta(bp)).find((a) => a.repo === repo.path && a.start) : undefined;
    if (app) ui.info(`${t.id} is in ${repo.base} · Run the new version: squad app restart${readMeta(bp).repos?.length ? ` ${app.name}` : ''}`);
    ui.info('Release it when you are ready: squad release');
  }
}

export async function runChange(ticketId: string, words: string[]): Promise<void> {
  const bp = board();
  const was = requireTicket(bp, ticketId).waiting?.kind;
  const text = words.join(' ') || (await input({ message: 'What should change?' }));
  const t = requestChange(bp, ticketId, text);
  ui.success(
    was === 'spec'
      ? 'Sent to the Analyst to update the spec.'
      : t.stage === 'implement'
        ? 'Sent back to the Builder with your note.'
        : t.specApproved
          ? 'Sent to the Architect to update the design.'
          : 'Sent to the Spec writer to update the plan.',
  );
}

/**
 * A change goes through the spec: propose it, then approve or decline what the Analyst wrote (and, for a big one, the
 * Architect's design update). Accepted work only answers questions: the change becomes a new linked ticket or a bug.
 */
export async function runPropose(ticketId: string, words: string[], opts: { approve?: boolean; decline?: boolean; withdraw?: boolean; retry?: boolean; as?: string }): Promise<void> {
  const bp = board();
  warnIfNoSquad(bp);
  if (opts.approve) {
    const t = approveChange(bp, ticketId);
    ui.success(t.activity[0]?.text ?? 'Approved.');
    return;
  }
  if (opts.decline) {
    declineChange(bp, ticketId, words.join(' '));
    ui.success('Declined. The spec stays as it was.');
    return;
  }
  if (opts.withdraw) {
    withdrawChange(bp, ticketId, words.join(' '));
    ui.success('Withdrawn. The spec is back to how it was, and the work carries on without it.');
    return;
  }
  if (opts.retry) {
    retryChange(bp, ticketId);
    ui.success('The Analyst writes the change again.');
    return;
  }
  const text = words.join(' ') || (await input({ message: 'What should change?' }));
  if (opts.as) {
    if (opts.as !== 'ticket' && opts.as !== 'bug') throw new Error('--as is one of: ticket, bug.');
    const made = changeAfterRelease(bp, ticketId, text, opts.as);
    ui.success(`Made ${opts.as === 'bug' ? 'bug' : 'ticket'} ${made.id}, linked to ${ticketId.toUpperCase()}. Follow it: squad watch ${made.id}`);
    return;
  }
  try {
    proposeChange(bp, ticketId, text);
  } catch (err) {
    if (!(err instanceof ReleasedError)) throw err;
    ui.warning(err.message);
    ui.info(`As a new linked ticket: squad propose ${ticketId} --as ticket ${shellQuote(text)}`);
    ui.info(`As a bug report: squad propose ${ticketId} --as bug ${shellQuote(text)}`);
    return;
  }
  ui.success('Proposed. The Analyst writes it into the spec while the work goes on.');
  ui.info(`Then approve it: squad propose ${ticketId} --approve, or decline it: squad propose ${ticketId} --decline`);
}

/** "story", "decision", "step 2" or "done when 1" (also "criterion 1"), as people write them. */
export function parsePart(words: string): PlanPart | null {
  const w = words.trim().toLowerCase();
  if (w === 'story') return { part: 'story' };
  if (w === 'decision') return { part: 'decision' };
  const m = /^(step|done when|criterion)\s+(\d+)$/.exec(w);
  if (!m) return null;
  return { part: m[1] === 'step' ? 'step' : 'criterion', index: Number(m[2]) - 1 };
}

export async function runSendBack(ticketId: string, comments: string[]): Promise<void> {
  const parsed = comments.map((c) => {
    const i = c.indexOf(':');
    const part = i > 0 ? parsePart(c.slice(0, i)) : null;
    if (!part) throw new Error(`Start each comment with the part, like "step 2: use the cache" or "story: …". Not: ${c}`);
    return { ...part, text: c.slice(i + 1).trim() };
  });
  const t = sendBack(board(), ticketId, parsed);
  ui.success(`Sent back with ${parsed.length} ${parsed.length === 1 ? 'comment' : 'comments'}. ${t.status}.`);
}

export async function runEditPlan(ticketId: string, part: string, words: string[]): Promise<void> {
  const p = parsePart(part);
  if (!p || p.part === 'decision') throw new Error('Edit "story", "step N" or "done when N".');
  const text = words.join(' ');
  if (p.part === 'criterion') {
    const m = /^given (.+?),? when (.+?),? then (.+?)\.?$/i.exec(text.trim());
    if (!m) throw new Error('Write it as: Given …, when …, then …');
    editPlan(board(), ticketId, { ...p, criterion: { given: m[1]!, when: m[2]!, then: m[3]! } });
  } else editPlan(board(), ticketId, { ...p, text });
  ui.success('Edited. Approve keeps your wording, and so does a rewrite.');
}

export async function runStartOver(ticketId: string, words: string[]): Promise<void> {
  const text = words.join(' ') || (await input({ message: 'What is the new direction?' }));
  const t = startOver(board(), ticketId, text);
  ui.success(`Starting over. ${t.status}.`);
}

/** Waits for the agent's chat reply (the squad writes it while the board is open) and prints it. */
async function chatAnswer(bp: BoardPaths, id: string): Promise<boolean> {
  const spin = ui.spinner('Thinking…');
  const started = Date.now();
  for (;;) {
    stepSquad(bp);
    const c = requireTicket(bp, id).chat;
    if (!c?.thinking) {
      spin.stop();
      const last = c?.messages.at(-1);
      if (last && last.who !== 'you') {
        out();
        out(`  ${kleur.bold(last.who === 'squad' ? 'squad-kit' : `${last.who[0]!.toUpperCase()}${last.who.slice(1)}`)}`);
        out(last.text.replace(/^/gm, '  '));
        out();
      }
      if (c?.ready) ui.info(c.with === 'analyst' ? 'It thinks it understands. Write the spec: /write' : c.with === 'architect' ? 'It thinks it understands. Write the design: /write' : 'It thinks it understands. Carry on: /done');
      return true;
    }
    if (Date.now() - started > 10 * 60_000) {
      spin.stop();
      ui.warning('No answer yet. Check the board in a moment.');
      return false;
    }
    await sleep(500);
  }
}

/**
 * Talk a ticket through with an agent. Without a message in a terminal, it keeps the talk going until /done or /write.
 * `--ask` is Ask a question: questions only, with whoever knows the story best, and the ticket stays where it is.
 */
export async function runChat(ticketId: string, words: string[], opts: { with?: string; write?: boolean; done?: boolean; stop?: boolean; retry?: boolean; ask?: boolean }): Promise<void> {
  const bp = board();
  warnIfNoSquad(bp);
  let t = requireTicket(bp, ticketId);
  if (opts.done) {
    chatDone(bp, t.id);
    ui.success('Done talking. The squad carries on.');
    return;
  }
  if (opts.stop) {
    chatStop(bp, t.id);
    ui.success('Stopping the answer. The talk stays open.');
    return;
  }
  if (opts.retry) {
    chatRetry(bp, t.id);
    await chatAnswer(bp, t.id);
    return;
  }
  if (opts.write) {
    t = chatWrite(bp, t.id);
    ui.success(`${t.status}. You check it as usual: squad show ${t.id}`);
    return;
  }
  if (!t.chat?.open) {
    const agent = opts.with?.toLowerCase() as AgentName | undefined;
    t = opts.ask ? askQuestion(bp, t.id, agent) : startChat(bp, t.id, agent ?? 'analyst');
    if (opts.ask) ui.info(`Questions only: ${whereItStands(t)}. Asking changes nothing.`);
    await chatAnswer(bp, t.id);
  }
  const text = words.join(' ');
  if (text) {
    sendChat(bp, t.id, text);
    await chatAnswer(bp, t.id);
    return;
  }
  if (!process.stdin.isTTY) return;
  for (;;) {
    const line = (await input({ message: 'You (/write, /done, Enter to leave the chat open)' })).trim();
    if (!line) {
      ui.info(`The chat stays open on the board. Continue: squad chat ${t.id}`);
      return;
    }
    if (line === '/done') return runChat(t.id, [], { done: true });
    if (line === '/write') return runChat(t.id, [], { write: true });
    sendChat(bp, t.id, line);
    await chatAnswer(bp, t.id);
  }
}

/** Shows an agent: its tool, model and the team's instructions per step; or one step's core prompt; or sets them. */
export async function runAgent(role: string, opts: { step?: string; set?: string; prompt?: boolean; ticket?: string }): Promise<void> {
  const bp = board();
  const r = role.toLowerCase() as AgentRole;
  if (!AGENTS.some((a) => a.role === r)) throw new Error(`There is no ${role} agent. Agents: ${AGENTS.map((a) => a.role).join(', ')}.`);
  const steps = STEPS[r];
  if (opts.step && !steps.some((s) => s.id === opts.step)) throw new Error(`The ${r} has no step "${opts.step}". Its steps: ${steps.map((s) => s.id).join(', ')}.`);
  if (opts.set !== undefined) {
    writeAgent(bp, r, opts.step ? { steps: { [opts.step]: opts.set } } : { instructions: opts.set });
    ui.success(`Saved. The ${r} reads it ${opts.step ? `in the ${opts.step} step` : 'in every step'}, on top of its core prompt.`);
    return;
  }
  if (opts.prompt) {
    const core = await corePrompts(bp, r, opts.ticket);
    out(kleur.gray(`  Core prompts, read only, filled in from ${core.ticket.id} "${core.ticket.title}"`));
    for (const p of core.prompts.filter((x) => !opts.step || x.step === opts.step)) {
      out();
      out(kleur.bold(`  ── ${p.name} (${p.step}) ──`));
      out(p.prompt);
      if (p.team) out(`\n${kleur.green(p.team)}`);
    }
    return;
  }
  const a = readAgent(bp, r);
  const clean = (x: string) => withoutComments(x).trim();
  out();
  out(`  ${kleur.bold(AGENTS.find((x) => x.role === r)!.name)}  ${kleur.gray(`${a.tool}${a.model ? ` · ${a.model}` : ''}`)}`);
  out(`  ${kleur.gray('Every step:')} ${clean(a.instructions) || kleur.gray('nothing added')}`);
  for (const s of steps) out(`  ${kleur.gray(`${s.name} (${s.id}):`)} ${clean(a.steps[s.id] ?? '') || kleur.gray('nothing added')}`);
  out();
  ui.info(`See a core prompt: squad agent ${r} --prompt --step ${steps[0]!.id}`);
  ui.info(`Add to a step: squad agent ${r} --step ${steps[0]!.id} --set "..."`);
}

/** Shows the project's Quality setting, or sets it: best, balanced or thrifty. The whole team shares it. */
export async function runQuality(setting: string | undefined): Promise<void> {
  const bp = board();
  const meta = readMeta(bp);
  if (setting === undefined) {
    const now = meta.quality ?? DEFAULT_QUALITY;
    out();
    for (const q of QUALITIES) out(`  ${q === now ? kleur.bold(`● ${q}`) : `○ ${q}`}${' '.repeat(10 - q.length)}${kleur.gray(QUALITY_NOTE[q])}`);
    out();
    ui.info(`Change it: ${cmd('squad config set quality best')} (or balanced, thrifty)`);
    return;
  }
  const q = parseQuality(setting);
  if (!q) throw new Error(`"${setting}" is not a Quality setting. Use best, balanced or thrifty.`);
  writeMeta(bp, { ...meta, quality: q });
  ui.success(`Quality is ${q} now: ${QUALITY_NOTE[q]} The squad uses it from its next step.`);
}

export async function runReply(ticketId: string, words: string[]): Promise<void> {
  const bp = board();
  const t = requireTicket(bp, ticketId);
  const q = t.agentQuestion;
  if (t.waiting?.kind !== 'ask' || !q) throw new Error(`${t.id} has no question waiting for you.`);
  let text = words.join(' ');
  if (!text) {
    out();
    ui.info(`${q.from[0]!.toUpperCase()}${q.from.slice(1)} asks: ${q.text}`);
    if (q.why) ui.info(`Why it matters: ${q.why}`);
    for (const f of q.files ?? []) ui.info(`Attached: ${f}`);
    const choice = await select({
      message: 'Your answer',
      choices: [...q.options.map((o) => ({ name: o, value: o })), { name: 'Let it decide', value: DECIDE_YOURSELF }, { name: 'Write my own', value: '' }],
    });
    text = choice || (await input({ message: 'Your answer' }));
  }
  answerAgent(bp, ticketId, text);
  ui.success('Sent. The squad carries on with your answer.');
}

export async function runChanges(ticketId: string, opts: { full?: boolean }): Promise<void> {
  const c = await ticketChanges(board(), ticketId);
  if (!c.files.length) {
    ui.info(c.from === 'none' ? 'Nothing built yet, so there are no changes to show.' : 'No changes against main.');
    return;
  }
  ui.info(`${c.files.length} files changed${c.from === 'branch' ? ` on ${c.branch}` : ''}:`);
  for (const f of c.files) {
    out(`  ${f.status.padEnd(8)} ${f.path}${f.binary ? '  (binary)' : `  +${f.added} -${f.removed}`}`);
    if (opts.full && f.patch) out(f.patch.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  if (!opts.full) ui.info(`Full diff: squad changes ${ticketId} --full`);
}

export async function runOpen(ticketId: string, opts: { editor?: string }): Promise<void> {
  const r = openInEditor(board(), ticketId, opts.editor);
  ui.success(`Opened ${r.folder} in ${r.editor}.`);
}

export async function runNote(ticketId: string, words: string[], opts: { criterion?: boolean; rule?: boolean }): Promise<void> {
  const bp = board();
  const text = words.join(' ') || (await input({ message: 'What should the squad know?' }));
  const kind = opts.criterion ? 'criterion' : opts.rule ? 'rule' : 'note';
  const t = addNote(bp, ticketId, { text, kind });
  ui.success(`Added to ${t.id}. ${liveNow(t, readUsual(bp)).noteWhen}`);
}

export async function runMessage(ticketId: string, words: string[], opts: { to?: string }): Promise<void> {
  const bp = board();
  const to = (opts.to ?? 'builder').toLowerCase() as AgentName;
  if (!['analyst', 'architect', 'builder', 'reviewer', 'tester'].includes(to)) throw new Error('--to is one of: analyst, architect, builder, reviewer, tester.');
  const text = words.join(' ') || (await input({ message: `Your message to the ${to}` }));
  const t = addNote(bp, ticketId, { text, to });
  ui.success(`Sent. ${liveNow(t, readUsual(bp)).noteWhen}`);
}

export async function runTakeOver(ticketId: string): Promise<void> {
  const t = takeOver(board(), ticketId);
  ui.success(`${t.id} is yours. The squad stops and waits.`);
  out();
  out(`  Open the Builder's session in its copy of the code:`);
  out(`    ${kleur.bold(`cd ${shellQuote(t.takenOver!.cwd)} && claude --resume ${t.takenOver!.session}`)}`);
  out();
  ui.info(`When you are done: squad give-back ${t.id} "what you changed"`);
}

export async function runGiveBack(ticketId: string, words: string[]): Promise<void> {
  const t = giveBack(board(), ticketId, words.join(' '));
  ui.success(`Given back. The checks, review and proof run again on your changes. Follow it: squad watch ${t.id}`);
}

export async function runTakeBack(ticketId: string, opts: { reason: string }): Promise<void> {
  const t = takeBack(board(), ticketId, opts.reason);
  ui.success(`${t.id} is yours now. The reason stays on the ticket.`);
}

export async function runHandOver(ticketId: string, words: string[], opts: { note?: string }): Promise<void> {
  const bp = board();
  const to = words.join(' ').trim() || (await input({ message: 'Hand it over to (their name, as their board shows it)' }));
  const t = await handOver(bp, ticketId, { to, note: opts.note });
  ui.success(`${t.id} is ${t.owner}'s now.${t.branch && readMeta(bp).engine === 'live' ? ` The work so far and the documents are pushed on ${t.branch}.` : ''}`);
  out();
  out(`  ${t.owner}'s squad carries on from the branch: the Builder starts a fresh chat from the spec, the design and the code.`);
  out(kleur.gray('  Live progress, agent chats and screenshots stay on this computer. Your squad stops working on it.'));
  out();
}

/** "The Architect suggests changing the test command from `npm test` to `vitest run`". */
export function testChangeLine(c: { from: string; to: string }): string {
  return `The Architect suggests changing the test command from "${c.from}" to "${c.to}"`;
}

/** The Architect's change to the test command: use it, or keep the current one. Without a choice, it says what waits. */
export async function runTestCommand(ticketId: string, opts: { use?: boolean; keep?: boolean }): Promise<void> {
  const bp = board();
  const t = requireTicket(bp, ticketId);
  if (opts.use && opts.keep) throw new Error('Pick one: --use or --keep.');
  if (!opts.use && !opts.keep) {
    if (!t.testChange) {
      ui.info(`${t.id} has no change to the test command waiting.`);
      return;
    }
    out();
    out(`  ${testChangeLine(t.testChange)}.`);
    out(kleur.gray(t.testChange.ask ? '  squad-kit cannot tell, so the checks keep using the current one until you choose.' : '  squad-kit tries it at the next checks and keeps what works. You can choose now.'));
    out(`  ${cmd(`squad test-command ${t.id} --use`)}   or   ${cmd(`squad test-command ${t.id} --keep`)}`);
    out();
    return;
  }
  const c = t.testChange;
  decideTestCommand(bp, t.id, Boolean(opts.use));
  ui.success(opts.use ? `The test command is now "${c?.to}".` : `Kept the test command "${c?.from}".`);
}

export async function runDecide(ticketId: string, choice?: string, opts: { note?: string; reason?: string } = {}): Promise<void> {
  const bp = board();
  const t = requireTicket(bp, ticketId);
  if (!t.stuck || t.waiting?.kind !== 'stuck') throw new Error(`${t.id} is not stuck.`);
  let index = choice ? Number(choice) - 1 : NaN;
  const ask = Number.isNaN(index);
  if (ask) {
    out();
    out(`  ${t.stuck.question}`);
    for (const line of t.stuck.points ?? []) out(`  - ${line}`);
    index = await select({
      message: 'What should happen?',
      choices: t.stuck.options.map((o, i) => ({ name: `${o.name}  ${kleur.gray(o.note)}`, value: i })),
    });
  }
  const way = t.stuck.options[index]?.do;
  let { note, reason } = opts;
  if ((way === 'continue' || way === 'skip-hooks') && !reason?.trim()) {
    if (!ask) throw new Error('Add --reason "why". It shows on the ticket, the pull request and the release notes.');
    reason = await input({ message: `${way === 'continue' ? 'Why continue anyway?' : "Why save without the project's own check?"} (shows on the ticket, the pull request and the release notes)`, validate: (v) => (v.trim() ? true : 'Write a short reason.') });
  }
  if (way === 'retry' && ask && note === undefined) note = await input({ message: 'A note for the squad (optional, Enter to skip)' });
  if (way === 'yourself' && t.worktree) out(`  The ticket's copy: ${t.worktree}`);
  await endingSaves(bp, () => decideStuckBeside(bp, t.id, index, { note, reason }));
  ui.success(way === 'yourself' ? 'OK. The checks, review and proof run again on your fix.' : `Decided: "${t.stuck.options[index]?.name}".`);
}

export async function runWatch(ticketId: string): Promise<void> {
  const bp = board();
  warnIfNoSquad(bp);
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

/** 1.5.0 and v1.5.0 are one release, in every command. */
function withV(version: string | undefined): string | undefined {
  return version && (version.startsWith('v') ? version : `v${version}`);
}

export async function runRelease(version: string | undefined, opts: { yes?: boolean; pushAgain?: boolean; markSent?: boolean; reason?: string; goOn?: string; anyway?: boolean; without?: string[]; putBack?: string[] }): Promise<void> {
  const bp = board();
  const named = withV(version);
  // Words that do nothing here say so, or a person would think they counted.
  if (!opts.markSent) {
    if (opts.reason !== undefined) ui.warning('--reason only counts with --mark-sent, so it is left out here.');
    if (opts.anyway) ui.warning('--anyway only counts with --mark-sent, so it is left out here.');
  }
  if (opts.goOn !== undefined && !opts.goOn.trim()) throw new Error(`Say why it goes on: ${cmd('squad release --go-on "<why>"')}`);
  if (opts.pushAgain) return runPushAgain(bp, named);
  if (opts.markSent) {
    const target = listReleases(bp).find((r) => r.unpushed?.length && (!named || r.version === named));
    if (!target) throw new Error(named ? `${named} has nothing left to push.` : 'Every release is pushed already.');
    if (!opts.reason?.trim()) throw new Error(`Say how it got there: ${cmd(`squad release ${target.version} --mark-sent --reason "<how>"`)}`);
    try {
      const r = await markReleaseSent(bp, target.version, { reason: opts.reason, ...(opts.anyway ? { anyway: true } : {}) });
      ui.success(`${r.version} is marked as sent. Its tickets are closed.`);
      for (const l of (r.log ?? []).slice(-1)) if (!l.ok) ui.warning(l.text);
    } catch (err) {
      if (err instanceof SentNotSure) throw new Error(`${err.message} To mark it anyway, add: ${cmd('--anyway')}`);
      throw err;
    }
    return;
  }
  let draft = draftRelease(bp);
  if (!draft || (named && draft.version !== named)) {
    throw new Error('There is no release ready to go out.');
  }
  // Put back, or take out before it is made: its code stays in main, and it goes out with the next release.
  if (opts.putBack?.length) {
    for (const x of opts.putBack) putBackInRelease(bp, draft.version, x);
    ui.success(`${opts.putBack.map((x) => x.toUpperCase()).join(', ')} ${opts.putBack.length === 1 ? 'is' : 'are'} back in ${draft.version}.`);
    return;
  }
  for (const x of opts.without ?? []) {
    draft = await takeOutOfRelease(bp, draft.version, x);
    ui.success(`Took ${x.toUpperCase()} out of ${draft.version}. It goes out with the next release. Put it back: ${cmd(`squad release --put-back ${x.toUpperCase()}`)}`);
  }
  const tickets = listTickets(bp).filter((t) => draft!.tickets.includes(t.id));
  out();
  out(`  ${kleur.bold(`Release ${draft.version}`)}  ${kleur.gray(`${draft.from} → ${draft.version}`)}`);
  out();
  for (const t of tickets) out(`    ${kleur.green('✓')} ${id(t.id)}  ${t.title}`);
  for (const x of draft.out ?? []) out(kleur.gray(`    ○ ${x}  taken out: it goes out with the next release`));
  out();
  for (const l of (draft.notes.trim() || composeNotes(bp, draft)).split('\n')) out(`  ${kleur.gray(l.replace(/\*\*/g, ''))}`);
  out();
  const meta = readMeta(bp);
  if (meta.engine === 'live') {
    const targets = new Map(tickets.map((t) => [repoFor(meta, t).path, repoFor(meta, t)]));
    out(`  ${kleur.bold('This release changes these branches:')}`);
    for (const r of targets.values()) {
      out(`    ${r.path === '.' ? 'project' : r.path}: ${r.base} ${r.remote ? amber(`→ pushed to ${r.remote}`) : kleur.gray('(no remote, stays on this computer)')}`);
    }
    out();
  }
  if (!opts.yes && !(await confirm({ message: `Release ${draft.version} now?`, default: false }))) {
    ui.info('Not released.');
    return;
  }
  const spin = ui.spinner(`Releasing ${draft.version}…`);
  // A failed release gate stops it, with what happened; the same command with --go-on goes past it, with the reason on the record.
  const r = await releaseVersion(bp, draft.version, opts.goOn)
    .catch((err: Error) => {
      if (readRelease(bp, draft!.version)?.gateStop?.length) throw new Error(`${err.message} To go on anyway, say why: ${cmd(`squad release ${draft!.version} --go-on "<why>"`)}`);
      throw err;
    })
    .finally(() => spin.stop());
  if (r.unpushed?.length) ui.warning(`Released ${r.version} on this computer, but it did not reach your team's shared copy of the code. Send it with: squad release ${r.version} --push-again`);
  else ui.success(`Released ${r.version}.`);
  if (r.log) {
    for (const l of r.log) (l.ok ? ui.success : ui.warning)(l.text);
  } else {
    const tag = kleur.gray(' (shown, not run, on a demo board)');
    if (r.addons.changelog) ui.success(`Changelog updated${tag}`);
    if (r.addons.tag) ui.success(`Tagged ${r.version} in git${tag}`);
    if (r.addons.pipeline) ui.success(`Pipeline started${tag}`);
  }
  if (r.addons.whatsapp && r.whatsappDraft) {
    out();
    out(kleur.gray('  WhatsApp note for your manager. Copy it and send it yourself:'));
    out();
    for (const l of r.whatsappDraft.split('\n')) out(`  ${l}`);
    out();
  }
}

/** A release whose push failed: send its commits and tags again (the newest such release, or the one named). */
async function runPushAgain(bp: BoardPaths, version: string | undefined): Promise<void> {
  const target = listReleases(bp).find((r) => r.unpushed?.length && (!version || r.version === version));
  if (!target) throw new Error(version ? `${version} has nothing left to push.` : 'Every release is pushed already.');
  const spin = ui.spinner(`Pushing ${target.version}…`);
  const r = await pushReleaseAgain(bp, target.version).finally(() => spin.stop());
  if (r.unpushed?.length) {
    for (const u of r.unpushed) ui.warning(`${u.repo === '.' ? '' : `${u.repo}: `}${u.plain ?? `Push to ${u.remote} failed again: ${u.error}`}`);
    throw new Error(`${r.version} is still not pushed. Fix the problem above, then run: squad release ${r.version} --push-again`);
  }
  ui.success(`Sent ${r.version}. Its tickets are closed.`);
}

export async function runBug(words: string[], opts: { in?: string; severity?: string; how?: string; expected?: string }): Promise<void> {
  const bp = board();
  const what = words.join(' ') || (await input({ message: 'What happened?' }));
  const severity = (['stops-work', 'annoying', 'small'].includes(opts.severity ?? '') ? opts.severity : 'annoying') as Ticket['severity'];
  const t = reportBug(bp, { what, how: opts.how, expected: opts.expected, severity, foundIn: opts.in });
  ui.success(`${t.id} created${t.foundIn ? `, linked to ${t.foundIn}` : ''}. Triage is sorting it.`);
}

interface NewOptions {
  ask?: string;
  priority?: Ticket['priority'];
  bug?: boolean;
  severity?: string;
  express?: boolean;
  talk?: boolean;
  full?: boolean;
  criteria?: string[];
  rule?: string[];
  edge?: string[];
  attach?: string[];
  from?: string;
}

export async function runNew(words: string[], opts: NewOptions): Promise<void> {
  const bp = board();
  const files = (opts.attach ?? []).map((f) => {
    if (!fs.existsSync(f)) throw new Error(`No file at ${f}`);
    return { name: path.basename(f), data: fs.readFileSync(f).toString('base64') };
  });
  let fields: NewTicketInput = {
    title: words.join(' '),
    ask: opts.ask,
    priority: opts.priority,
    kind: opts.bug ? 'bug' : 'feature',
    ...(opts.bug && ['stops-work', 'annoying', 'small'].includes(opts.severity ?? '') ? { severity: opts.severity as Ticket['severity'] } : {}),
    track: opts.express ? 'express' : 'full',
    talkFirst: Boolean(opts.talk),
    criteria: opts.criteria,
    rules: opts.rule,
    edgeCases: opts.edge,
  };
  if (opts.from !== undefined) {
    ui.info('The Analyst is filling in the ticket…');
    const d = await draftTicket(bp, { text: opts.from, files });
    const list = (head: string, items: string[]) => (items.length ? `\n${kleur.bold(head)}\n${items.map((x) => `  - ${x}`).join('\n')}` : '');
    console.log(
      `\n${kleur.bold(d.title)} ${kleur.dim(`(${d.kind}, ${d.priority}, ${d.track === 'express' ? 'Express' : 'Full'} track suggested)`)}\n${d.ask}` +
        list('Acceptance criteria', d.criteria) +
        list('Business rules', d.rules) +
        list('Edge cases', d.edgeCases) +
        list('Still unclear (the Analyst will ask)', d.gaps) +
        '\n',
    );
    if (!(await confirm({ message: 'Create this ticket?', default: true }))) {
      ui.info('Not created.');
      return;
    }
    // What the person typed as options wins over the draft.
    fields = {
      title: fields.title || d.title,
      ask: fields.ask ?? d.ask,
      priority: fields.priority ?? d.priority,
      kind: opts.bug ? 'bug' : d.kind,
      track: opts.express ? 'express' : opts.full ? 'full' : d.track,
      talkFirst: Boolean(opts.talk),
      criteria: [...d.criteria, ...(fields.criteria ?? [])],
      rules: [...d.rules, ...(fields.rules ?? [])],
      edgeCases: [...d.edgeCases, ...(fields.edgeCases ?? [])],
    };
  }
  const title = fields.title || (await input({ message: 'Ticket title:' }));
  const t = createTicket(bp, { ...fields, title, files });
  ui.success(t.track === 'express' ? `${t.id} created on the Express track. The squad goes straight to the plan.` : `${t.id} created. The Analyst is reading it.`);
}

export async function runUnstick(ticketId: string, opts: { keepWaiting?: boolean; freePort?: boolean }): Promise<void> {
  const bp = board();
  if (opts.freePort) {
    const port = requireTicket(bp, ticketId).quiet?.port;
    if (port?.ours && !(await confirm({ message: `Stop the program on port ${port.port}, which squad-kit started, and try the step again?`, default: true }))) {
      ui.info('Nothing was stopped.');
      return;
    }
    const t = await freePortAndRetry(bp, ticketId);
    ui.success(`Freed ${port ? `port ${port.port}` : 'the port'} on ${t.id}. The step starts again, with the work so far.`);
    return;
  }
  if (opts.keepWaiting) {
    const t = keepWaiting(bp, ticketId);
    ui.success(`OK, waiting. squad-kit stays quiet about ${t.id} for 10 minutes.`);
    return;
  }
  const t = endStuckCommand(bp, ticketId);
  ui.success(`Ended the stuck command on ${t.id}. The squad carries on from there.`);
}

export async function runStop(ticketId: string, opts: { again?: boolean } = {}): Promise<void> {
  const bp = board();
  if (opts.again) {
    const t = restartStep(bp, ticketId);
    ui.success(`Stopping the step on ${t.id}, then it starts again. The work so far is kept.`);
    return;
  }
  const t = stopTicket(bp, ticketId);
  ui.success(`Stopping the squad on ${t.id}. The work so far is kept.`);
}

/** The sprint's open stories and bugs on the tracker, with the ticket each one became. */
export async function runBacklog(opts: { sprint?: string; all?: boolean }): Promise<void> {
  const bp = board();
  const tracker = trackerFor(bp);
  if (!tracker) throw new Error('No tracker is set up for this project. Run: squad config set tracker');
  const sprints = tracker.abilities.sprints ? await tracker.sprints() : [];
  const wanted = opts.sprint?.toLowerCase();
  const sprint = opts.all ? undefined : wanted ? sprints.find((s) => s.name.toLowerCase() === wanted || s.path.toLowerCase() === wanted) : sprints.find((s) => s.current) ?? sprints[0];
  if (wanted && !sprint) throw new Error(`No sprint called "${opts.sprint}". Sprints: ${sprints.map((s) => s.name).join(', ')}`);
  const items = await tracker.list(sprint ? { sprint: sprint.path } : {});
  const tickets = listTickets(bp).filter((t) => t.source.type === tracker.name);
  out();
  out(`  ${kleur.bold('Backlog')} ${kleur.gray(`${sprint ? sprint.name : 'everything open'} · ${items.length} open`)}`);
  out();
  const w = Math.min(60, Math.max(10, ...items.map((i) => i.title.length)));
  for (const i of items) {
    const t = tickets.find((x) => x.source.id === i.id || x.source.ref === i.ref);
    const title = i.title.length > w ? `${i.title.slice(0, w - 1)}…` : i.title.padEnd(w);
    const kind = i.isBug ? kleur.red('bug ') : '    ';
    const where = t ? kleur.gray(`${t.id} ${t.stage === 'done' ? 'released' : STAGE_NAME[t.stage]}`) : cmd(`squad pull ${i.id}`);
    out(`  ${id(i.id.padStart(5))}  ${kind}${title}  ${kleur.gray(String(i.points ?? '').padStart(2))}  ${kleur.gray(i.state.padEnd(9))} ${where}`);
  }
  out();
}

export async function runPull(ref: string): Promise<void> {
  const bp = board();
  const t = await pullTicket(bp, ref);
  ui.success(`${t.id} pulled from ${t.source.ref}: ${t.title}`);
}

export interface DemoOptions {
  speed?: number;
  project?: string;
  port?: number;
  open?: boolean;
  keep?: boolean;
  token?: string;
  firstRun?: boolean;
}

/** Sets up a sample board (and a minimal .squad/ if needed), then opens the console. */
export { demoFolder };

export async function runDemo(opts: DemoOptions): Promise<void> {
  const root = demoFolder();
  const paths = buildPaths(root);
  if (!fs.existsSync(paths.configFile)) {
    fs.mkdirSync(paths.squadDir, { recursive: true });
    saveConfig(paths.configFile, { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: opts.project ?? 'Case portal' } });
  }
  const bp = boardPaths(paths.squadDir);
  if (opts.firstRun) {
    seedDemoBoard(bp, { speed: opts.speed, project: opts.project, firstRun: true });
    ui.success('Sample project at its first open: follow the setup, then check the Overview.');
  } else if (!opts.keep || !boardExists(bp)) {
    seedDemoBoard(bp, { speed: opts.speed, project: opts.project });
    ui.success('Sample board ready: 14 tickets, 4 releases and 5 saved decisions.');
  }
  // The app opens the sample board from its own folder.
  process.chdir(root);
  await runConsole({ port: opts.port, open: opts.open, token: opts.token, demo: true });
}

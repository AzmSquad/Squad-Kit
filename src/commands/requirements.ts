import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { Command } from 'commander';
import { confirm, input, select, Separator } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { isSquadExit } from '../core/cli-exit.js';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { AnswerInput, UploadedFile } from '../board/actions.js';
import type { Criterion } from '../board/types.js';
import type { BreakdownEstimate, BreakdownStatus, BreakdownStory, BreakdownView, StoryProgress } from '../board/requirements-types.js';
import { breakdownRows, readBreakdown, refWords, viewBreakdown } from '../board/requirements.js';
import {
  SKIP_CHOICE,
  addBreakdown,
  addItem,
  answerBreakdown,
  approveBreakdown,
  approveProblems,
  askAboutQuestion,
  changeDecided,
  deleteBreakdown,
  editItem,
  moveItem,
  redoItem,
  removeItem,
  renameBreakdown,
  retryBreakdown,
  skipBreakdownQuestions,
  startStory,
  stopBreakdown,
  type ItemPatch,
} from '../board/requirements-actions.js';
import { setBuild } from '../board/requirements-build.js';
import { requestSend, sendPreview } from '../board/requirements-send.js';
import { squadRunsElsewhere } from '../board/lock.js';
import { tick } from '../board/engine.js';
import { board } from './board.js';

/**
 * `squad requirements …`: every button of the Requirements page, from the terminal. Each command is one engine call,
 * the same one the board's REST route makes, and prints what changed in plain words.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const STATUS_WORDS: Record<BreakdownStatus, string> = {
  reading: 'Analyst reading',
  questions: 'Questions for you',
  drafting: 'Analyst writing the breakdown',
  ready: 'Ready for you to approve',
  approved: 'Approved',
  failed: 'Stopped',
};

function statusWords(v: Pick<BreakdownView, 'status' | 'state'>): string {
  return v.status === 'approved' && v.state.build?.on ? 'Building continuously' : STATUS_WORDS[v.status];
}

/** On a sample board with no board open, the terminal plays the scripted Analyst itself while it waits. */
function stepDemo(bp: BoardPaths): void {
  if (squadRunsElsewhere(bp)) return;
  if (readMeta(bp).engine === 'demo') tick(bp);
}

function warnIfNoSquad(bp: BoardPaths, what = 'The Analyst works'): void {
  if (readMeta(bp).engine === 'live' && !squadRunsElsewhere(bp)) ui.warning(`${what} while the board is open. Run \`squad console\` in another tab.`);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function countWords(c: BreakdownView['counts']): string {
  return `${plural(c.epics, 'epic')}, ${plural(c.features, 'feature')}, ${plural(c.stories, 'story', 'stories')}`;
}

function timeWords(minutes: number): string {
  if (minutes < 90) return `about ${Math.max(1, Math.round(minutes))} min`;
  const h = Math.round(minutes / 30) / 2;
  return `about ${h} hours`;
}

/** "About $140 and 6 hours to build, 2 at a time (based on 9 finished tickets)". */
export function estimateWords(e: BreakdownEstimate): string {
  if (!e.stories) return 'Every story is merged.';
  const cost = e.costUsd !== undefined ? `$${Math.round(e.costUsd)} and ` : '';
  const what = `About ${cost}${timeWords(e.minutes).replace(/^about /, '')} to build ${plural(e.stories, 'story', 'stories')}, ${e.parallel} at a time`;
  return `${what} (${e.rough ? 'a rough guess: no finished tickets yet' : `based on ${plural(e.basedOn, 'finished ticket')}`})`;
}

/** "Reading the document, part 2 of 5. Found 3 epics and 6 features so far". */
export function jobWords(v: BreakdownView): string | null {
  const j = v.state.job;
  if (!j || (j.status !== 'pending' && j.status !== 'running' && j.status !== 'stopping')) return null;
  if (j.status === 'stopping') return 'Stopping the Analyst…';
  const at = j.at && j.step === 'read' && j.at.done ? `, ${j.at.unit} ${j.at.done} of ${j.at.of}` : '';
  const f = j.found;
  const found = f && (f.epics || f.features) ? `. Found ${plural(f.epics, 'epic')} and ${plural(f.features, 'feature')}${f.stories ? ` and ${plural(f.stories, 'story', 'stories')}` : ''} so far` : '';
  return `${j.now ?? 'Waiting for the Analyst'}${at}${found}`;
}

function rows(): void {
  const bp = board();
  const list = breakdownRows(bp);
  out();
  if (!list.length) {
    out(`  No breakdowns yet. Add a BRD: ${cmd('squad requirements add "<file>"')}`);
    out();
    return;
  }
  for (const r of list) {
    out(`  ${kleur.bold(r.id)}  ${r.title}  ${kleur.yellow(r.status === 'approved' && r.building ? 'Building continuously' : STATUS_WORDS[r.status])}`);
    out(kleur.gray(`        ${countWords(r.counts)}${r.counts.merged ? `, ${r.counts.merged} merged` : ''}${r.counts.needsYou ? `, ${r.counts.needsYou} need you` : ''} · from ${r.source.name} · ${r.owner}`));
  }
  out();
}

const STATE_MARK: Record<StoryProgress['state'], string> = {
  'not-started': kleur.gray('○'),
  next: kleur.cyan('›'),
  waits: kleur.gray('…'),
  building: kleur.cyan('●'),
  'needs-you': kleur.yellow('!'),
  merged: kleur.green('✓'),
  released: kleur.green('✓'),
};

function storyLine(s: BreakdownStory, p: StoryProgress | undefined, map: boolean): string {
  const needs = s.dependsOn.length ? kleur.gray(` needs ${s.dependsOn.join(', ')}`) : '';
  const from = s.ref?.section ? kleur.gray(` From ${s.ref.section}`) : '';
  if (!map) return `${kleur.bold(s.key)}  ${s.title}  ${kleur.gray(s.size)}${needs}${from}${s.ticket ? kleur.gray(` · ${s.ticket}`) : ''}`;
  const state = p ? `${STATE_MARK[p.state]} ${p.line}` : '';
  return `${kleur.bold(s.key)}  ${s.title}${needs}  ${state}${s.ticket ? kleur.gray(` · ${s.ticket}`) : ''}${s.tracker ? kleur.gray(` · ${s.tracker.ref}`) : ''}`;
}

/** The tree: epics, features and stories with their keys; with `map`, each story's needs and where it is. */
export function treeLines(v: BreakdownView, map = false): string[] {
  const lines: string[] = [];
  const progress = new Map(v.progress.map((p) => [p.key, p]));
  const merged = (stories: BreakdownStory[]) => stories.filter((s) => ['merged', 'released'].includes(progress.get(s.key)?.state ?? '')).length;
  for (const e of v.epics) {
    const all = [...e.features.flatMap((f) => f.stories), ...e.stories];
    lines.push(`${kleur.gray('Epic')} ${kleur.bold(e.key)}  ${kleur.bold(e.title)}${map ? kleur.gray(`  ${merged(all)} of ${all.length}`) : e.goal ? kleur.gray(`  ${e.goal}`) : ''}`);
    e.features.forEach((f, fi) => {
      const lastF = fi === e.features.length - 1 && !e.stories.length;
      lines.push(`${map ? (lastF ? '└─ ' : '├─ ') : '  '}${kleur.gray('Feature')} ${kleur.bold(f.key)}  ${f.title}${map ? kleur.gray(`  ${merged(f.stories)}/${f.stories.length}`) : ''}`);
      f.stories.forEach((s, si) => {
        const bar = map ? `${lastF ? '   ' : '│  '}${si === f.stories.length - 1 ? '└─ ' : '├─ '}` : '    ';
        lines.push(`${bar}${storyLine(s, progress.get(s.key), map)}`);
      });
    });
    e.stories.forEach((s, si) => lines.push(`${map ? (si === e.stories.length - 1 ? '└─ ' : '├─ ') : '  '}${storyLine(s, progress.get(s.key), map)}`));
    lines.push('');
  }
  return lines;
}

function whoWords(bp: BoardPaths, name: string): string {
  return name.trim().toLowerCase() === readMeta(bp).user.name.trim().toLowerCase() ? 'you' : name;
}

function dayWords(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? 'today' : `on ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`;
}

/** A tracker's item type, many of them: "User Stories", "Product Backlog Items", "Requirements". */
function many(type: string): string {
  if (/[^aeiou]y$/i.test(type)) return `${type.slice(0, -1)}ies`;
  return /s$/i.test(type) ? type : `${type}s`;
}

/** Build continuously and the send, while either is going on or has something to say. */
export function buildSendLines(v: BreakdownView): string[] {
  const lines: string[] = [];
  const b = v.state.build;
  if (b?.on) lines.push(kleur.cyan(`Building continuously, ${v.estimate.parallel} at a time: ${v.counts.merged} of ${v.counts.stories} merged, ${v.counts.building} building${v.counts.needsYou ? `, ${v.counts.needsYou} need you` : ''}`));
  if (b?.on && b.held) lines.push(kleur.yellow(b.held));
  const s = v.state.sync;
  const to = v.tracker?.label ?? 'the tracker';
  if (s?.status === 'pending' || s?.status === 'running') lines.push(kleur.cyan(`Sending to ${to}: ${sendProgress(s)}`));
  else if (s?.status === 'failed') lines.push(kleur.yellow(`The send to ${to} stopped: ${s.error ?? 'no reason given'}`));
  return lines;
}

/** "14 of 30 items, then 20 links": a send's progress in the Send dialog's units. */
function sendProgress(s: NonNullable<BreakdownView['state']['sync']>): string {
  const i = s.items;
  const l = s.links;
  if (!i || !l) return `${s.done} of ${s.of}`;
  if (i.done < i.of || !l.of) return `${i.done} of ${plural(i.of, 'item')}${l.of ? `, then ${plural(l.of, 'link')}` : ''}`;
  return `${plural(i.of, 'item')} sent, ${l.done} of ${plural(l.of, 'link')}`;
}

/** What to run next, for the breakdown as it is. */
function nextLine(v: BreakdownView): string | null {
  const j = v.state.job;
  if (j?.heldFor === 'budget') return `Carry on: ${cmd(`squad requirements retry ${v.id}`)}   or stop it: ${cmd(`squad requirements stop ${v.id}`)}`;
  if (j && (j.status === 'pending' || j.status === 'running')) return `Stop it: ${cmd(`squad requirements stop ${v.id}`)}`;
  if (v.status === 'questions') return `Answer them: ${cmd(`squad requirements answer ${v.id}`)}   or let the Analyst decide: ${cmd(`squad requirements answer ${v.id} --skip`)}`;
  if (v.status === 'failed') return `Try again: ${cmd(`squad requirements retry ${v.id}`)}`;
  if (v.status === 'ready') return `Edit any part (${cmd(`squad requirements edit ${v.id} S-1 --title "…"`)}), then ${cmd(`squad requirements approve ${v.id}`)}`;
  if (v.status === 'approved' && v.state.build?.on) return `Pause: ${cmd(`squad requirements build ${v.id} --pause`)}`;
  if (v.status === 'approved') return `Build it story by story: ${cmd(`squad requirements build ${v.id}`)}   or start one: ${cmd(`squad requirements start ${v.id} <story>`)}`;
  return null;
}

async function show(id: string, opts: { map?: boolean }): Promise<void> {
  const bp = board();
  stepDemo(bp);
  const v = await viewBreakdown(bp, id);
  const s = v.source;
  out();
  out(`  ${kleur.bold(v.id)}  ${kleur.bold(v.title)}  ${kleur.yellow(statusWords(v))}`);
  out(kleur.gray(`  From ${s.name}${s.pages ? `, ${plural(s.pages, s.kind === 'pdf' ? 'page' : 'part')}` : ''}${s.pictures ? `, ${plural(s.pictures, 'picture')}` : ''}, added by ${whoWords(bp, s.addedBy)} ${dayWords(s.addedAt)}`));
  if (!v.mine) out(kleur.gray(`  ${v.owner}'s breakdown: only their squad builds it. You see it read only.`));
  const job = jobWords(v);
  if (job) out(`  ${kleur.cyan(job)}`);
  for (const l of buildSendLines(v)) out(`  ${l}`);
  if (v.status === 'failed' && v.error) out(`  ${kleur.yellow(v.error)}`);
  if (v.summary) out(`\n  ${v.summary}`);
  if (v.status === 'questions') {
    out();
    out(`  ${kleur.bold(`The Analyst has ${plural(v.questions.length, 'question')}`)}`);
    v.questions.forEach((q, i) => {
      out(`  ${i + 1}. ${kleur.yellow(q.kind === 'clash' ? 'Two parts clash' : 'Missing in the BRD')}${q.refs?.length ? kleur.gray(` ${q.refs.map(refWords).join(' and ')}`) : ''}${q.impact ? kleur.gray(` · ${q.impact}`) : ''}`);
      out(`     ${q.text}`);
      for (const o of q.options) out(kleur.gray(`     - ${o}`));
      if (q.answer) out(kleur.green(`     Answer: ${q.answer.value ?? q.answer.choice}`));
    });
  }
  if (v.epics.length) {
    out();
    out(`  ${countWords(v.counts)}${v.counts.merged ? ` · ${v.counts.merged} merged` : ''}${v.counts.building ? ` · ${v.counts.building} building` : ''}${v.counts.needsYou ? ` · ${v.counts.needsYou} need you` : ''}`);
    if (!opts.map) out(kleur.gray(`  ${estimateWords(v.estimate)}`));
    if (v.decided.length || v.leftOut.length) out(kleur.gray(`  ${plural(v.decided.length, 'thing')} decided for you · ${plural(v.leftOut.length, 'part')} left out`));
    out();
    for (const l of treeLines(v, opts.map)) out(l ? `  ${l}` : '');
    if (!opts.map) {
      if (v.leftOut.length) {
        out(`  ${kleur.bold('Left out')}`);
        for (const l of v.leftOut) out(`  - ${l.text}${kleur.gray(`: ${l.why}`)}`);
        out();
      }
      if (v.decided.length) {
        out(`  ${kleur.bold('Decided for you')}`);
        for (const d of v.decided) {
          const by = d.by === 'answer' ? 'from your answer' : d.by[0]!.toUpperCase() + d.by.slice(1);
          out(`  ${kleur.bold(d.id)} ${kleur.gray(`${[d.item, d.ticket].filter(Boolean).join(' · ')}${d.item || d.ticket ? ' · ' : ''}${by}`)}  ${d.changed ? `${d.changed.text} ${kleur.gray(`(was: ${d.text})`)}` : d.text}`);
        }
        out();
      }
      if (v.status === 'ready') {
        const problems = approveProblems(v);
        for (const p of problems.slice(0, 5)) out(`  ${kleur.yellow('!')} ${p}`);
      }
    }
  }
  const next = nextLine(v);
  if (next) out(`  ${next}`);
  out();
}

/** "Given a free slot | When I pick it | Then it is held", or "Given a free slot, when I pick it, then it is held". */
export function parseCriterion(text: string): Criterion {
  const bar = text.split('|').map((x) => x.trim().replace(/^(given|when|then)\s+/i, ''));
  if (bar.length === 3 && bar.every(Boolean)) return { given: bar[0]!, when: bar[1]!, then: bar[2]! };
  const m = /^\s*given\s+(.+?),?\s+when\s+(.+?),?\s+then\s+(.+?)\.?\s*$/i.exec(text);
  if (m) return { given: m[1]!, when: m[2]!, then: m[3]! };
  throw new Error(`Write a "done when" check as "Given …, when …, then …" or "given | when | then": ${text}`);
}

function keysOf(list: string[] | string | undefined): string[] {
  return (Array.isArray(list) ? list : list ? [list] : []).flatMap((x) => x.split(/[\s,]+/)).filter(Boolean);
}

interface PartOptions {
  title?: string;
  goal?: string;
  summary?: string;
  story?: string;
  size?: string;
  /** False from --no-needs. */
  needs?: string[] | false;
  criterion?: string[];
}

function patchFrom(o: PartOptions): ItemPatch {
  return {
    ...(o.title !== undefined ? { title: o.title } : {}),
    ...(o.goal !== undefined ? { goal: o.goal } : {}),
    ...(o.summary !== undefined ? { summary: o.summary } : {}),
    ...(o.story !== undefined ? { story: o.story } : {}),
    ...(o.size !== undefined ? { size: o.size } : {}),
    ...(o.needs === false ? { needs: [] } : o.needs?.length ? { needs: keysOf(o.needs) } : {}),
    ...(o.criterion?.length ? { criteria: o.criterion.map(parseCriterion) } : {}),
  };
}

function file(f: string): UploadedFile {
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error(`No file at ${f}`);
  return { name: path.basename(f), data: fs.readFileSync(f).toString('base64') };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

async function add(doc: string | undefined, opts: { name?: string; with?: string[]; paste?: boolean }): Promise<void> {
  const bp = board();
  if (!doc && !opts.paste) throw new Error('Name the BRD file, or paste its text: squad requirements add --paste < brd.md');
  const text = opts.paste ? await readStdin() : undefined;
  const b = addBreakdown(bp, { ...(doc && !opts.paste ? { file: file(doc) } : {}), ...(text !== undefined ? { text } : {}), ...(opts.name ? { name: opts.name } : {}), with: (opts.with ?? []).map(file) });
  ui.success(`${b.id} added: ${b.title}. The Analyst is reading it.`);
  ui.info(`Follow it: squad requirements show ${b.id}`);
  warnIfNoSquad(bp);
}

/** Waits for the Analyst's answer to "Ask about this". */
async function waitForReply(bp: BoardPaths, id: string, qid: string): Promise<string> {
  warnIfNoSquad(bp);
  const spin = ui.spinner('The Analyst is answering…');
  try {
    for (let i = 0; i < 400; i += 1) {
      stepDemo(bp);
      const q = readBreakdown(bp, id)?.questions.find((x) => x.id === qid);
      if (q && !q.thinking) return q.thread?.at(-1)?.text ?? '';
      await sleep(400);
    }
    return 'The Analyst has not answered yet. Look again in a moment: squad requirements show ' + id;
  } finally {
    spin.stop();
  }
}

async function answer(id: string, opts: { skip?: boolean }): Promise<void> {
  const bp = board();
  if (opts.skip) {
    const b = skipBreakdownQuestions(bp, id);
    ui.success(`The Analyst decides the open questions of ${b.id} itself and writes each one down in Decided for you. It is writing the breakdown now.`);
    return;
  }
  stepDemo(bp);
  const v = await viewBreakdown(bp, id);
  if (v.status !== 'questions') throw new Error(`${v.id} has no open questions.`);
  const answers: Record<string, AnswerInput> = {};
  for (const [i, q] of v.questions.entries()) {
    out();
    out(kleur.gray(`  Question ${i + 1} · ${q.kind === 'clash' ? 'Two parts clash' : 'Missing in the BRD'}${q.refs?.length ? ` · ${q.refs.map(refWords).join(' and ')}` : ''}`));
    for (;;) {
      const choice = await select({
        message: q.text,
        choices: [
          ...q.options.map((o) => ({ name: o === q.inputOption ? `${o} (type it)` : o, value: o })),
          { name: 'Something else (type your own)', value: '__other' },
          { name: SKIP_CHOICE, value: SKIP_CHOICE },
          new Separator(),
          { name: 'Ask about this', value: '__ask' },
        ],
      });
      if (choice === '__ask') {
        const text = await input({ message: 'Your question:' });
        if (!text.trim()) continue;
        askAboutQuestion(bp, v.id, q.id, text);
        out(`  ${kleur.green('Analyst:')} ${await waitForReply(bp, v.id, q.id)}`);
        continue;
      }
      if (choice === '__other') answers[q.id] = { choice: 'Other', value: await input({ message: 'Your answer:' }) };
      else if (choice === q.inputOption) answers[q.id] = { choice, value: await input({ message: `${choice.replace(/:$/, '')}, which one?` }) };
      else answers[q.id] = { choice };
      break;
    }
  }
  answerBreakdown(bp, v.id, answers);
  out();
  ui.success('Answers sent. The Analyst is writing the epics, features and stories.');
  ui.info(`Follow it: squad requirements show ${v.id}`);
}

async function askOne(id: string, qid: string, words: string[]): Promise<void> {
  const bp = board();
  const text = words.join(' ') || (await input({ message: 'Your question:' }));
  const b = askAboutQuestion(bp, id, qid, text);
  out(`  ${kleur.green('Analyst:')} ${await waitForReply(bp, b.id, qid.toLowerCase())}`);
}

/** Runs a command and prints the plain error, the way every other squad command does. */
function run<A extends unknown[]>(fn: (...args: A) => Promise<void> | void) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (isSquadExit(err)) {
        if (err.message.trim()) ui.info(err.message);
        process.exit(err.exitCode);
      }
      ui.renderError(err);
      process.exit(1);
    }
  };
}

function more(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** The part options shared by edit and add-item. */
function partOptions(c: Command): Command {
  return c
    .option('--title <text>', 'Its title')
    .option('--goal <text>', 'An epic: what it is for')
    .option('--summary <text>', 'A feature: what it covers')
    .option('--story <text>', 'A story: "As a …, I want …, so that …"')
    .option('--size <size>', 'A story: S, M or L')
    .option('--needs <keys>', 'A story: the stories it needs merged first, like S-1,S-2 (repeat for more)', more, [])
    .option('--no-needs', 'A story: it needs no other story')
    .option('--criterion <text>', 'A story: a "done when" check, "Given …, when …, then …" (repeat for more; replaces them all)', more, []);
}

/** `squad requirements`, with one command per button of the Requirements page. */
export function requirementsCommand(): Command {
  const r = new Command('requirements').description('Break a BRD into epics, features and stories, review and approve it, and start its stories');
  r.command('list').description('List the breakdowns in this project').action(run(rows));
  r.command('add [file]')
    .description('Add a BRD (PDF, Word, Markdown or text); the Analyst reads it and asks only about gaps and clashes')
    .option('--name <name>', 'What to call it (default: the file name)')
    .option('--with <file>', 'A screen mockup or another file that goes with it (repeat for more)', more, [])
    .option('--paste', 'Read the text from what you paste or pipe in, instead of a file')
    .action(run(add));
  r.command('show <id>')
    .description('Show a breakdown: the tree, the estimate and what is decided')
    .option('--map', 'The tree with each story\'s needs and where it is')
    .action(run(show));
  r.command('stop <id>')
    .description('Stop the Analyst; Try again carries on')
    .action(run((id: string) => {
      const b = stopBreakdown(board(), id);
      ui.success(`Stopping the Analyst on ${b.id}. Nothing is lost. Carry on: squad requirements retry ${b.id}`);
    }));
  r.command('retry <id>')
    .description('Try the Analyst\'s step again')
    .action(run((id: string) => {
      const bp = board();
      const b = retryBreakdown(bp, id);
      ui.success(`The Analyst carries on with ${b.id}. Follow it: squad requirements show ${b.id}`);
      warnIfNoSquad(bp);
    }));
  r.command('answer <id>')
    .description('Answer the Analyst\'s questions in the terminal')
    .option('--skip', 'Skip: let the Analyst decide each open question and write it down')
    .action(run(answer));
  r.command('ask <id> <question> [text...]').description('Ask the Analyst about one of its questions, like q2').action(run(askOne));
  partOptions(r.command('edit <id> <key>').description('Change an epic, a feature or a story')).action(
    run((id: string, key: string, o: PartOptions) => {
      const patch = patchFrom(o);
      if (!Object.keys(patch).length) throw new Error(`Say what to change, for example: squad requirements edit ${id.toUpperCase()} ${key.toUpperCase()} --title "…"`);
      const b = editItem(board(), id, key, patch);
      ui.success(`Saved ${key.toUpperCase()} in ${b.id}.`);
    }),
  );
  partOptions(
    r
      .command('add-item <id>')
      .description('Add an epic, or a feature or story under one')
      .option('--under <key>', 'The epic or feature it goes under (left out: a new epic)')
      .option('--feature', 'Under an epic: a feature, not a story')
      .option('--before <key>', 'Put it before this part'),
  ).action(
    run((id: string, o: PartOptions & { under?: string; feature?: boolean; before?: string }) => {
      const { key, breakdown } = addItem(board(), id, { ...patchFrom(o), title: o.title ?? '', ...(o.under ? { under: o.under } : {}), ...(o.feature ? { level: 'feature' } : {}), ...(o.before ? { before: o.before } : {}) });
      ui.success(`Added ${key} to ${breakdown.id}.`);
      if (key.startsWith('S-') && !o.criterion?.length) ui.info(`Give it a "done when" check before you approve: squad requirements edit ${breakdown.id} ${key} --criterion "Given …, when …, then …"`);
    }),
  );
  r.command('move <id> <key>')
    .description('Move a part under another feature or epic, or before another part')
    .option('--under <key>', 'The feature or epic it goes under')
    .option('--before <key>', 'Put it before this part')
    .action(run((id: string, key: string, o: { under?: string; before?: string }) => {
      const b = moveItem(board(), id, key, { ...(o.under ? { under: o.under } : {}), ...(o.before ? { before: o.before } : {}) });
      ui.success(`Moved ${key.toUpperCase()} in ${b.id}.`);
    }));
  r.command('remove <id> <key>')
    .description('Take a part out, with what is under it (a started story stays)')
    .action(run((id: string, key: string) => {
      const b = removeItem(board(), id, key);
      ui.success(`Removed ${key.toUpperCase()} from ${b.id}. Its key is never given again.`);
    }));
  r.command('redo <id> <key> [what...]')
    .description('Ask the Analyst to redo a part (or the whole breakdown, with its id) with your words')
    .action(run(async (id: string, key: string, words: string[]) => {
      const bp = board();
      const text = words.join(' ') || (await input({ message: 'What should the Analyst change?' }));
      const b = redoItem(bp, id, key, text);
      ui.success(`The Analyst is redoing ${key.toUpperCase() === b.id ? 'the breakdown' : key.toUpperCase()}. Follow it: squad requirements show ${b.id}`);
      warnIfNoSquad(bp);
    }));
  r.command('rename <id> [name...]')
    .description('Rename a breakdown')
    .action(run((id: string, words: string[]) => {
      const b = renameBreakdown(board(), id, words.join(' '));
      ui.success(`${b.id} is now called ${b.title}.`);
    }));
  r.command('approve <id>')
    .description('Approve the breakdown: nothing is built or sent before this')
    .action(run((id: string) => {
      const b = approveBreakdown(board(), id);
      ui.success(`${b.id} is approved. Start a story: squad requirements start ${b.id} <story>`);
    }));
  r.command('start <id> <story>')
    .description('Start one story now, as a ticket that builds by itself')
    .action(run((id: string, key: string) => {
      const bp = board();
      const t = startStory(bp, id, key);
      ui.success(`${key.toUpperCase()} started as ${t.id}: ${t.title}. Follow it: squad watch ${t.id}`);
      warnIfNoSquad(bp, 'The squad builds');
    }));
  r.command('build <id>')
    .description('Build continuously: start each next story by itself once what it needs is merged')
    .option('--pause', 'Pause: no new story starts; the ones building carry on')
    .action(run(async (id: string, o: { pause?: boolean }) => {
      const bp = board();
      const b = setBuild(bp, id, !o.pause);
      const v = await viewBreakdown(bp, b.id);
      if (o.pause) {
        ui.success(`${b.id} is paused: no new story starts. The ${v.counts.building === 1 ? 'story' : 'stories'} building now carry on.`);
        ui.info(`Carry on: squad requirements build ${b.id}`);
        return;
      }
      ui.success(`${b.id} builds continuously, ${v.estimate.parallel} at a time. It stops only for a missing part, a clash or a failed check, and merges each story when its checks and review pass.`);
      if (v.state.build?.held) ui.info(v.state.build.held);
      ui.info(`Follow it: squad requirements show ${b.id} --map    Pause: squad requirements build ${b.id} --pause`);
      warnIfNoSquad(bp, 'The squad builds');
    }));
  r.command('send <id>')
    .description('Send the breakdown to the tracker: epics, features and stories with their links (again: only what changed)')
    .option('--preview', 'Show what would be sent, and send nothing')
    .action(run(async (id: string, o: { preview?: boolean }) => {
      const bp = board();
      if (o.preview) {
        const p = await sendPreview(bp, id);
        const c = p.counts;
        const level = (n: { all: number; new: number; changed: number }, name: string) => `${String(n.all).padStart(4)}  ${name}${n.new || n.changed ? kleur.gray(`  ${[n.new ? `${n.new} new` : '', n.changed ? `${n.changed} changed` : ''].filter(Boolean).join(', ')}`) : kleur.gray('  as sent')}`;
        out();
        out(`  ${kleur.bold(`Send ${id.toUpperCase()} to ${p.tracker.label}`)}${p.tracker.project ? kleur.gray(`  into project ${p.tracker.project}, as the ${p.levels.process} process names them`) : ''}`);
        out(`  ${level(c.epics, many(p.levels.epic))}`);
        out(`  ${level(c.features, `${many(p.levels.feature)}, each under its epic`)}`);
        out(`  ${level(c.stories, `${many(p.levels.story)}, each under its ${c.storiesUnderEpic ? 'feature or epic' : 'feature'}`)}`);
        out(`  ${String(c.links).padStart(4)}  Links between stories that need each other${p.links ? kleur.gray(`  ${p.links} to add`) : ''}`);
        out();
        out(p.items || p.links ? `  ${p.first ? `Send ${plural(p.items, 'item')}` : `Send changes: ${plural(p.items, 'item')}${p.links ? ` and ${plural(p.links, 'link')}` : ''}`}: ${cmd(`squad requirements send ${id.toUpperCase()}`)}` : kleur.gray('  Nothing changed since the last send.'));
        out(kleur.gray('  They go into the backlog, not a sprint. squad-kit never deletes anything in the tracker.'));
        out();
        return;
      }
      const b = requestSend(bp, id);
      const v = await viewBreakdown(bp, b.id);
      const s = v.state.sync;
      const what = [s?.items?.of ? plural(s.items.of, 'item') : '', s?.links?.of ? plural(s.links.of, 'link') : ''].filter(Boolean).join(' and ') || plural(s?.of ?? 0, 'step');
      ui.success(`Sending ${b.id} to ${v.tracker?.label ?? 'the tracker'}: ${what}. The squad sends it item by item, beside its other work.`);
      ui.info(`Watch it: squad requirements show ${b.id}`);
      warnIfNoSquad(bp, 'The squad sends it');
    }));
  r.command('decided <id> <entry> [text...]')
    .description('Change a Decided for you entry, like d3; the Analyst redoes the part it is about')
    .action(run(async (id: string, did: string, words: string[]) => {
      const text = words.join(' ') || (await input({ message: 'What do you want instead?' }));
      const b = changeDecided(board(), id, did, text);
      ui.success(`Changed ${did.toLowerCase()} in ${b.id}.`);
    }));
  r.command('delete <id>')
    .description('Delete a breakdown and its document (not while its stories build)')
    .option('-y, --yes', 'Skip the confirmation')
    .action(run(async (id: string, o: { yes?: boolean }) => {
      const bp = board();
      const b = readBreakdown(bp, id);
      if (!b) throw new Error(`No breakdown ${id.toUpperCase()} in this project.`);
      if (!o.yes && !(await confirm({ message: `Delete ${b.id} ${b.title} and its document?`, default: false }))) {
        ui.info('Not deleted.');
        return;
      }
      deleteBreakdown(bp, b.id);
      ui.success(`Deleted ${b.id}. The tickets of its stories stay on the board.`);
    }));
  return r;
}

export { rows as runRequirementsList, show as runRequirementsShow, add as runRequirementsAdd, answer as runRequirementsAnswer };

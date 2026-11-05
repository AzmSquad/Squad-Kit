import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { readMeta, type BoardPaths } from '../board/store.js';
import {
  approveOverview,
  overviewView,
  readAgainWithTalk,
  readTalk,
  sendTalk,
  setupAgain,
  setupLine,
  setupView,
  startTalk,
  stopSetup,
  tellIdea,
  ticketFromIdea,
  type SetupStepView,
  type SetupView,
} from '../board/first-run.js';
import { SETUP_STEPS, readWords, type SetupStepId } from '../board/setup-state.js';
import { durationWords } from '../board/usual.js';
import { squadRunsElsewhere } from '../board/lock.js';
import { tick } from '../board/engine.js';
import { board } from './board.js';

/**
 * The first run and the Overview in the terminal: `squad setup` shows the setup's steps with their times, and
 * `squad overview` what squad-kit understood, with every button of the Overview page as an option.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MARK: Record<SetupStepView['state'], string> = {
  done: kleur.green('✓'),
  now: kleur.cyan('…'),
  todo: kleur.gray('○'),
  failed: kleur.red('!'),
  skipped: kleur.gray('–'),
  stopped: kleur.yellow('■'),
};

/** The step's time: how long it took, or how long it has run so far, and the usual time. */
function timeOf(st: SetupStepView, at = Date.now()): string {
  if (st.state === 'now' && st.since) return `${durationWords((at - Date.parse(st.since)) / 1000)} · ${st.usual}`;
  if (st.seconds !== undefined && st.state !== 'skipped') return durationWords(st.seconds);
  return st.state === 'todo' ? st.usual : '';
}

/** One step as a line, with what it found, or why it failed and the way out, under it. */
export function stepLines(st: SetupStepView, at = Date.now()): string[] {
  const time = timeOf(st, at);
  const lines = [`  ${MARK[st.state]} ${st.state === 'todo' ? kleur.gray(st.label) : st.label}${time ? kleur.gray(`  ${time}`) : ''}`];
  if (st.note && st.state !== 'todo') lines.push(kleur.gray(`      ${st.note}`));
  if (st.error) lines.push(kleur.red(`      ${st.error}`));
  for (const w of st.ways) if (w.do === 'again') lines.push(`      ${w.label}: ${cmd(w.command)}`);
  return lines;
}

function printSetup(v: SetupView): void {
  out();
  out(`  ${kleur.bold(`Getting to know ${v.project}`)}  ${kleur.gray(setupLine(v))}`);
  out();
  for (const st of v.steps) for (const l of stepLines(st)) out(l);
  out();
  if (v.ready && !v.approved) out(v.empty ? `  What do you want to build? ${cmd('squad overview --build "what you want"')}` : `  Check what squad-kit understood: ${cmd('squad overview')}   then   ${cmd('squad overview --approve')}`);
  else if (!v.ready) out(`  Follow it: ${cmd('squad setup --follow')}   Stop: ${cmd('squad setup --stop')}`);
  if (!v.qualityAsked && !v.approved) out(kleur.gray(`  Quality is ${v.quality}. To change it: squad config set quality best|balanced|thrifty`));
  out();
}

/** A sample board with no squad-kit open: this terminal plays the sample squad while it waits. */
function stepDemo(bp: BoardPaths): void {
  if (readMeta(bp).engine === 'demo' && !squadRunsElsewhere(bp)) tick(bp);
}

function noSquadNote(bp: BoardPaths): void {
  if (readMeta(bp).engine === 'live' && !squadRunsElsewhere(bp)) ui.warning('The setup runs while squad-kit is open. Run `squad console` in another tab.');
}

/**
 * Prints each step once it changes, until the overview is ready or the person presses Ctrl-C. The setup keeps going
 * either way: it runs in squad-kit, not in this terminal. Returns a stop for the caller.
 */
export function followSetup(bp: BoardPaths, onDone?: () => void, playDemo = false): () => void {
  const said = new Map<SetupStepId, string>();
  let ended = false;
  const look = () => {
    if (ended) return;
    let v: SetupView | null;
    try {
      if (playDemo) stepDemo(bp);
      v = setupView(bp);
    } catch {
      return;
    }
    if (!v) return;
    for (const st of v.steps) {
      const key = `${st.state}|${st.state === 'now' ? '' : (st.note ?? '')}|${st.error ?? ''}`;
      if (said.get(st.id) === key || st.state === 'todo') continue;
      said.set(st.id, key);
      for (const l of stepLines(st)) out(l);
    }
    if (v.ready || v.approved) {
      ended = true;
      out();
      ui.success(v.approved ? 'Set up.' : v.empty ? `${v.project} is ready. One question for you on the Overview, or here: squad overview --build "what you want"` : `squad-kit knows ${v.project} now. Check what it understood on the Overview, or here: squad overview`);
      // After the caller has its stop.
      setTimeout(() => onDone?.(), 0);
    }
  };
  look();
  const timer = setInterval(look, 1000);
  return () => {
    ended = true;
    clearInterval(timer);
  };
}

export interface SetupOptions {
  follow?: boolean;
  stop?: boolean;
  /** Try again from this step (the read when given with no step). */
  again?: string | boolean;
}

/** `squad setup`: the first run's steps, with their times. Every button on the setup page is an option here. */
export async function runSetup(opts: SetupOptions): Promise<void> {
  const bp = board();
  if (opts.stop) {
    stopSetup(bp);
    ui.success('Stopped. The setup waits until you start it again: squad setup --again');
    return;
  }
  if (opts.again) {
    const step = (typeof opts.again === 'string' ? opts.again : 'read') as SetupStepId;
    if (!SETUP_STEPS.includes(step)) throw new Error(`"${step}" is not a step. Use tool, read, commands, tests or app.`);
    setupAgain(bp, step);
    ui.success(step === 'read' || step === 'tool' ? 'The Architect reads the project again.' : 'squad-kit tries that step again.');
    noSquadNote(bp);
  }
  const v = setupView(bp);
  if (!v) {
    ui.info('This project is set up. See what squad-kit understood: squad overview');
    return;
  }
  if (!opts.follow) return printSetup(v);
  noSquadNote(bp);
  out();
  out(`  ${kleur.bold(`Getting to know ${v.project}`)}  ${kleur.gray('Ctrl-C stops watching; the setup keeps going.')}`);
  out();
  await new Promise<void>((done) => {
    const stop = followSetup(
      bp,
      () => {
        stop();
        done();
      },
      true,
    );
  });
}

export interface OverviewOptions {
  approve?: boolean;
  idea?: string;
  again?: boolean;
  /** "Something is wrong": what to tell the Architect. */
  wrong?: string[] | boolean;
  /** "Read it again with this", after the talk. */
  withTalk?: boolean;
  /** "What do you want to build?", on a project with no code. */
  build?: string[];
}

const list = (head: string, items: string[]) => {
  if (!items.length) return;
  out(`  ${kleur.bold(head)}`);
  for (const x of items) out(`    • ${x}`);
  out();
};

/** `squad overview`: what squad-kit understood about the project, its rules and three ticket ideas. */
export async function runOverview(opts: OverviewOptions): Promise<void> {
  const bp = board();
  if (opts.approve) {
    const v = approveOverview(bp);
    ui.success(`Approved. ${v.rules.filter((r) => r.fromScan).length ? 'The rules squad-kit found are the rules every agent follows now.' : 'The overview is the project\'s home now.'}`);
    ui.info(`Start with your first ticket: ${v.ideas.length ? 'squad overview --idea 1' : 'squad new "what you want"'}`);
    return;
  }
  if (opts.idea) {
    const t = ticketFromIdea(bp, Number(opts.idea));
    ui.success(`${t.id} is on the board: ${t.title}. The Analyst reads it first.`);
    ui.info(`Follow it: squad watch ${t.id}`);
    return;
  }
  if (opts.again || opts.withTalk) {
    if (opts.withTalk) readAgainWithTalk(bp);
    else setupAgain(bp, 'read');
    ui.success('The Architect reads the project again. Follow it: squad setup --follow');
    noSquadNote(bp);
    return;
  }
  if (opts.wrong) return talk(bp, Array.isArray(opts.wrong) ? opts.wrong.join(' ') : '');
  if (opts.build) {
    tellIdea(bp, opts.build.join(' '));
    ui.success('The Architect reads what you want to build. Follow it: squad setup --follow');
    noSquadNote(bp);
    return;
  }

  const v = overviewView(bp);
  out();
  out(`  ${kleur.bold(v.project)}${v.readAt ? kleur.gray(`  read ${new Date(v.readAt).toLocaleString()}`) : ''}`);
  out();
  if (v.handover === 'reading') {
    out(`  ${kleur.yellow(v.setup?.line ?? 'squad-kit is getting to know the project.')}  ${cmd('squad setup')}`);
    out();
  }
  if (v.handover === 'ready' && v.empty && !v.idea) {
    out(`  ${kleur.yellow('What do you want to build?')}  ${cmd('squad overview --build "what you want"')}`);
    out();
  } else if (v.handover === 'ready') {
    out(`  ${kleur.yellow(v.empty ? 'The Architect wrote down what you want to build. Check it, then start.' : 'squad-kit has read your project. Check what it understood, then start.')}`);
    if (v.proposed) out(kleur.gray(`  When you approve, the ${v.proposed} ${v.proposed === 1 ? 'rule' : 'rules'} below become the rules every agent follows.`));
    out();
  }
  if (v.summary) out(`  ${v.summary}`), out();
  if (v.users) out(`  ${kleur.bold('Who uses it')}`), out(`    ${v.users}`), out();
  list('What it can do today', [...v.can, ...v.since.map((x) => `${x.title} (${x.id}, new since the read)`)]);
  if (v.proof) {
    const p = v.proof;
    list('Proof squad-kit can work here', [
      ...(p.files ? [readWords(p.files)] : []),
      ...(p.tests ?? []).map((t) => (t.ok ? `Ran your tests: ${t.passed ?? 'they'} pass` : `Your tests did not pass here (${t.command})`)),
      ...(p.app ? [p.app.ok ? 'Opened the app' : 'The app did not open here'] : []),
      ...(p.branch ? [`On git branch ${p.branch}${p.unsaved ? `, ${p.unsaved} changes not saved in git` : ', nothing unsaved'}`] : []),
    ]);
  }
  if (v.parts.length) {
    out(`  ${kleur.bold('How it fits together')}`);
    for (const part of v.parts) {
      const to = v.links.filter((l) => l.from === part.id).map((l) => `${l.label ?? '→'} ${v.parts.find((x) => x.id === l.to)?.name ?? l.to}`);
      out(`    ${part.name}${part.what ? kleur.gray(`: ${part.what}`) : ''}${part.files.length ? kleur.gray(` (${part.files.join(', ')})`) : ''}`);
      if (to.length) out(kleur.gray(`      ${to.join(' · ')}`));
    }
    out();
  } else if (v.map.length) list('Project map', v.map.map((m) => `${m.area}: ${m.detail}`));
  list(
    v.proposed ? 'Rules the squad will follow once you approve' : 'Rules the squad follows',
    v.rules.map((r) => `${r.id} ${r.title}${r.proposed ? kleur.yellow(' (proposed)') : ''}`),
  );
  list('Worth knowing', v.worth);
  if (v.ideas.length) {
    out(`  ${kleur.bold('Good first tickets')}`);
    v.ideas.forEach((i, n) => out(`    ${n + 1}. ${i.title}${i.ticket ? kleur.gray(` (${i.ticket})`) : ''}  ${cmd(`squad overview --idea ${n + 1}`)}`));
    out();
  }
  if (v.old) out(kleur.gray('  Read by an older squad-kit. Who uses it, what it can do and ticket ideas come with the next read: squad overview --again')), out();
  if (v.empty) {
    if (v.handover === 'ready' && v.idea) out(`  Looks right: ${cmd('squad overview --approve')}   Change what you said: ${cmd('squad overview --build "what you want"')}`);
  } else if (v.handover === 'ready') out(`  Looks right: ${cmd('squad overview --approve')}   Something is wrong: ${cmd('squad overview --wrong "what is wrong"')}`);
  else out(kleur.gray(`  Read it again: squad overview --again`));
  out();
}

/** "Something is wrong": the person's words go to the Architect, and its answer prints here when squad-kit is open. */
async function talk(bp: BoardPaths, text: string): Promise<void> {
  const open = readTalk(bp)?.open;
  if (!text.trim() && open) throw new Error('Say what is wrong: squad overview --wrong "the login does check passwords"');
  const before = readTalk(bp)?.messages.length ?? 0;
  if (open) sendTalk(bp, text);
  else startTalk(bp, text || undefined);
  if (readMeta(bp).engine === 'live' && !squadRunsElsewhere(bp)) {
    ui.warning('The Architect answers while squad-kit is open. Run `squad console` in another tab, then: squad overview --wrong');
    return;
  }
  ui.info('The Architect is answering…');
  for (let i = 0; i < 600; i += 1) {
    stepDemo(bp);
    const t = readTalk(bp);
    if (t && !t.thinking && t.messages.length > before) {
      const answer = [...t.messages].reverse().find((m) => m.who !== 'you');
      if (answer) out(`\n  ${kleur.bold('Architect')}: ${answer.text}\n`);
      out(`  Answer: ${cmd('squad overview --wrong "…"')}   Read it again with this: ${cmd('squad overview --again --with-talk')}`);
      return;
    }
    await sleep(1000);
  }
  ui.warning('No answer yet. It shows on the Overview when it comes.');
}

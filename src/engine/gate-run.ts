import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HARNESS_FILE_GATE, addAddition, readHarness, setGateTried, noteAdded, type Addition, type GateAddition, type GateTried, type GateWhen, type NewAddition } from '../board/additions.js';
import { partsOf } from '../board/parts.js';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { ProductPart, ProjectCommands, Ticket } from '../board/types.js';
import { scrubSecrets } from '../core/scrub.js';
import { CHECK_MS, CHECK_SILENT_MS, OWN_CHECK, runCommand, withOneMoreRun, type CommandWatch } from './checks.js';
import { copyViews } from './copies.js';
import { addSnapshot, dropSnapshot, git, worktreeRoot } from './git.js';
import { hookFiles } from './hook-files.js';
import { checkLane, watchLane } from './lane.js';
import { fillOwnCopy } from './local-files.js';
import { guardBlockedPath, guardSupport, projectGuardFor } from './project-guard.js';
import { repoFor, reposOf } from './repos.js';
import { SETUP_MS } from './run-app.js';
import { gateChanged, type Weakening } from './weakened.js';

/**
 * A gate a team added: a command squad-kit runs itself, with the runner of the project's checks, inside the guard, in
 * the story's copy, so no agent is asked whether it passed. What it changes in the copy goes back, so it never reaches the
 * commit. It either fails, which means the code, or cannot run, which never counts against the story.
 */

/** A gate's words kept on the story, for engineers. */
const KEPT_OUTPUT = 6000;
const NOT_THERE = /Missing script:|ERR_PNPM_NO_SCRIPT|error Command ".*" not found/;

export const CANT_RUN = {
  missing: 'The command, or a tool it needs, is not there.',
  time: 'It did not finish in time.',
  guard: 'It needed a file outside its copy, and the guard blocked it.',
  part: 'The part it runs in is no longer in the project.',
};

export interface GateRun {
  result: 'passed' | 'failed' | 'cant-run';
  output: string;
  seconds: number;
  why?: string;
  failedFirst?: string;
}

const cleanOutput = (s: string): string => scrubSecrets(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')).slice(-KEPT_OUTPUT);

/** One gate in one place: once more when it failed, as a project check does, and once more when it ran out of time. */
export async function runGate(dir: string, command: string, watch: CommandWatch = {}, timeoutMs = CHECK_MS): Promise<GateRun> {
  if (!fs.existsSync(dir)) return { result: 'cant-run', why: CANT_RUN.part, output: '', seconds: 0 };
  const once = async () => {
    const top = git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true }) || dir;
    const lane = watchLane(top, hookFiles(top), true);
    const r = await runCommand(dir, command, timeoutMs, { silentMs: CHECK_SILENT_MS, ...watch, endAll: true });
    checkLane(lane);
    return r;
  };
  let r = await withOneMoreRun(once, watch, () => undefined);
  if (r.ended && !watch.signal?.aborted) r = await once();
  const output = cleanOutput(r.output);
  const out = { output, seconds: r.seconds, ...(r.failedFirst !== undefined ? { failedFirst: cleanOutput(r.failedFirst) } : {}) };
  if (r.ok) return { result: 'passed', ...out };
  if (r.ended) return { result: 'cant-run', why: CANT_RUN.time, ...out };
  if (watch.guard && guardBlockedPath(r.output, watch.guard)) return { result: 'cant-run', why: CANT_RUN.guard, ...out };
  if (r.code === 126 || r.code === 127 || r.code === undefined || NOT_THERE.test(r.output)) return { result: 'cant-run', why: CANT_RUN.missing, ...out };
  return { result: 'failed', ...out };
}

export interface GatePlace {
  dir: string;
  /** The repo it is a copy of, '.' for the project itself. */
  repo: string;
  label?: string;
}

/** What a gate did this time, with its state read again after the run. */
export interface GateDone extends GateRun {
  id: string;
  name: string;
  command: string;
  state: 'try' | 'on';
  /** Its failing stops the story. On Try first or warn only nothing does. */
  stops: boolean;
  label?: string;
}

const partFolder = (dir: string, part: ProductPart | undefined): string => (part?.folder ? path.join(dir, part.folder) : dir);

const WORSE = { passed: 0, failed: 1, 'cant-run': 2 };

/**
 * Runs the gates due at this point of the line. A file that cannot be read comes back as one gate that cannot run, so the
 * team's gates are never dropped without a word. A gate turned off or removed while it ran says nothing. `skip`: what a
 * person went past on this story.
 */
export async function runGatesAt(bp: BoardPaths, when: GateWhen, places: GatePlace[], skip: string[], watchFor: (dir: string) => CommandWatch, onStart?: (name: string) => void): Promise<GateDone[]> {
  const { additions, broken } = readHarness(bp);
  if (broken) return skip.includes(HARNESS_FILE_GATE) ? [] : [{ id: HARNESS_FILE_GATE, name: "Your team's additions", command: '', state: 'on', stops: true, result: 'cant-run', why: broken, output: '', seconds: 0 }];
  const parts = partsOf(readMeta(bp));
  const out: GateDone[] = [];
  for (const g of additions.filter((a): a is GateAddition => a.kind === 'gate' && a.when === when && a.state !== 'off' && !skip.includes(a.id))) {
    const part = g.part ? parts.find((p) => p.id === g.part) : undefined;
    const base = { id: g.id, name: g.name, command: g.command, state: g.state as 'try' | 'on', stops: g.state === 'on' && g.on_fail === 'stop' };
    if (g.part && !part) {
      out.push({ ...base, result: 'cant-run', why: CANT_RUN.part, output: '', seconds: 0 });
      continue;
    }
    let worst: GateDone | undefined;
    for (const p of part ? places.filter((x) => x.repo === (part.repo ?? '.')) : places) {
      onStart?.(g.name);
      const watch = watchFor(p.dir);
      const run = await runGate(partFolder(p.dir, part), g.command, watch);
      if (watch.signal?.aborted) return out;
      if (!worst || WORSE[run.result] > WORSE[worst.result]) worst = { ...base, ...run, ...(p.label ? { label: p.label } : {}) };
    }
    if (!worst) continue;
    const now = readHarness(bp).additions.find((a) => a.id === g.id);
    if (!now || now.state === 'off') continue;
    out.push({ ...worst, state: now.state as 'try' | 'on', stops: now.state === 'on' && (now as GateAddition).on_fail === 'stop' });
  }
  return out;
}

/** Puts what the gates did on the story. What squad-kit says of them it says here, once, in plain words. */
export function noteGates(t: Ticket, done: GateDone[], addLine: (text: string) => void): void {
  const at = new Date().toISOString();
  for (const d of done.filter((x) => x.id !== HARNESS_FILE_GATE)) {
    const result = d.result === 'failed' && !d.stops ? (d.state === 'try' ? 'would-stop' : 'warned') : d.result;
    noteAdded(t, {
      id: d.id,
      name: d.name,
      kind: 'gate',
      state: d.state,
      at,
      result,
      ...(d.why ? { why: d.why } : {}),
      ...(d.output && d.result !== 'passed' ? { output: d.output } : {}),
      ...(d.stops && d.result === 'failed' ? { stopped: at } : {}),
    });
    if (result === 'would-stop') addLine(`"${d.name}" would have stopped this story. It is on Try first, so nothing stopped`);
    if (result === 'warned') addLine(`"${d.name}" did not pass. It is warn only, so the work goes on`);
    if (result === 'cant-run' && !d.stops) addLine(`"${d.name}" could not run: ${d.why} It stops nothing`);
  }
}

const COPY_PREFIX = 'gate-copy-';
/** Longer than a setup and two runs of a gate together, so a copy this old has no one left in it. */
const OLD_COPY_MS = 2 * 60 * 60_000;

/** A copy left by an app that ended in the middle of a try goes when the next one starts. */
function dropOldCopies(src: string): void {
  const root = worktreeRoot(src);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => n.startsWith(COPY_PREFIX));
  } catch {
    return;
  }
  for (const n of names) {
    const dir = path.join(root, n);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > OLD_COPY_MS) dropSnapshot(src, dir);
    } catch {
      // It went while we looked, or the next try cleans it up.
    }
  }
}

/** A throwaway copy of the code as `commit` has it, ready to run in, for what happens outside any story. */
export async function cleanCopy(bp: BoardPaths, repo: { path: string; base: string; commands: ProjectCommands }, watch: CommandWatch = {}): Promise<string> {
  const src = path.join(bp.root, repo.path);
  const commit = git(src, ['rev-parse', '--verify', '-q', `${repo.base}^{commit}`], { allowFail: true }) || git(src, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  if (!commit) throw new Error('This project has no saved code yet, so there is nothing to run it on.');
  dropOldCopies(src);
  const name = `${COPY_PREFIX}${randomBytes(3).toString('hex')}`;
  const dir = addSnapshot(src, name, commit);
  fillOwnCopy(bp, repo.path, dir);
  if (repo.commands.setup?.trim()) await runCommand(dir, repo.commands.setup, SETUP_MS, { ...watch, ...guardOf(bp, dir) });
  return dir;
}

export const dropCleanCopy = (bp: BoardPaths, repo: { path: string }, dir: string): void => dropSnapshot(path.join(bp.root, repo.path), dir);

export function guardOf(bp: BoardPaths, dir: string): { guard?: CommandWatch['guard'] } {
  if (!guardSupport().on) return {};
  const allow = readMeta(bp).guard;
  return { guard: projectGuardFor(bp, { cwd: dir, ...(allow ? { allow } : {}) }) };
}

/** The last Try it now of each command, until the app restarts: a gate is saved only after one. */
const lastTry = new Map<string, GateRun & { at: string }>();
const tryKey = (bp: BoardPaths, command: string, part?: string) => `${bp.squadDir}\0${part ?? ''}\0${command.trim()}`;

export interface GateTryAnswer {
  result: GateRun['result'];
  seconds: number;
  why?: string;
  output: string;
}

/** Try it now: once, on clean code, inside the guard. Tried on an existing gate, its row remembers. */
export async function tryGate(bp: BoardPaths, by: string, input: { command?: string; part?: string; id?: string }): Promise<GateTryAnswer> {
  const meta = readMeta(bp);
  if (meta.engine !== 'live') throw new Error('The demo has no code to run a command on. In your own project this runs it once on your latest code.');
  const had = input.id ? readHarness(bp).additions.find((a) => a.id === input.id && a.kind === 'gate') as GateAddition | undefined : undefined;
  if (input.id && !had) throw new Error('That gate is no longer there.');
  const command = (had?.command ?? input.command ?? '').trim();
  if (!command) throw new Error('Write the command first.');
  const partId = had?.part ?? input.part;
  const part = partId ? partsOf(meta).find((p) => p.id === partId) : undefined;
  if (partId && !part) throw new Error(CANT_RUN.part);
  const repo = part ? reposOf(meta).find((r) => r.path === (part.repo ?? '.')) : reposOf(meta)[0];
  if (!repo) throw new Error(CANT_RUN.part);
  const dir = await cleanCopy(bp, repo);
  try {
    const run = await runGate(partFolder(dir, part), command, guardOf(bp, dir));
    lastTry.set(tryKey(bp, command, partId), { ...run, at: new Date().toISOString() });
    if (had && run.result !== 'cant-run') setGateTried(bp, by, had.id, { at: new Date().toISOString(), by, result: run.result, seconds: Math.round(run.seconds) });
    return { result: run.result, seconds: Math.round(run.seconds), output: run.output, ...(run.why ? { why: run.why } : {}) };
  } finally {
    dropCleanCopy(bp, repo, dir);
  }
}

/** Saves a gate, only after its try: one that cannot run is refused, one that fails today stays on Try first. */
export function addTriedGate(bp: BoardPaths, by: string, input: NewAddition & { name: string; kind: 'gate' }, from?: string): { added: Addition; failsToday: boolean } {
  const t = lastTry.get(tryKey(bp, input.command, input.part));
  if (!t) throw new Error('Press Try it now first, so a broken gate cannot stop every story.');
  if (t.result === 'cant-run') throw new Error(`It can't be saved yet: ${t.why} Fix that and press Try it now again.`);
  const tried: GateTried = { at: t.at, by, result: t.result, seconds: Math.round(t.seconds) };
  return { added: addAddition(bp, by, { ...input, tried }, from), failsToday: t.result === 'failed' };
}

export function releaseGatesDue(bp: BoardPaths): boolean {
  const { additions, broken } = readHarness(bp);
  return Boolean(broken) || additions.some((a) => a.kind === 'gate' && a.when === 'release' && a.state !== 'off');
}

/** The release gates, on a copy of the base with the stories not merged yet brought in. No gate due: no copy made. */
export async function runReleaseGates(bp: BoardPaths, tickets: Ticket[]): Promise<GateDone[]> {
  if (!releaseGatesDue(bp)) return [];
  const meta = readMeta(bp);
  const repos = new Map<string, Ticket[]>();
  for (const t of tickets) for (const v of copyViews(meta, t)) repos.set(repoFor(meta, v).path, [...(repos.get(repoFor(meta, v).path) ?? []), v]);
  const copies: { repo: ReturnType<typeof repoFor>; dir: string }[] = [];
  try {
    for (const [at, list] of repos) {
      const repo = reposOf(meta).find((r) => r.path === at)!;
      const dir = await cleanCopy(bp, repo);
      copies.push({ repo, dir });
      for (const t of list.filter((x) => x.branch && !x.mergedAt)) {
        git(dir, ['-c', 'user.name=squad-kit', '-c', 'user.email=squad-kit@localhost', 'merge', '--no-edit', t.branch!], { allowFail: true });
        // Two stories that clash: the release says so itself, and a gate must not judge half-merged files.
        git(dir, ['merge', '--abort'], { allowFail: true });
      }
    }
    return await runGatesAt(bp, 'release', copies.map((c) => ({ dir: c.dir, repo: c.repo.path })), [], (dir) => guardOf(bp, dir));
  } finally {
    for (const c of copies) dropCleanCopy(bp, c.repo, c.dir);
  }
}

/** A story that changes what a must-pass gate runs, or the project's scripts/check, stops as weakened tests do. */
export function gatesChanged(bp: BoardPaths, dir: string, repo: string, base: string): Weakening[] {
  const { additions } = readHarness(bp);
  const parts = partsOf(readMeta(bp));
  const out = gateChanged(dir, base, `./${OWN_CHECK}`, "the project's own check");
  for (const g of additions.filter((a): a is GateAddition => a.kind === 'gate' && a.state === 'on' && a.on_fail === 'stop')) {
    const part = g.part ? parts.find((p) => p.id === g.part) : undefined;
    if (g.part && (part?.repo ?? '.') !== repo) continue;
    out.push(...gateChanged(partFolder(dir, part), base, g.command, `your team's gate "${g.name}"`));
  }
  return out;
}

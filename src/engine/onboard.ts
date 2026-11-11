import fs from 'node:fs';
import path from 'node:path';
import { listDecisions, nextDecisionId, now, readMeta, writeDecision, writeMeta, type BoardPaths } from '../board/store.js';
import type { BoardMeta, ProjectCommands, RepoInfo } from '../board/types.js';
import { cleanOverview, readOverview, writeOverview } from '../board/overview.js';
import { cleanParts, partsAfterRead, repoInUse } from '../board/parts.js';
import { begin, currentStep, finish, learnSetupTime, nextProofStep, readTalk, readWords, stepOf, type SetupState, type SetupStepId, type SetupTestRun } from '../board/setup-state.js';
import { runCommand, startApp, tail, testCount, CHECK_MS, CHECK_SILENT_MS, type RunningApp } from './checks.js';
import { APP_WAIT_MS, SETUP_MS } from './run-app.js';
import { GitStopped, NoRoomForCopy, addSnapshot, copyIsWhole, dropSnapshot, firstSaveLater, git, worktreeRoot } from './git.js';
import { plainWords } from '../core/for-people.js';
import { reposOf } from './repos.js';
import { dockerBlockedWords, guardSupport, projectGuardFor, type GuardSpec } from './project-guard.js';
import { fillOwnCopy, placeStoryFiles } from './local-files.js';
import { countFiles, gitState, nextToNothing } from './first-look.js';
import { DOING } from './plain-doing.js';
import { fromTheRead, withBrowserTests } from './find-commands.js';
import { writeLog } from '../core/app-log.js';
import { learnAfterRead } from './story-db.js';

/**
 * The first run on the live engine: the Architect reads the project, then squad-kit proves it can work here, on its
 * own copy of the code: it installs what the project needs, runs the tests and opens the app once, with a screenshot.
 * A failure there never stops the setup: the step says what went wrong, with a way out, and the overview still comes.
 * The person's own folder is never touched.
 */

const STOPPED = 'You stopped the squad.';

/** The Architect's answer to the first read, as SCAN_SCHEMA asks for it. Fields from before the overview may be missing. */
export interface ScanAnswer {
  empty: boolean;
  summary: string;
  map: { area: string; detail: string }[];
  decisions: { title: string; why: string }[];
  commands: ProjectCommands;
  repos?: { path: string; summary: string; commands: ProjectCommands }[];
  users?: string;
  can?: string[];
  worth?: string[];
  ideas?: { title: string; why: string }[];
  parts?: unknown[];
  links?: unknown[];
  /** What runs when the whole product is up. Not the picture's parts: those are the code as a person would draw it. */
  runs?: unknown[];
}

/** Changes the setup in place, when the project has one. */
function withSetup(bp: BoardPaths, change: (s: SetupState, meta: BoardMeta) => void): void {
  const meta = readMeta(bp);
  if (!meta.setup) return;
  change(meta.setup, meta);
  writeMeta(bp, meta);
}

function clean(c: ProjectCommands): ProjectCommands {
  return Object.fromEntries(Object.entries(c ?? {}).filter(([, v]) => typeof v === 'string' && v.trim())) as ProjectCommands;
}

/** An idea for a first story that is about technology, not about what people will do. */
const TECHNICAL_IDEA = /\b(tech(nology)?\s*stack|the\s+stack|technolog(y|ies)|framework|programming\s+language|database|repo(sitory)?|boilerplate|scaffold|set\s*up|install|tooling|hosting|deploy)\b/i;

/**
 * What a read of a project with no code may say: no rules, no map, no commands and no parts, as nothing was found. The
 * Architect picks the technology when the first story is planned. First stories come only from what the person said
 * they want to build, and never about technology.
 */
function noCodeAnswer(out: ScanAnswer, idea: string): ScanAnswer {
  const ideas = idea ? (out.ideas ?? []).filter((i) => i?.title && !TECHNICAL_IDEA.test(`${i.title} ${i.why ?? ''}`)) : [];
  return { empty: true, summary: out.summary, map: [], decisions: [], commands: {}, users: '', can: [], worth: [], ideas, parts: [], links: [] };
}

/**
 * The Architect's commands, ready to save: its test command with the project's separate browser tests when it left them
 * out, and a start that opens a window, or Flutter's plain analyze, made safe (fromTheRead). Each change goes in the log.
 */
function withAllTests(dir: string, c: ProjectCommands): ProjectCommands {
  const safe = fromTheRead(dir, c);
  for (const line of safe.changed) writeLog({ level: 'info', text: line });
  const test = withBrowserTests(dir, safe.commands.test);
  return test ? { ...safe.commands, test } : safe.commands;
}

/* ── The read ──────────────────────────────────────────── */

/** What the first step says while a big folder with no git gets its first save. */
export const FIRST_SAVE_WORDS = 'Saving your files for the first time. On a big project this takes a while.';

/** True when a big folder's first save is not over: nothing else can start without it (ensureRepo). */
export function firstSaveHolds(meta: BoardMeta): boolean {
  return Boolean(meta.setup?.steps.some((s) => s.id === 'files' && s.state !== 'done'));
}

export function firstSaveDue(meta: BoardMeta): boolean {
  return Boolean(meta.setup?.steps.some((s) => s.id === 'files' && (s.state === 'todo' || s.state === 'now')));
}

/** A big folder's first save, as a step of the setup. A Stop or the board closing leaves it to be run again. */
export async function runFirstSave(bp: BoardPaths, signal: AbortSignal): Promise<void> {
  withSetup(bp, (s) => begin(s, 'files', FIRST_SAVE_WORDS));
  try {
    await firstSaveLater(bp.root, signal);
    withSetup(bp, (s) => {
      finish(s, 'files', 'done');
      delete stepOf(s, 'files').note;
    });
  } catch (err) {
    if (signal.aborted) return;
    withSetup(bp, (s) => finish(s, 'files', 'failed', { error: plainWords(err, 'Saving the files for the first time', 'something technical stopped it. Press Try again.') }));
  }
}

/** The read starts: the AI tool's step says whether it is ready, and the Architect starts reading. */
export async function readStarted(bp: BoardPaths, tool: { label: string; ready: boolean }): Promise<void> {
  const [files, here] = await Promise.all([countFiles(bp.root), gitState(bp.root)]);
  withSetup(bp, (s) => {
    const t = stepOf(s, 'tool');
    if (t.state !== 'done') {
      if (t.state !== 'now') begin(s, 'tool');
      if (tool.ready) finish(s, 'tool', 'done', { note: 'The squad works with it' });
      else finish(s, 'tool', 'failed', { error: `${tool.label} is not installed on this computer. Install it and sign in once, then press Try again.` });
    }
    begin(s, 'read', 'Starting…');
    s.reads = [];
    s.proof = { ...s.proof, files, read: 0, ...here };
  });
}

/** What the Architect reads right now, and how many files it opened so far. */
export function readingNow(bp: BoardPaths, line: string, opened: number, read = line): void {
  withSetup(bp, (s) => {
    const st = stepOf(s, 'read');
    if (st.state !== 'now') return;
    // Plain words, with how many it opened itself. It reads more through the shell, so never "1 of 98".
    st.note = `${line}${opened ? ` · ${opened} ${opened === 1 ? 'file' : 'files'}` : ''}`;
    // What it opened, for engineers: behind "See what the Architect is reading".
    if (s.reads?.at(-1) !== read) s.reads = [...(s.reads ?? []), read].slice(-8);
    s.proof = { ...s.proof, read: opened };
  });
}


/**
 * Stop was pressed while nothing runs: the usage limit holds the read, say. Nothing would ever answer it, so the step
 * stands stopped now, and Start again works at once.
 */
export function settleSetupStop(bp: BoardPaths): void {
  withSetup(bp, (s) => {
    if (!s.stopping) return;
    const step = s.steps.find((x) => x.state === 'now') ?? currentStep(s);
    if (step) {
      step.state = 'stopped';
      step.note = 'You stopped it.';
    }
    delete s.stopping;
  });
  const meta = readMeta(bp);
  if (meta.scan?.status === 'pending' || meta.scan?.status === 'running') writeMeta(bp, { ...meta, scan: { status: 'failed', at: now(), error: 'You stopped it. Press Start again when you are ready.' } });
}

export function readFailed(bp: BoardPaths, error: string): void {
  withSetup(bp, (s) => {
    const stopped = Boolean(s.stopping) || error === STOPPED;
    finish(s, 'read', stopped ? 'stopped' : 'failed', stopped ? { note: 'You stopped it.' } : { error });
    delete s.stopping;
  });
}

/**
 * The Architect handed in its read. The map, the commands and the repos are saved as before, and squad-kit learns the
 * project's database from its files (engine/story-db.ts); the overview goes to
 * `knowledge/overview.md`; and the technical choices it found become proposed decisions (STACK.1, STACK.2): the person
 * approves them on the overview, and only then are they rules. A choice found before stays as it is; a proposal the
 * new read no longer finds goes. `idea` is what the person wants to build, on a project with no code.
 */
export function saveScan(bp: BoardPaths, answer: ScanAnswer, nested: RepoInfo[], at = now(), idea = ''): void {
  const fresh = readMeta(bp);
  // A folder squad-kit made itself, with nothing in it but its README, has no code, whatever the answer says.
  const none = answer.empty || (fresh.setup?.kind === 'empty' && nextToNothing(bp.root));
  const out = none ? noCodeAnswer(answer, idea) : answer;
  fresh.map = out.map ?? [];
  fresh.commands = { ...withAllTests(bp.root, clean(out.commands)), ...clean(fresh.commands ?? {}) };
  if (nested.length) {
    fresh.repos = nested.map((r) => {
      const found = out.repos?.find((x) => x.path.replace(/\/$/, '') === r.path);
      const kept = fresh.repos?.find((x) => x.path === r.path);
      return { ...r, summary: found?.summary ?? kept?.summary, commands: { ...withAllTests(path.join(bp.root, r.path), clean(found?.commands ?? {})), ...clean(kept?.commands ?? {}) } };
    });
  }
  const parts = partsAfterRead(cleanParts(out.runs, fresh, bp.root), fresh.parts);
  if (parts.length) fresh.parts = parts;
  else delete fresh.parts;
  fresh.scan = { status: 'done', at, summary: out.summary, empty: out.empty };
  if (fresh.setup) {
    const s = fresh.setup;
    finish(s, 'read', 'done', { note: readWords(s.proof?.files) });
    learnSetupTime(bp, stepOf(s, 'read'));
    if (out.empty) {
      for (const id of ['commands', 'tests', 'app'] as const) finish(s, id, 'skipped', { note: 'Nothing to run yet: the project has no code' }, Date.parse(at));
    }
  }
  writeMeta(bp, fresh);
  // The project's database, from its own files: an engineer confirms it before any story gets its own copy.
  if (!out.empty) learnAfterRead(bp);

  const before = readOverview(bp);
  writeOverview(bp, { ...cleanOverview(out), readAt: at, ...(before.approved && !fresh.setup ? { approved: before.approved } : {}) });

  const found = (out.decisions ?? []).filter((d) => d?.title?.trim());
  const titles = new Set(found.map((d) => d.title.trim()));
  for (const d of listDecisions(bp)) {
    // Never approved, and not found again: it was only ever a proposal.
    if (d.proposed && !titles.has(d.title)) fs.rmSync(path.join(bp.decisionsDir, `${d.id}.md`), { force: true });
  }
  const existing = listDecisions(bp);
  for (const d of found) {
    if (existing.some((x) => x.title === d.title.trim())) continue;
    // Found in the code, made by no ticket: STACK.1, STACK.2 (ADR-001). A proposal until the person approves it.
    writeDecision(bp, {
      id: nextDecisionId(bp),
      title: d.title.trim(),
      why: d.why ?? '',
      options: [d.title.trim()],
      chosen: d.title.trim(),
      from: 'Project scan',
      approvedBy: '',
      proposed: true,
      date: at,
      checkedBy: null,
      tickets: [],
    });
  }
}

/* ── squad-kit's own proof, on its own copy ────────────── */

export interface ProofDeps {
  /**
   * squad-kit takes one screenshot of the app it opened, with its own browser. The file it saved, or why it could
   * not, in plain words. `onLine` shows what it does meanwhile, like setting up its browser the first time.
   */
  shoot(o: { cwd: string; url: string; file: string; onLine?: (text: string) => void }): Promise<{ file?: string; why?: string }>;
  /** The person's Stop, or the board closing. */
  signal: AbortSignal;
}

/** squad-kit's own copy of one repo for the setup, beside the ticket copies, kept until the overview is approved. */
export function setupCopyDir(bp: BoardPaths, repo: RepoInfo): string {
  return path.join(worktreeRoot(path.join(bp.root, repo.path)), 'setup-copy');
}

/** Makes the copy, or keeps the one there. True when it is new, so it still needs its setup command. */
async function ensureCopy(bp: BoardPaths, repo: RepoInfo, signal: AbortSignal): Promise<{ dir: string; fresh: boolean }> {
  await droppingSetup.get(bp.squadDir);
  const dir = setupCopyDir(bp, repo);
  if (copyIsWhole(dir)) {
    placeStoryFiles(bp, repo.path, dir);
    return { dir, fresh: false };
  }
  const src = path.join(bp.root, repo.path);
  const commit = git(src, ['rev-parse', '--verify', `${repo.base}^{commit}`], { allowFail: true }) || git(src, ['rev-parse', 'HEAD']);
  await addSnapshot(src, path.basename(dir), commit, { signal });
  // The app needs the person's .env files to start; git never carries them. A file an engineer named as local uses the
  // values kept for squad-kit's own runs instead: what a failing test prints here is saved with the setup.
  await fillOwnCopy(bp, repo.path, dir);
  return { dir, fresh: true };
}

/** The copies go once the person approved the overview, or a new setup starts. */
/** squad-kit's own guard for a setup copy's commands on this computer, or null where there is none (Windows). */
function guardFor(bp: BoardPaths, cwd: string): GuardSpec | undefined {
  if (!guardSupport().on) return undefined;
  const allow = readMeta(bp).guard;
  return projectGuardFor(bp, { cwd, ...(allow ? { allow } : {}) });
}

export function dropSetupCopies(bp: BoardPaths): Promise<void> {
  const run = (droppingSetup.get(bp.squadDir) ?? Promise.resolve()).then(async () => {
    let meta: BoardMeta;
    try {
      meta = readMeta(bp);
    } catch {
      return;
    }
    for (const repo of reposOf(meta)) {
      const dir = setupCopyDir(bp, repo);
      if (fs.existsSync(dir)) await dropSnapshot(path.join(bp.root, repo.path), dir);
    }
  });
  droppingSetup.set(bp.squadDir, run.catch(() => undefined));
  return run;
}

/** Setup copies going away beside everything else: a step that wants one waits for this first, or it could take one that is going. */
const droppingSetup = new Map<string, Promise<unknown>>();

/** What the step found, in plain words. The commands themselves are in Settings, under How the squad checks and runs this project. */
export function commandsLine(meta: BoardMeta): string {
  const repos = reposOf(meta);
  const tests = repos.some((r) => r.commands.test?.trim());
  const start = repos.some((r) => r.commands.start?.trim());
  if (tests && start) return 'Found how to run the tests and start the app';
  if (tests) return 'Found how to run the tests';
  if (start) return 'Found how to start the app';
  return 'Found no tests and no app to start yet.';
}

type Step = (bp: BoardPaths, deps: ProofDeps, copies: Map<string, string>) => Promise<void>;

/** Finding how to test and run it: squad-kit's own copy of the code, with what it needs installed. */
const commandsStep: Step = async (bp, deps, copies) => {
  withSetup(bp, (s) => begin(s, 'commands', "Making squad-kit's own copy of the code. On a big project this takes a while."));
  const meta = readMeta(bp);
  const failures: { error: string; output?: string }[] = [];
  for (const repo of reposOf(meta).filter((r) => repoInUse(meta, r.path))) {
    let copy: { dir: string; fresh: boolean };
    try {
      copy = await ensureCopy(bp, repo, deps.signal);
    } catch (err) {
      if (err instanceof GitStopped) throw err;
      failures.push({ error: err instanceof NoRoomForCopy ? err.message : `squad-kit could not make its copy of the code: ${(err as Error).message}` });
      continue;
    }
    copies.set(repo.path, copy.dir);
    const setup = repo.commands.setup?.trim();
    if (!setup) continue;
    withSetup(bp, (s) => (stepOf(s, 'commands').note = 'Installing what it needs'));
    const r = await runCommand(copy.dir, setup, SETUP_MS, { silentMs: CHECK_SILENT_MS, signal: deps.signal, ...(guardFor(bp, copy.dir) ? { guard: guardFor(bp, copy.dir)! } : {}) });
    if (deps.signal.aborted) throw new Error(STOPPED);
    if (!r.ok) failures.push({ error: dockerBlockedWords(r.output, guardFor(bp, copy.dir)) ?? 'Installing what it needs did not work.', output: `${setup}:\n${tail(r.output, 30)}` });
  }
  const fresh = readMeta(bp);
  withSetup(bp, (s) => {
    const f = failures[0];
    if (f) finish(s, 'commands', 'failed', { note: commandsLine(fresh), error: f.error, ...(f.output ? { output: f.output } : {}) });
    else finish(s, 'commands', 'done', { note: commandsLine(fresh) });
    learnSetupTime(bp, stepOf(s, 'commands'));
  });
};

/** A copy for a later step that was tried again on its own. */
async function copyFor(bp: BoardPaths, repo: RepoInfo, copies: Map<string, string>, signal: AbortSignal): Promise<string> {
  const known = copies.get(repo.path);
  if (known) return known;
  const copy = await ensureCopy(bp, repo, signal);
  copies.set(repo.path, copy.dir);
  const setup = repo.commands.setup?.trim();
  if (copy.fresh && setup) await runCommand(copy.dir, setup, SETUP_MS, { silentMs: CHECK_SILENT_MS, signal, ...(guardFor(bp, copy.dir) ? { guard: guardFor(bp, copy.dir)! } : {}) });
  return copy.dir;
}

/** Trying the tests, in squad-kit's copy. */
const testsStep: Step = async (bp, deps, copies) => {
  const meta = readMeta(bp);
  const repos = reposOf(meta).filter((r) => r.commands.test?.trim() && repoInUse(meta, r.path));
  if (!repos.length) {
    withSetup(bp, (s) => {
      begin(s, 'tests');
      finish(s, 'tests', 'skipped', { note: 'No tests found. Your first ticket can add some.' });
    });
    return;
  }
  const runs: SetupTestRun[] = [];
  for (const repo of repos) {
    const command = repo.commands.test!.trim();
    withSetup(bp, (s) => begin(s, 'tests', DOING.tests));
    let dir: string;
    try {
      dir = await copyFor(bp, repo, copies, deps.signal);
    } catch (err) {
      runs.push({ ok: false, command, repo: repo.path, output: (err as Error).message });
      continue;
    }
    const r = await runCommand(dir, command, CHECK_MS, { silentMs: CHECK_SILENT_MS, signal: deps.signal, ...(guardFor(bp, dir) ? { guard: guardFor(bp, dir)! } : {}) });
    if (deps.signal.aborted) throw new Error(STOPPED);
    const passed = testCount(r.output);
    runs.push({ ok: r.ok, command, repo: repo.path, seconds: Math.round(r.seconds), ...(passed !== null ? { passed } : {}), ...(r.ok ? {} : { output: tail(r.output, 30) }) });
  }
  const failed = runs.filter((x) => !x.ok);
  const passed = runs.reduce((n, x) => n + (x.passed ?? 0), 0);
  withSetup(bp, (s) => {
    s.proof = { ...s.proof, tests: runs };
    if (failed.length) {
      const f = failed[0]!;
      finish(s, 'tests', 'failed', {
        note: runs.length > 1 ? `${failed.length} of ${runs.length} test runs did not pass` : 'Your tests did not pass here',
        error: "The tests did not pass in squad-kit's copy. The setup goes on: this does not stop you.",
        output: `${f.command}:\n${f.output ?? ''}`,
      });
    } else finish(s, 'tests', 'done', { note: passed ? `Ran your tests: ${passed} pass` : 'Ran your tests: they pass' });
    learnSetupTime(bp, stepOf(s, 'tests'));
  });
};

/** Opening the app once, with a screenshot the person sees on the overview. */
const appStep: Step = async (bp, deps, copies) => {
  const meta = readMeta(bp);
  const repo = reposOf(meta).find((r) => r.commands.start?.trim() && r.commands.url?.trim() && repoInUse(meta, r.path));
  if (!repo) {
    withSetup(bp, (s) => {
      begin(s, 'app');
      finish(s, 'app', 'skipped', { note: 'No app to open yet.' });
    });
    return;
  }
  const start = repo.commands.start!.trim();
  const url = repo.commands.url!.trim();
  withSetup(bp, (s) => begin(s, 'app', DOING.start));
  let app: RunningApp | null = null;
  let dir = '';
  try {
    dir = await copyFor(bp, repo, copies, deps.signal);
    app = await startApp(dir, start, url, APP_WAIT_MS, deps.signal, guardFor(bp, dir));
    const at = app.url;
    withSetup(bp, (s) => (stepOf(s, 'app').note = 'Taking a screenshot'));
    fs.mkdirSync(bp.proofDir, { recursive: true });
    const file = path.join(bp.proofDir, 'setup-app.png');
    fs.rmSync(file, { force: true });
    let shot: { file?: string; why?: string };
    try {
      shot = await deps.shoot({ cwd: dir, url: at, file, onLine: (t) => withSetup(bp, (s) => (stepOf(s, 'app').note = t)) });
    } catch (err) {
      if (deps.signal.aborted) throw err;
      shot = { why: (err as Error).message };
    }
    const saved = fs.existsSync(file) ? path.basename(file) : undefined;
    withSetup(bp, (s) => {
      s.proof = { ...s.proof, app: { ok: true, url: at, command: start, repo: repo.path, ...(saved ? { shot: saved } : {}) } };
      // The exact address and why there is no picture stay in the proof, for engineers.
      finish(s, 'app', 'done', { note: saved ? 'Opened the app' : 'Opened the app. No screenshot this time.', ...(saved ? {} : { output: `${at}: ${(shot.why ?? 'squad-kit saved none').slice(0, 400)}` }) });
      learnSetupTime(bp, stepOf(s, 'app'));
    });
  } catch (err) {
    if (deps.signal.aborted) throw err;
    const error = (err as Error).message;
    withSetup(bp, (s) => {
      s.proof = { ...s.proof, app: { ok: false, url, command: start, repo: repo.path, error } };
      // One plain sentence; what the app printed is behind "See what failed", for engineers.
      finish(s, 'app', 'failed', { note: 'The app did not open here', error: (dir ? dockerBlockedWords(error, guardFor(bp, dir)) : null) ?? 'squad-kit could not start the app in its own copy. The setup goes on: this does not stop you.', output: error.slice(-4000) });
    });
  } finally {
    app?.stop();
  }
};

const overviewStep: Step = async (bp) => {
  withSetup(bp, (s, meta) => {
    begin(s, 'overview');
    const empty = readTalk(bp)?.idea ? 'Your first stories, for you to check' : 'One question for you: what do you want to build?';
    finish(s, 'overview', 'done', { note: meta.scan?.empty ? empty : 'What squad-kit understood, for you to check' });
    s.readyAt = now();
  });
};

const STEPS: Partial<Record<SetupStepId, Step>> = { commands: commandsStep, tests: testsStep, app: appStep, overview: overviewStep };

/** The board closed in the middle of a step: it runs again from its start. The read starts again by itself. */
export function resumeSetup(bp: BoardPaths): void {
  withSetup(bp, (s) => {
    for (const st of s.steps) {
      if (st.state === 'now' && st.id !== 'read') {
        st.state = 'todo';
        delete st.since;
      }
    }
    delete s.stopping;
  });
}

/**
 * Runs the steps after the read, one after another, until the overview is ready. A Stop ends the step running then;
 * it waits as "stopped" until the person starts it again.
 */
export async function runSetupProof(bp: BoardPaths, deps: ProofDeps): Promise<void> {
  const copies = new Map<string, string>();
  for (;;) {
    const id = nextProofStep(readMeta(bp).setup);
    if (!id) return;
    try {
      if (deps.signal.aborted) throw new Error(STOPPED);
      await STEPS[id]!(bp, deps, copies);
    } catch (err) {
      const stopped = deps.signal.aborted || (err as Error).message === STOPPED;
      withSetup(bp, (s) => {
        if (stopped) finish(s, id, 'stopped', { note: 'You stopped it.' });
        else finish(s, id, 'failed', { error: (err as Error).message });
        delete s.stopping;
      });
      if (stopped) return;
    }
  }
}

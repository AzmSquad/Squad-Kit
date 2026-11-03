import fs from 'node:fs';
import path from 'node:path';
import { listDecisions, nextDecisionId, now, readMeta, writeDecision, writeMeta, type BoardPaths } from '../board/store.js';
import type { BoardMeta, ProjectCommands, RepoInfo } from '../board/types.js';
import { cleanOverview, readOverview, writeOverview } from '../board/overview.js';
import { begin, finish, learnSetupTime, nextProofStep, stepOf, type SetupState, type SetupStepId, type SetupTestRun } from '../board/setup-state.js';
import { runCommand, startApp, tail, testCount, CHECK_SILENT_MS, type RunningApp } from './checks.js';
import { addSnapshot, dropSnapshot, git, worktreeRoot } from './git.js';
import { reposOf } from './repos.js';
import { copyEnvFiles } from './run-app.js';
import { countFiles, gitState } from './first-look.js';

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

/* ── The read ──────────────────────────────────────────── */

/** The read starts: the AI tool's step says whether it is ready, and the Architect starts reading. */
export function readStarted(bp: BoardPaths, tool: { label: string; ready: boolean }): void {
  const files = countFiles(bp.root);
  const here = gitState(bp.root);
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
export function readingNow(bp: BoardPaths, line: string, opened: number): void {
  withSetup(bp, (s) => {
    const st = stepOf(s, 'read');
    if (st.state !== 'now') return;
    const total = s.proof?.files;
    // It may open files git does not count (the project's own notes): then the count alone.
    st.note = `${line}${opened ? ` · ${opened}${total && opened <= total ? ` of ${total}` : ''} files` : ''}`;
    s.reads = [...(s.reads ?? []), line].slice(-8);
    s.proof = { ...s.proof, read: opened };
  });
}

export function readFailed(bp: BoardPaths, error: string): void {
  withSetup(bp, (s) => {
    const stopped = Boolean(s.stopping) || error === STOPPED;
    finish(s, 'read', stopped ? 'stopped' : 'failed', stopped ? { note: 'You stopped it.' } : { error });
    delete s.stopping;
  });
}

/**
 * The Architect handed in its read. The map, the commands and the repos are saved as before; the overview goes to
 * `knowledge/overview.md`; and the technical choices it found become proposed decisions (STACK.1, STACK.2): the person
 * approves them on the overview, and only then are they rules. A choice found before stays as it is; a proposal the
 * new read no longer finds goes.
 */
export function saveScan(bp: BoardPaths, out: ScanAnswer, nested: RepoInfo[], at = now()): void {
  const fresh = readMeta(bp);
  fresh.map = out.map ?? [];
  fresh.commands = { ...clean(out.commands), ...clean(fresh.commands ?? {}) };
  if (nested.length) {
    fresh.repos = nested.map((r) => {
      const found = out.repos?.find((x) => x.path.replace(/\/$/, '') === r.path);
      const kept = fresh.repos?.find((x) => x.path === r.path);
      return { ...r, summary: found?.summary ?? kept?.summary, commands: { ...clean(found?.commands ?? {}), ...clean(kept?.commands ?? {}) } };
    });
  }
  fresh.scan = { status: 'done', at, summary: out.summary, empty: out.empty };
  if (fresh.setup) {
    const s = fresh.setup;
    const opened = s.proof?.read ?? 0;
    const total = s.proof?.files ?? 0;
    const note = !opened ? 'Read the project' : opened === total ? `Read all ${total} files` : opened < total ? `Read ${opened} of ${total} files` : `Read ${opened} files`;
    finish(s, 'read', 'done', { note });
    learnSetupTime(bp, stepOf(s, 'read'));
    if (out.empty) {
      for (const id of ['commands', 'tests', 'app'] as const) finish(s, id, 'skipped', { note: 'Nothing to run yet: the project has no code' }, Date.parse(at));
    }
  }
  writeMeta(bp, fresh);

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
  /** The Tester takes one screenshot of the app squad-kit opened. The file it saved, or why it could not. */
  shoot(o: { cwd: string; url: string; file: string }): Promise<{ file?: string; why?: string }>;
  /** The person's Stop, or the board closing. */
  signal: AbortSignal;
}

/** squad-kit's own copy of one repo for the setup, beside the ticket copies, kept until the overview is approved. */
export function setupCopyDir(bp: BoardPaths, repo: RepoInfo): string {
  return path.join(worktreeRoot(path.join(bp.root, repo.path)), 'setup-copy');
}

/** Makes the copy, or keeps the one there. True when it is new, so it still needs its setup command. */
function ensureCopy(bp: BoardPaths, repo: RepoInfo): { dir: string; fresh: boolean } {
  const dir = setupCopyDir(bp, repo);
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, fresh: false };
  const src = path.join(bp.root, repo.path);
  const commit = git(src, ['rev-parse', '--verify', `${repo.base}^{commit}`], { allowFail: true }) || git(src, ['rev-parse', 'HEAD']);
  addSnapshot(src, path.basename(dir), commit);
  // The app needs the person's .env files to start; git never carries them.
  copyEnvFiles(src, dir);
  return { dir, fresh: true };
}

/** The copies go once the person approved the overview, or a new setup starts. */
export function dropSetupCopies(bp: BoardPaths): void {
  let meta: BoardMeta;
  try {
    meta = readMeta(bp);
  } catch {
    return;
  }
  for (const repo of reposOf(meta)) {
    const dir = setupCopyDir(bp, repo);
    if (fs.existsSync(dir)) dropSnapshot(path.join(bp.root, repo.path), dir);
  }
}

/** "Tests: npm test · Starts with: npm run dev", per repo when there are several. */
export function commandsLine(meta: BoardMeta): string {
  const repos = reposOf(meta);
  const one = (c: ProjectCommands) => [c.test && `Tests: ${c.test}`, c.start && `Starts with: ${c.start}`].filter(Boolean).join(' · ');
  const lines = repos.map((r) => ({ r, text: one(r.commands) })).filter((x) => x.text);
  if (!lines.length) return 'No test or start command found. You can add them in Settings.';
  return repos.length > 1 ? lines.map((x) => `${x.r.path}: ${x.text}`).join(' · ') : lines[0]!.text;
}

type Step = (bp: BoardPaths, deps: ProofDeps, copies: Map<string, string>) => Promise<void>;

/** Finding how to test and run it: squad-kit's own copy of the code, with what it needs installed. */
const commandsStep: Step = async (bp, deps, copies) => {
  withSetup(bp, (s) => begin(s, 'commands', "Making squad-kit's own copy of the code"));
  const meta = readMeta(bp);
  const failures: { error: string; output?: string }[] = [];
  for (const repo of reposOf(meta)) {
    let copy: { dir: string; fresh: boolean };
    try {
      copy = ensureCopy(bp, repo);
    } catch (err) {
      failures.push({ error: `squad-kit could not make its copy of ${repo.path === '.' ? 'the code' : repo.path}: ${(err as Error).message}` });
      continue;
    }
    copies.set(repo.path, copy.dir);
    const setup = repo.commands.setup?.trim();
    if (!setup) continue;
    withSetup(bp, (s) => (stepOf(s, 'commands').note = `Installing what it needs: ${setup}`));
    const r = await runCommand(copy.dir, setup, 20 * 60_000, { silentMs: CHECK_SILENT_MS, signal: deps.signal });
    if (deps.signal.aborted) throw new Error(STOPPED);
    if (!r.ok) failures.push({ error: `Installing what it needs did not work (${setup}).`, output: tail(r.output, 30) });
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
  const copy = ensureCopy(bp, repo);
  copies.set(repo.path, copy.dir);
  const setup = repo.commands.setup?.trim();
  if (copy.fresh && setup) await runCommand(copy.dir, setup, 20 * 60_000, { silentMs: CHECK_SILENT_MS, signal });
  return copy.dir;
}

/** Trying the tests, in squad-kit's copy. */
const testsStep: Step = async (bp, deps, copies) => {
  const repos = reposOf(readMeta(bp)).filter((r) => r.commands.test?.trim());
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
    withSetup(bp, (s) => begin(s, 'tests', `Running ${command}${repos.length > 1 ? ` in ${repo.path}` : ''}`));
    let dir: string;
    try {
      dir = await copyFor(bp, repo, copies, deps.signal);
    } catch (err) {
      runs.push({ ok: false, command, repo: repo.path, output: (err as Error).message });
      continue;
    }
    const r = await runCommand(dir, command, 15 * 60_000, { silentMs: CHECK_SILENT_MS, signal: deps.signal });
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
        error: `The tests did not pass in squad-kit's copy (${f.command}). The setup goes on: this does not stop you.`,
        output: f.output ?? '',
      });
    } else finish(s, 'tests', 'done', { note: passed ? `Ran your tests: ${passed} pass` : 'Ran your tests: they pass' });
    learnSetupTime(bp, stepOf(s, 'tests'));
  });
};

/** Opening the app once, with a screenshot the person sees on the overview. */
const appStep: Step = async (bp, deps, copies) => {
  const repo = reposOf(readMeta(bp)).find((r) => r.commands.start?.trim() && r.commands.url?.trim());
  if (!repo) {
    withSetup(bp, (s) => {
      begin(s, 'app');
      finish(s, 'app', 'skipped', { note: 'No app to open: squad-kit found no start command. You can set it in Settings.' });
    });
    return;
  }
  const start = repo.commands.start!.trim();
  const url = repo.commands.url!.trim();
  withSetup(bp, (s) => begin(s, 'app', `Starting it: ${start}`));
  let app: RunningApp | null = null;
  try {
    const dir = await copyFor(bp, repo, copies, deps.signal);
    app = await startApp(dir, start, url, 3 * 60_000, deps.signal);
    const at = app.url;
    withSetup(bp, (s) => (stepOf(s, 'app').note = `Taking a screenshot at ${at}`));
    fs.mkdirSync(bp.proofDir, { recursive: true });
    const file = path.join(bp.proofDir, 'setup-app.png');
    fs.rmSync(file, { force: true });
    let shot: { file?: string; why?: string };
    try {
      shot = await deps.shoot({ cwd: dir, url: at, file });
    } catch (err) {
      if (deps.signal.aborted) throw err;
      shot = { why: (err as Error).message };
    }
    const saved = fs.existsSync(file) ? path.basename(file) : undefined;
    const host = at.replace(/^https?:\/\//, '').replace(/\/$/, '');
    withSetup(bp, (s) => {
      s.proof = { ...s.proof, app: { ok: true, url: at, command: start, repo: repo.path, ...(saved ? { shot: saved } : {}) } };
      finish(s, 'app', 'done', { note: saved ? `Opened it at ${host}` : `Opened it at ${host}. No screenshot: ${(shot.why ?? 'the Tester saved none').slice(0, 200)}` });
      learnSetupTime(bp, stepOf(s, 'app'));
    });
  } catch (err) {
    if (deps.signal.aborted) throw err;
    const error = (err as Error).message;
    withSetup(bp, (s) => {
      s.proof = { ...s.proof, app: { ok: false, url, command: start, repo: repo.path, error } };
      finish(s, 'app', 'failed', { note: 'The app did not open here', error: `${error.slice(0, 600)} The setup goes on: this does not stop you.` });
    });
  } finally {
    app?.stop();
  }
};

const overviewStep: Step = async (bp) => {
  withSetup(bp, (s) => {
    begin(s, 'overview');
    finish(s, 'overview', 'done', { note: 'What squad-kit understood, for you to check' });
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

import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { SQUAD_DIR, findSquadRoot, type SquadPaths } from '../core/paths.js';
import { boardExists, boardPaths, listTickets, readMeta, settingsProblem, type BoardPaths } from '../board/store.js';
import { startDemoSquad } from '../board/engine.js';
import { claimSquad } from '../board/lock.js';
import { runningConsole, writeConsoleInfo, type ConsoleInfo } from '../board/console-info.js';
import { inbox } from '../board/actions.js';
import type { Ticket } from '../board/types.js';
import { LiveSquad } from '../engine/live.js';
import { stopApps } from '../engine/run-app.js';
import { stopTries } from '../engine/try-app.js';
import { prepareProject } from '../engine/setup.js';
import { addAsk } from '../engine/first-look.js';
import { dropNewProject, makeNewProject, type NewProjectInput } from '../engine/new-project.js';
import { setupLine, setupView } from '../board/first-run.js';
import { forgetProject, projectName, readProjects, rememberProject } from '../core/projects.js';
import { mountApi, type MountApiOptions } from './api/index.js';
import { authMiddleware } from './auth.js';

/**
 * One app, many projects (ADR-001). Each open project runs its own squad and answers the same API one board always
 * had, under /p/<project id>/. The tickets running at once are limited across all of them (see LiveSquad). The app's
 * list of projects lives in ~/.squad-kit/projects.json.
 */

export interface OpenProject {
  id: string;
  root: string;
  paths: SquadPaths;
  bp: BoardPaths;
  /** The project's own API, at the addresses one board always had: /api/v1/board, /mockup/:id … */
  api: Hono;
  close(): void;
}

/** A project on the app's list that could not open here, with why, in plain words. */
export interface ClosedProject {
  id: string;
  root: string;
  why: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  /** The squad runs here. A project that could not open says why instead. */
  open: boolean;
  why?: string;
  engine?: 'demo' | 'live';
  /** The Architect's first read of the project, and the setup's step in one line while it runs. */
  setup?: { status: 'pending' | 'running' | 'done' | 'failed'; now?: string; error?: string; line?: string; ready?: boolean; approved?: boolean };
  tickets: number;
  waiting: number;
  working: number;
  /** The board's address in the app. */
  url: string;
}

export interface OpenProjectsOptions {
  token: string;
  control?: MountApiOptions['control'];
  /** Where the app runs, written for each open project so `squad console` and terminal commands find it. */
  info(): ConsoleInfo;
  /** Keep the app's list in ~/.squad-kit/projects.json. Off when one board is served on its own (tests). */
  remember: boolean;
}

/** The setup in one line for the project's card on Home, while it runs or waits for the person. */
function setupSummary(bp: BoardPaths): { line?: string; ready?: boolean; approved?: boolean; brd?: { id: string; title: string } } {
  const v = setupView(bp);
  return v ? { line: setupLine(v), ready: v.ready, approved: v.approved, ...(v.brd ? { brd: v.brd } : {}) } : {};
}

export class OpenProjects {
  private open = new Map<string, OpenProject>();
  private closed = new Map<string, ClosedProject>();
  /** The project the app was started for (`squad console`): its API also answers without the /p/<id> prefix, for older links and tools. */
  first: string | null = null;

  constructor(private opts: OpenProjectsOptions) {}

  get(id: string): OpenProject | undefined {
    return this.open.get(id);
  }

  all(): OpenProject[] {
    return [...this.open.values()];
  }

  /** Opens every project on the app's list that is not open yet. One that cannot open stays listed with why. */
  openSaved(): void {
    for (const entry of readProjects()) {
      if (this.open.has(entry.id) || [...this.open.values()].some((p) => p.root === entry.root)) continue;
      if (!fs.existsSync(path.join(entry.root, SQUAD_DIR, 'config.yaml'))) {
        this.closed.set(entry.id, { ...entry, why: fs.existsSync(entry.root) ? 'Its squad-kit files are gone from the folder.' : 'The folder is not there any more.' });
        continue;
      }
      try {
        this.prepareAndOpen(entry.root);
      } catch (err) {
        this.closed.set(entry.id, { ...entry, why: (err as Error).message });
      }
    }
  }

  /**
   * Add project: any folder, set up the way `squad console` does it. A folder of a project adds that project. A
   * project that is open already is simply returned. A folder inside something bigger is never guessed at: the person
   * says which (`choice`), and a subfolder of a repo can only add the repo's top folder.
   */
  add(folder: string, choice?: 'above' | 'here'): { project: OpenProject; did: string[]; added: boolean } {
    const asked = path.resolve(folder);
    if (!fs.existsSync(asked) || !fs.statSync(asked).isDirectory()) throw new Error(`There is no folder at ${asked}.`);
    const ask = addAsk(asked);
    if (ask && (!choice || (choice === 'here' && ask.kind === 'inside-repo'))) throw new Error(ask.words);
    const root = ask ? (choice === 'above' ? ask.root : asked) : (findSquadRoot(asked) ?? asked);
    const known = this.all().find((p) => p.root === root);
    if (known) return { project: known, did: [], added: false };
    return { ...this.prepareAndOpen(root), added: true };
  }

  /** New project: made on disk with what the person gave, and only then its squad starts. */
  create(input: NewProjectInput): { project: OpenProject; did: string[]; opens: string } {
    const made = makeNewProject(input);
    try {
      return { project: this.openReady(made.paths), did: made.did, opens: made.opens };
    } catch (err) {
      if (this.open.has(made.bp.projectId)) this.remove(made.bp.projectId);
      dropNewProject(made.bp.root, made.bp);
      throw err;
    }
  }

  private prepareAndOpen(root: string): { project: OpenProject; did: string[] } {
    const elsewhere = runningConsole(boardPaths(path.join(root, SQUAD_DIR)));
    if (elsewhere) throw new Error('Its board is open in another squad-kit. Close that one first, then add it here.');
    const ready = prepareProject(root);
    return { project: this.openReady(ready.paths), did: ready.did };
  }

  /** Opens a project that is set up: its API, its squad, and the files that say the app runs it. */
  openReady(paths: SquadPaths): OpenProject {
    const bp = boardPaths(paths.squadDir);
    const id = bp.projectId;
    const same = this.open.get(id);
    if (same && same.root !== bp.root) {
      if (fs.existsSync(path.join(same.root, SQUAD_DIR))) throw new Error(`The same project is open already from ${same.root}. squad-kit can run one copy of a project at a time.`);
      // Its folder moved while the app ran: Add from Home follows it, and the squad at the old place ends.
      same.close();
      this.open.delete(id);
    }
    if (this.open.get(id)) return this.open.get(id)!;

    const api = new Hono();
    api.use('/api/*', authMiddleware(this.opts.token));
    mountApi(api, { paths, control: this.opts.control });

    // Each squad only acts on its own kind of board: `engine: demo` plays a script, `engine: live` runs the AI tools.
    const stopTimer = startDemoSquad(bp);
    const stopLive = new LiveSquad(bp).start();
    const releaseLock = claimSquad(bp);
    writeConsoleInfo(bp, this.opts.info());
    const project: OpenProject = {
      id,
      root: bp.root,
      paths,
      bp,
      api,
      close: () => {
        stopTimer();
        stopLive();
        // The apps squad-kit started for the project stop with its board, the whole process group, and so does the
        // ticket's copy the person was trying.
        stopApps(bp);
        stopTries(bp);
        releaseLock();
        writeConsoleInfo(bp, { ...this.opts.info(), pid: null });
      },
    };
    this.open.set(id, project);
    for (const c of [...this.closed.values()]) if (c.id === id || c.root === bp.root) this.closed.delete(c.id);
    if (this.opts.remember) rememberProject(id, bp.root);
    return project;
  }

  /** Takes a project out of the app: its squad stops and it leaves the list. Its files stay where they are. */
  remove(id: string): boolean {
    const p = this.open.get(id);
    p?.close();
    this.open.delete(id);
    const was = this.closed.delete(id) || Boolean(p);
    if (this.first === id) this.first = null;
    if (this.opts.remember) forgetProject(id);
    return was;
  }

  closeAll(): void {
    for (const p of this.open.values()) p.close();
  }

  summaries(): ProjectSummary[] {
    const rows: ProjectSummary[] = [];
    for (const p of this.open.values()) {
      const base = { id: p.id, name: projectName(p.root), root: p.root, url: `/p/${encodeURIComponent(p.id)}/board`, tickets: 0, waiting: 0, working: 0 };
      try {
        if (!boardExists(p.bp)) {
          const why = settingsProblem(p.bp);
          rows.push({ ...base, open: true, ...(why ? { why } : {}) });
          continue;
        }
        const meta = readMeta(p.bp);
        const open = listTickets(p.bp).filter((t) => t.stage !== 'done');
        rows.push({
          ...base,
          name: meta.project || base.name,
          open: true,
          engine: meta.engine,
          ...(meta.scan && (meta.engine === 'live' || meta.setup) ? { setup: { status: meta.scan.status, now: meta.scan.now, error: meta.scan.error, ...setupSummary(p.bp) } } : {}),
          tickets: open.length,
          waiting: inbox(p.bp).length,
          working: open.filter((t) => t.live && t.squad && !t.waiting).length,
        });
      } catch (err) {
        rows.push({ ...base, open: true, why: (err as Error).message });
      }
    }
    for (const c of this.closed.values()) {
      rows.push({ id: c.id, name: projectName(c.root), root: c.root, url: `/p/${encodeURIComponent(c.id)}/board`, open: false, why: c.why, tickets: 0, waiting: 0, working: 0 });
    }
    return rows;
  }

  /** Everything waiting for the person, across every open project, newest first. */
  waiting(): { project: { id: string; name: string }; ticket: Ticket }[] {
    const items: { project: { id: string; name: string }; ticket: Ticket; at: string }[] = [];
    for (const p of this.open.values()) {
      try {
        if (!boardExists(p.bp)) continue;
        const project = { id: p.id, name: readMeta(p.bp).project || projectName(p.root) };
        for (const t of inbox(p.bp)) items.push({ project, ticket: t, at: t.activity[0]?.at ?? t.createdAt });
      } catch {
        // A half-written file; the next poll reads it again.
      }
    }
    return items.sort((a, b) => b.at.localeCompare(a.at)).map(({ project, ticket }) => ({ project, ticket }));
  }
}

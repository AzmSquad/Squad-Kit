import fs from 'node:fs';
import path from 'node:path';
import { squadHome } from '../core/home.js';
import { changelogBlobUrl, readInstalledPackage, type InstalledPackage } from '../core/package-info.js';
import { projectName } from '../core/projects.js';
import { fetchLatest, isNewer } from '../core/registry.js';
import { checkForUpdates, setCheckForUpdates } from '../core/settings.js';
import { INSTALL_TIMEOUT_MS, fetchReleaseNotes, isMajorBump, runInstall, upgradePlan, whyInstallFailed, type InstallResult, type ReleaseNotes } from '../core/update.js';
import { boardExists, listTickets, readMeta, readTicket } from '../board/store.js';
import { agentRuns, holdNewRuns } from '../engine/live.js';
import type { OpenProject, OpenProjects } from './open-projects.js';

/**
 * The Update button. The app looks for a new squad-kit on npm on start and once a day (a setting, on by default),
 * and keeps what it found in ~/.squad-kit/update.json. Update now waits until no agent is in the middle of a step (or
 * the person says Now), installs with the package manager that installed squad-kit, and restarts through the keeper,
 * so every ticket carries on. The file keeps where the update is, so the fresh app can say how it went.
 */

export type UpdateState = 'idle' | 'waiting' | 'installing' | 'restarting' | 'done' | 'failed';

/** Work going on in a project, in plain words. */
export interface WorkItem {
  project: string;
  ticket?: string;
  title: string;
}

export interface UpdateProgress {
  state: UpdateState;
  /** When this state began. */
  at?: string;
  from?: string;
  /** The version being installed. */
  to?: string;
  /** In the middle of a step right now, while the update waits. */
  busy?: WorkItem[];
  /** What was in the middle of a step when the person pressed Update; the update waited for it. */
  waitedFor?: WorkItem[];
  /** The person said Now: running steps stop and pick up again after the restart. */
  now?: boolean;
  /** The tickets the squads were working through when the app restarted; each carries on where it was. */
  carried?: WorkItem[];
  reason?: string;
  /** The install needs the person's permission: they run the command once in a terminal. */
  permission?: boolean;
  /** What the package manager printed, for engineers. */
  output?: string;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  newer: boolean;
  /** A new major version: the person reads what changed and runs the command; it never installs by itself. */
  major: boolean;
  checkedAt: string | null;
  checkError?: string;
  /** A few lines of what is new in the latest version, or in this one right after an update. */
  notes?: string[];
  notesUrl: string;
  /** A source checkout never installs itself: it only gets the command. */
  devInstall: boolean;
  /** The one command that installs it by hand. */
  command: string;
  /** Look on start and once a day. */
  daily: boolean;
  /** The version the person said Later to: no banner for it. */
  later: string | null;
  /** When this app started; a new value means it restarted. */
  startedAt: string;
  progress: UpdateProgress;
}

interface Saved {
  checkedAt?: string;
  latest?: string;
  checkError?: string;
  notes?: ReleaseNotes;
  later?: string;
  progress?: UpdateProgress;
}

export interface UpdateDeps {
  fetch?: typeof fetch;
  install?: (cmd: string, args: string[]) => Promise<InstallResult>;
  installed?: () => InstalledPackage;
  /** Agent runs in the middle of a step, across every project. None means a safe moment. */
  busy?: () => WorkItem[];
  /** Tickets the squads are working through, across every project. */
  carrying?: () => WorkItem[];
  /** Stop or allow new runs while the update waits and installs. */
  hold?: (on: boolean) => void;
  /** Start a fresh app through the keeper. */
  restart?: () => void;
  now?: () => number;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const WAIT_POLL_MS = 1000;

const file = () => path.join(squadHome(), 'update.json');

export class UpdateService {
  private saved: Saved;
  /** The squad-kit this app runs. Read once: an install changes the files on disk, not the code running here. */
  private pkg: InstalledPackage;
  private checking: Promise<UpdateStatus> | null = null;
  private waitTimer: NodeJS.Timeout | null = null;
  readonly startedAt = new Date().toISOString();

  constructor(private deps: UpdateDeps = {}) {
    this.pkg = (deps.installed ?? readInstalledPackage)();
    this.saved = read();
    this.resume();
  }

  private installed(): InstalledPackage {
    return this.pkg;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private save(patch: Partial<Saved>): void {
    this.saved = { ...this.saved, ...patch };
    try {
      fs.mkdirSync(squadHome(), { recursive: true });
      fs.writeFileSync(file(), `${JSON.stringify(this.saved, null, 2)}\n`, 'utf8');
    } catch {
      // A read-only home folder: the update still runs, it just can't say how it went after the restart.
    }
  }

  private set(progress: UpdateProgress): void {
    this.save({ progress: { ...progress, at: this.stamp() } });
  }

  private progress(): UpdateProgress {
    return this.saved.progress ?? { state: 'idle' };
  }

  /** The app started: an update that restarted it is done when this is the new version. One cut off is not. */
  private resume(): void {
    const p = this.progress();
    const current = this.installed().version;
    if (p.state === 'restarting') {
      if (p.to && isNewer(p.to, current)) {
        this.set({ ...p, state: 'failed', reason: `squad-kit restarted, but it still runs ${current}. The new version went somewhere else on this computer.`, permission: false });
      } else {
        this.set({ state: 'done', from: p.from, to: current, carried: p.carried, waitedFor: p.waitedFor, now: p.now });
      }
    } else if (p.state === 'waiting') {
      this.set({ state: 'idle' });
    } else if (p.state === 'installing') {
      this.set({ ...p, state: 'failed', reason: 'squad-kit closed while it installed the update. Try again.', permission: false });
    }
  }

  /** On start, then once a day while the setting is on. The timer never keeps the app open. */
  watch(): () => void {
    if (checkForUpdates()) void this.check().catch(() => undefined);
    const timer = setInterval(() => {
      if (checkForUpdates() && this.due()) void this.check().catch(() => undefined);
    }, HOUR);
    timer.unref();
    return () => clearInterval(timer);
  }

  private due(): boolean {
    const at = Date.parse(this.saved.checkedAt ?? '');
    if (!Number.isFinite(at)) return true;
    // A failed check (offline) tries again within the hour; a good one waits a day.
    return this.now() - at >= (this.saved.checkError ? HOUR : DAY);
  }

  /** Ask npm for the latest version, and GitHub for what is new in it. */
  check(): Promise<UpdateStatus> {
    this.checking ??= this.look().finally(() => (this.checking = null));
    return this.checking;
  }

  private async look(): Promise<UpdateStatus> {
    const installed = this.installed();
    let latest: string;
    try {
      latest = (await fetchLatest(installed.name, 5000, this.deps.fetch)).latest;
    } catch {
      this.save({ checkedAt: this.stamp(), checkError: 'Could not reach the npm registry. Check the internet connection.' });
      return this.status();
    }
    this.save({ checkedAt: this.stamp(), latest, checkError: undefined });
    // Notes once per version; again while its release has none yet (it is often published a little after npm).
    if (isNewer(latest, installed.version) && (this.saved.notes?.version !== latest || !this.saved.notes.lines.length)) {
      this.save({ notes: await fetchReleaseNotes(installed.repositoryUrl, latest, { fetch: this.deps.fetch }) });
    }
    return this.status();
  }

  status(): UpdateStatus {
    const installed = this.installed();
    const latest = this.saved.latest ?? null;
    const newer = Boolean(latest && isNewer(latest, installed.version));
    let progress = this.progress();
    // The note after an update stays a day, unless the person closes it first.
    if (progress.state === 'done' && this.now() - Date.parse(progress.at ?? '') > DAY) progress = { state: 'idle' };
    const about = progress.state === 'done' ? installed.version : (latest ?? installed.version);
    const notes = this.saved.notes?.version === about ? this.saved.notes : undefined;
    const target = progress.to ?? (newer && latest ? latest : 'latest');
    return {
      current: installed.version,
      latest,
      newer,
      major: Boolean(newer && latest && isMajorBump(latest, installed.version)),
      checkedAt: this.saved.checkedAt ?? null,
      ...(this.saved.checkError ? { checkError: this.saved.checkError } : {}),
      ...(notes?.lines.length ? { notes: notes.lines } : {}),
      notesUrl: notes?.url ?? changelogBlobUrl(installed.repositoryUrl, about),
      devInstall: installed.isDevInstall,
      command: upgradePlan(installed, target).text,
      daily: checkForUpdates(),
      later: this.saved.later ?? null,
      startedAt: this.startedAt,
      progress,
    };
  }

  /** The person's choices: look every day or not, and Later for one version. */
  prefs(p: { daily?: boolean; later?: string | null }): UpdateStatus {
    if (typeof p.daily === 'boolean') setCheckForUpdates(p.daily);
    if (p.later !== undefined) this.save({ later: p.later ?? undefined });
    return this.status();
  }

  /** Update now. It waits for a safe moment unless the person says Now. */
  async start(opts: { now?: boolean } = {}): Promise<UpdateStatus> {
    const p = this.progress();
    if (p.state === 'waiting' && opts.now) {
      this.stopWaiting();
      void this.install(p.to!, { waitedFor: p.waitedFor, now: true });
      return this.status();
    }
    if (p.state === 'waiting' || p.state === 'installing' || p.state === 'restarting') return this.status();
    if (!this.saved.latest) await this.check();
    const s = this.status();
    if (!s.latest || !s.newer) throw new Error(s.checkError ?? `You are on the latest version (${s.current}).`);
    if (s.devInstall) throw new Error(`This squad-kit runs from a source folder, so it does not update itself. Run: ${s.command}`);
    if (s.major) throw new Error(`squad-kit ${s.latest} is a big change. Read what is new first, then run: ${s.command}`);
    const to = s.latest;
    this.hold(true);
    const busy = this.busy();
    if (!busy.length || opts.now) {
      void this.install(to, { waitedFor: [], now: Boolean(opts.now && busy.length) });
      return this.status();
    }
    this.set({ state: 'waiting', from: s.current, to, busy, waitedFor: busy });
    this.waitTimer = setInterval(() => {
      const still = this.busy();
      const cur = this.progress();
      if (cur.state !== 'waiting') return this.stopWaiting();
      if (still.length) {
        if (JSON.stringify(still) !== JSON.stringify(cur.busy)) this.set({ ...cur, busy: still });
        return;
      }
      this.stopWaiting();
      void this.install(to, { waitedFor: cur.waitedFor });
    }, WAIT_POLL_MS);
    this.waitTimer.unref();
    return this.status();
  }

  private stopWaiting(): void {
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
  }

  private async install(to: string, how: { waitedFor?: WorkItem[]; now?: boolean }): Promise<void> {
    const installed = this.installed();
    const plan = upgradePlan(installed, to);
    this.set({ state: 'installing', from: installed.version, to, ...how });
    let result: InstallResult;
    try {
      result = await (this.deps.install ?? ((cmd, args) => runInstall(cmd, args, { timeoutMs: INSTALL_TIMEOUT_MS })))(plan.cmd, plan.args);
    } catch (err) {
      result = { ok: false, code: null, output: '', timedOut: false, startError: (err as Error).message };
    }
    if (!result.ok) {
      this.hold(false);
      const why = whyInstallFailed(result, plan.cmd);
      this.set({ state: 'failed', from: installed.version, to, ...how, ...why, output: result.output.trim().slice(-4000) });
      return;
    }
    this.restartInto(to, how);
  }

  private restartInto(to: string, how: { waitedFor?: WorkItem[]; now?: boolean } = {}): void {
    this.set({ state: 'restarting', from: this.pkg.version, to, ...how, carried: this.carrying() });
    (this.deps.restart ?? (() => undefined))();
  }

  /** Restart after the person ran the command by hand. The fresh app says whether it runs the new version. */
  restartNow(): UpdateStatus {
    const p = this.progress();
    if (p.state === 'restarting') return this.status();
    if (p.state !== 'failed' || !p.to) throw new Error('There is no update to restart for. Check for updates first.');
    this.restartInto(p.to, { waitedFor: p.waitedFor });
    return this.status();
  }

  /** Not now while it waits; Close on the note after it. An install goes on to its end. */
  close(): UpdateStatus {
    const p = this.progress();
    if (p.state === 'installing') throw new Error('The update is installing. It takes about a minute.');
    if (p.state === 'waiting') {
      this.stopWaiting();
      this.hold(false);
    }
    if (p.state !== 'idle') this.set({ state: 'idle' });
    return this.status();
  }

  private busy(): WorkItem[] {
    return this.deps.busy?.() ?? [];
  }

  private carrying(): WorkItem[] {
    return this.deps.carrying?.() ?? [];
  }

  private hold(on: boolean): void {
    (this.deps.hold ?? holdNewRuns)(on);
  }
}

function read(): Saved {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as Saved) : {};
  } catch {
    return {};
  }
}

/** The Architect's reads and the chat answers beside the tickets, by the key the squad runs them under. */
function besideLabel(key: string): string {
  if (key.startsWith('__chat:')) return `Answering in the chat on ${key.slice(7)}`;
  if (key.startsWith('__change:')) return `Writing the change for ${key.slice(9)}`;
  if (key.startsWith('__impact:')) return `The Architect checks what ${key.slice(9)} changes`;
  if (key.startsWith('__tech:')) return `The Architect writes the ${key.slice(7)} decision`;
  if (key === '__blueprint') return 'The Architect reads the code for the architecture page';
  return 'The Architect reads the project';
}

function label(p: OpenProject): string {
  try {
    return (boardExists(p.bp) && readMeta(p.bp).project) || projectName(p.root);
  } catch {
    return projectName(p.root);
  }
}

/** Agent runs in the middle of a step in every open project, from the squads' own list. */
export function runsNow(projects: OpenProjects): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of agentRuns()) {
    const p = projects.all().find((x) => x.root === r.root);
    const name = p ? label(p) : projectName(r.root);
    for (const key of r.keys) {
      if (key.startsWith('__')) {
        // A chat answer or a change being written belongs to its ticket; the Architect's reads to the project.
        const ticket = /^__(?:chat|change):(.+)$/.exec(key)?.[1];
        items.push({ project: name, ...(ticket ? { ticket } : {}), title: besideLabel(key) });
        continue;
      }
      let title = key;
      try {
        title = (p && readTicket(p.bp, key)?.title) || key;
      } catch {
        // A half-written ticket file; its id says enough.
      }
      items.push({ project: name, ticket: key, title });
    }
  }
  return items;
}

/** The tickets the live squads are working through in every open project: each picks up where it was after a restart. */
export function ticketsInProgress(projects: OpenProjects): WorkItem[] {
  const items: WorkItem[] = [];
  for (const p of projects.all()) {
    try {
      if (!boardExists(p.bp) || readMeta(p.bp).engine !== 'live') continue;
      const name = label(p);
      for (const t of listTickets(p.bp)) if (t.squad && t.stage !== 'done') items.push({ project: name, ticket: t.id, title: t.title });
    } catch {
      // A half-written file; it is not worth stopping the update for.
    }
  }
  return items;
}

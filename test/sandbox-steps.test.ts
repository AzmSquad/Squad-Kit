import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import type { SandboxSupport } from '../src/modules/ai-tool/types.js';

/**
 * The Builder and the Tester run their commands in the sandbox, read-only steps do not need one, a computer without
 * it runs the steps as before, what it refused shows on the ticket, and a step that reaches its cap pauses with the
 * work kept and two ways out: Give it more, or Stop.
 */

const h = vi.hoisted(() => ({
  support: { available: true, why: "Claude Code's sandbox (macOS Seatbelt)" } as SandboxSupport,
  calls: [] as RunOptions[],
  /** What the fake Claude Code does with a run before it answers; it may change the answer. */
  run: null as ((opts: RunOptions) => Partial<RunResult> | void) | null,
}));

vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    h.calls.push(opts);
    const extra = h.run?.(opts) ?? {};
    return { ok: true, structured: { summary: 'Built it', shots: [], offScreen: [{ criterion: 1, why: 'It is about the saved data.' }] }, sessionId: opts.resume ?? opts.sessionId ?? 's-1', text: '', ...extra };
  },
}));

vi.mock('../src/modules/claude/sandbox.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/sandbox.js')>()),
  claudeSandboxSupport: () => h.support,
}));

const { boardPaths, readMeta, readTicket, writeMeta, writeTicket } = await import('../src/board/store.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { addWorktree } = await import('./support/copy.js');
const actions = await import('../src/board/actions.js');
const { problemOf } = await import('../src/board/problem.js');
const { squadHome } = await import('../src/core/home.js');
const { buildPaths } = await import('../src/core/paths.js');
const { mountApi } = await import('../src/console/api/index.js');
const { AgentWindow, ALL_TOOLS } = await import('../src/engine/window.js');
const { addLocalFile, addLockedFile, storyFile } = await import('../src/board/project-files.js');
const { deniedTools } = await import('../src/modules/claude/direct.js');
const { blockedSites, projectNetwork } = await import('../src/engine/sandbox.js');
const { networkRule } = await import('../src/engine/prompts.js');
const { KNOWN_BAD, RECOMMENDED } = await import('../src/engine/network-lists.js');
const { ticketGuard, projectGuardFor } = await import('../src/engine/project-guard.js');

let tmp: string;
let project: string;
let wt: string;
let bp: ReturnType<typeof boardPaths>;
type Squad = {
  workspace(id: string): Promise<unknown>;
  runBuilder(id: string, prompt: string, resume: boolean, step?: string): Promise<void>;
  shoot(id: string, t: unknown, when: 'before' | 'after', meta: unknown, win: unknown, appUrl: string): Promise<void>;
  review(id: string): Promise<void>;
  launch(key: string, job: () => Promise<void>): void;
  running: Set<string>;
};

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const activity = () => readTicket(bp, 'AP-1')!.activity.map((a) => a.text);
const squad = () => new LiveSquad(bp) as unknown as Squad;
const setMeta = (more: Record<string, unknown>) => writeMeta(bp, { ...readMeta(bp), ...more });

/** Runs a step the way the squad does (so a stop becomes its card), and waits for it to end. */
async function step(s: Squad, job: () => Promise<void>): Promise<void> {
  s.launch('AP-1', job);
  await vi.waitFor(() => expect(s.running.has('AP-1')).toBe(false), { timeout: 10_000 });
}

beforeEach(() => {
  h.calls.length = 0;
  h.run = null;
  h.support = { available: true, why: "Claude Code's sandbox (macOS Seatbelt)" };
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-box-')));
  project = path.join(tmp, 'app');
  fs.mkdirSync(project);
  sh('git init -q -b main', project);
  fs.writeFileSync(path.join(project, 'limit.txt'), 'limit = 2\n');
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm start', project);
  bp = boardPaths(path.join(project, '.squad'));
  writeMeta(bp, {
    project: 'App',
    key: 'AP',
    nextNumber: 2,
    engine: 'live',
    runner: 'direct',
    user: { name: 'Momen', role: 'Project manager' },
    roles: { analyst: 'Claude', architect: 'Claude', builder: 'Claude', tester: 'Claude', reviewer: 'Claude' },
    tools: [],
    speed: 1,
    map: [],
    lessons: [],
    commands: {},
    git: { base: 'main', remote: 'origin' },
    scan: { status: 'done', empty: false },
  });
  const copy = addWorktree(project, 'AP-1', 'main');
  wt = copy.dir;
  // The Builder's work so far, not committed yet.
  fs.writeFileSync(path.join(wt, 'limit.txt'), 'limit = 3\n');
  writeTicket(bp, {
    id: 'AP-1',
    title: 'Raise the limit',
    ask: 'Let people book 3 a day',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'implement',
    status: '',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'Momen',
    activity: [],
    worktree: wt,
    branch: copy.branch,
    baseCommit: copy.baseCommit,
    squad: { phase: 'build', nextAt: new Date().toISOString() },
    sessions: { build: 'b-1', tester: 't-1', review: 'r-1' },
    criteria: [{ given: 'a person with 2 bookings', when: 'they book again', then: 'it works' }],
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('files agents may not touch', () => {
  const REAL = 'REAL-VALUE-9931';
  const TEST = 'TEST-VALUE-6127';
  const ignore = () => {
    fs.writeFileSync(path.join(project, '.gitignore'), '.env.dev\n.squad/\n');
    fs.writeFileSync(path.join(project, 'docker-compose.yml'), 'services: {}\n');
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -qm files', project);
    sh('git pull -q --no-rebase --no-edit . main', wt);
    fs.writeFileSync(path.join(project, '.env.dev'), `KEY=${REAL}\n`);
    addLocalFile(bp, '.', '.env.dev');
    addLockedFile(bp, '.', 'docker-compose.yml');
    const f = storyFile(bp, { repo: '.', path: '.env.dev' });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `KEY=${TEST}\n`);
  };

  /** A Builder step as the squad runs it: the copy made ready first. */
  const build = async () => {
    const s = squad();
    await s.workspace('AP-1');
    await s.runBuilder('AP-1', 'Build it', false, 'build');
  };

  it("are refused by exact path: the Builder's file tools and its commands", async () => {
    ignore();
    await build();
    const call = h.calls[0]!;
    const inCopy = path.join(wt, '.env.dev');
    expect(call.secretFiles).toEqual(expect.arrayContaining([inCopy, path.join(project, '.env.dev')]));
    expect(deniedTools(call)).toEqual(expect.arrayContaining([`Read(/${inCopy})`, `Edit(/${inCopy})`, `Read(/${path.join(project, '.env.dev')})`]));
    expect(call.sandbox!.filesystem.denyRead).toEqual(expect.arrayContaining([inCopy, path.join(project, '.env.dev')]));
    // The copy is otherwise as readable as ever.
    expect(call.sandbox!.filesystem.allowRead).toContain(wt);
    // Nothing in the prompt carries a value.
    expect(call.prompt).not.toContain(TEST);
    expect(call.prompt).not.toContain(REAL);
  });

  it("the story's values are in the copy for the project's own commands, never the person's", async () => {
    ignore();
    await build();
    expect(fs.readFileSync(path.join(wt, '.env.dev'), 'utf8')).toContain(TEST);
  });

  it('what the Builder changed goes back, with a plain line, and its other work stays', async () => {
    ignore();
    h.run = () => {
      fs.writeFileSync(path.join(wt, '.env.dev'), 'KEY=CHANGED\n');
      fs.writeFileSync(path.join(wt, 'docker-compose.yml'), 'services: { evil: { volumes: ["/:/host"] } }\n');
      fs.writeFileSync(path.join(wt, 'limit.txt'), 'limit = 4\n');
    };
    await build();
    expect(fs.readFileSync(path.join(wt, '.env.dev'), 'utf8')).toContain(TEST);
    expect(fs.readFileSync(path.join(wt, 'docker-compose.yml'), 'utf8')).toBe('services: {}\n');
    expect(fs.readFileSync(path.join(wt, 'limit.txt'), 'utf8')).toBe('limit = 4\n');
    expect(activity().some((a) => a.includes('which only an engineer changes') && a.includes('docker-compose.yml'))).toBe(true);
  });

  it('a deleted locked file comes back', async () => {
    ignore();
    h.run = () => fs.rmSync(path.join(wt, 'docker-compose.yml'));
    await build();
    expect(fs.readFileSync(path.join(wt, 'docker-compose.yml'), 'utf8')).toBe('services: {}\n');
  });

  it('a local file with no values is said once, and the story goes on', async () => {
    ignore();
    fs.rmSync(storyFile(bp, { repo: '.', path: '.env.dev' }));
    await build();
    await build();
    expect(activity().filter((a) => a.includes('has not given stories their values for .env.dev'))).toHaveLength(1);
    expect(fs.existsSync(path.join(wt, '.env.dev'))).toBe(false);
  });

  it('a project with none of these runs as before', async () => {
    await build();
    expect(h.calls[0]!.secretFiles).toEqual([bp.secretsFile, path.join(bp.squadDir, 'secrets.yaml')]);
  });
});

describe('the sandbox', () => {
  it("keeps the Builder's commands to its copy, the proof folder and temp folders, the registries and the project's hosts", async () => {
    setMeta({ allowedHosts: ['nexus.example.com'] });
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    const box = h.calls[0]!.sandbox!;
    expect(box).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: false, network: { strictAllowlist: true } });
    expect(box.filesystem.allowWrite).toEqual(expect.arrayContaining([bp.proofDir, os.tmpdir()]));
    expect(box.filesystem.denyRead).toEqual(
      expect.arrayContaining([path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws'), fs.realpathSync(squadHome()), bp.secretsFile, `${project}/**/.env`]),
    );
    // Its own copy sits inside squad-kit's folder: that one stays readable.
    expect(box.filesystem.allowRead).toContain(wt);
    expect(box.network.allowedDomains).toEqual(expect.arrayContaining(['registry.npmjs.org', 'pypi.org', 'github.com', 'nexus.example.com']));
    expect(box).not.toHaveProperty('excludedCommands');
    // The Builder's work goes on as before.
    expect(fs.readFileSync(path.join(wt, 'limit.txt'), 'utf8')).toBe('limit = 3\n');
  });

  it("keeps the Tester's commands in it too, with no browser let out: squad-kit's own tools take the pictures", async () => {
    const win = new AgentWindow({ ticket: 'AP-1', step: 'proof', who: 'Tester', tools: ALL_TOOLS, proofDir: bp.proofDir, prefix: 'ap-1-after', say: () => undefined });
    await squad().shoot('AP-1', readTicket(bp, 'AP-1')!, 'after', readMeta(bp), win, 'http://127.0.0.1:4999');
    await win.close();
    const call = h.calls[0]!;
    const box = call.sandbox!;
    expect(box).not.toHaveProperty('excludedCommands');
    expect(box.filesystem.allowRead).toContain(bp.proofDir);
    // It only reads; the pictures, the pages and the app go through the window, its tools allowed outright.
    expect(call.allowedTools).not.toContain('Bash');
    expect(call.allowedTools).toEqual(expect.arrayContaining(['mcp__squad__take_screenshots', 'mcp__squad__look_at_page', 'mcp__squad__i_am_stuck']));
    expect(call.window).toMatchObject({ name: 'squad', key: win.key, tools: ALL_TOOLS });
    expect(call.appendSystemPrompt).toContain('call i_am_stuck');
    expect(call.prompt).not.toMatch(/playwright|npx/i);
  });

  it('is not used by steps that only read: they have no free shell to keep in', async () => {
    await squad().review('AP-1').catch(() => undefined);
    expect(h.calls[0]!.sandbox).toBeUndefined();
  });

  it('on a computer without it, the step runs as before', async () => {
    h.support = { available: false, why: 'socat is not installed', fix: 'Install it, for example: sudo apt install socat' };
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.sandbox).toBeUndefined();
    expect(h.calls[0]!.maxTurns).toBe(300);
    expect(activity()).not.toContain(expect.stringContaining('blocked'));
  });

  it('says on the ticket in plain words what it refused, each thing once', async () => {
    h.run = (opts) => {
      for (let i = 0; i < 3; i += 1) opts.onBlocked?.({ kind: 'host', target: 'example.com' });
      opts.onBlocked?.({ kind: 'read', target: path.join(os.homedir(), '.ssh', 'id_rsa') });
    };
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    const lines = activity().filter((a) => /was blocked|was not allowed/.test(a));
    expect(lines).toEqual(['Reading ~/.ssh/id_rsa was blocked: keys and sign-ins stay private.', 'A download from example.com was not allowed for this project; the work goes on without it.']);
  });
});

describe('the network level', () => {
  it("is kept with the project's shared settings, beside the allowed websites, and Standard when not set", () => {
    expect(projectNetwork(project)).toBe('standard');
    setMeta({ network: 'strict', allowedHosts: ['nexus.example.com'] });
    expect(readMeta(bp).network).toBe('strict');
    // In .squad/config.yaml, which git carries to the team, not in this computer's own file.
    expect(fs.readFileSync(bp.configFile, 'utf8')).toMatch(/board:[\s\S]*allowedHosts:[\s\S]*network: strict/);
    expect(fs.existsSync(bp.localMetaFile) ? fs.readFileSync(bp.localMetaFile, 'utf8') : '').not.toContain('network');
    expect(projectNetwork(project)).toBe('strict');
    // A level written by hand that is none of the three, or a folder with no settings: Standard.
    fs.writeFileSync(bp.configFile, fs.readFileSync(bp.configFile, 'utf8').replace('network: strict', 'network: loose'));
    expect(projectNetwork(project)).toBe('standard');
    expect(projectNetwork(path.join(tmp, 'nowhere'))).toBe('standard');
  });

  it("gives the Builder's commands any site but the known-bad ones on Standard", async () => {
    setMeta({ allowedHosts: ['nexus.example.com'] });
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    const net = h.calls[0]!.sandbox!.network;
    expect(net.allowedDomains[0]).toBe('*');
    expect(net.allowedDomains).toEqual(expect.arrayContaining([...RECOMMENDED, 'nexus.example.com']));
    expect(net.deniedDomains).toEqual(KNOWN_BAD);
    expect(net.strictAllowlist).toBe(true);
    // The Builder is told up front what its commands reach, and the way around a refused site.
    expect(h.calls[0]!.appendSystemPrompt).toContain(networkRule('standard'));
  });

  it('tells a step with no sandbox here nothing about sites it could not be refused', async () => {
    h.support = { available: false, why: 'socat is not installed', fix: 'Install it, for example: sudo apt install socat' };
    setMeta({ network: 'off' });
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    expect(h.calls[0]!.sandbox).toBeUndefined();
    expect(h.calls[0]!.appendSystemPrompt).not.toContain('Your shell commands reach');
  });

  it('gives them the recommended sites and the project\'s own on Strict, the known-bad ones still closed', async () => {
    setMeta({ network: 'strict', allowedHosts: ['nexus.example.com'] });
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    const net = h.calls[0]!.sandbox!.network;
    expect(net.allowedDomains).toEqual([...RECOMMENDED, 'nexus.example.com']);
    expect(net.allowedDomains).not.toContain('*');
    expect(net.deniedDomains).toEqual(KNOWN_BAD);
    expect(net.strictAllowlist).toBe(true);
  });

  it("gives them nothing outside this computer on Off, and closes the project's own commands too on a Mac", async () => {
    setMeta({ network: 'off', allowedHosts: ['nexus.example.com'] });
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    const net = h.calls[0]!.sandbox!.network;
    expect(net.allowedDomains).toEqual([]);
    expect(net.strictAllowlist).toBe(true);
    if (process.platform === 'darwin') expect(net.allowLocalBinding).toBe(true);
    expect(h.calls[0]!.appendSystemPrompt).toContain(networkRule('off'));
    // The same policy for the guard around the project's own commands: Seatbelt says "only this computer"; Linux stays open.
    expect(ticketGuard(bp, { cwd: wt, id: 'AP-1', platform: 'darwin' }).offline).toBe(true);
    expect(projectGuardFor(bp, { cwd: project, platform: 'darwin' }).offline).toBe(true);
    expect(ticketGuard(bp, { cwd: wt, id: 'AP-1', platform: 'linux' })).not.toHaveProperty('offline');
    for (const level of ['standard', 'strict']) {
      setMeta({ network: level });
      expect(ticketGuard(bp, { cwd: wt, id: 'AP-1', platform: 'darwin' })).not.toHaveProperty('offline');
    }
  });

  it('a refused site asks the person nothing, stops nothing, and goes in the log for engineers', async () => {
    setMeta({ network: 'strict' });
    h.run = (opts) => {
      opts.onBlocked?.({ kind: 'host', target: 'binaries.example.dev' });
      opts.onBlocked?.({ kind: 'host', target: 'binaries.example.dev' });
    };
    const s = squad();
    await step(s, () => s.runBuilder('AP-1', 'Build it', false, 'build'));
    const t = readTicket(bp, 'AP-1')!;
    const line = t.activity.map((a) => a.text).filter((a) => a.includes('binaries.example.dev'));
    expect(line).toEqual(['A download from binaries.example.dev was not allowed for this project; the work goes on without it.']);
    // No question, no setting to change, no word a project manager would have to look up.
    expect(line[0]).not.toMatch(/\?|allow it|Harness|Safety|Settings|sandbox|proxy|allowlist|egress|registr/i);
    // The story was not stopped and waits for nobody.
    expect(t.stuck).toBeUndefined();
    expect(t.waiting).toBeNull();
    expect(blockedSites(bp)).toEqual([{ host: 'binaries.example.dev', story: 'AP-1', level: 'strict', at: expect.any(String) }]);
  });
});

describe('the terminal', () => {
  it('squad config set network shows the levels and the sites refused lately, and sets one for the team', async () => {
    const { chooseProject } = await import('../src/core/paths.js');
    const { runNetwork } = await import('../src/commands/sandbox.js');
    const { noteBlockedSite } = await import('../src/engine/sandbox.js');
    const said: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (said.push(String(s)), true));
    chooseProject(project);
    try {
      noteBlockedSite(bp, { host: 'cdn.example.dev', story: 'AP-1', level: 'standard' });
      await runNetwork(undefined);
      const shown = said.join('');
      expect(shown).toMatch(/● standard/);
      expect(shown).toMatch(/○ strict/);
      expect(shown).toContain('cdn.example.dev');
      await runNetwork('off');
      expect(readMeta(bp).network).toBe('off');
      await expect(runNetwork('loose')).rejects.toThrow('"loose" is not a network level. Use standard, strict or off.');
    } finally {
      chooseProject(null);
      write.mockRestore();
    }
  });
});

describe('the board', () => {
  it('sets the network level for the team, refuses a level that is none of the three, and shows the sites refused lately', async () => {
    const app = new Hono();
    mountApi(app, { paths: buildPaths(project) });
    const put = (b: object) => app.request('/api/v1/settings', { method: 'PUT', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
    expect((await put({ network: 'Strict' })).status).toBe(200);
    expect(readMeta(bp).network).toBe('strict');
    const bad = await put({ network: 'loose' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('"loose" is not a network level. Use standard, strict or off.');
    // A known-bad site stays closed, whoever asks.
    const closed = await put({ allowedHosts: ['nexus.example.com', 'https://abc.ngrok.io/x'] });
    expect(closed.status).toBe(400);
    expect(((await closed.json()) as { error: string }).error).toBe('abc.ngrok.io stays closed for every project: it is one of the tunnels that open this computer to the internet, which a build never needs.');
    const { noteBlockedSite } = await import('../src/engine/sandbox.js');
    noteBlockedSite(bp, { host: 'cdn.example.dev', story: 'AP-1', level: 'strict' });
    const info = (await (await app.request('/api/v1/sandbox')).json()) as { network: { level: string; blocked: { host: string; story: string }[] } };
    expect(info.network.level).toBe('strict');
    expect(info.network.blocked).toEqual([expect.objectContaining({ host: 'cdn.example.dev', story: 'AP-1', level: 'strict' })]);
    const view = (await (await app.request('/api/v1/harness')).json()) as { safety: { sites: string[]; network: { level: string; levels: { id: string }[]; closed: string[] } } };
    expect(view.safety.network.level).toBe('strict');
    expect(view.safety.network.levels.map((l) => l.id)).toEqual(['standard', 'strict', 'off']);
    expect(view.safety.sites).toEqual(expect.arrayContaining(['npm', 'PyPI', 'Prisma', 'Dart and Flutter']));
    expect(view.safety.network.closed).toContain('Paste and file-drop sites');
  });

  it('says whether this computer has the sandbox, and keeps the hosts the project allows', async () => {
    const app = new Hono();
    mountApi(app, { paths: buildPaths(project) });
    const put = (allowedHosts: unknown) =>
      app.request('/api/v1/settings', { method: 'PUT', body: JSON.stringify({ allowedHosts }), headers: { 'content-type': 'application/json' } });
    expect((await put(['https://Nexus.Example.com/repo', '*.corp.example.com'])).status).toBe(200);
    expect(readMeta(bp).allowedHosts).toEqual(['nexus.example.com', '*.corp.example.com']);
    const bad = await put(['*']);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('"*" is not a host name. Write it like nexus.example.com, or *.example.com for all of its subdomains.');
    h.support = { available: false, why: 'socat is not installed', fix: 'Install it, for example: sudo apt install socat' };
    const info = (await (await app.request('/api/v1/sandbox')).json()) as { tools: unknown[]; registries: string[]; allowedHosts: string[] };
    expect(info.tools).toEqual([{ tool: 'Claude Code', available: false, why: 'socat is not installed', fix: 'Install it, for example: sudo apt install socat' }]);
    expect(info.registries).toContain('registry.npmjs.org');
    expect(info.allowedHosts).toEqual(['nexus.example.com', '*.corp.example.com']);
  });
});

describe('caps', () => {
  it('come from the Quality setting for each step', async () => {
    await squad().runBuilder('AP-1', 'Build it', false, 'build');
    setMeta({ quality: 'thrifty' });
    await squad().runBuilder('AP-1', 'Build it', true, 'fix');
    const win = new AgentWindow({ ticket: 'AP-1', step: 'proof', who: 'Tester', tools: ALL_TOOLS, proofDir: bp.proofDir, prefix: 'ap-1-after', say: () => undefined });
    await squad().shoot('AP-1', readTicket(bp, 'AP-1')!, 'after', {}, win, 'http://127.0.0.1:4999');
    await win.close();
    expect(h.calls.map((c) => [c.maxTurns, c.maxBudgetUsd])).toEqual([
      [300, 60],
      [90, 9],
      [48, 3],
    ]);
  });

  it('pause the step with the work kept, not as a failed try, and Give it more carries on with twice the room', async () => {
    h.run = () => ({ ok: false, capped: { by: 'turns' }, error: 'It used the 300 turns this step may take.', structured: undefined });
    const s = squad();
    await step(s, () => s.runBuilder('AP-1', 'Build it', false, 'build'));
    let t = readTicket(bp, 'AP-1')!;
    expect(t.waiting).toEqual({ kind: 'stuck', summary: 'The Builder reached its limit for this step' });
    expect(t.stuck).toMatchObject({ gate: 'cap', question: 'The Builder used the 300 turns one step may take on Best, so squad-kit paused it. Its work so far is kept.' });
    expect(t.stuck!.options.map((o) => [o.do, o.name])).toEqual([
      ['more', 'Give it more'],
      ['stop', 'Stop'],
    ]);
    expect(problemOf(t)).toMatchObject({ title: 'The Builder reached its limit for this step', safe: ["The changes are kept in the ticket's own copy of the code.", 'Nothing was merged or pushed.'] });
    expect(t.fails ?? 0).toBe(0);
    expect(t.retryPhase).toBe('build');
    expect(fs.readFileSync(path.join(wt, 'limit.txt'), 'utf8')).toBe('limit = 3\n');

    t = actions.decideStuck(bp, 'AP-1', 0);
    expect(t).toMatchObject({ waiting: null, capRaise: { role: 'builder', step: 'build', times: 1 }, squad: { phase: 'build' } });
    h.run = null;
    await squad().runBuilder('AP-1', 'Continue', true, 'build');
    expect([h.calls[1]!.maxTurns, h.calls[1]!.maxBudgetUsd]).toEqual([600, 120]);
    // Done with the step: the next one has its usual caps again.
    expect(readTicket(bp, 'AP-1')!.capRaise).toBeUndefined();
  });

  it('a spend cap says so, and Stop leaves the usual ways out', async () => {
    setMeta({ quality: 'balanced' });
    h.run = () => ({ ok: false, capped: { by: 'spend' }, error: 'It reached the $36 this step may spend.', structured: undefined });
    const s = squad();
    await step(s, () => s.runBuilder('AP-1', 'Build it', false, 'build'));
    expect(readTicket(bp, 'AP-1')!.stuck!.question).toBe('The Builder reached the $36 one step may spend on Balanced, so squad-kit paused it. Its work so far is kept.');
    const t = actions.decideStuck(bp, 'AP-1', 1);
    expect(t.waiting).toEqual({ kind: 'stuck', summary: 'The squad stopped and needs you' });
    expect(t.stuck!.question).toBe('You stopped the squad. Nothing was lost; the work so far is kept.');
    expect(t.stuck!.options.map((o) => o.name)).toEqual(['Carry on', 'Fix it yourself', 'Send it back to the plan']);
    expect(t.retryPhase).toBe('build');
    expect(t.capRaise).toBeUndefined();
    expect(problemOf(t)!.title).toBe('You stopped the squad');
  });

  it('Give it more and Stop belong to a paused step only', () => {
    writeTicket(bp, { ...readTicket(bp, 'AP-1')!, waiting: { kind: 'stuck', summary: 'x' }, stuck: { question: 'It failed', options: [{ do: 'more', name: 'Give it more', note: '' }] } });
    expect(() => actions.decideStuck(bp, 'AP-1', 0)).toThrow('Only a step paused at its limit can be given more or stopped here.');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';
import { runAcp, type AcpLaunch } from '../src/engine/acp-runner.js';
import { installCrashNet } from '../src/core/crash-net.js';
import { fileTroubleWords, isDiskTrouble } from '../src/core/file-trouble.js';

/**
 * squad-kit's own file writes fail: a full disk, or a project folder that moved while an agent ran. Never a crash, and
 * never a step that starts again every second with no word to anyone. The AI tool is a fake.
 */

const realDirect = await vi.importActual<typeof import('../src/modules/claude/direct.js')>('../src/modules/claude/direct.js');
let runCount = 0;
let answer: (opts: RunOptions) => Promise<RunResult> = async (opts) => ({ ok: true, structured: {}, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' });
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: (opts: RunOptions) => {
    runCount += 1;
    return answer(opts);
  },
}));

const { boardPaths, readMeta, readTicket, updateTicket, writeMeta } = await import('../src/board/store.js');
const { createTicket } = await import('../src/board/actions.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { ensureLiveBoard, setupProject } = await import('../src/engine/setup.js');
const { SAVE_CHECK_MS, TURN_TROUBLE, canSave, forgetSaveTrouble, noteSaveTrouble, saveTroubleOf, saveTroubles, stillHeld } = await import('../src/engine/save-trouble.js');
const { startedToOutlive } = await import('../src/console/server.js');

/** A fake ACP adapter that reports one update a little after the prompt, then finishes. */
const ADAPTER = `
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/cancel') return;
  if (msg.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
    setTimeout(() => send({ id: msg.id, result: { stopReason: 'end_turn' } }), 200);
  }
});
`;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-own-'));
  runCount = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const launch = (script: string): AcpLaunch => ({
  command: process.execPath,
  args: [script],
  env: process.env,
  meta: {},
  canResume: () => false,
  explain: (raw) => raw,
  toolName: () => undefined,
});

const noSpace = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: 'ENOSPC', syscall: 'write' });

describe('an agent run whose progress cannot be saved', () => {
  let script: string;

  beforeEach(() => {
    script = path.join(tmp, 'adapter.mjs');
    fs.writeFileSync(script, ADAPTER);
  });

  it('stops with the exact error when the status update throws, instead of ending the app', async () => {
    const r = await runAcp(launch(script), {
      cwd: tmp,
      prompt: 'go',
      onText: () => {
        throw new Error('No ticket AP-1 on this board.');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not save what the agent was doing/);
    expect(r.saveError?.message).toBe('No ticket AP-1 on this board.');
  }, 15_000);

  it('stops when its own log cannot be written: the folder went away while it ran', async () => {
    const logDir = path.join(tmp, 'logs');
    const r = await runAcp(launch(script), { cwd: tmp, prompt: 'go', logDir, onSpawn: () => fs.rmSync(logDir, { recursive: true, force: true }) });
    expect(r.ok).toBe(false);
    expect((r.saveError as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
  }, 15_000);

  it('the direct way stops the same way', async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\\n');\nsetTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 's' }) + '\\n'), 300);\n`,
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv('HOME', tmp);
    const r = await realDirect.runClaude({
      cwd: tmp,
      prompt: 'go',
      timeoutMs: 10_000,
      onText: () => {
        throw noSpace();
      },
    } as RunOptions);
    vi.unstubAllEnvs();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not save what the agent was doing/);
    expect((r.saveError as NodeJS.ErrnoException | undefined)?.code).toBe('ENOSPC');
  }, 15_000);
});

describe('the last net under the app', () => {
  it('logs what nobody caught and keeps the app running', () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const said: string[] = [];
    const off = installCrashNet(proc as never, (t) => said.push(t));
    proc.emit('uncaughtException', new Error('boom'));
    proc.emit('unhandledRejection', new Error('later boom'));
    expect(said[0]).toContain('boom');
    expect(said[1]).toContain('later boom');
    expect(proc.exit).not.toHaveBeenCalled();
    off();
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });

  it('a port it cannot listen on still ends it: nothing could reach it', () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    installCrashNet(proc as never, () => undefined);
    proc.emit('uncaughtException', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE', syscall: 'listen' }));
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it('a terminal nobody reads is no error, and never a line about a line', () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() });
    const said: string[] = [];
    const off = installCrashNet(proc as never, (t) => said.push(t));
    // With no listener these would throw, and become the uncaught error below.
    const gone = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });
    expect(() => proc.stderr.emit('error', gone)).not.toThrow();
    expect(() => proc.stdout.emit('error', gone)).not.toThrow();
    proc.emit('uncaughtException', gone);
    proc.emit('uncaughtException', Object.assign(new Error('write after destroy'), { code: 'ERR_STREAM_DESTROYED' }));
    expect(said).toEqual([]);
    off();
    expect(proc.stderr.listenerCount('error')).toBe(0);
  });

  it('what fails while it says so is not said again', () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    let lines = 0;
    installCrashNet(proc as never, () => {
      lines += 1;
      proc.emit('uncaughtException', new Error('from the log line itself'));
    });
    proc.emit('uncaughtException', new Error('boom'));
    expect(lines).toBe(1);
  });

  it('with the real pipe: `squad | tee` whose reader died does not spin', async () => {
    const script = path.join(tmp, 'pipe.mts');
    fs.writeFileSync(
      script,
      `import { installCrashNet } from ${JSON.stringify(path.resolve('src/core/crash-net.ts'))};
       import { log, printErrors } from ${JSON.stringify(path.resolve('src/core/app-log.ts'))};
       printErrors(true);
       let said = 0;
       installCrashNet(process, (t) => { said += 1; log.error(t); });
       process.stdout.write('ready\\n', () => {});
       setTimeout(() => {
         for (let i = 0; i < 5; i += 1) log.error('a line for a terminal nobody reads');
         setTimeout(() => { fs.writeFileSync(process.argv[2], String(said)); process.exit(0); }, 400);
       }, 400);
       import fs from 'node:fs';`,
    );
    const result = path.join(tmp, 'said');
    const child = spawn(process.execPath, ['--import', 'tsx', script, result], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    await new Promise<void>((done) => child.stdout.once('data', () => done()));
    // The reader goes away, as when tee ends.
    child.stderr.destroy();
    child.stdout.destroy();
    const code = await new Promise<number | null>((done) => child.once('exit', (c) => done(c)));
    expect(code).toBe(0);
    expect(fs.readFileSync(result, 'utf8')).toBe('0');
  }, 60_000);

  it('a log line that cannot be written is no second crash', () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    installCrashNet(proc as never, () => {
      throw noSpace();
    });
    expect(() => proc.emit('uncaughtException', new Error('boom'))).not.toThrow();
  });
});

describe('the words', () => {
  it('say what to do, with no raw error', () => {
    expect(isDiskTrouble(noSpace())).toBe(true);
    expect(fileTroubleWords(noSpace())).toMatch(/^The disk is full/);
    expect(fileTroubleWords(noSpace())).not.toMatch(/ENOSPC/);
    expect(fileTroubleWords({ code: 'EROFS' })).toMatch(/cannot be written/);
    expect(fileTroubleWords({ code: 'ENOENT' })).toMatch(/folder is not where it was/);
    expect(isDiskTrouble({ code: 'ENOENT' })).toBe(false);
  });
});

describe('a full disk under a live squad', () => {
  let project: string;
  let bp: ReturnType<typeof boardPaths>;
  let squad: InstanceType<typeof LiveSquad>;

  beforeEach(() => {
    project = path.join(tmp, 'app');
    fs.mkdirSync(project);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: project });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start'], { cwd: project });
    setupProject(project);
    bp = ensureLiveBoard(boardPaths(path.join(project, '.squad')), 'App').bp;
    writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct', commands: {} });
    squad = new LiveSquad(bp);
  });

  afterEach(() => {
    forgetSaveTrouble(bp);
  });

  const tick = () => (squad as unknown as { tick(): void }).tick();
  const settle = async () => {
    for (let i = 0; i < 40 && (squad as unknown as { running: Set<string> }).running.size; i += 1) await new Promise((r) => setTimeout(r, 50));
  };
  const diskFull = () => {
    const write = fs.writeFileSync;
    return vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).startsWith(project) || String(file).includes(bp.localDir)) throw noSpace();
      return (write as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.writeFileSync);
  };

  it('holds the project with one plain message, starts nothing, and carries on by itself when space is back', async () => {
    const t = createTicket(bp, { title: 'A thing' });
    updateTicket(bp, t.id, (x) => {
      x.squad = { phase: 'analyst-read', nextAt: new Date(Date.now() - 1000).toISOString() };
    });
    const disk = diskFull();
    const logged = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // The step starts, cannot save, and the squad holds: no card could be saved, so the banner says it.
    tick();
    await settle();
    const trouble = saveTroubleOf(bp);
    expect(trouble?.text).toMatch(/^The disk is full/);
    expect(trouble?.detail).toMatch(/ENOSPC/);
    expect(saveTroubles().map((x) => x.root)).toContain(project);

    // No loop: the turns that follow start nothing and find no agent to run.
    const before = runCount;
    const launched = vi.spyOn(squad as unknown as { launch(): void }, 'launch');
    for (let i = 0; i < 5; i += 1) tick();
    await settle();
    expect(launched).not.toHaveBeenCalled();
    expect(runCount).toBe(before);

    // Still full at the next look: still held.
    expect(stillHeld(bp, Date.now() + SAVE_CHECK_MS + 1).held).toBe(true);

    disk.mockRestore();
    logged.mockRestore();
    expect(canSave(bp)).toBe(true);
    // Space is back: at the next look the trouble is over and the same step starts again.
    const later = Date.now() + SAVE_CHECK_MS * 3;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    tick();
    vi.spyOn(Date, 'now').mockRestore();
    expect(saveTroubleOf(bp)).toBeNull();
    await settle();
    expect(runCount).toBeGreaterThan(before);
  }, 20_000);

  it('a step that fails on a missing file while saving works is a normal stop with a way out, not a hold', async () => {
    const t = createTicket(bp, { title: 'A thing' });
    answer = async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, open 'x.txt'"), { code: 'ENOENT', path: 'x.txt' });
    };
    updateTicket(bp, t.id, (x) => {
      x.squad = { phase: 'analyst-read', nextAt: new Date(Date.now() - 1000).toISOString() };
    });
    tick();
    await settle();
    answer = async (opts) => ({ ok: true, structured: {}, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' });
    expect(saveTroubleOf(bp)).toBeNull();
    expect(readTicket(bp, t.id)?.waiting?.kind).toBe('stuck');
  }, 20_000);

  it('a project folder that moved while it ran holds that project and leaves no folder behind at the old place', async () => {
    const t = createTicket(bp, { title: 'A thing' });
    let release: () => void = () => undefined;
    answer = (opts) =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, structured: {}, text: '', sessionId: opts.sessionId ?? 's-1' });
      });
    updateTicket(bp, t.id, (x) => {
      x.squad = { phase: 'analyst-read', nextAt: new Date(Date.now() - 1000).toISOString() };
    });
    tick();
    await new Promise((r) => setTimeout(r, 200));
    const moved = path.join(tmp, 'moved');
    fs.renameSync(project, moved);
    release();
    await settle();
    answer = async (opts) => ({ ok: true, structured: {}, text: '', sessionId: opts.resume ?? opts.sessionId ?? 's-1' });
    expect(saveTroubleOf(bp)?.text).toMatch(/folder is not where it was/);
    expect(fs.existsSync(project)).toBe(false);
    // Put back: it carries on.
    fs.renameSync(moved, project);
    expect(stillHeld(bp, Date.now() + SAVE_CHECK_MS + 1)).toEqual({ held: false, fixed: true });
  }, 20_000);

  it('a turn that throws stays inside its project', () => {
    vi.spyOn(squad as unknown as { tick(): void }, 'tick').mockImplementation(() => {
      throw new Error('a bug in one turn');
    });
    expect(() => (squad as unknown as { safeTick(): void }).safeTick()).not.toThrow();
  });

  it('turns that keep throwing get the banner, and the first one that gets through ends it', () => {
    const live = squad as unknown as { tick(): void; safeTick(): void };
    const tick = vi.spyOn(live, 'tick').mockImplementation(() => {
      throw new Error('a bug in every turn');
    });
    live.safeTick();
    live.safeTick();
    // One or two can be bad luck.
    expect(saveTroubles().filter((t) => t.root === bp.root)).toEqual([]);
    live.safeTick();
    const shown = saveTroubles().filter((t) => t.root === bp.root);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.text).toBe(TURN_TROUBLE);
    expect(shown[0]!.text).not.toMatch(/bug|throw|stack/);
    expect(shown[0]!.detail).toContain('a bug in every turn');
    tick.mockImplementation(() => undefined);
    live.safeTick();
    expect(saveTroubles().filter((t) => t.root === bp.root)).toEqual([]);
  });

  it('a squad held on saving never holds a free place back from the others', () => {
    type Live = { mayStart(limit: number): boolean; tick(): void; running: Set<string> };
    const held = squad as unknown as Live;
    const other = new LiveSquad(bp) as unknown as Live;
    // It waits for a place, then saving stops working for it.
    expect(held.mayStart(0)).toBe(false);
    noteSaveTrouble(bp, noSpace());
    held.tick();
    other.running.add('AP-9');
    expect(other.mayStart(5)).toBe(true);
    other.running.delete('AP-9');
    forgetSaveTrouble(bp);
  });
});

describe('started to outlive its terminal', () => {
  it('reads the sign from where its output goes: files yes, a terminal or a pipe no', () => {
    const on = (kinds: Record<number, 'tty' | 'file' | 'null' | 'pipe' | 'socket'>) => ({
      isatty: (fd: number) => kinds[fd] === 'tty',
      fstat: (fd: number) => ({ isFIFO: () => kinds[fd] === 'pipe', isSocket: () => kinds[fd] === 'socket' }),
    });
    expect(startedToOutlive([1, 2], on({ 1: 'file', 2: 'file' }))).toBe(true);
    expect(startedToOutlive([1, 2], on({ 1: 'null', 2: 'null' }))).toBe(true);
    expect(startedToOutlive([1, 2], on({ 1: 'tty', 2: 'tty' }))).toBe(false);
    expect(startedToOutlive([1, 2], on({ 1: 'file', 2: 'tty' }))).toBe(false);
    expect(startedToOutlive([1, 2], on({ 1: 'pipe', 2: 'pipe' }))).toBe(false);
    expect(startedToOutlive([1, 2], on({ 1: 'socket', 2: 'file' }))).toBe(false);
  });

  it('goes on when the terminal closes, and its own stop still works', async () => {
    const { startConsoleServer } = await import('../src/console/server.js');
    const before = process.listenerCount('SIGHUP');
    const server = await startConsoleServer({ requestedPort: 0, token: 'a'.repeat(64), app: true, keepOnHangup: true } as never);
    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    process.emit('SIGHUP');
    let ended = false;
    void server.done.then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(ended).toBe(false);
    await server.close();
    expect(process.listenerCount('SIGHUP')).toBe(before);
  }, 20_000);
});

describe('closing the terminal', () => {
  it('stops the app the clean way, so no agent goes on working and spending', async () => {
    const { startConsoleServer } = await import('../src/console/server.js');
    const before = process.listenerCount('SIGHUP');
    const server = await startConsoleServer({ requestedPort: 0, token: 'a'.repeat(64), app: true } as never);
    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    process.emit('SIGHUP');
    await server.done;
    expect(process.listenerCount('SIGHUP')).toBe(before);
  }, 20_000);
});

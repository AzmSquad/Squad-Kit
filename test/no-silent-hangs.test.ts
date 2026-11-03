import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks, runCommand, startApp } from '../src/engine/checks.js';
import { AcpStartError, runAcp, type AcpLaunch } from '../src/engine/acp-runner.js';
import { netGit, networkGitEnv } from '../src/engine/git.js';
import { Azure } from '../src/modules/azure/client.js';

/**
 * Nothing squad-kit waits on may wait forever (E1): each of these ends inside its limit with a plain message.
 */

let dir: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hangs-')));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('commands squad-kit runs', () => {
  it('end when the command exits, even when something it started holds the output open, and that is ended too', async () => {
    const started = Date.now();
    const r = await runCommand(dir, 'sleep 30 & echo $!', 20_000);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.ok).toBe(true);
    expect(await gone(Number(r.output.trim()))).toBe(true);
  });

  it('a timeout ends the whole process group, not only the shell', async () => {
    const pidFile = path.join(dir, 'bg.pid');
    const started = Date.now();
    const r = await runCommand(dir, `sleep 30 & echo $! > ${pidFile}; sleep 30`, 400);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toMatchObject({ ok: false, output: expect.stringContaining('(stopped after') });
    expect(await gone(Number(fs.readFileSync(pidFile, 'utf8').trim()))).toBe(true);
  });

  it('kills a group that ignores TERM after 5 seconds', async () => {
    const started = Date.now();
    const r = await runCommand(dir, "trap '' TERM; sleep 30; sleep 30", 300);
    const took = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(took).toBeGreaterThanOrEqual(5000);
    expect(took).toBeLessThan(9000);
  }, 15_000);

  it('Stop ends a running command at once, and a stopped one never starts', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const started = Date.now();
    const r = await runCommand(dir, 'sleep 30', 20_000, { signal: stop.signal });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r).toMatchObject({ ok: false, output: expect.stringContaining('You stopped the squad.') });

    let spawned = false;
    const again = await runCommand(dir, 'echo hi', 20_000, { signal: stop.signal, onSpawn: () => (spawned = true) });
    expect(again.ok).toBe(false);
    expect(spawned).toBe(false);
  });

  it('Stop during the checks ends the one running and skips the rest', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const started: string[] = [];
    const results = await runChecks(dir, { test: 'sleep 30', lint: 'echo lint', build: 'echo build' }, (name) => started.push(name), { signal: stop.signal });
    expect(started).toEqual(['test']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'test', ok: false });
  });

  it('stops a command that prints nothing for too long, in plain words', async () => {
    const r = await runCommand(dir, 'echo watching; sleep 30', 20_000, { silentMs: 400 });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('watching');
    expect(r.output).toContain('it may be waiting in watch mode or for input');
  });

  it("run without squad-kit's own keys, like every agent", async () => {
    const before = process.env.AZURE_DEVOPS_PAT;
    process.env.AZURE_DEVOPS_PAT = 'tracker-secret';
    try {
      const r = await runCommand(dir, 'echo "pat=${AZURE_DEVOPS_PAT:-none} ci=$CI"', 20_000);
      expect(r.output).toBe('pat=none ci=1');
    } finally {
      if (before === undefined) delete process.env.AZURE_DEVOPS_PAT;
      else process.env.AZURE_DEVOPS_PAT = before;
    }
  });

  it('Stop ends the wait for the app, and the app with it', async () => {
    const pidFile = path.join(dir, 'app.pid');
    fs.writeFileSync(path.join(dir, 'slow.js'), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 500);
    const started = Date.now();
    await expect(startApp(dir, 'node slow.js', 'http://127.0.0.1:47391', 60_000, stop.signal)).rejects.toThrow('You stopped the squad.');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await gone(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  }, 15_000);
});

describe.skipIf(process.platform === 'win32')('starting an agent over ACP', () => {
  const launch = (code: string): AcpLaunch => ({
    label: 'Fake tool',
    command: process.execPath,
    args: ['-e', code],
    env: process.env,
    meta: {},
    canResume: () => false,
    explain: (raw) => raw,
    toolName: () => undefined,
  });
  const answersStart = `
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } }) + '\\n');
    });`;

  it('gives up on an adapter that never answers initialize, says so plainly, and ends it', async () => {
    let pid = 0;
    const started = Date.now();
    const err = await runAcp(launch('setInterval(() => {}, 1000)'), { cwd: dir, prompt: 'go', startLimits: { initializeMs: 1500 }, onSpawn: (p) => (pid = p) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AcpStartError);
    expect((err as Error).message).toContain('Fake tool did not start in 2 seconds');
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await gone(pid)).toBe(true);
  }, 15_000);

  it('gives up on a session that never opens', async () => {
    const r = await runAcp(launch(answersStart), { cwd: dir, prompt: 'go', startLimits: { sessionMs: 1500 } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Fake tool did not open a session in 2 seconds');
  }, 15_000);

  it('starts nothing once stopped, and a Stop during the start is a stop, not a failed start', async () => {
    const stopped = new AbortController();
    stopped.abort();
    let spawned = false;
    const r = await runAcp(launch(answersStart), { cwd: dir, prompt: 'go', signal: stopped.signal, onSpawn: () => (spawned = true) });
    expect(r).toMatchObject({ ok: false, error: 'You stopped the squad.' });
    expect(spawned).toBe(false);

    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const during = await runAcp(launch('setInterval(() => {}, 1000)'), { cwd: dir, prompt: 'go', signal: stop.signal });
    expect(during).toMatchObject({ ok: false, error: 'You stopped the squad.' });
  }, 15_000);

  it('an adapter whose input is closed when squad-kit writes to it cannot crash the app', async () => {
    // The adapter closes its input, then asks a question: squad-kit's answer breaks the pipe (EPIPE).
    const script = path.join(dir, 'no-input.js');
    fs.writeFileSync(
      script,
      `setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { options: [] } }) + '\\n'), 300);
       setInterval(() => {}, 1000);`,
    );
    const noInput: AcpLaunch = { ...launch(''), command: '/bin/sh', args: ['-c', `exec 0<&-; exec "${process.execPath}" "${script}"`] };
    const err = await runAcp(noInput, { cwd: dir, prompt: 'go', startLimits: { initializeMs: 1500 } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AcpStartError);
    expect((err as Error).message).toContain('Fake tool did not start in 2 seconds');
  }, 15_000);
});

describe('git over the network', () => {
  it('never asks for a password, and ssh gives up instead of asking or waiting', () => {
    const repo = path.join(dir, 'env-repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const before = process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_COMMAND;
    try {
      expect(networkGitEnv(repo)).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' });
      // Your own ssh command keeps its options, from the environment or from git's settings.
      expect(networkGitEnv(repo, { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work -o ConnectTimeout=5' }).GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/work -o ConnectTimeout=5 -o BatchMode=yes');
      execFileSync('git', ['config', 'core.sshCommand', 'ssh -i ~/.ssh/other'], { cwd: repo });
      expect(networkGitEnv(repo).GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/other -o BatchMode=yes -o ConnectTimeout=15');
      // A module's sign-in variables stay.
      expect(networkGitEnv(repo, { GIT_CONFIG_COUNT: '1' })).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_TERMINAL_PROMPT: '0' });
    } finally {
      if (before !== undefined) process.env.GIT_SSH_COMMAND = before;
    }
  });

  it('a remote that asks for a password fails at once with git’s reason', async () => {
    // The remote runs in its own process: git over the network blocks this one while it waits.
    const remote = spawn(process.execPath, ['-e', `require('http').createServer((q, r) => { r.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }); r.end(); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`]);
    try {
      const port = await new Promise<number>((resolve) => remote.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim()))));
      const repo = path.join(dir, 'auth-repo');
      fs.mkdirSync(repo);
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const started = Date.now();
      expect(() => netGit(repo, ['ls-remote', `http://127.0.0.1:${port}/x.git`])).toThrow(/git ls-remote failed: .*(terminal prompts disabled|could not read Username)/i);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      remote.kill();
    }
  }, 20_000);

  it('a remote that never answers gives up within its limit, with a plain message', () => {
    const repo = path.join(dir, 'slow-repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const fakeSsh = path.join(dir, 'fake-ssh');
    const args = path.join(dir, 'ssh-args.txt');
    fs.writeFileSync(fakeSsh, `#!/bin/sh\necho "$@" > ${args}\nexec sleep 30\n`, { mode: 0o755 });
    const started = Date.now();
    expect(() => netGit(repo, ['ls-remote', 'ssh://example.invalid/x.git'], { env: { GIT_SSH_COMMAND: fakeSsh }, timeoutMs: 1500 })).toThrow(
      /git ls-remote gave up after 2 seconds\. Check the network, and that git can reach the remote without asking for a password\./,
    );
    expect(Date.now() - started).toBeLessThan(8000);
    expect(fs.readFileSync(args, 'utf8')).toContain('-o BatchMode=yes -o ConnectTimeout=15');
  });
});

describe('tracker calls', () => {
  it('give up on Azure DevOps when it does not answer', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const az = new Azure({ organization: 'o', project: 'p', pat: 'x' }, hang, 300);
    const started = Date.now();
    await expect(az.whoAmI()).rejects.toThrow('Azure DevOps did not answer within 1 second. Check the network, then try again.');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

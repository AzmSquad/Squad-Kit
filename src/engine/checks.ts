import { spawn } from 'node:child_process';
import net from 'node:net';
import type { ProjectCommands } from '../board/types.js';
import { withIpv4First } from './agent-env.js';

/** squad-kit runs the project's own checks itself, so the AI never grades its own work. */

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  output: string;
  seconds: number;
}

export interface CommandWatch {
  /** Called with the process id once the command starts. */
  onSpawn?(pid: number): void;
  /** Called whenever the command prints something. */
  onOutput?(): void;
}

export function runCommand(cwd: string, command: string, timeoutMs = 15 * 60_000, watch: CommandWatch = {}): Promise<{ ok: boolean; output: string; seconds: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: withIpv4First({ ...process.env, CI: '1', FORCE_COLOR: '0' }) });
    if (child.pid) watch.onSpawn?.(child.pid);
    let out = '';
    const keep = (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-12_000);
      watch.onOutput?.();
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      out += `\n(stopped after ${Math.round(timeoutMs / 60000)} minutes)`;
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message, seconds: (Date.now() - started) / 1000 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim(), seconds: (Date.now() - started) / 1000 });
    });
  });
}

export async function runChecks(cwd: string, commands: ProjectCommands, onStart?: (name: string) => void, watch: CommandWatch = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const name of ['test', 'lint', 'build'] as const) {
    const command = commands[name]?.trim();
    if (!command) continue;
    onStart?.(name);
    const r = await runCommand(cwd, command, undefined, watch);
    results.push({ name, command, ...r });
  }
  return results;
}

export interface RunningApp {
  url: string;
  stop(): void;
}

/**
 * squad-kit starts the app for the Tester and stops it afterwards, so a dev server can never keep a step running
 * forever. Resolves once the app answers at its address.
 */
/** True when something already answers at the address. */
async function answers(url: string): Promise<boolean> {
  for (const u of [url, url.replace('://localhost', '://127.0.0.1')]) {
    if (await fetch(u, { signal: AbortSignal.timeout(3000) }).then((r) => r.status < 500).catch(() => false)) return true;
  }
  return false;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts the ticket's copy of the app and waits until it answers. When something else already answers at the app's
 * address (often the person's own "npm run dev"), the copy starts on a free port instead (PORT), so the Tester never
 * looks at the wrong app. The address the app really runs at comes back in `url`.
 */
export async function startApp(cwd: string, command: string, url: string, waitMs = 3 * 60_000): Promise<RunningApp> {
  const taken = await answers(url);
  const port = taken ? await freePort() : null;
  const target = port ? url.replace(/(:\/\/[^/:]+)(:\d+)?/, `$1:${port}`) : url;
  const env = withIpv4First({ ...process.env, CI: '1', FORCE_COLOR: '0', BROWSER: 'none', ...(port ? { PORT: String(port) } : {}) });
  const child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  let exited: number | null = null;
  const keep = (chunk: Buffer) => {
    out = (out + chunk.toString('utf8')).slice(-6_000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => (exited = code ?? 0));
  const stop = () => {
    try {
      // The whole process group: the shell, npm, and the server it started.
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  const busy = port ? ` ${new URL(url).host} is used by another program (maybe your own "npm run dev"), so squad-kit tried port ${port}.` : '';
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (exited !== null) throw new Error(`The app stopped while starting (${command}):${busy} ${tail(out, 8)}`);
    if (await answers(target)) return { url: target, stop };
    await new Promise((r) => setTimeout(r, 2000));
  }
  stop();
  throw new Error(
    port
      ? `The app did not start on a free port.${busy} Stop the other program, then press Try again. (${command}): ${tail(out, 8)}`
      : `The app did not answer at ${url} within ${Math.round(waitMs / 60_000)} minutes (${command}): ${tail(out, 8)}`,
  );
}

/** "18 passed" style counts from common test runners, for the gate pill. */
export function testCount(output: string): number | null {
  // The "Tests" summary line first (vitest, jest), so a "Test Files 1 passed" line is not mistaken for it.
  const patterns = [/^\s*Tests:?\s+(\d+)\s+passed/im, /(\d+)\s+passing/i, /^# pass (\d+)/m, /Passed:\s+(\d+)/i, /(\d+)\s+passed/i];
  for (const p of patterns) {
    const m = output.match(p);
    if (m) return Number(m[1]);
  }
  return null;
}

export function tail(output: string, lines = 40): string {
  return output.split('\n').slice(-lines).join('\n');
}

import { spawn } from 'node:child_process';
import type { ProjectCommands } from '../board/types.js';
import { withIpv4First } from './claude.js';

/** squad-kit runs the project's own checks itself, so the AI never grades its own work. */

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  output: string;
  seconds: number;
}

export function runCommand(cwd: string, command: string, timeoutMs = 15 * 60_000): Promise<{ ok: boolean; output: string; seconds: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: withIpv4First({ ...process.env, CI: '1', FORCE_COLOR: '0' }) });
    let out = '';
    const keep = (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-12_000);
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

export async function runChecks(cwd: string, commands: ProjectCommands, onStart?: (name: string) => void): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const name of ['test', 'lint', 'build'] as const) {
    const command = commands[name]?.trim();
    if (!command) continue;
    onStart?.(name);
    const r = await runCommand(cwd, command);
    results.push({ name, command, ...r });
  }
  return results;
}

/** "18 passed" style counts from common test runners, for the gate pill. */
export function testCount(output: string): number | null {
  const patterns = [/Tests?:?\s+(\d+)\s+passed/i, /(\d+)\s+passing/i, /(\d+)\s+passed/i, /Passed:\s+(\d+)/i];
  for (const p of patterns) {
    const m = output.match(p);
    if (m) return Number(m[1]);
  }
  return null;
}

export function tail(output: string, lines = 40): string {
  return output.split('\n').slice(-lines).join('\n');
}

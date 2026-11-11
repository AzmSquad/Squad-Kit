import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { System } from './catalog.js';

/**
 * A tool installed while squad-kit runs lands on the person's own PATH, the one their terminal builds from its start
 * files, but not on the PATH squad-kit started with. On Mac and Linux each check reads that PATH from a login shell and
 * adds its new folders, so the checks, and the agents squad-kit starts after, find the new tool without a restart.
 * Windows keeps the PATH squad-kit started with.
 */

const START = '__SQUAD_KIT_PATH_START__';
const END = '__SQUAD_KIT_PATH_END__';

/** What the shell runs: the PATH between two marks, as start files may print anything around it. Works in fish too. */
export const PRINT_PATH = `printf '%s%s%s' '${START}' "$PATH" '${END}'`;

/** The PATH a login shell printed between the two marks, or null when it is not there. */
export function pathBetweenMarks(output: string): string | null {
  const from = output.lastIndexOf(START);
  if (from < 0) return null;
  const to = output.indexOf(END, from + START.length);
  if (to < 0) return null;
  const found = output.slice(from + START.length, to).trim();
  return found || null;
}

/** The PATH with the new folders added after its own: each folder once, in the order first seen. */
export function mergePath(current: string | undefined, more: string | null | undefined, sep = ':'): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...(current ?? '').split(sep), ...(more ?? '').split(sep)]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(sep);
}

/** The person's own shell, or the usual one of the system when it is not set or not there. */
export function loginShell(system: System, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  const own = env.SHELL?.trim();
  if (own && exists(own)) return own;
  return system === 'mac' ? '/bin/zsh' : '/bin/bash';
}

/**
 * The PATH of the person's login shell, as their terminal has it. Never fatal and never waits long: at most `limitMs`,
 * then null, even when a start file leaves something running. Null on Windows and on any problem.
 */
export function readLoginPath(system: System, opts: { env?: NodeJS.ProcessEnv; shell?: string; limitMs?: number } = {}): Promise<string | null> {
  if (system === 'windows') return Promise.resolve(null);
  const env = opts.env ?? process.env;
  const shell = opts.shell ?? loginShell(system, env);
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const end = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-ilc', PRINT_PATH], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    // A start file that waits, or leaves a program holding the output open, never holds the check up.
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child.stdout?.destroy();
      end(null);
    }, opts.limitMs ?? 5_000);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (s: string) => {
      // Only so much is kept: the PATH is short, and a noisy start file is not.
      out = (out + s).slice(-256 * 1024);
      const found = pathBetweenMarks(out);
      if (found) end(found);
    });
    child.on('error', () => {
      clearTimeout(timer);
      end(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      end(pathBetweenMarks(out));
    });
  });
}

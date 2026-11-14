import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { ownAzureFolder } from '../../core/home.js';

/**
 * Microsoft's own Azure tool, az, as squad-kit runs it (ADR-011): always with squad-kit's own settings folder
 * (`AZURE_CONFIG_DIR`), never the person's `~/.azure`, so squad-kit never sees or changes their other Azure sign-ins.
 * Plain, with no colors, no questions and no usage reports. On a Mac az is a small script that starts Python without
 * handing over its own process, so a stop always takes the whole group squad-kit started.
 */

const WINDOWS = process.platform === 'win32';
const AZ = WINDOWS ? 'az.cmd' : 'az';

/** The environment az runs with: squad-kit's own folder, made private on first use. */
export function azEnv(): NodeJS.ProcessEnv {
  const dir = ownAzureFolder();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Only this person may read it, whoever made it first (az itself, on the Tools page's check).
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AZURE_CONFIG_DIR: dir,
    AZURE_CORE_NO_COLOR: 'true',
    AZURE_CORE_COLLECT_TELEMETRY: 'false',
    AZURE_CORE_LOGIN_EXPERIENCE_V2: 'off',
    NO_COLOR: '1',
  };
  // The person's own "errors only" would hide the sign-in code, which az prints as a warning.
  delete env.AZURE_CORE_ONLY_SHOW_ERRORS;
  return env;
}

/** az started: in a group of its own (Mac and Linux), so a stop reaches the Python it starts too. */
export function startAz(args: string[]): ChildProcess {
  // Windows runs az's .cmd through the shell; every word squad-kit passes is a fixed flag, an id or a checked tenant.
  return spawn(AZ, args, { env: azEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !WINDOWS, shell: WINDOWS });
}

/** Stops the az squad-kit started, by its own id: the group it leads, or its tree on Windows. */
export function stopAz(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (WINDOWS) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
    else process.kill(-pid, 'SIGTERM');
  } catch {
    // Gone already.
  }
}

export interface AzRan {
  code: number;
  out: string;
  err: string;
}

/** What az said, 'missing' when it is not on this computer, or 'no-answer' when it did not finish in time. */
export type AzAnswer = AzRan | 'missing' | 'no-answer';

export function runAz(args: string[], timeoutMs = 30_000): Promise<AzAnswer> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = startAz(args);
    } catch {
      resolve('missing');
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const end = (a: AzAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(a);
    };
    const timer = setTimeout(() => {
      stopAz(child);
      end('no-answer');
    }, timeoutMs);
    child.stdin?.end();
    child.stdout?.on('data', (d: Buffer) => (out += String(d)));
    child.stderr?.on('data', (d: Buffer) => (err += String(d)));
    child.on('error', (e: NodeJS.ErrnoException) => end(e.code === 'ENOENT' ? 'missing' : 'no-answer'));
    // A shell that cannot find az says so with 127 (9009 on Windows).
    child.on('close', (code) => end(code === 127 || code === 9009 ? 'missing' : code === null ? 'no-answer' : { code, out, err }));
  });
}

let version: { at: number; found: string | null } | null = null;

/** az's version, kept ten minutes: "2.88.0", or null when az is not here or did not answer. */
export async function azVersion(): Promise<string | null> {
  if (version && Date.now() - version.at < 600_000) return version.found;
  const a = await runAz(['version', '--output', 'json'], 20_000);
  const found = typeof a === 'object' && a.code === 0 ? (/"azure-cli"\s*:\s*"([\d.]+)"/.exec(a.out)?.[1] ?? null) : null;
  version = { at: Date.now(), found };
  return found;
}

export function forgetAzVersion(): void {
  version = null;
}

export interface AzAccount {
  /** The Microsoft account: "sara@contoso.com". */
  user: string;
  tenant: string;
  default: boolean;
}

/** Who squad-kit's own az is signed in as, from its profile file: no az run, nothing secret read. */
export function azAccounts(): AzAccount[] {
  try {
    const text = fs.readFileSync(path.join(ownAzureFolder(), 'azureProfile.json'), 'utf8').replace(/^﻿/, '');
    const p = JSON.parse(text) as { subscriptions?: { user?: { name?: string; type?: string }; tenantId?: string; isDefault?: boolean }[] };
    const all = (p.subscriptions ?? []).filter((s) => s.user?.name && s.user.type !== 'servicePrincipal');
    return all.map((s) => ({ user: s.user!.name!, tenant: s.tenantId ?? '', default: Boolean(s.isDefault) })).sort((a, b) => Number(b.default) - Number(a.default));
  } catch {
    return [];
  }
}

/** The last line az printed, for a plain failure. az never prints a token on its error side. */
export function azLastLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.replace(/^(ERROR|WARNING):\s*/, '').trim())
      .filter(Boolean)
      .pop()
      ?.slice(0, 200) ?? ''
  );
}

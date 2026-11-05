import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentResult, BlockedAction, RunCaps, SandboxAsk, SandboxSupport } from '../ai-tool/types.js';

/**
 * Claude Code's own sandbox for a step's shell commands (Seatbelt on macOS, bubblewrap on Linux and WSL 2). squad-kit
 * asks for folders and hosts; this file turns them into the `sandbox` block of Claude Code's settings, which goes
 * over ACP as the Agent SDK's `sandbox` option and to `claude -p` inside `--settings`. Only shell commands are
 * sandboxed: the file tools keep squad-kit's permission rules.
 */

/** The part of Claude Code's `sandbox` settings squad-kit sets. */
export interface ClaudeSandbox {
  enabled: true;
  failIfUnavailable: boolean;
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: boolean;
  network: { allowedDomains: string[]; strictAllowlist: boolean; allowLocalBinding?: boolean };
  filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[]; allowRead: string[] };
}

/** Claude Code's own sign-in and the person's other conversations: Claude Code reads them, its commands never need to. */
export function claudePrivate(home: string): string[] {
  return [path.join(home, '.claude', '.credentials.json'), path.join(home, '.claude', 'projects'), path.join(home, '.claude.json')];
}

/**
 * What the project's own commands never read of Claude's: Claude Code's sign-in and conversations, and the Claude
 * desktop app's folder on a Mac (its settings can hold keys for the tools it connects to).
 */
export function claudePrivateFiles(home: string, platform: NodeJS.Platform = process.platform): string[] {
  const desktop = platform === 'darwin' ? ['Claude', 'Claude-3p'].map((d) => path.join(home, 'Library', 'Application Support', d)) : [path.join(home, '.config', 'Claude')];
  return [...claudePrivate(home), ...desktop];
}

/** Claude's keys and Claude Code's own settings in the environment. */
export const CLAUDE_ENV = ['ANTHROPIC_*', 'CLAUDE_*', 'CLAUDECODE'];

/** Claude Code's sandbox settings for what a step asked. */
export function claudeSandbox(ask: SandboxAsk, platform: NodeJS.Platform = process.platform, home = os.homedir()): ClaudeSandbox {
  return {
    enabled: true,
    // squad-kit checks that the sandbox can start before it asks for one. If Claude Code still cannot start it, the
    // step runs as it did before the sandbox instead of failing (Claude Code's own default for the SDK is to fail).
    failIfUnavailable: false,
    // squad-kit's allowed and denied tools still decide which commands run; the sandbox only limits what they reach.
    autoAllowBashIfSandboxed: false,
    // No way out for the agent: a command asking to run outside the sandbox (dangerouslyDisableSandbox) stays in it.
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: ask.hosts,
      // Any other host is refused at once instead of asked about.
      strictAllowlist: true,
      // No Unix socket is opened here, so its commands cannot reach Docker's: a container could read any folder.
      // macOS: tests may listen on this computer's own ports and reach them, as the app's own tests do.
      ...(platform === 'darwin' ? { allowLocalBinding: true } : {}),
    },
    // No command runs outside it: pictures and the app go through squad-kit's own tools instead.
    filesystem: { allowWrite: ask.write, denyWrite: ask.noWrite, denyRead: [...new Set([...ask.noRead, ...claudePrivate(home)])], allowRead: ask.read },
  };
}

/* ── Is it there on this computer? ───────────────────────── */

/** What squad-kit looks at to tell whether Claude Code's sandbox runs here. Tests give their own. */
export interface SandboxHost {
  platform: NodeJS.Platform;
  /** The kernel's release: WSL 1 ends in "-Microsoft". */
  release: string;
  /** True when the program is on PATH, or the absolute path exists. */
  has(program: string): boolean;
  /** True when bubblewrap can really make a sandbox (some Linux setups forbid it). */
  bwrapWorks(): boolean;
}

/** Whether Claude Code's sandbox runs on this computer, with the same needs Claude Code checks at start. */
export function sandboxSupportOn(h: SandboxHost): SandboxSupport {
  if (h.platform === 'darwin') {
    return h.has('/usr/bin/sandbox-exec') ? { available: true, why: "Claude Code's sandbox (macOS Seatbelt)" } : { available: false, why: 'macOS sandbox-exec is missing on this Mac' };
  }
  if (h.platform === 'win32') return { available: false, why: "Claude Code's sandbox does not run on Windows yet" };
  if (h.platform !== 'linux') return { available: false, why: "Claude Code's sandbox does not run on this system" };
  if (/-Microsoft$/i.test(h.release)) return { available: false, why: 'WSL 1 has no sandbox', fix: 'Move this Linux to WSL 2: wsl --set-version <name> 2' };
  const missing = ['bubblewrap', 'socat'].filter((p) => !h.has(p === 'bubblewrap' ? 'bwrap' : p));
  if (missing.length) {
    return { available: false, why: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not installed`, fix: `Install ${missing.length === 1 ? 'it' : 'them'}, for example: sudo apt install ${missing.join(' ')}` };
  }
  if (!h.bwrapWorks()) {
    return {
      available: false,
      why: 'bubblewrap cannot make a sandbox on this Linux',
      fix: 'Allow unprivileged user namespaces for bwrap (on Ubuntu 24.04 this needs an AppArmor profile for it)',
    };
  }
  return { available: true, why: "Claude Code's sandbox (bubblewrap)" };
}

function onPath(program: string): boolean {
  if (path.isAbsolute(program)) return fs.existsSync(program);
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [program], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function bwrapWorks(): boolean {
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', 'true'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

let support: SandboxSupport | null = null;

/** This computer's answer, found once. */
export function claudeSandboxSupport(): SandboxSupport {
  return (support ??= sandboxSupportOn({ platform: process.platform, release: os.release(), has: onPath, bwrapWorks }));
}

/* ── What it refused ─────────────────────────────────────── */

/** Claude Code adds what the sandbox refused to a command's output, one line each, inside this block. */
const VIOLATIONS = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/g;
/** "deny network-outbound example.com:443 (not_allowlisted)". */
const HOST = /network-outbound\s+(\[[^\]\s]+\]|[^\s:()]+)/;
/** macOS: "bash(4242) deny(1) file-read-data /Users/me/.ssh/id_rsa". */
const FILE = /deny(?:\(\d+\))?\s+file-(read|write)[\w-]*\s+(\/.*?)\s*$/;

/** What the sandbox refused, from a command's output. Each host or file once. */
export function claudeBlocked(output: string): BlockedAction[] {
  const out: BlockedAction[] = [];
  const seen = new Set<string>();
  for (const block of output.matchAll(VIOLATIONS)) {
    for (const line of block[1]!.split('\n')) {
      const host = HOST.exec(line);
      const file = host ? null : FILE.exec(line);
      const action: BlockedAction | null = host
        ? { kind: 'host', target: host[1]!.replace(/^\[|\]$/g, '') }
        : file
          ? { kind: file[1] === 'read' ? 'read' : 'write', target: file[2]! }
          : null;
      if (!action || seen.has(`${action.kind}:${action.target}`)) continue;
      seen.add(`${action.kind}:${action.target}`);
      out.push(action);
    }
  }
  return out;
}

/* ── Caps ────────────────────────────────────────────────── */

/** How Claude Code ends a run on a cap: its result subtype, or its words ("Reached maximum number of turns (40)"). */
const TURNS = /error_max_turns|maximum number of turns/i;
const SPEND = /error_max_budget_usd|maximum budget/i;

/**
 * A run that stopped on one of its caps says so to the engine, whichever way it ran. Over ACP the adapter either ends
 * the turn with "max_turn_requests" (the gateway marks that) or fails it with Claude Code's own words.
 */
export function withCap(r: AgentResult, caps: RunCaps | undefined): AgentResult {
  if (r.ok || !caps || r.limit) return r;
  const said = `${r.detail ?? ''}\n${r.error ?? ''}`;
  let by: 'turns' | 'spend' | undefined = SPEND.test(said) ? 'spend' : TURNS.test(said) ? 'turns' : r.capped?.by;
  // ACP's "max_turn_requests" is the same for both caps: it was the spend when the run got to its spend cap.
  if (r.capped && !SPEND.test(said) && !TURNS.test(said) && caps.spendUsd && (r.usage?.costUsd ?? 0) >= caps.spendUsd * 0.95) by = 'spend';
  if (!by || (by === 'turns' ? !caps.turns : !caps.spendUsd)) return r;
  const error = by === 'turns' ? `It used the ${caps.turns} turns this step may take.` : `It reached the $${caps.spendUsd} this step may spend.`;
  return { ...r, capped: { by }, error, detail: r.detail ?? said.trim() };
}

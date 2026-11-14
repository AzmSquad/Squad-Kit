import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUBSCRIPTION_WITHHELD_ENV_KEYS } from '../planner/runtimes/sdk-env.js';

/**
 * Node tools (npm, pnpm, vite) stall on networks with broken IPv6. Preferring IPv4 is not enough on its own: Node
 * still races IPv6 connections, and a stuck one hangs `npm install`. So use the first (IPv4) address only.
 */
export function withIpv4First(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const current = env.NODE_OPTIONS ?? '';
  const flags = ['--dns-result-order=ipv4first', '--no-network-family-autoselection'].filter((f) => !current.includes(f.replace(/^--(no-)?/, '').split('=')[0]!));
  return flags.length ? { ...env, NODE_OPTIONS: `${current} ${flags.join(' ')}`.trim() } : env;
}

/** squad-kit's own keys are for the engine: agents never talk to the tracker, the code host or the speech service themselves. */
const ENGINE_ONLY_ENV_KEYS = ['AZURE_DEVOPS_PAT', 'AZURE_DEVOPS_EXT_PAT', 'SQUAD_TRACKER_API_KEY', 'JIRA_API_TOKEN', 'MUNSIT_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

/**
 * Takes the place of the person's GitHub sign-in for agents and the project's own commands. GitHub's tool reads its
 * token from these first, and with one set it never looks in the person's keychain; this one is no token, so every call
 * it makes is refused. squad-kit's own calls and pushes use squad-kit's own environment, never this one.
 */
export const NO_GITHUB_SIGN_IN = 'squad-kit-agents-have-no-github-sign-in';
const NO_SIGN_IN_ENV = { GH_TOKEN: NO_GITHUB_SIGN_IN, GH_ENTERPRISE_TOKEN: NO_GITHUB_SIGN_IN };

let noSignIn: string | null = null;

/**
 * Empty settings folders for GitHub's tool and Microsoft's Azure tool, so they find no account there either: one pair
 * per run, emptied again before each use, and removed when squad-kit ends. Without its own, Microsoft's tool would read
 * the person's `~/.azure`; squad-kit's own Microsoft sign-in sits in squad-kit's folder, which the guard hides (ADR-011).
 */
function emptyToolFolders(): { gh: string; az: string } {
  if (!noSignIn) {
    noSignIn = path.join(os.tmpdir(), `squad-kit-no-sign-in-${process.pid}`);
    const made = noSignIn;
    process.once('exit', () => fs.rmSync(made, { recursive: true, force: true }));
  }
  fs.rmSync(noSignIn, { recursive: true, force: true });
  const gh = path.join(noSignIn, 'gh');
  const az = path.join(noSignIn, 'az');
  for (const d of [gh, az]) fs.mkdirSync(d, { recursive: true });
  return { gh, az };
}

/**
 * No sign-in to the code hosts' own tools: a GitHub token that is none, and empty settings folders for gh and az.
 * projectEnv sets it again after its own cleaning.
 */
export function noToolSignIn(): Record<string, string> {
  const dirs = emptyToolFolders();
  return { ...NO_SIGN_IN_ENV, GH_CONFIG_DIR: dirs.gh, AZURE_CONFIG_DIR: dirs.az };
}

/** The environment every agent process starts with, whichever AI tool it is. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = withIpv4First({ ...process.env });
  // An inherited API key would outrank the subscription login and bill API credits instead.
  for (const key of Object.keys(env)) {
    if (SUBSCRIPTION_WITHHELD_ENV_KEYS.includes(key.toUpperCase()) || ENGINE_ONLY_ENV_KEYS.includes(key.toUpperCase())) delete env[key];
  }
  return { ...env, ...noToolSignIn() };
}

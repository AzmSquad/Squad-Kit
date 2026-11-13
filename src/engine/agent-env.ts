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

/**
 * squad-kit's own keys are for the engine: agents never talk to the tracker, the code host or the speech service
 * themselves. The code host's tool keeps its sign-in in its own folder, so agents get an empty one of those too.
 */
const ENGINE_ONLY_ENV_KEYS = ['AZURE_DEVOPS_PAT', 'SQUAD_TRACKER_API_KEY', 'JIRA_API_TOKEN', 'MUNSIT_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

let noSignIn: string | null = null;

/** An empty folder for the code host tool's settings: a tool started there finds no sign-in. Made once per run. */
function emptyToolFolder(): string {
  if (noSignIn && fs.existsSync(noSignIn) && !fs.readdirSync(noSignIn).length) return noSignIn;
  noSignIn = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-kit-no-sign-in-'));
  return noSignIn;
}

/** The environment every agent process starts with, whichever AI tool it is. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = withIpv4First({ ...process.env });
  // An inherited API key would outrank the subscription login and bill API credits instead.
  for (const key of Object.keys(env)) {
    if (SUBSCRIPTION_WITHHELD_ENV_KEYS.includes(key.toUpperCase()) || ENGINE_ONLY_ENV_KEYS.includes(key.toUpperCase())) delete env[key];
  }
  env.GH_CONFIG_DIR = emptyToolFolder();
  return env;
}

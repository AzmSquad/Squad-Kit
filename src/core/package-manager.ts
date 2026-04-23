import path from 'node:path';
import process from 'node:process';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface DetectedPM {
  pm: PackageManager;
  /** Why we think this — e.g. "binary path contains ~/.pnpm/" or "npm_config_user_agent". */
  reason: string;
}

/**
 * Best-effort detection based on the current process metadata and the installed binary path.
 * Order of preference: explicit user-agent > install-path heuristic > fallback to npm.
 */
export function detectPackageManager(installRoot: string): DetectedPM {
  const ua = process.env.npm_config_user_agent;
  if (ua) {
    if (ua.startsWith('pnpm/')) return { pm: 'pnpm', reason: 'npm_config_user_agent' };
    if (ua.startsWith('yarn/')) return { pm: 'yarn', reason: 'npm_config_user_agent' };
    if (ua.startsWith('bun/')) return { pm: 'bun', reason: 'npm_config_user_agent' };
    if (ua.startsWith('npm/')) return { pm: 'npm', reason: 'npm_config_user_agent' };
  }

  // Path-based heuristic: where is the package installed?
  const root = installRoot.toLowerCase();
  if (root.includes(`${path.sep}pnpm${path.sep}`) || root.includes(`${path.sep}.pnpm${path.sep}`))
    return { pm: 'pnpm', reason: `install path contains pnpm` };
  if (root.includes(`${path.sep}.yarn${path.sep}`) || root.includes(`${path.sep}yarn${path.sep}`))
    return { pm: 'yarn', reason: `install path contains yarn` };
  if (root.includes(`${path.sep}.bun${path.sep}`) || root.includes(`${path.sep}bun${path.sep}`))
    return { pm: 'bun', reason: `install path contains bun` };

  return { pm: 'npm', reason: 'default fallback' };
}

export function installCommandFor(pm: PackageManager, pkg: string, version: string): { cmd: string; args: string[] } {
  const spec = `${pkg}@${version}`;
  switch (pm) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-g', spec] };
    case 'yarn':
      return { cmd: 'yarn', args: ['global', 'add', spec] };
    case 'bun':
      return { cmd: 'bun', args: ['install', '-g', spec] };
    case 'npm':
      return { cmd: 'npm', args: ['install', '-g', spec] };
  }
}

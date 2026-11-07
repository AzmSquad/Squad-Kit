import { spawn } from 'node:child_process';
import process from 'node:process';
import { confirm } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { boardExists, boardPaths } from '../board/store.js';
import { buildPaths, findSquadRoot } from '../core/paths.js';
import { changelogBlobUrl, readInstalledPackage } from '../core/package-info.js';
import { fetchLatest, isNewer } from '../core/registry.js';
import { fetchReleasesBetween, isMajorBump, upgradePlan } from '../core/update.js';

const REGISTRY_HOST = 'registry.npmjs.org';

export interface UpgradeOptions {
  check?: boolean;
  yes?: boolean;
}

export async function runUpgrade(opts: UpgradeOptions): Promise<void> {
  const installed = readInstalledPackage();
  ui.divider('squad upgrade');
  ui.info(`  installed  ${installed.version}`);

  if (installed.isDevInstall) {
    ui.failure(
      'Development install detected (source directory alongside the binary). Run `pnpm add -g squad-kit@latest` (or `npm i -g squad-kit@latest`) from npm, not a source checkout.',
    );
    process.exit(1);
  }

  let latest: string;
  try {
    const info = await fetchLatest(installed.name);
    latest = info.latest;
  } catch (err) {
    ui.failure(
      `Could not reach the npm registry: ${(err as Error).message}. Check your network, then run \`pnpm add -g squad-kit@latest\` (or \`npm i -g squad-kit@latest\`) manually.`,
    );
    process.exit(1);
  }

  ui.info(`  latest     ${latest}  (from ${REGISTRY_HOST})`);

  if (!isNewer(latest, installed.version)) {
    ui.blank();
    ui.success(`You're on the latest version (${installed.version}).`);
    return;
  }

  if (isMajorBump(latest, installed.version)) {
    ui.blank();
    ui.failure(
      `Major version change detected (${installed.version} → ${latest}). Run \`squad upgrade --check\` after you install a specific version, and review: ${changelogBlobUrl(installed.repositoryUrl, latest)}`,
    );
    process.exit(1);
  }

  // The same command and notes the app's Update button uses.
  const pm = upgradePlan(installed, latest);
  const { cmd, args } = pm;
  const releases = await fetchReleasesBetween(installed.repositoryUrl, installed.version, latest);
  const newest = releases.find((r) => r.version === latest);

  ui.blank();
  ui.info(`Detected package manager: ${pm.pm} (${pm.reason})`);
  // Every release since this version, newest first, so nothing in between is missed.
  for (const r of releases) {
    if (!r.lines.length) continue;
    ui.info(`What is new in ${r.version}:`);
    for (const line of r.lines) ui.info(`  · ${line}`);
  }
  ui.info(`Changelog: ${newest?.url ?? changelogBlobUrl(installed.repositoryUrl, latest)}`);

  if (opts.check) {
    ui.blank();
    ui.info(`Run to upgrade: ${cmd} ${args.join(' ')}`);
    return;
  }

  if (!opts.yes) {
    const interactive = Boolean(process.stdin.isTTY) && process.env.CI !== 'true';
    if (!interactive) {
      ui.failure(
        `Refusing to run a global install without --yes. Run \`squad upgrade --yes\` in non-interactive mode, or run manually: ${cmd} ${args.join(' ')}`,
      );
      process.exit(1);
    }
    const go = await confirm({ message: `Run "${cmd} ${args.join(' ')}"?`, default: true });
    if (!go) {
      ui.info('Cancelled. No changes applied.');
      return;
    }
  }

  ui.blank();
  ui.info(`Running: ${cmd} ${args.join(' ')}`);
  const exitCode = await spawnInherit(cmd, args);

  if (exitCode !== 0) {
    ui.failure(
      `${cmd} exited with code ${exitCode}. Upgrade may be incomplete — run \`squad doctor\` and re-run \`squad upgrade\` if needed.`,
    );
    process.exit(exitCode);
  }

  ui.blank();
  ui.success(`Upgraded to ${latest}.`);
  // Only a project from before 1.0 has anything to move.
  const root = findSquadRoot();
  if (root && !boardExists(boardPaths(buildPaths(root).squadDir))) ui.info('Run `squad migrate` to update your .squad/ structure if needed.');
}

export function spawnInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    // Ended by a signal there is no exit code, and the install did not finish.
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => reject(err));
  });
}

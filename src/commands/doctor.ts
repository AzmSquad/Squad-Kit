import * as ui from '../ui/index.js';
import * as theme from '../ui/theme.js';
import { findSquadRoot, buildPaths } from '../core/paths.js';
import {
  gatherContext,
  runAllChecks,
  summarise,
  type CheckResult,
  type DoctorContext,
} from './doctor-engine.js';

export type { CheckResult, DoctorContext };

/** Re-export for tests that assert cache-check behaviour. */
export { checkPlannerCache } from './doctor-engine.js';

export interface DoctorOptions {
  fix?: boolean;
  json?: boolean;
}

function colorForStatus(s: CheckResult['status']): (t: string) => string {
  switch (s) {
    case 'ok':
      return theme.primary;
    case 'warn':
      return theme.warn;
    case 'fail':
      return theme.danger;
    case 'skip':
      return theme.dim;
    default:
      return (x) => x;
  }
}

function symbolForStatus(s: CheckResult['status']): string {
  switch (s) {
    case 'ok':
      return '✓';
    case 'warn':
      return '!';
    case 'fail':
      return '✗';
    case 'skip':
      return '·';
    default:
      return '?';
  }
}

function renderChecks(root: string, checks: CheckResult[]): void {
  ui.divider('squad doctor');
  ui.info(`workspace  ${root}`);
  ui.info('');
  for (const c of checks) {
    const sym = symbolForStatus(c.status);
    const col = colorForStatus(c.status);
    const detail = c.detail ? theme.dim(` — ${c.detail}`) : '';
    ui.line(`  ${col(sym)}  ${c.name}${detail}`);
    if (c.fixHint) ui.line(`       ${theme.dim('↳ ' + c.fixHint)}`);
  }
  ui.info('');
  const counts = summarise(checks);
  ui.info(`${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail · ${counts.skip} skip`);
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  const fix = opts.fix ?? false;
  const json = opts.json ?? false;

  const root = findSquadRoot();
  if (!root) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ error: 'No .squad/ directory found. Run `squad init` first.', checks: [] }, null, 2) + '\n',
      );
    } else {
      ui.failure('No .squad/ directory found. Run `squad init` first.');
    }
    process.exit(1);
  }
  const paths = buildPaths(root);

  const ctx = await gatherContext(paths);
  const checks = await runAllChecks(paths, ctx, fix);

  if (json) {
    process.stdout.write(JSON.stringify({ root, checks }, null, 2) + '\n');
  } else {
    renderChecks(root, checks);
  }

  if (fix) {
    const repaired = checks.filter((c) => c.detail === 'repaired').length;
    if (repaired > 0 && !json) {
      ui.info('');
      ui.info(`Applied ${repaired} repair(s).`);
    }
  }

  if (!json) {
    const fixableWarns = checks.filter((c) => c.status === 'warn' && c.fixable).length;
    const migrateNeeded = checks.filter((c) => c.id === 'legacy-prompts' && c.status === 'warn').length;
    if (!fix && (fixableWarns > 0 || migrateNeeded > 0)) {
      ui.info('');
      if (fixableWarns > 0) {
        ui.info(
          `${fixableWarns} fixable issue(s) found. Run \`squad doctor --fix\` to apply non-destructive repairs.`,
        );
      }
      if (migrateNeeded > 0) {
        ui.info(`${migrateNeeded} destructive issue requires \`squad migrate\`.`);
      }
    }
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  if (fails > 0) process.exit(1);
}

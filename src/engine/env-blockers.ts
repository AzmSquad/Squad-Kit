import type { CheckResult } from './checks.js';

/**
 * A check that failed for a reason no change to the code can fix (#37): Docker is not running, PHP lacks the database
 * driver the tests use, the check's own program is not installed. The Builder is never sent to "fix" these: the ticket
 * stops once, with what to install or start, and Try again.
 */

export interface EnvBlocker {
  /** squad-kit's own words for the person: what is missing, and what to do. */
  words: string;
  /** A short name for the ticket's line and the log. */
  what: string;
}

/** The program a command runs first: "php artisan test" is php, "FOO=1 npx jest" is npx. */
function firstProgram(command: string): string {
  const words = command.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
  return words[0]?.replace(/^.*\//, '') ?? '';
}

const DRIVER_PACKAGES: Record<string, string> = { sqlite: 'php-sqlite3', mysql: 'php-mysql', pgsql: 'php-pgsql', sqlsrv: 'the sqlsrv extension' };

/** What blocks this failed check, or null when it may well be the code's. */
export function envBlockerIn(output: string, command: string): EnvBlocker | null {
  if (/Cannot connect to the Docker daemon|Is the docker daemon running\?|error during connect:[^\n]*docker|permission denied while trying to connect to the Docker daemon/i.test(output)) {
    return {
      what: 'Docker is not running',
      words: "Docker is not running on this computer, and the project's checks need it. Start Docker (Docker Desktop, or sudo systemctl start docker on Linux), then press Try again. No change to the code can fix this, so the Builder was not sent.",
    };
  }
  const driver = /could not find driver(?:[^\n]*Connection: (\w+))?/i.exec(output);
  if (driver) {
    const name = driver[1]?.toLowerCase();
    const pkg = name ? DRIVER_PACKAGES[name] : undefined;
    return {
      what: `PHP has no ${name ?? 'database'} driver`,
      words: `PHP on this computer has no ${name ? `${name} ` : ''}database driver, and the tests need it. Install it${pkg ? ` (for example: sudo apt install ${pkg}, or enable pdo_${name} in php.ini)` : ''}, then press Try again. No change to the code can fix this, so the Builder was not sent.`,
    };
  }
  const ext = /requires (?:the )?(?:PHP )?ext(?:ension)?-(\w+)/i.exec(output);
  if (ext) {
    return {
      what: `PHP has no ${ext[1]} extension`,
      words: `PHP on this computer is missing the ${ext[1]} extension, and the project needs it. Install or enable it, then press Try again. No change to the code can fix this, so the Builder was not sent.`,
    };
  }
  const program = firstProgram(command);
  const missing = /(?:^|\n)(?:\S*sh|\S+): (?:(?:line )?\d+: )?(\S+): (?:command )?not found/.exec(output)?.[1];
  if (program && missing && missing.replace(/^.*\//, '') === program) {
    return {
      what: `${program} is not installed`,
      words: `${program} is not installed on this computer, and the check "${command.slice(0, 80)}" runs it. Install it, then press Try again. No change to the code can fix this, so the Builder was not sent.`,
    };
  }
  return null;
}

/** The first failed check that something outside the code blocks, with what blocks it. */
export function envBlocked(ran: CheckResult[]): { result: CheckResult; blocker: EnvBlocker } | null {
  for (const r of ran) {
    if (r.ok) continue;
    const blocker = envBlockerIn(r.output, r.command);
    if (blocker) return { result: r, blocker };
  }
  return null;
}

import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { SQUAD_DIR, findSquadRoot } from '../core/paths.js';
import { projectName, readProjects } from '../core/projects.js';
import { logFile, logsDir, tailLines } from '../core/app-log.js';
import { boardPaths } from '../board/store.js';
import { writeReport, type ReportInput } from '../engine/report.js';
import { activePause, endPause, limitText } from '../engine/usage-limit.js';

/**
 * The terminal side of "when something goes wrong" (phase 10): `squad report [ticket]` saves the same file as Report a
 * problem on the board, `squad logs` says where squad-kit's own log is, and `squad try-now` ends a usage-limit wait.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);

/** One zip with the ticket (or the project, or the whole app), the log for 24 hours and the versions. */
export async function runReport(ticket: string | undefined, opts: { note?: string; out?: string } = {}): Promise<void> {
  const root = findSquadRoot();
  if (ticket && !root) throw new Error('Run this in the project\'s folder, or add --project <name>, so squad-kit knows whose ticket it is.');
  const input: ReportInput = root
    ? { bp: boardPaths(path.join(root, SQUAD_DIR)), ...(ticket ? { ticket } : {}) }
    : {
        projects: readProjects().map((p) => {
          const open = fs.existsSync(path.join(p.root, SQUAD_DIR, 'config.yaml'));
          return { id: p.id, name: projectName(p.root), root: p.root, open, ...(open ? {} : { why: 'its folder or its .squad/ folder is gone' }) };
        }),
      };
  const r = writeReport({ ...input, ...(opts.note ? { note: opts.note } : {}), ...(opts.out ? { dir: path.resolve(opts.out) } : {}) });
  ui.success(`Saved ${r.name}`);
  out(`  ${r.file}`);
  out();
  out('  It holds:');
  for (const h of r.holds) out(`  ${kleur.green('✓')} ${h}`);
  out(kleur.gray(`  ${r.never}`));
  out();
  out(`  ${kleur.bold('Send this file to whoever helps you with squad-kit.')}`);
}

/** Where the log is; with --tail, its last lines. */
export async function runLogs(opts: { tail?: string | boolean } = {}): Promise<void> {
  if (opts.tail !== undefined && opts.tail !== false) {
    const n = typeof opts.tail === 'string' && Number(opts.tail) > 0 ? Math.min(2000, Math.floor(Number(opts.tail))) : 40;
    const lines = tailLines(n);
    if (!lines.length) ui.info('Nothing is logged yet.');
    for (const l of lines) out(l.includes(' error ') ? kleur.red(l) : l.includes(' warn ') ? kleur.yellow(l) : l);
    return;
  }
  out(`  squad-kit's own log: ${logsDir()}`);
  out(`  Today:               ${logFile()}${fs.existsSync(logFile()) ? '' : kleur.gray(' (nothing yet)')}`);
  out(kleur.gray('  One file a day, kept 14 days. Never tokens, passwords or what was sent to an agent.'));
  out(kleur.gray(`  The last lines: ${kleur.green('squad logs --tail')}   Send it all with your ticket: ${kleur.green('squad report <ticket>')}`));
}

/** Try now: the queue stops waiting for the usage limit to reset. */
export async function runTryNow(): Promise<void> {
  const pause = activePause();
  if (!pause) {
    ui.info('Nothing waits for a usage limit right now.');
    return;
  }
  out(`  ${limitText(pause)}.`);
  endPause();
  ui.success('The squad carries on now. If the limit is still there, the first step finds it and waits again.');
}

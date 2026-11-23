import { projectApps } from '../board/apps.js';
import { readMeta, type BoardPaths } from '../board/store.js';
import { writeLog } from '../core/app-log.js';
import { tail } from './checks.js';

/** What a failed start of one of Your apps knows about itself (run-app.ts). */
interface FailedRun {
  error?: string;
  detail?: string;
  busy?: { port: number; program?: string };
}

/**
 * Why an app did not start, in squad-kit's log too: before, it lived only in the board's memory, so the Squad lead and
 * a problem report found nothing after a failed start (the Nov 17 demo). The detail is what engineers read.
 */
export function logAppFailure(bp: BoardPaths, runs: Map<string, unknown>, run: FailedRun): void {
  try {
    const meta = readMeta(bp);
    const repo = [...runs.entries()].find(([, r]) => r === run)?.[0];
    const name = repo === undefined ? 'The app' : (projectApps(meta).find((a) => a.repo === repo)?.name ?? repo);
    const busy = run.busy ? ` Port ${run.busy.port} is held${run.busy.program ? ` by ${run.busy.program}` : ''}.` : '';
    const detail = run.detail?.trim() ? ` | ${tail(run.detail, 30)}` : '';
    writeLog({ level: 'error', project: meta.project, text: `Run app: ${name} did not start: ${run.error ?? 'no reason given'}${busy}${detail}` });
  } catch {
    // Logging never fails the work it describes.
  }
}

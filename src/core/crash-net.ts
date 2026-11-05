import { log } from './app-log.js';

/**
 * The last net under the app. Without it, one error nobody caught ends every project's squad. Each project's files are
 * the truth, so the app stays up: the exact error goes to the app log and the terminal. A port it cannot listen on is
 * still the end, because then nothing can reach it.
 */

type Output = { on(event: 'error', fn: () => void): unknown; off(event: 'error', fn: () => void): unknown };
type Proc = Pick<NodeJS.Process, 'on' | 'off'> & { exit(code?: number): never; stdout?: Output; stderr?: Output };

/** Nobody reads the terminal any more: it closed, or the program after a pipe ended (`squad | tee`). Not the app's trouble. */
function outputGone(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  return (e?.code === 'EPIPE' && e.syscall === 'write') || e?.code === 'ERR_STREAM_DESTROYED' || e?.code === 'ERR_STREAM_WRITE_AFTER_END';
}

function fatal(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  return e?.syscall === 'listen' && (e.code === 'EADDRINUSE' || e.code === 'EACCES');
}

export function installCrashNet(proc: Proc = process, say: (text: string) => void = (text) => log.error(text)): () => void {
  let saying = false;
  const onError = (err: unknown, kind: string) => {
    // Saying so would write to that same output, and fail the same way, for ever.
    if (outputGone(err)) return;
    // What goes wrong while it says this is not said again: a line about a line never ends.
    if (!saying) {
      saying = true;
      try {
        say(`squad-kit kept running after ${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      } catch {
        // A full disk or a closed terminal: the app goes on without this line.
      } finally {
        saying = false;
      }
    }
    if (fatal(err)) proc.exit(1);
  };
  // A write to a terminal nobody reads fails with an error event. With no one listening, that is an uncaught error.
  const quiet = () => undefined;
  proc.stdout?.on('error', quiet);
  proc.stderr?.on('error', quiet);
  const uncaught = (err: unknown) => onError(err, 'an error nobody caught');
  const rejected = (err: unknown) => onError(err, 'a promise that failed with nobody waiting');
  proc.on('uncaughtException', uncaught);
  proc.on('unhandledRejection', rejected);
  return () => {
    proc.off('uncaughtException', uncaught);
    proc.off('unhandledRejection', rejected);
    proc.stdout?.off('error', quiet);
    proc.stderr?.off('error', quiet);
  };
}

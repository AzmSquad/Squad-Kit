import { writeLog } from './app-log.js';

/**
 * Only words meant for a person reach a toast or a stop. squad-kit's own `new Error("…")` and its own error classes are
 * written for people. A system error with its code, a command that failed, a language error, a library's own error and
 * git's words are not: they go to the app log for engineers, and the person reads one plain sentence.
 */

/** An error whose words are for engineers, though squad-kit wrote the line around them. */
export class RawError extends Error {}

const LANGUAGE_ERRORS = [TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError];

/** The person's words in this error, or null when they are not meant for a person. */
export function wordsForPeople(err: unknown): string | null {
  if (!(err instanceof Error) || err instanceof RawError || !err.message.trim()) return null;
  const e = err as NodeJS.ErrnoException & { stderr?: unknown; cmd?: unknown };
  if (e.code !== undefined || e.syscall !== undefined || e.stderr !== undefined || e.cmd !== undefined) return null;
  if (LANGUAGE_ERRORS.some((L) => err instanceof L) || err.name === 'YAMLException' || err.name === 'AbortError' || err.name === 'TimeoutError') return null;
  return err.message;
}

/** What the person reads when the words were not for them. */
export const SOMETHING_TECHNICAL = 'That did not work because of something technical, and nothing was lost. Try again. If it happens again, an engineer can see why in the log.';

/** The words of an error for a person: its own, or the plain sentence, with the exact words in the app log. `doing` says what was going on, for the log. */
export function plainWords(err: unknown, doing = 'A button failed', fallback = SOMETHING_TECHNICAL): string {
  const words = wordsForPeople(err);
  if (words !== null) return words;
  writeLog({ level: 'error', text: `${doing}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` });
  return fallback;
}

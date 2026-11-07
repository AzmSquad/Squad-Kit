import { NO_ANSWER, UnauthorizedError } from '../api/client';

/**
 * A page's first load did not get through: what to say instead of an empty list. An all-clear, "No board yet" or "Add
 * your first project" would be false, since nothing was read. What it says, and whether Home is the way on.
 */
export function loadTrouble(err: unknown, what: string): { text: string; home: boolean } {
  if (err instanceof UnauthorizedError) return { text: err.message, home: false };
  if (err instanceof Error && err.message === NO_ANSWER) return { text: `squad-kit did not answer, so ${what} could not load. Check that it still runs in its terminal, then press Try again.`, home: false };
  // The project is no longer in the app: it was taken out, or the link is old.
  if (err instanceof Error && /^404\b/.test(err.message)) return { text: `${what[0]!.toUpperCase()}${what.slice(1)} could not load: this project is not open in squad-kit now. Add it again from Home.`, home: true };
  return { text: `${what[0]!.toUpperCase()}${what.slice(1)} could not load. Nothing is lost. Press Try again.`, home: false };
}

import { StepError } from '../board/problem.js';
import type { AiTool } from '../modules/ai-tool/types.js';

/**
 * Only squad-kit's own plain words reach a person's stop as they are: a StepError's, the sentences below that a run
 * of an agent stops with, and the AI tool module's own (AiTool.ownWords). Anything else, like a tool's raw error,
 * "TypeError: …", "write EPIPE" or "status code 529", becomes the plain technical stop, and its exact words go to the
 * engineer details and the app log. A list of what may pass, never a list of words that may not.
 */

const STOPPED = 'You stopped the squad.';

/** A step that stopped on something squad-kit has no plain words for. */
export const TECHNICAL_STOP = 'The step stopped on something technical, so squad-kit could not finish it. Press Try again.';

/** What an agent run stops with in squad-kit's own words, whichever AI tool ran it. */
const RUN_WORDS: RegExp[] = [
  /^You stopped the squad\.$/,
  /^The step reached the most it may do in one run\.$/,
  /^It used the \d+ turns this step may take\.$/,
  /^It reached the \$[\d.]+ this step may spend\.$/,
  /^Stopped after \d+ minutes without finishing\.$/,
  /^It took longer than \d+ minutes, so squad-kit stopped it\.$/,
  /^The answer was cut off because it got too long\.$/,
  /^The agent declined to do this step\.$/,
  /^The step was cancelled\.$/,
  /^The agent finished without giving squad-kit its answer\.$/,
  /^[\w .-]{1,40} did not (start|open its session|open a session) in \d+ seconds?\. Check that it opens in a terminal and is logged in, then press Try again\.$/,
];

/** True when a run's error is squad-kit's own sentence, or the AI tool module's own plain words. */
export function ownRunWords(said: string, tool?: Pick<AiTool, 'ownWords'>): boolean {
  const s = said.trim();
  return RUN_WORDS.some((re) => re.test(s)) || Boolean(tool?.ownWords?.(s));
}

/** squad-kit's own plain words for an error, or null when its words are not squad-kit's to show. */
export function ownWords(err: unknown): string | null {
  if (err instanceof StepError) return err.message;
  if (err instanceof Error && err.message === STOPPED) return STOPPED;
  return null;
}

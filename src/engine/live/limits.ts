export const MAX_CHECK_TRIES = 3;
export const MAX_REVIEW_ROUNDS = 2;
/** The longest one run may take: writing words (questions, a spec, a design, a read of the project), answering about a question, the Builder, the Reviewer and the picture check, and the Tester. */
export const WORDS_STEP_MS = 10 * 60_000;
export const ANSWER_STEP_MS = 5 * 60_000;
export const BUILD_STEP_MS = 60 * 60_000;
export const REVIEW_STEP_MS = 15 * 60_000;
export const PROOF_STEP_MS = 30 * 60_000;
/** How often the board looks for tickets teammates pushed: handed to you, or moved on by their owner. */
export const PICK_UP_MS = 2 * 60_000;
/** The "before" screenshots run beside the build and stop after this long, so they never hold anything up. */
export const BEFORE_SHOTS_MS = 8 * 60_000;
/** How long an app squad-kit keeps for the proof may wait for it, while no step of its story runs. */
export const KEPT_APP_MS = 10 * 60_000;

/** Turns of a squad that failed in a row before the board says so: one can be bad luck, a few mean nothing moves. */
export const TURNS_BEFORE_BANNER = 3;

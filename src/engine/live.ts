/**
 * The live squad. Each step of a ticket is one real run of the role's AI tool in the project (or the
 * ticket's own worktree). Every step reads the ticket file, does its work, and writes the result
 * back, so the board and the terminal always show the true state.
 */
// Each step is in its own file in ./live/.

export {
  MAX_CHECK_TRIES,
  MAX_REVIEW_ROUNDS,
  WORDS_STEP_MS,
  BUILD_STEP_MS,
  REVIEW_STEP_MS,
  PROOF_STEP_MS,
  BEFORE_SHOTS_MS,
  KEPT_APP_MS,
  TURNS_BEFORE_BANNER,
} from './live/limits.js';
export { planStepOf, projectRoot, secretFiles, BLIP_WAITS_MIN } from './live/shared.js';
export { ticketsRunning, holdNewRuns, agentRuns, queuedText, LiveSquad } from './live/squad.js';

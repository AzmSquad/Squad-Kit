/** Every person-facing action lives here, so the board and the terminal do exactly the same thing. */
// Each group of actions is in its own file in ./actions/.

export { BoardActionError } from './actions/errors.js';
export {
  MAX_UPLOADS,
  MAX_UPLOAD_BYTES,
  saveTicketUploads,
  saveUploads,
  createTicket,
  WAITS_TO_START,
  NEW_TESTS_ALWAYS,
  startTicket,
  pullTicket,
  startFromTracker,
  reportBug,
} from './actions/new-ticket.js';
export type { NewTicketInput, UploadedFile, BugInput } from './actions/new-ticket.js';
export {
  answerQuestions,
  skipQuestions,
  askAbout,
  approve,
  approveExpress,
  needsSpec,
  saveDesignDecision,
} from './actions/approve.js';
export type { AnswerInput } from './actions/approve.js';
export { CHECKOUT_WAITS, acceptProof } from './actions/accept.js';
export {
  HookStopped,
  refuseWhileSaving,
  isSaving,
  holdingSave,
  acceptInTurn,
  endSaves,
  approveBeside,
  decideStuckBeside,
  saveBeforeAccept,
  pullRequestClashed,
} from './actions/save.js';
export {
  answerAgent,
  DECIDE_YOURSELF,
  addNote,
  takeOver,
  giveBack,
  handOver,
  requestChange,
} from './actions/agent-talk.js';
export type { HandOverInput } from './actions/agent-talk.js';
export {
  CHAT_SESSION,
  startChat,
  askQuestion,
  sendChat,
  chatWrite,
  chatDone,
  chatStop,
  chatRetry,
} from './actions/chat.js';
export {
  shipped,
  ReleasedError,
  openChange,
  changeNeedsYou,
  buildStarted,
  changeWork,
  changeParts,
  proposeChange,
  retryChange,
  approveChange,
  withdrawChange,
  declineChange,
  changeAfterRelease,
} from './actions/change.js';
export type { ChangeAnswer } from './actions/change.js';
export {
  planSnapshot,
  applyPlanEdits,
  editPlan,
  reviewText,
  changeSummary,
  sendBack,
  startOver,
} from './actions/plan-edits.js';
export { gateCantRunCard, wayOptions, saveTestCommand, decideTestCommand, decideStuck } from './actions/decide.js';
export {
  ensureDraftRelease,
  composeNotes,
  saveReleaseNotes,
  releaseVersion,
  closeReleased,
  joinNextRelease,
  pushReleaseAgain,
  SentNotSure,
  markReleaseSent,
} from './actions/release.js';
export { stopTicket, endStuckCommand, keepWaiting, restartStep, inbox, setUpLocalCopy } from './actions/steps.js';
export {
  readCodeAgain,
  draftTechDecision,
  approveTechDecision,
  discardTechDecision,
  updateForDecision,
  keepPlan,
  checkTicketsAgainst,
} from './actions/decisions.js';

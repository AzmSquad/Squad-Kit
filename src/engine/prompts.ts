/** Role briefs for the live squad, and the JSON shapes each role must answer in. */
// Each role and step has its own file in ./prompts/.

export {
  PROCESS_RULE,
  SCAN_SCHEMA,
  BLUEPRINT_SCHEMA,
  FIRST_BLUEPRINT_SCHEMA,
  TECH_DECISION_SCHEMA,
  IMPACT_SCHEMA,
  QUESTIONS_SCHEMA,
  PLAN_SCHEMA,
  SPEC_SCHEMA,
  CHANGE_SCHEMA,
  CHANGE_DESIGN_SCHEMA,
  CHAT_SCHEMA,
  DESIGN_SCHEMA,
  BUILD_SCHEMA,
  REVIEW_SCHEMA,
  PROOF_SCHEMA,
  PROOF_CHECK_SCHEMA,
  DRAFT_SCHEMA,
} from './prompts/schemas.js';
export {
  writtenInArabic,
  theirLanguage,
  EXAMPLES_FIT,
  asData,
  changesFile,
  projectContext,
  ticketContext,
  openTicketsText,
  notesText,
  doneWhenItems,
  startWithNoWindow,
} from './prompts/context.js';
export type { PromptContext, OpenTicket } from './prompts/context.js';
export { offLimitsText, TECH_RULE, windowRule, networkRule } from './prompts/rules.js';
export { scanPrompt, blueprintPrompt, techDecisionPrompt, impactPrompt } from './prompts/project.js';
export { intakePrompt, replyPrompt, draftPrompt } from './prompts/questions.js';
export { planPrompt, phoneAppWords, specPrompt, designPrompt } from './prompts/plan.js';
export {
  buildPrompt,
  MADE_BY_ITS_TOOL,
  XCODE_IS_SQUAD_KITS,
  setupTroubleText,
  dependencyText,
  answerPrompt,
  fixChecksPrompt,
  weakenedFixPrompt,
  reviewFixPrompt,
  clashPrompt,
  changeFixPrompt,
} from './prompts/build.js';
export { reviewPrompt } from './prompts/review.js';
export { proofPrompt, proofAgainPrompt, proofCheckPrompt, proofFixPrompt } from './prompts/proof.js';
export type { PhoneForPictures, PictureFile, PictureToCheck } from './prompts/proof.js';
export {
  overviewTalkPrompt,
  answerAgainPrompt,
  chatPrompt,
  besideNext,
  copyNow,
  whereToLook,
  besidePrompt,
  earlierTalk,
  chatNext,
  chatCarryOnPrompt,
} from './prompts/talk.js';
export type { ReviewLook } from './prompts/talk.js';
export {
  changeLines,
  changePrompt,
  changeDesignPrompt,
  smallChangePrompt,
  changeRedoPrompt,
} from './prompts/change.js';

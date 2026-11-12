/**
 * The Squad lead's limits, in one place, so the Harness page shows the same numbers the engine keeps. The most one
 * question may use (turns and spend) comes from the Quality setting, like every step: see stepCaps in levels.ts.
 */

/** The longest one answer may take, looking at the app in its own copy included. */
export const LEAD_ANSWER_MS = 8 * 60_000;

/** The most the lead's answers may cost in one day, at API prices. Past it, it answers again the next day. */
export const MAX_LEAD_DAY_USD = 10;

/** The most cards, pictures and sources one answer keeps. */
export const MAX_LEAD_CARDS = 4;
export const MAX_LEAD_PICTURES = 4;
export const MAX_LEAD_SOURCES = 8;

/** The longest question the lead takes. */
export const MAX_QUESTION_CHARS = 4000;

/**
 * The card's line of a story that waits for a tool, kept apart so the board's own files can tell it from work going on
 * (board/now.ts) without the rest of the tools.
 */

export const TOOLS_CHECKING = "Checking this computer's tools for this story";
export const GOES_ON = (n: number) => `Goes on by itself once ${n === 1 ? "it's" : "they're"} there`;
export const CANT_HERE = "It can't go on on this computer";

/** True for the card's line of a story that waits for a tool. */
export function waitsForTools(status: string | undefined): boolean {
  if (!status) return false;
  return status === TOOLS_CHECKING || (status.startsWith('Waits for ') && (/\. Goes on by itself once (?:it's|they're) there$/.test(status) || status.endsWith(`. ${CANT_HERE}`)));
}

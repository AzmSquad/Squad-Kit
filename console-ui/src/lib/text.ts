/**
 * A value as one word of a command the person copies into a terminal. Plain text keeps its double quotes; text that a
 * shell reads inside them ($, `, \, " or !) goes in single quotes instead, where the shell reads nothing, so pasting
 * the command never runs a part of it.
 */
export function shellQuote(x: string): string {
  return /["$`\\!]/.test(x) ? `'${x.replace(/'/g, `'\\''`)}'` : `"${x}"`;
}

/** The text without its HTML comments, such as the hints in a template, removed again until none is left. */
export function withoutComments(text: string): string {
  let before: string;
  do {
    before = text;
    text = text.replace(/<!--[\s\S]*?-->/g, '');
  } while (text !== before);
  return text;
}

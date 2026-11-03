/**
 * Removes every match of a global pattern, again until none is left, so removing one match can never join the text
 * around it into a new one: one pass over `<!<!-- a -->-- b -->` leaves `<!-- b -->`.
 */
function removeAll(text: string, pattern: RegExp): string {
  let before: string;
  do {
    before = text;
    text = text.replace(pattern, '');
  } while (text !== before);
  return text;
}

/**
 * Text put in a command the person copies into a terminal, as one argument. Plain text goes in double quotes; text
 * with anything a shell reads inside them ($, `, \, " or !) goes in single quotes instead, where the shell reads
 * nothing, so pasting the command never runs a part of it. The same rule as the board's (console-ui/src/lib/text.ts).
 */
export function shellQuote(x: string): string {
  return /["$`\\!]/.test(x) ? `'${x.replace(/'/g, `'\\''`)}'` : `"${x}"`;
}

/** One word of a command: a plain name or address stays as it is ("Sara", "http://localhost:3000"); anything else is quoted. */
export function shellArg(x: string): string {
  return /^[\w@%+=:,./#-]+$/.test(x) && !x.startsWith('#') ? x : shellQuote(x);
}

/** The text without its HTML tags. */
export function withoutTags(html: string): string {
  return removeAll(html, /<[^>]+>/g);
}

/** The text without its HTML comments, such as the hints in a template. */
export function withoutComments(text: string): string {
  return removeAll(text, /<!--[\s\S]*?-->/g);
}

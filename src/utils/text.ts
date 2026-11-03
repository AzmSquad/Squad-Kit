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

/** The text without its HTML tags. */
export function withoutTags(html: string): string {
  return removeAll(html, /<[^>]+>/g);
}

/** The text without its HTML comments, such as the hints in a template. */
export function withoutComments(text: string): string {
  return removeAll(text, /<!--[\s\S]*?-->/g);
}

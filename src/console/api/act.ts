import type { Context } from 'hono';
import { fileTroubleWords, isDiskTrouble } from '../../core/file-trouble.js';
import { plainWords, wordsForPeople } from '../../core/for-people.js';

/**
 * Runs what a button asks. A person-facing reason comes back as a 400 with its words. Anything else comes back as a 500
 * with one plain sentence, for the toast's Try again and Report a problem, and its exact words go to the app log.
 */
export async function act(c: Context, fn: () => unknown) {
  try {
    return c.json(((await fn()) as object) ?? { ok: true });
  } catch (err) {
    if (isDiskTrouble(err)) return c.json({ error: fileTroubleWords(err) }, 400);
    const said = plainWords(err, `${c.req.method} ${new URL(c.req.url).pathname} failed`);
    return c.json({ error: said }, wordsForPeople(err) === null ? 500 : 400);
  }
}

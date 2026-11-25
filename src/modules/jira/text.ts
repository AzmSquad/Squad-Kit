import { adfToMarkdown } from './adf-read.js';
import type { SiteFields } from './context.js';
import type { RawIssue } from './rows.js';

/** An issue's text as the squad reads it: its description, and its "done when" from its own field or from the text. */

const CRITERIA = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)?(?:done when|acceptance criteria)(?:\*\*)?:?(?:\*\*)?[ \t]*$/im;

/** A description with its "done when" part apart, for a project whose stories keep it in the text. */
export function splitCriteria(text: string): { description: string; acceptance: string } {
  const at = CRITERIA.exec(text);
  return at ? { description: text.slice(0, at.index).trim(), acceptance: text.slice(at.index + at[0].length).trim() } : { description: text, acceptance: '' };
}

/** The description and the criteria of an issue read with its description and the site's criteria field. */
export function issueText(issue: RawIssue, fields: SiteFields): { description: string; acceptance: string } {
  const description = adfToMarkdown(issue.fields.description);
  const criteria = fields.criteria ? adfToMarkdown(issue.fields[fields.criteria.id]) : '';
  return criteria ? { description, acceptance: criteria } : splitCriteria(description);
}

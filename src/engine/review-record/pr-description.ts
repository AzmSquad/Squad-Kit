import { NO_NEW_TESTS_LABEL, type Ticket } from '../../board/types.js';
import { KIND_NAMES } from '../../board/proof-lock.js';
import { plainMarkdown as plain } from '../../core/safe-markdown.js';
import { criterionText } from '../proof-verdict.js';
import { commitWords, countWords, reviewView, type ReviewView } from './view.js';
import { approvalWords, oneLine, reasonWords } from './words.js';

/**
 * The pull request's description: the full record of the story (ADR-007). Every word an agent or a person wrote goes
 * in as plain text (core/safe-markdown.ts): no link, picture or mention of theirs can reach the page. What was asked, each "done when" with how it
 * is proved and a link to its proof, the review in short with the notes the person went past and why, the checks, and
 * who pressed Looks right. Each note is a thread of its own on its file (write.ts). The screenshots come last, as a code
 * host may cut a long description short.
 */

/** The ask can be a whole pasted text: its start is enough here, the story keeps the rest. */
const MOST_ASKED = 800;

function askedLines(t: Ticket): string[] {
  const asked = (t.story ?? t.ask ?? '').trim();
  return asked ? ['### What was asked', '', plain(asked, MOST_ASKED), ''] : [];
}

function doneWhenLines(t: Ticket, shots: { label: string; url: string }[]): string[] {
  if (!t.criteria?.length) return [];
  const lines = t.criteria.map((c, i) => {
    const kind = c.proof?.kind ? `\`${KIND_NAMES[c.proof.kind]}\` ` : '';
    const label = criterionText(t, i + 1);
    const shot = label ? shots.find((s) => s.label === label) : undefined;
    return `- [x] ${kind}**Given** ${plain(c.given)}, **when** ${plain(c.when)}, **then** ${plain(c.then)}${shot ? ` · [proof](${shot.url})` : ''}`;
  });
  return ['### Done when, with its proof', ...lines, ''];
}

/** The review in short. The notes the person went past are named with their reason; every note has its own thread. */
export function reviewLines(v: ReviewView): string[] {
  if (!v.rounds.length) return [];
  const lines = ['### The review', `- Rounds: **${v.rounds.length}**`, `- Notes: **${countWords(v)}**`, `- Builder changes after review: **${commitWords(v.fixes.length)}**${v.fixes.length ? ` (${v.fixes.join(', ')})` : ''}`, ''];
  const past = v.rounds.flatMap((r) => r.notes).filter((n) => n.state === 'past');
  if (past.length) {
    lines.push(`> **You went past ${past.length === 1 ? '1 note' : `${past.length} notes`}**`);
    for (const n of past) lines.push('>', `> "${plain(oneLine(n, 300))}"`, `> ${plain(reasonWords(n))}`);
    lines.push('');
  }
  return lines;
}

/** `rounds`: the review's rounds on the record, which go on counting when a story comes back to review. */
function checksLines(t: Ticket, rounds: number): string[] {
  const g = t.gates;
  if (!g) return [];
  const lines = ['### Checks'];
  lines.push(`- Tests, lint and build: ${g.checks === 'pass' ? 'pass' : g.checks === 'skipped' ? 'failed, continued anyway' : g.checks === 'unchecked' ? 'not checked, no tests ran' : g.checks}${g.checksText ? ` (${plain(g.checksText)})` : ''}`);
  // Old tests that fail on main too, without this change: named, with the story that fixes them.
  for (const o of g.oldFailures ?? []) lines.push(`  - Fails on main too, without this change: ${plain(o.title)} (${plain(o.file)})${o.story ? `; ${o.story} fixes it` : ''}`);
  lines.push(`- Code review: ${g.review === 'pass' ? 'approved' : g.review === 'skipped' ? 'notes still open, continued anyway' : g.review}${rounds ? ` after ${rounds} round${rounds > 1 ? 's' : ''}` : ''}`);
  lines.push(`- Proof: ${g.proof === 'pass' ? `checked by ${t.createdBy}` : g.proof === 'skipped' ? 'no screenshots, continued anyway' : g.proof}`);
  // The person chose it on the new story form: the project's own checks ran, and the story added no tests.
  if (t.noNewTests) lines.push(`- ${NO_NEW_TESTS_LABEL}: the project's own checks ran, and this story added no tests`);
  lines.push('');
  return lines;
}

function continuedLines(t: Ticket): string[] {
  if (!t.overrides?.length) return [];
  const what = (o: NonNullable<Ticket['overrides']>[number]) =>
    o.added ? `Without your team's check "${o.added}"` : o.weakened?.length ? 'Weakened tests' : o.gate === 'hooks' ? "Saved without the project's own check" : o.gate === 'checks' ? 'Failed checks' : o.gate === 'proof' ? 'No screenshots' : 'Open review notes';
  return ['### Continued anyway', ...t.overrides.map((o) => `- **${what(o)}**, by ${plain(o.by)}: ${plain(o.reason)}`), ''];
}

export function prDescription(t: Ticket, item: string | null, shots: { label: string; url: string }[]): string {
  const view = reviewView(t);
  const lines = [...askedLines(t), ...(item ? [`Work item: #${item}`, ''] : []), ...doneWhenLines(t, shots), ...reviewLines(view), ...checksLines(t, view.rounds.length || (t.reviewRound ?? 0)), ...continuedLines(t)];
  if (view.looksRight) lines.push(approvalWords(view.looksRight, true), '');
  if (shots.length) {
    lines.push('### Screenshots');
    for (const s of shots) lines.push(`**${plain(s.label)}**`, '', `![${plain(s.label)}](${s.url})`, '');
  }
  lines.push(`Ticket ${t.id} on the squad-kit board.`);
  return lines.join('\n');
}

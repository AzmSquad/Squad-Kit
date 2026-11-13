import { PROOF_KINDS } from './proof-lock.js';
import type { CriterionProof, ProofKind } from './proof-kind.js';
import type { ProofPicture, ProofShot, TestProof } from './proof-rows.js';
import { block, dec, enc, escText, sections } from './docs.js';

/**
 * The proof in the project's files (ADR-001): each row of a ticket's proof.md with its pictures, its verdict, its kind,
 * its test and what the Reviewer checked; and the line under each "done when" in spec.md that says how it is proved.
 * The rest of a ticket's documents are in board/docs.ts.
 */

/** The line under a "done when" in spec.md: "Proof: data. Nothing new on a screen." or "Proof: screen, locked. …". */
export function proofLine(p: CriterionProof | undefined): string {
  if (!p) return '';
  return `\n   Proof: ${p.kind}${p.locked ? ', locked' : ''}${p.why ? `. ${p.why.replace(/\s+/g, ' ').trim()}` : ''}`;
}

const LINE = /\nProof: (screen|api|data|test|none)(, locked)?(?:\. (.*))?$/;

/** A "done when" as read from spec.md: its own words, and its proof when the line under it says one. */
export function splitProofLine(text: string): { words: string; proof?: CriterionProof } {
  const m = text.match(LINE);
  if (!m) return { words: text };
  const proof: CriterionProof = { kind: m[1] as ProofKind, ...(m[3]?.trim() ? { why: m[3].trim() } : {}), ...(m[2] ? { locked: true } : {}) };
  return { words: text.slice(0, m.index), proof };
}

/** The lines a proof row adds in proof.md. */
export function rowLines(p: ProofShot): string[] {
  return [...(p.kind ? [`- Kind: ${p.kind}`] : []), ...(p.test ? [`- Test: ${JSON.stringify(p.test)}`] : []), ...(p.checked ? [`- Checked: ${JSON.stringify(p.checked)}`] : [])];
}

/** Reads one of those lines into the row. False when the line is not one. */
export function readRowLine(row: ProofShot, line: string): boolean {
  const m = line.match(/^- (Kind|Test|Checked): (.+)$/);
  if (!m) return false;
  try {
    if (m[1] === 'Kind') {
      const kind = PROOF_KINDS.find((k) => k === m[2]!.trim());
      if (kind) row.kind = kind;
    } else if (m[1] === 'Test') row.test = JSON.parse(m[2]!) as TestProof;
    else row.checked = JSON.parse(m[2]!) as string;
  } catch {
    // A hand edit broke it: the row is read without it.
  }
  return true;
}

export function proofDoc(title: string, shots: ProofShot[]): string {
  return `${[
    `# ${enc(title)}: proof`,
    ...shots.map((p) =>
      [
        `### ${enc(p.criterion)}`,
        '',
        `- Before: ${enc(p.before)} (${enc(p.beforeLabel)})`,
        `- After: ${enc(p.after)} (${enc(p.afterLabel)})`,
        // Where the after picture was taken: the page to look at in the app.
        ...(p.page ? [`- Page: ${enc(p.page)}`] : []),
        // The device each picture was taken on, for a phone app: "iPhone 16 Pro", "Web version".
        ...(p.device ? [`- Device: ${enc(p.device)}`] : []),
        ...(p.beforeDevice ? [`- Before device: ${enc(p.beforeDevice)}`] : []),
        // What the picture shows: the "done when" met, or not yet and why.
        ...(p.shows ? [`- Shows: ${SHOWS_WORDS[p.shows]}`] : []),
        ...(p.why ? [`- Why: ${enc(p.why)}`] : []),
        ...rowLines(p),
        // The other pictures of this "done when", each with its own page and note.
        ...(p.more ?? []).flatMap((m) => [`- More: ${enc(m.after)}`, ...(m.page ? [`  - Page: ${enc(m.page)}`] : []), ...(m.device ? [`  - Device: ${enc(m.device)}`] : []), ...(m.note ? [`  - Note: ${enc(m.note)}`] : [])]),
        ...(p.note !== undefined ? ['', escText(p.note)] : []),
      ].join('\n'),
    ),
  ].join('\n\n')}\n`;
}

/** What a proof row's "Shows:" line says. */
const SHOWS_WORDS: Record<NonNullable<ProofShot['shows']>, string> = { met: 'met', broken: 'not working', 'not-shown': 'not shown', 'off-screen': 'not on a screen' };

export function parseProof(text: string): ProofShot[] {
  return sections(text, /^### (.*)$/).map((s) => {
    const shot: ProofShot = { criterion: dec(s.match[1]!), before: '', after: '', beforeLabel: '', afterLabel: '' };
    const rest: string[] = [];
    let said = '';
    let more: ProofPicture | null = null;
    for (const line of s.text.split('\n')) {
      const m = line.match(/^- (Before|After): (.*) \((.*)\)$/);
      const also = line.match(/^- More: (.+)$/);
      const of = more && line.match(/^ {2}- (Page|Note|Device): (.+)$/);
      // A picture's page and note come right under it; anything else ends it.
      if (!also && !of) more = null;
      if (also) (shot.more ??= []).push((more = { after: dec(also[1]!) }));
      else if (of) more![of[1] === 'Page' ? 'page' : of[1] === 'Device' ? 'device' : 'note'] = dec(of[2]!);
      else if (m && m[1] === 'Before') [shot.before, shot.beforeLabel] = [dec(m[2]!), dec(m[3]!)];
      else if (m && m[1] === 'After') [shot.after, shot.afterLabel] = [dec(m[2]!), dec(m[3]!)];
      else if (/^- Page: \S/.test(line) && !shot.page) shot.page = dec(line.slice('- Page: '.length));
      else if (/^- Device: \S/.test(line) && !shot.device) shot.device = dec(line.slice('- Device: '.length));
      else if (/^- Before device: \S/.test(line) && !shot.beforeDevice) shot.beforeDevice = dec(line.slice('- Before device: '.length));
      else if (/^- Shows: /.test(line) && !shot.shows) said = line.slice('- Shows: '.length).trim();
      else if (/^- Why: \S/.test(line) && !shot.why) shot.why = dec(line.slice('- Why: '.length));
      else if (!readRowLine(shot, line)) rest.push(line);
    }
    const shows = showsOf(said, shot.why);
    if (shows) shot.shows = shows;
    const note = block(rest.join('\n'));
    if (note || rest.some((l) => l.trim())) shot.note = note;
    return shot;
  });
}

/**
 * A row's verdict from its line. "not met" is from before the three verdicts, when a picture that did not show it
 * clearly counted as not met too: its reason tells them apart.
 */
function showsOf(said: string, why: string | undefined): ProofShot['shows'] {
  if (said === 'not met') return why && /^(The screenshot does not show clearly|No screenshot shows it)/.test(why) ? 'not-shown' : 'broken';
  return (Object.keys(SHOWS_WORDS) as NonNullable<ProofShot['shows']>[]).find((k) => SHOWS_WORDS[k] === said);
}

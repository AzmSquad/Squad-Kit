import { KIND_NAMES, PROOF_KINDS } from '../../board/proof-lock.js';
import { hasKinds } from '../../board/proof-rows.js';
import type { BoardMeta, Ticket } from '../../board/types.js';
import { hasAppToStart } from '../../board/apps.js';
import { criterionText } from '../proof-verdict.js';
import { MAX_ROWS } from './rows.js';
import { kindOf, linesOf, testerLines } from './lines.js';

/**
 * The words the agents get about the proof kinds. They show read only on the Harness page, so they stay plain. The
 * core prompts (engine/prompts.ts) take them in at one place each.
 */

const STR = { type: 'string' } as const;

/** The proof an agent proposes for one "done when": in the spec, the Express plan and a change. */
export const PROOF_SHAPE = {
  type: 'object',
  properties: { kind: { type: 'string', enum: PROOF_KINDS }, why: STR },
  required: ['kind'],
} as const;

/** For the Analyst's spec and the Express plan: how each "done when" will be proved. */
const KINDS_ASK = `- proof, for each "done when": how the person will see it is done, and why in one plain line.
  kind is one of:
  screen: pictures before and after, for what someone sees on a page.
  data: rows of the story's own database before and after, for what is saved and shows on no page.
  api: the call and its answer, for what other apps or parts call.
  test: a test that fails before the change and passes after it, for a rule, a timer or a background job.
  none: only for what truly has nothing to show (speed, a clean-up, something never saved), with the reason the
  Reviewer will check.
  Pick the lightest proof that truly shows the line: a picture only where someone sees a change. A line about what
  someone sees is always screen. why: one short plain line for a project manager, like "Other apps will call this, so
  the answer itself is the proof." It may be empty for screen.`;

/** The same for a project with no app to start (board/apps.ts hasAppToStart): only a test, or nothing to show. */
const NO_APP_ASK = `- proof, for each "done when": how the person will see it is done, and why in one plain line. This project has no
  app to start (a command-line tool or a library), so nothing can be shown on a screen, called or read. kind is test (a
  test that fails before the change and passes after it) or none (only for what truly has nothing to show, with the
  reason the Reviewer will check). why: one short plain line for a project manager.`;

/** What the spec and the Express plan ask about the proof: with no app to start, only a test or nothing to show. */
export function kindsAsk(meta?: BoardMeta): string {
  return meta && !hasAppToStart(meta) ? NO_APP_ASK : KINDS_ASK;
}

/** On a rewrite of the spec: the kinds as the person left them, to keep unless the change asks otherwise. */
export function proofsNow(t: Pick<Ticket, 'criteria'>): string {
  if (!hasKinds(t)) return '';
  const lines = (t.criteria ?? []).map((c, i) => `${i + 1}. ${KIND_NAMES[c.proof?.kind ?? 'screen']}${c.proof?.locked ? ' (squad-kit keeps this one)' : ''}`);
  return `\nHow each "done when" is proved now, as the person left it. Keep each unless the change asks otherwise:\n${lines.join('\n')}`;
}

/** For a change written into an approved spec: a changed or new line may say how it is proved. */
export const CHANGE_KINDS = `  proof: only when the change asks how a "done when" is proved, or for a new one: kind (screen, data, api, test or
  none) and why. A line about what someone sees stays screen.`;

/** Before the change, pictures only of the Screen lines: the others are proved another way. */
export function beforeKinds(t: Ticket): string {
  if (!hasKinds(t)) return '';
  const screens = linesOf(t, ['screen']);
  return `\nOnly ${screens.length === 1 ? `"done when" ${screens[0]} is` : `"done when" ${screens.join(', ')} are`} proved with pictures. Take before pictures of ${screens.length === 1 ? 'it' : 'those'} only, and leave the others out of shots.\n`;
}

/** The Tester's list: each "done when" with its kind, and which ones it proves itself. */
export function kindsForTester(t: Ticket, apiParts: string[]): string {
  if (!hasKinds(t)) return '';
  const all = Array.from({ length: (t.criteria?.length ?? 0) + (t.notes ?? []).filter((n) => n.kind === 'criterion').length }, (_, i) => i + 1);
  const mine = testerLines(t);
  const left = all.filter((n) => !mine.includes(n));
  const list = all.map((n) => `${n}. ${KIND_NAMES[kindOf(t, n) ?? 'screen']}`).join('\n');
  const has = (k: 'screen' | 'api' | 'data') => linesOf(t, [k]).length > 0;
  return `

How each "done when" is proved, as the person approved it:
${list}
Prove only ${mine.join(', ')}.${left.length ? ` Leave out ${left.join(', ')}: squad-kit proves a Test line by running its test, and the Reviewer checks a Not on a screen line. They are in neither shots nor offScreen.` : ''}
${has('screen') ? `- Screen: pictures, as above. A planned picture is never dropped quietly: if you truly cannot take it, put it in
  offScreen with why, and squad-kit asks the person.
` : ''}${has('api') ? `- API call: call ask_api${apiParts.length ? ` with part (${apiParts.join(', ')})` : ''}, path, and method and body when it needs them, and name the
  saved file in shots. This line needs no picture.
` : ''}${has('data') ? `- Data: call read_rows with when "before" BEFORE you do the action, then do the action (with ask_api, or with the
  steps of take_screenshots when a page does it), then call read_rows again with the same table and where, with when
  "after". It reads at most ${MAX_ROWS} rows, read only. Name the rows file in shots, with shows judged by what changed,
  and a note for a project manager like "Booking 1042 changed from waiting to paid, with its amount." Never quote secret
  values. This line needs no picture.
` : ''}`;
}

/** The Tester's brief when no line is Screen: no browser and no pictures, only the API and the rows. */
export function noPicturesPrompt(t: Ticket, criteria: string, apiParts: string[], tail: string): string {
  return `You are the Tester of a software squad. This story changes nothing anyone sees on a page, so no picture is
taken. Prove each "done when" below with squad-kit's own tools; your shell only reads.

Done when:
${criteria}

The app runs headless; squad-kit started it and stops it. Read the code first for the addresses, the tables and the
test sign-ins or sample data in the project's own seed, fixture or example files. Use only those, never a real
person's details.${kindsForTester(t, apiParts)}
In shots, one entry per saved file: criterion (its number), file (a file from the list the tools give you, saved in
this step), shows ("met" when it shows the "done when" works as written, "broken" when it shows it does not, with what
is wrong, "not-shown" when you could not get it) and note (one plain sentence for the person).
offScreen: a line above you cannot prove at all, with why in plain words. squad-kit then asks the person.
start_app, stop_app and app_status: the app, should it stop. i_am_stuck: anything technical in your way.
Never wait for the clock. Never ask the person anything technical. Do not change project files.${tail}`;
}

/** The answer of the Tester's short run that names the test for each Test line. */
export const TESTS_SCHEMA = {
  type: 'object',
  properties: {
    tests: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: { criterion: { type: 'integer' }, file: STR, name: STR, line: { type: 'integer' }, steps: { type: 'array', minItems: 1, maxItems: 6, items: STR } },
        required: ['criterion', 'file', 'name', 'steps'],
      },
    },
  },
  required: ['tests'],
};

/** The Tester names the one test that proves each Test line, and says what it does in plain words. */
export function testsPrompt(t: Ticket, lines: number[]): string {
  return `You are the Tester of a software squad. These "done when" are proved by a test, not by a picture:
${lines.map((n) => `${n}. ${criterionText(t, n)}`).join('\n')}

For each, find the one test in this story's copy that proves it: one the Builder added or changed with this story (run
"git diff --stat ${t.baseCommit ?? 'main'}" and read those test files). A test from before the story is never the
proof. squad-kit then runs that one test on main's code and on the story's code. It must fail on main and pass now, or
it proves nothing.
In tests, one for each: criterion (its number), file (the test file's path in this copy, like tests/booking.test.ts),
name (the test's full name as the test tool prints it, its groups first, joined with " > ", like "Bookings > frees an
unpaid slot after 15 minutes"), line (the line the test starts on, for a browser test), and steps: what the test does,
in 2 to 5 short plain sentences for a project manager, like "Makes a booking at 10:00 and does not pay", "Moves the
clock to 10:16", "The 10:30 slot is free again". No code and no file names in the steps.
When no test proves one of them, leave it out: squad-kit then asks the Builder to write one.
Do not change any file. Never ask the person anything technical.`;
}

/** The answer's part where the Reviewer says what it checked for each Not on a screen line. */
export const NONE_CHECKS = {
  type: 'array',
  maxItems: 12,
  items: { type: 'object', properties: { criterion: { type: 'integer' }, checked: STR, holds: { type: 'boolean' } }, required: ['criterion', 'checked', 'holds'] },
} as const;

/** For the Reviewer: the lines with nothing to show, which its review is the proof of. */
export function noneForReviewer(t: Ticket): string {
  const lines = linesOf(t, ['none']);
  if (!lines.length) return '';
  return `
These "done when" have no picture, call, rows or test as their proof: the person approved "Not on a screen" for them,
with the reason below. Your review is their proof. Check each in the code, the tests, the database files and the logs,
and say in noneChecks: criterion (its number), checked (one or two plain sentences for a project manager: what you
checked and what you found, like "Checked the code, the bookings and payments tables and the logs: no card number is
written anywhere. Only the last 4 digits are kept."), and holds (true when it holds). One that does not hold is a real
problem: say it in notes too.
${lines.map((n) => `${n}. ${criterionText(t, n)} Reason: ${t.criteria?.[n - 1]?.proof?.why ?? ''}`).join('\n')}`;
}

/** For squad-kit's check of the proof, when it has rows: how to read them. */
export function rowsForCheck(files: (string | undefined)[]): string {
  if (!files.some((f) => f?.endsWith('.rows.json'))) return '';
  return `
A file ending in .rows.json is no picture: squad-kit read rows of the story's own database before and after the
Tester's action, read only, and saved both, with what changed under "changes". Read it, and judge the "done when" by the
rows after and what changed: met when they show it as written. A value shown as ••• is a secret squad-kit hides: never
fault it. Rows with no "before" show only the rows after.`;
}

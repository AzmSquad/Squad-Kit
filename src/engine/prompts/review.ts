import type { BoardMeta, Decision, Ticket } from '../../board/types.js';
import { reposOf } from '../repos.js';
import {
  asData,
  changesFile,
  decisionText,
  doneWhen,
  LOOK,
  NO_NEW_TESTS,
  projectContext,
  type PromptContext,
  stepsText,
  ticketContext,
} from './context.js';
import { askRule } from './rules.js';
import { notesAsk } from '../review-record/prompt.js';

/**
 * What squad-kit's own run of the project checks found. The Reviewer reads the result instead of running the checks:
 * its shell may not run them, and it must never report a check it could not run as a problem.
 */
function checksRan(t: Ticket, meta: BoardMeta, ctx?: PromptContext): string {
  const c = ctx?.repo?.commands ?? reposOf(meta)[0]?.commands ?? {};
  const ran = (['test', 'lint', 'build'] as const).filter((k) => c[k]?.trim()).map((k) => `${k}: ${c[k]!.trim()}`);
  const result = t.gates?.checksText?.trim();
  const each = t.gates?.ran?.length
    ? `\nEach check squad-kit ran:\n${t.gates.ran.map((r) => `- ${r.name === 'start' ? 'the app starts' : r.name} (${r.command}): ${r.ok ? 'passed' : 'failed'}${r.tests !== undefined ? `, ${r.tests} tests` : ''}${r.failedOnce ? '; it failed once first, and passed when run again' : ''}`).join('\n')}`
    : '';
  const weakened = (t.overrides ?? []).filter((o) => o.gate === 'checks' && o.weakened?.length);
  const old = t.gates?.oldFailures?.length
    ? `\nSome tests failed here that fail on main's code too, without this change, so they are not this story's: a story of their own fixes them. Do not ask for them here. ${asData('Their names', t.gates.oldFailures.map((o) => o.title).join('\n'))}`
    : '';
  const past = `${weakened.length
    ? `\nThe tests were made weaker in this change, and the person chose to go on anyway (${weakened.map((o) => o.reason).join('; ')}): ${weakened.flatMap((o) => o.weakened!).join(' ')} Look closely at whether the tests still check every "done when".`
    : ''}${old}`;
  if (t.gates?.checks === 'unchecked') {
    return `squad-kit ran the project checks on this copy, but no tests ran${result ? ` (${result})` : ''}, so nothing checked that the work does what it should. Do not run them yourself. Read the code with extra care against every "done when"${t.noNewTests ? '' : ', and say in a note if tests are missing'}.${each}${past}`;
  }
  if (!ran.length) {
    return `This project has no test, lint or build commands set up yet, so squad-kit had no checks to run. Do not try to run them yourself.${t.noNewTests ? '' : ' If the change needs tests and has none, say so in a note.'}`;
  }
  const how = `(${ran.join('; ')})`;
  if (t.gates?.checks === 'skipped') return `squad-kit ran the project checks on this copy ${how}, and they did not pass: ${result ?? 'some failed'}. The person chose to go on anyway. Do not run them yourself.${each}${past}`;
  if (t.gates?.checks === 'pass' && result) return `squad-kit already ran the project checks on this copy before your review ${how}, and they pass: ${result}. Do not run them yourself; take this result as given.${each}${past}`;
  return `squad-kit runs the project checks itself ${how}. Do not run them yourself.${each}${past}`;
}

/**
 * The Reviewer's brief. Every round gets the whole ticket, the check results and the whole change since the base, so
 * a later round never judges the fix alone (its conversation may also be a new one). `files` lists what changed.
 */
export function reviewPrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, round: number, ctx?: PromptContext, files: string[] = []): string {
  const criteria = doneWhen(t);
  // The plan as written, never the talk that made it: the Reviewer checks the change against the same page the Builder had.
  const steps = stepsText(t);
  const plan = steps ? `\n\nThe approved plan:\n${steps}` : '';
  const again = round > 1;
  const changed = files.length ? `\nFiles changed since ${t.baseCommit} (${files.length}): ${files.slice(0, 60).join(', ')}${files.length > 60 ? `, and ${files.length - 60} more` : ''}` : '';
  const asked = again && t.reviewAsked?.length ? `\nIn your last round you asked for:\n${t.reviewAsked.map((c) => `- ${c}`).join('\n')}\nThe Builder says these are fixed. Check each one in the code.` : '';
  const head = again
    ? `You are the Reviewer of a software squad. This is review round ${round}: the Builder changed the code after your last review. Do not edit files.`
    : 'You are the Reviewer of a software squad: a second pair of eyes on the Builder\'s work. Do not edit files.';
  const inFolders = ctx?.copies?.length ? ctx.copies.map((c) => changesFile(c.folder)).join(', ') : '';
  const look = inFolders
    ? `${again ? 'Review the whole change again, not only the fix. A fix can break something that was right before.' : 'Look at everything that changed in every part.'} squad-kit wrote what changed in each part to a file in this folder, so read each one: ${inFolders}. Each ends with the new files, which you read in the part's folder.`
    : again
    ? `Review the whole change again, not only the fix: run "git status" and "git diff ${t.baseCommit}", and read new files. A fix can break something that was right before.`
    : `Look at everything that changed since commit ${t.baseCommit}: run "git status" and "git diff ${t.baseCommit}", and read new files.`;
  return `${head}

${projectContext(meta, decisions, ctx)}

${ticketContext(t)}

Story: ${t.story}
Done when:
${criteria}${decisionText(t)}${plan}

${look}${changed}${asked}
${checksRan(t, meta, ctx)}
Check: does it do every "done when"? Does it follow ${steps ? 'the plan and ' : ''}the saved decisions? Real bugs, security holes${t.noNewTests ? `?
${NO_NEW_TESTS}, so do not ask for new tests.` : ', missing tests?'}
Were tests deleted, switched off or made weaker? That is a real problem unless the plan asks for it.
${notOnScreenRule(t)}
${again ? 'Approve when your notes are handled and nothing else is wrong.' : 'Approve unless there is a real problem.'} Small style notes do not block.
${notesAsk(t)}
alsoChanged: each thing this change touches that the story, its "done when" and the plan did not ask for, as a short
plain phrase for a project manager, like "the Services screen". Leave it out when there is none. It does not block
your approval by itself: squad-kit shows it to the person.${canLook(meta, ctx) ? `
To see a page of the app as it is now, call look_at_page, at the size you need (phone or desktop): squad-kit opens the
page in its own browser, starting this story's app when needed, and gives back what is on it. It saves no pictures.
Never start the app or a browser of your own.` : ''}
${askRule(t)}
${LOOK}`;
}

/**
 * A "done when" that ends as Not on a screen has no picture that proves it, or only of a part, so the code and the tests
 * are the only proof of the rest. Those the last round of screenshots could not show are named.
 */
function notOnScreenRule(t: Ticket): string {
  const known = [...(t.proof ?? []).filter((p) => p.shows === 'off-screen').map((p) => ({ criterion: p.criterion, why: p.why ?? '' })), ...(t.offScreen ?? [])];
  const named = [...new Map(known.map((o) => [o.criterion, o])).values()];
  const list = named.length ? `\nThe last screenshots could not show these:\n${named.map((o) => `- ${o.criterion}${o.why ? `: ${o.why}` : ''}`).join('\n')}` : '';
  const proof = t.noNewTests ? 'find the code that does it. A "Not on a screen" with no code is a real problem.' : 'find the code that does it and a test that covers it. A "Not on a screen" with no code, or with no test where one could be written, is a real problem.';
  return `A "done when" can end as "Not on a screen", when the app has no way to show it (an old record it cannot make, what happens after a restart, an email). The screenshots do not prove those, so check them here: ${proof}${list}`;
}

/** The project can start its app, so the Reviewer can look at its pages through squad-kit. */
function canLook(meta: BoardMeta, ctx?: PromptContext): boolean {
  const c = ctx?.repo?.commands ?? meta.commands ?? {};
  return Boolean(c.start?.trim() && c.url?.trim());
}

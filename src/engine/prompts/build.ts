import type { BoardMeta, Decision, Ticket } from '../../board/types.js';
import { reposOf } from '../repos.js';
import {
  asData,
  decisionText,
  doneWhen,
  NO_NEW_TESTS,
  projectContext,
  type PromptContext,
  STEP_LINE,
  stepsText,
  ticketContext,
} from './context.js';
import { askRule } from './rules.js';

export function buildPrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, ctx?: PromptContext): string {
  const steps = stepsText(t);
  const criteria = doneWhen(t);
  const decision = decisionText(t);
  return `You are the Builder of a software squad. Build the approved plan below in this folder.

${projectContext(meta, decisions, ctx)}

${ticketContext(t)}

Story: ${t.story}
Done when:
${criteria}${decision}${dependencyText(t)}${setupTroubleText(t)}

Steps:
${steps}

Rules:
- ${STEP_LINE}
- Follow the saved decisions and the project's existing style.
- ${t.noNewTests ? `${NO_NEW_TESTS}: write no new tests. Run the tests the project already has before you finish, so
  nothing that worked before breaks.` : 'Write tests that check every "done when", and run the tests before you finish.'} A browser cannot start in your shell:
  run tests that open a browser with squad-kit's run_checks tool, never yourself.
- Never commit, push, switch branches, or change files outside this folder.
- Wait for every command to finish (installs too). Never leave anything running in the background; this step ends when you answer.
- If the plan does not cover a small choice, take the simplest one and say so in notes.${t.setsUp ? `\n- ${MADE_BY_ITS_TOOL}` : ''}${builtWithXcode(meta) ? `\n- ${XCODE_IS_SQUAD_KITS}` : ''}
${askRule(t)}`;
}

/** The first story makes the app: with its tool's own create command, never by hand. */
export const MADE_BY_ITS_TOOL = "Make a new app with its tool's own create command, as the plan says (like flutter create or create-expo-app), never by writing its files yourself.";

/** A native iPhone app: Xcode runs only outside squad-kit's guard (outsideTheGuard in engine/checks.ts), so never in the Builder's shell. */
export const XCODE_IS_SQUAD_KITS = "This is a native iPhone app: never run xcodebuild yourself, as Xcode can't start in your shell. squad-kit runs the iPhone build and tests after your step and shows you the result.";

/** True when the project builds with Xcode: one of its saved commands is xcodebuild. */
function builtWithXcode(meta: BoardMeta): boolean {
  return reposOf(meta).some((r) => Object.values(r.commands).some((c) => typeof c === 'string' && /^\s*xcodebuild\s/.test(c)));
}

export function setupTroubleText(t: Ticket): string {
  const s = t.setupTrouble;
  if (!s) return '';
  return `\n\nsquad-kit ran the project's setup command in this copy, \`${s.command}\`, and it failed, so the copy does not work yet. Sort this out before the steps, without asking the person. Fix it in the project, so that the same command works in a clean copy on any computer: a package that cannot be built here gets replaced by one that installs with no compiler, and you say so in notes. A setting only in your own shell is not a fix.\n${asData('What the command printed', s.output)}`;
}

/** A ticket that depends on unmerged work: what is in this copy and what is not, so the Builder never has to guess. */
export function dependencyText(t: Ticket): string {
  const c = t.dependency;
  if (!c?.on.length) return '';
  const on = c.on.join(' and ');
  if (c.way === 'branch' && !c.caughtUp) {
    return `\n\nThis ticket depends on ${on}, which is not merged into the main branch yet. squad-kit started this copy from ${on}'s branch, so its work so far is here. Build on it. Change ${on}'s part only where this plan needs it; squad-kit brings in the main branch once ${on} is merged.`;
  }
  if (c.way === 'anyway') {
    return `\n\nThis ticket depends on ${on}, which is not merged yet, so its code is not in this copy. The person chose to build without it: do not wait for it and do not ask about it. Build what this plan needs on the code that is here, and keep it easy to join with ${on} later.`;
  }
  return `\n\nThis ticket depends on ${on}. It is merged now, so its code is in this copy.`;
}

/** The person's answer to a question an agent asked mid-work. It goes back into the same conversation. */
export function answerPrompt(q: { text: string; answer?: string }, role: 'architect' | 'builder' | 'reviewer'): string {
  const next =
    role === 'builder'
      ? 'Carry on with the work from where you stopped, then run the tests.'
      : role === 'architect'
        ? 'Now write the design with this answer.'
        : 'Finish your review with this in mind.';
  return `You asked: "${q.text}"\nThe person answered: "${q.answer ?? ''}"\n\n${next}`;
}

/** Every fix of the Builder's: what is broken in the product, nothing for a picture's sake. */
export const FIX_ONLY_BROKEN = 'Fix only what is broken in the product. Never change the product just to make a picture clearer.';

export function fixChecksPrompt(failures: { name: string; command: string; output: string }[], known: { name: string; command: string; output?: string }[] = [], onMain: { passes?: string[]; fails?: string[] } = {}): string {
  const text = failures.map((f) => `"${f.name}" (${f.command}) failed. ${asData('Its output', f.output)}`).join('\n\n');
  const before = known.length
    ? `\n\nThese checks already failed before this story started: ${known.map((k) => `${k.name} (${k.command})`).join(', ')}. Fix what this story broke. Do not change other screens or rules to make an old failure pass, unless the plan asks.${known
        .filter((k) => k.output)
        .map((k) => `\n${asData(`What "${k.name}" printed then`, k.output!)}`)
        .join('')}`
    : '';
  // What squad-kit found when it ran the failed tests on their own on main's code (engine/old-tests.ts).
  const passes = onMain.passes?.length
    ? `\n\nsquad-kit ran the failed tests on their own on main's code, without this story's change. These pass there every time, so this story's change probably broke them: fix the code, not the tests. ${asData('Their names', onMain.passes.join('\n'))}`
    : '';
  const fails = onMain.fails?.length
    ? `\n\nThese failed tests fail on main's code too, without this story's change. They are not this story's, and a story of their own fixes them, so leave them as they are. ${asData('Their names', onMain.fails.join('\n'))}`
    : '';
  return `squad-kit ran the project checks and some failed.

${text}${before}${passes}${fails}

Print ">> fix" first. Fix the cause in the code. Do not delete or weaken tests to make them pass. ${FIX_ONLY_BROKEN} While you fix a failing test, run only that test: run_checks with "only" and its file. squad-kit runs all the checks again when you finish.`;
}

/** "Send it back to the Builder" after the tests were made weaker: it puts them back, then the checks run again. */
export function weakenedFixPrompt(points: string[]): string {
  return `squad-kit compared your work with the code it started from and the tests were made weaker, so passing them would prove little:
${points.map((p) => `- ${p}`).join('\n')}

Print ">> fix" first. Put back every test, test script and test setting you removed, switched off or changed, unless the
plan says to change it. Make the code pass the tests as they were, then run the tests again. Never weaken a test to make it pass.`;
}

export function reviewFixPrompt(comments: string[]): string {
  return `The Reviewer asked for these changes:\n${comments.map((c) => `- ${c}`).join('\n')}\n\nPrint ">> fix" first, then make the changes and run the tests again. ${FIX_ONLY_BROKEN}`;
}

export function clashPrompt(base: string, files: string[]): string {
  return `Someone changed the same lines in ${base} since this ticket started. squad-kit has merged ${base} into this folder, and these files have clash markers (<<<<<<<, =======, >>>>>>>):\n${files.map((f) => `- ${f}`).join('\n')}\n\nPrint ">> clash" first. In each file, keep both changes working together and remove every marker. Do not run git commands; squad-kit saves the merge. Then run the tests again.`;
}

export function changeFixPrompt(note: string): string {
  return `The person checked the result and said: "${note}"\n\nPrint ">> fix" first, then fix it and run the tests again.`;
}

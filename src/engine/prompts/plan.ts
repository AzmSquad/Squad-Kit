import { DECISION_AREAS, type BoardMeta, type Ticket } from '../../board/types.js';
import { partsOf } from '../../board/parts.js';
import { reposOf } from '../repos.js';
import {
  EXPO_CREATE,
  EXPO_WEB_PORT,
  EXPO_WEB_START,
  FLUTTER_COMMANDS,
  FLUTTER_CREATE,
  FLUTTER_WEB_PORT,
  flutterWebStart,
} from '../find-commands.js';
import {
  answersText,
  doneWhen,
  EXAMPLES_FIT,
  NO_NEW_TESTS,
  type OpenTicket,
  openTicketsText,
  PLAIN,
  theirLanguage,
} from './context.js';
import { askRule, offLimitsText } from './rules.js';

/** On a workspace, the Architect says which parts of the product a story changes. It is one story and one approval. */
function partsRule(meta?: BoardMeta): string {
  if (!meta?.repos?.length) return '';
  const list = partsOf(meta).filter((p) => !p.shared && !p.off);
  return `\n- parts: the ids of the parts of the product this story changes, in the order to build them: what the others rely on first, so the API before the web app. Only what must change. The parts:\n${list.map((p) => `  - ${p.id}: ${p.name}${p.needs.length ? ` (needs ${p.needs.join(', ')})` : ''}${p.noRun ? ' (nothing starts here by itself, and a story can still change it)' : ''}`).join('\n')}${offLimitsText(meta)}`;
}

export function planPrompt(t: Ticket, change?: string, meta?: BoardMeta, others?: OpenTicket[]): string {
  const repo = partsRule(meta);
  const head = change
    ? `The person read your plan.\n${changeText(change)}\n\nWrite the whole plan again with this.`
    : t.track === 'express'
      ? 'This ticket is on the Express track: a small change the person wants done fast, with no questions. Write a short plan, as the Architect and the Spec writer. Where something is unclear, take the simplest choice that fits and say it in the story. Keep it small: few steps, no new technical decisions unless needed.'
      : `The person answered your questions:\n${answersText(t)}\n\nNow write the plan, as the Architect and the Spec writer.`;
  return `${head}

- story: "As a <who>, I want <what>, so <why>."
- criteria: 2 to 5 "done when" checks in Given / When / Then form. Each must be testable. ${EXAMPLES_FIT}
- decision: only if this ticket makes a technical choice later tickets must follow. Give 2 options you considered,
  mark the chosen one, and say why in plain words tied to the person's answers. If the client forces a technology,
  check it against the business needs and write the result in clientCheck ("no conflict" or the conflict).${firstTechnology(meta, t)}
${DECISION_LINKS}
${DEPENDS_RULE}
${stepsAndTests(t)}
  asks: how many "done when" no page shows, but asking the running API would (0 when none).
- releaseNote: one line for release notes, like "**Dark mode.** Switch the dashboard to dark."
- commands: only if the project has no way yet to set up, test, build or start it, or this ticket changes that.
  For a new project, choose simple, common tools and give every command, including start and url.${repo}${testLine(t, meta)}${openTicketsText(others, 'architect')}
${PLAIN}${theirLanguage(t)}`;
}

const NO_CODE_WORDS = `\n  This project has no code yet, so this ticket picks its technology. Choose it yourself, simple and common, and never ask the person: make it the decision (the language, the framework and where the data is kept), so engineers can see it. The person may have no developer tools, so pick what installs with no compiler: no package that builds native code, and where the language has a built-in way to keep data, like node:sqlite in Node 22, use that.`;

/** squad-kit's own first story: a first version every other story builds on (board/first-story.ts). */
const SET_UP_WORDS = `\n  This story sets up the product, and every other story waits for it. The whole document says what the product must do, so pick tools that fit all of it, and build none of its features now: only a first version that starts, with its tests. All the code stays in this one repo. One part is best, as most products are one program. Only when the document clearly needs parts that run by themselves, like a web app and an API, does each get its own folder. Then a package.json in the top folder holds the scripts dev, test and build, whatever the parts are written in, and each works from there for all of them, and installing in the top folder installs them all, because squad-kit looks for them there. Write in the README.md the full address a person opens, like http://localhost:5173.`;

/**
 * A phone app from a document: Flutter, one code base for iPhone, Android and the web, unless React Native is asked for.
 * Made by its own tool, never written by hand, with the commands squad-kit finds in it later (engine/find-commands.ts).
 * Read when a prompt is made, as those commands live in another module.
 */
export function phoneAppWords(): string {
  return `\n  When the document or the ticket asks for a phone app, one people install on an iPhone or an Android phone, make it a Flutter app: one code base for iPhone, Android and the web. Make it React Native with Expo only when the document or the team asks for React Native. A phone app needs its phone's own tools, so the rule above on a compiler is not for it. Make the project with its tool's own create command in one step of the plan, never by writing its files yourself: for Flutter \`${FLUTTER_CREATE}\` in this folder, where <org> is the client's web address backwards, like com.acme (com.example when the document names none), and <name> the product's name in small letters with underscores, like visitor_log; for Expo \`${EXPO_CREATE}\`, then move everything in that new folder to the top of this folder. A Flutter app's commands: setup "${FLUTTER_COMMANDS.setup}", lint "${FLUTTER_COMMANDS.lint}", test "${FLUTTER_COMMANDS.test}", start "${flutterWebStart()}" and url "http://localhost:${FLUTTER_WEB_PORT}". An Expo app's: setup "npm install", test "npm test" (its Jest tests), start "${EXPO_WEB_START}" and url "http://localhost:${EXPO_WEB_PORT}". The web version is how squad-kit shows the app when this computer has no iPhone simulator. squad-kit's Tools page then shows the person what this computer needs for the app, like Flutter and Xcode, so never pick another technology because a tool seems missing here.`;
}

/** A project with no code: the Architect picks the technology itself now, and it is saved as a decision engineers can see. */
function firstTechnology(meta?: BoardMeta, t?: Ticket): string {
  if (t?.setsUp) return `${NO_CODE_WORDS}${phoneAppWords()}${SET_UP_WORDS}`;
  return meta?.scan?.empty ? `${NO_CODE_WORDS}${phoneAppWords()}` : '';
}

/** The plan's steps, and the tests it adds: none when the person chose to build it without new tests. */
function stepsAndTests(t: Ticket): string {
  const steps = t.noNewTests ? `${NO_NEW_TESTS}, so no step writes tests.` : 'The last step writes the tests.';
  const tests = t.noNewTests ? '0, as this story adds no tests.' : 'how many tests you expect to add.';
  return `- steps: 3 to 7 small steps in order, one sentence each. ${steps}
- tests: ${tests} screens: how many "done when" can be shown in a screenshot (0 without a UI).`;
}

/**
 * A project with no test command: the Architect suggests one with the design. squad-kit does not use it on its own;
 * the person approves it when the checks find no tests. Not on a story built without new tests: it would have none to run.
 */
function testLine(t: Ticket, meta?: BoardMeta): string {
  if (!meta || t.noNewTests) return '';
  const repos = reposOf(meta);
  const repo = repos.find((r) => r.path === t.repo);
  if (repo ? repo.commands.test?.trim() : repos.some((r) => r.commands.test?.trim())) return '';
  return `
- commands.test: this project has no test command yet, so squad-kit cannot check that the work does what it should.
  Suggest the one command that runs the project's tests, the tests this ticket adds included (like "npm test" or
  "pytest"), with common tools the project already uses where it can. The person approves it before squad-kit runs it.`;
}

/** A one-line change is quoted; a review (comments, edits) or a new direction is passed as it is. */
function changeText(change: string): string {
  return change.includes('\n') ? change : `They asked for this change: "${change}"`;
}

export function specPrompt(t: Ticket, change?: string, fromChat = false, others?: OpenTicket[]): string {
  const head = fromChat
    ? `You and the person talked it through in this conversation. Now write the spec from everything you agreed${t.story ? ', the whole spec again' : ''}. Where the talk changed something, follow the talk. Write what to build and how we know it is done, not how to build it.`
    : change
    ? `The person read your spec.\n${changeText(change)}\n\nWrite the whole spec again with this.`
    : `The person answered your questions:\n${answersText(t)}\n\nNow write the spec, as the Analyst: what to build and how we know it is done. Not how to build it; the Architect designs that next, after the person approves this.`;
  return `${head}

- story: "As a <who>, I want <what>, so <why>."
- criteria: 2 to 5 "done when" checks in Given / When / Then form. Each must be testable, in the person's words.
  ${EXAMPLES_FIT}
- releaseNote: one line for release notes, like "**Dark mode.** Switch the dashboard to dark."${openTicketsText(others, 'analyst')}
${PLAIN}${theirLanguage(t)}`;
}

export function designPrompt(t: Ticket, change?: string, meta?: BoardMeta, fromChat = false, others?: OpenTicket[]): string {
  const repo = partsRule(meta);
  const head = fromChat
    ? `You and the person talked it through in this conversation. Now write the design from everything you agreed${t.steps ? ', the whole design again' : ''}. Where the talk changed something, follow the talk.`
    : change
    ? `The person read your design.\n${changeText(change)}\n\nWrite the whole design again with this.`
    : 'The person approved the spec below. Now, as the Architect, design how to build it. Read the code you need first.';
  return `${head}

Approved spec (do not change it):
Story: ${t.story}
Done when:
${doneWhen(t)}

- decision: only if this ticket makes a technical choice later tickets must follow. Give 2 options you considered,
  mark the chosen one, and say why in plain words tied to the spec. If the client forces a technology,
  check it against the business needs and write the result in clientCheck ("no conflict" or the conflict).${firstTechnology(meta, t)}
${DECISION_LINKS}
${DEPENDS_RULE}
${stepsAndTests(t)}
  asks: how many "done when" no page shows, but asking the running API would (0 when none).
- commands: only if the project has no way yet to set up, test, build or start it, or this ticket changes that.
  For a new project, choose simple, common tools and give every command, including start and url.${repo}${testLine(t, meta)}
${MOCKUP_RULE}
${askRule(t)}${openTicketsText(others, 'architect')}
${PLAIN}${theirLanguage(t)}`;
}

const DECISION_LINKS = `  area: one of ${DECISION_AREAS.join(', ')}. replaces: only if it changes a saved decision, that decision's id
  (like "ADR-004"); the old one stops being a rule once this is approved.
- follows: the ids of the saved decisions this ticket's design relies on (like ["ADR-003", "ADR-005"]). Only real
  ones from the list, only those that shape this ticket. Empty if none.`;

const DEPENDS_RULE =`- dependsOn: the ids of other open tickets (from the list of open tickets, if there is one) whose code this ticket
  needs and that are not merged yet, like ["RO-1"]. squad-kit then waits for them, or builds on their branch. Empty if
  none.`;

const MOCKUP_RULE = `- mockup: when screens is 1 or more, one self-contained HTML page showing how the main screen will look after this
  ticket, using the project's own look where you can see it (colors, fonts, layout). Inline CSS and a little inline
  JavaScript for clicks are fine; no links to other sites, no images from the web. The person approves the look with
  the design, before anything is built. Leave it out when nothing on screen changes.`;

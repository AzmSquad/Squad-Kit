import { TECH_ROLES, type BoardMeta, type Decision, type RepoInfo, type Ticket } from '../../board/types.js';
import { asData, LOOK, PLAIN, type PromptContext, rulesText, startWithNoWindow } from './context.js';

export function scanPrompt(meta: BoardMeta, nested: RepoInfo[], ctx?: PromptContext, corrections = '', idea = ''): string {
  const repos = nested.length
    ? `\nThis folder is a workspace with several code repos inside, each with its own git:\n${nested.map((r) => `- ${r.path}`).join('\n')}
For each repo, fill one entry in repos with its path, a one-line summary, and its commands (run inside that repo's folder).
Leave the top-level commands empty.\n`
    : '';
  const fix = corrections
    ? `\n\nYou read this project before, and the person said some of it was wrong. Read it again with what they said in mind.\n${asData('What the person said', corrections)}\n`
    : '';
  const known = meta.parts?.length
    ? `\n\nYou found these parts before. In runs, keep the same id and name for each one still there.\n${asData('The parts found before', meta.parts.map((p) => `- ${p.id}: ${p.name}`).join('\n'))}\n`
    : '';
  const wants = idea
    ? `\n\nThis project has no code yet. The person said what they want to build.\n${asData('What the person wants to build', idea)}\nIn summary, say that in one plain sentence, in their language. In ideas, give up to three first stories for it: what people will be able to do, never about technology or setting things up.\n`
    : '';
  return `You are the Architect of a software squad, reading this project for the first time.
Look at the files (README, package files, project files, folders). Do not change anything.${rulesText(ctx)}
${repos}${fix}${known}${wants}
Produce:
- empty: true if the folder has no real code yet.
- summary: one sentence on what this project is.
- map: 4 to 8 rows of "area" and "detail", like "Front end: Angular 17, in web/".
- decisions: the technical choices already made (language, frameworks, database, test tools), each with a short why.
  The person checks them before they become the rules every ticket follows.
- commands: only the ones you are sure of from the files. setup installs dependencies, test runs all the tests,
  lint checks code style, build builds it, start runs the app for a browser, url is where it opens.
  Leave a command empty if the project does not have it. When the project has a separate script for browser or
  end-to-end tests, test runs it too: "npm test && npm run test:e2e".
  ${startWithNoWindow()}
- users: who uses the project and how they get in, in one or two sentences, from what the code shows (sign-in, roles,
  pages), like "Office staff who book rooms. They pick their name from a list; there are no accounts."
- can: 3 to 8 things it can do today, one short line each, in the words of the people who use it, like "Book a room
  in 15-minute steps". Only what the code really does.
- worth: 2 to 5 things worth knowing before the first ticket: surprises, gaps and risks, like "The login screen
  checks no password." or "No test opens the pages in a real browser yet."
- ideas: three good first tickets from what you saw, each a short title (what to do, like "Check a real password at
  login") and why, in one sentence.
- parts: 3 to 8 parts of the code for a picture of how it fits together, in the order a request flows: who uses it
  first (kind people), then screens, server, logic and data; tests last (kind tests); outside services as outside.
  For each: id, a short word like "pages"; name, a plain name like "Pages"; what, a few words like "Login page and
  booking page"; files, up to 3 real folder or file paths.
  When the product has several parts that run by themselves, each of those gets its own box, named as in runs.
- links: how the parts connect: from and to are part ids, label is a word or two, like "uses", "calls", "stores in"
  or "checks".
${runsWords(nested.length ? 'repo, the folder of its repo, exactly as in the list above' : 'repo, "."')}
If the folder has no real code yet, leave map, decisions, commands, users, can, worth, parts, links and runs empty. The .squad
folder is squad-kit's own and says nothing about the project. Choose no technology now: you pick it yourself when the
first story is planned. Give ideas only for what the person said they want to build.

Project name: ${meta.project}. ${PLAIN}
${LOOK}`;
}

/** The Architect reads the code as it is now: the project map, why each technology is there, and its patterns. */
/** How the Architect says what runs when the whole product is up. */
function runsWords(repo: string): string {
  return `- runs: what runs when the whole product is up. Each part that starts by itself (a web app, an API, a worker, a PDF
  service), and each service they share (a database, Redis, a queue). Look in compose files, launch settings, config
  examples and how the code connects, so no service is missed. A library, a folder of tests or an old app another part
  replaced is not one. For each: id, a short word like "api"; name, a plain name like "Web app" or "Database"; ${repo};
  folder, only when several parts share that repo; needs, the ids of what it cannot run without, and nothing from
  another product that only sits in the same folder; url, where it answers when it runs, like http://localhost:5180,
  when the project's files show it; shared, true for a service, which has no repo.`;
}

export function blueprintPrompt(meta: BoardMeta, decisions: Decision[], tech: string[], findRuns = false): string {
  const saved = decisions.filter((d) => !d.replacedBy).map((d) => `- ${d.id}: ${d.title}. Chosen: ${d.chosen}`).join('\n') || '- none yet';
  return `You are the Architect of a software squad. Read the project's code as it is now on its main branch.
Look at the files and folders. Do not change anything.${meta.repos?.length ? `\nThe code repos: ${meta.repos.map((r) => r.path).join(', ')}.` : ''}

Saved decisions:
${saved}

Technologies found in the package files: ${tech.join(', ') || 'none'}.

Produce:
- map: 4 to 8 rows of "area" and "detail" for the code today, like "Pages: Next.js app router, in src/app/".
- stack: every main technology the code uses. First each one found above, its name exactly as written above. Then the
  ones the package files do not show (a project may have no package files at all): its language, frameworks,
  database and test tools, as you see them in the code, each with role (${TECH_ROLES.join(', ')}). For each: why,
  one plain sentence on what it does here and why it fits this project; decision, the id of the saved decision that
  chose it, only if one clearly did.
- patterns: 4 to 8 design patterns the code really follows, the ones a new developer must keep, like "One rules file
  per feature, shared by the form and the server". name: a short name. what: one or two plain sentences, what it is
  and why. where: up to 4 real file or folder paths that show it. decision: the saved decision it comes from, if any.
- parts and links: 3 to 8 parts of the code for a picture of how it fits together, in the order a request flows (who
  uses it first as kind people, tests last as kind tests), each with id (a short word), name (plain), what (a few
  words) and files (up to 3 real paths); and links between them by id, each labelled with a word or two like "calls".${findRuns ? `\n${runsWords('repo, "."')}\n- summary: what the product is, in one sentence, in the words of the people who use it.\n- users: who uses it and how they get in, in one or two sentences, like "Office staff who book rooms. There are no accounts."` : ''}
Only what you can see in the code. ${PLAIN}
${LOOK}`;
}

/** The Architect writes down, after the fact, why a technology already in the code was picked. */
export function techDecisionPrompt(decisions: Decision[], tech: string, why?: string): string {
  const saved = decisions.filter((d) => !d.replacedBy).map((d) => `- ${d.id}: ${d.title}. Chosen: ${d.chosen}`).join('\n') || '- none yet';
  return `You are the Architect of a software squad. The code already uses ${tech}, but no saved decision says why.
Read how the project uses it (package files, config, the code that uses it). Do not change anything.${why ? `\nWhat you noted before: ${why}` : ''}

Saved decisions:
${saved}

Write the decision as it stands today, for the person to approve:
- title: a short question-like title, like "How we test the screens".
- area: the one that fits best.
- options: 2 or 3 real choices a team would weigh, the one in use first.
- chosen: the option in use. It must name ${tech}.
- why: 2 or 3 plain sentences on why it fits this project, from what you see in the code.
- buildsOn: ids of saved decisions this one relies on (like "ADR-003"). Only real ones from the list.
${PLAIN}
${LOOK}`;
}

/** The Architect checks the tickets planned before a new decision: does it change them? */
export function impactPrompt(d: Decision, tickets: Ticket[]): string {
  const list = tickets
    .map((t) => {
      const where = t.mergedAt ? 'merged into the main branch already' : t.worktree ? 'being built' : 'planned, not built yet';
      const steps = (t.steps ?? []).map((s, i) => `   ${i + 1}. ${s.title}`).join('\n');
      return `- ${t.id}: ${t.title} (${where})${t.story ? `\n  Story: ${t.story}` : ''}${t.decision ? `\n  Its design: ${t.decision.title}` : ''}${steps ? `\n  Steps:\n${steps}` : ''}`;
    })
    .join('\n');
  return `You are the Architect of a software squad. A new decision was just approved:
${d.id}: ${d.title}
Chosen: ${d.chosen}
Why: ${d.why}

These tickets were planned before it. Read the code on the main branch and the mockups if you need to. Do not change anything.
${list}

For each ticket, answer:
- affected: true only if its plan, or its code already merged, goes against ${d.id} or misses it. For example a screen
  that still has the old look, or a step that does it the old way. False if ${d.id} does not touch what it builds,
  or if its screens already follow ${d.id}.
- why: one plain sentence the person reads.
- change: if affected, one or two sentences on what to change so it follows ${d.id}. Empty if not.
${PLAIN}
${LOOK}`;
}

import { DECISION_AREAS } from '../board/types.js';
import type { BoardMeta, Decision, Question, RepoInfo, Ticket, TicketNote } from '../board/types.js';
import { reposOf } from './repos.js';

/** Role briefs for the live squad, and the JSON shapes each role must answer in. */

const STR = { type: 'string' } as const;

const COMMANDS = {
  type: 'object',
  properties: { setup: STR, test: STR, lint: STR, build: STR, start: STR, url: STR },
} as const;

export const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    empty: { type: 'boolean' },
    summary: STR,
    map: { type: 'array', items: { type: 'object', properties: { area: STR, detail: STR }, required: ['area', 'detail'] } },
    decisions: { type: 'array', items: { type: 'object', properties: { title: STR, why: STR }, required: ['title', 'why'] } },
    commands: COMMANDS,
    repos: {
      type: 'array',
      items: { type: 'object', properties: { path: STR, summary: STR, commands: COMMANDS }, required: ['path', 'summary', 'commands'] },
    },
  },
  required: ['empty', 'summary', 'map', 'decisions', 'commands'],
};

export const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    summary: STR,
    questions: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', enum: ['analyst', 'architect'] },
          text: STR,
          options: { type: 'array', minItems: 2, maxItems: 4, items: STR },
          typedOption: STR,
        },
        required: ['from', 'text', 'options'],
      },
    },
  },
  required: ['summary', 'questions'],
};

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    story: STR,
    criteria: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: { type: 'object', properties: { given: STR, when: STR, then: STR }, required: ['given', 'when', 'then'] },
    },
    decision: {
      type: 'object',
      properties: {
        title: STR,
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: { type: 'object', properties: { name: STR, note: STR, chosen: { type: 'boolean' } }, required: ['name', 'note', 'chosen'] },
        },
        why: STR,
        clientCheck: STR,
        replaces: STR,
        area: { type: 'string', enum: [...DECISION_AREAS] },
      },
      required: ['title', 'options', 'why', 'area'],
    },
    follows: { type: 'array', maxItems: 12, items: STR },
    steps: { type: 'array', minItems: 1, maxItems: 8, items: STR },
    tests: { type: 'integer' },
    screens: { type: 'integer' },
    releaseNote: STR,
    commands: COMMANDS,
    repo: STR,
    mockup: STR,
  },
  required: ['story', 'criteria', 'steps', 'tests', 'screens', 'releaseNote'],
};

const CRITERIA = {
  type: 'array',
  minItems: 1,
  maxItems: 6,
  items: { type: 'object', properties: { given: STR, when: STR, then: STR }, required: ['given', 'when', 'then'] },
};

/** Full track, step one: the what. The person approves it before any design. */
export const SPEC_SCHEMA = {
  type: 'object',
  properties: { story: STR, criteria: CRITERIA, releaseNote: STR },
  required: ['story', 'criteria', 'releaseNote'],
};


/** A reply in a chat with the person, and whether the agent thinks it understands enough for the next step. */
export const CHAT_SCHEMA = {
  type: 'object',
  properties: { reply: STR, ready: { type: 'boolean' } },
  required: ['reply', 'ready'],
};

/** Filled only when the agent must stop and ask the person. */
const QUESTION = {
  type: 'object',
  properties: { text: STR, options: { type: 'array', maxItems: 4, items: STR }, why: STR, files: { type: 'array', maxItems: 6, items: STR } },
  required: ['text'],
};

/** Full track, step two: the how, written from the approved spec. */
export const DESIGN_SCHEMA = {
  type: 'object',
  properties: { ...Object.fromEntries(Object.entries(PLAN_SCHEMA.properties).filter(([k]) => !['story', 'criteria', 'releaseNote'].includes(k))), question: QUESTION },
  required: ['steps', 'tests', 'screens'],
};

export const BUILD_SCHEMA = {
  type: 'object',
  properties: { summary: STR, testsAdded: { type: 'integer' }, notes: STR, question: QUESTION },
  required: ['summary'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, summary: STR, comments: { type: 'array', items: STR }, question: QUESTION },
  required: ['approved', 'summary', 'comments'],
};

export const PROOF_SCHEMA = {
  type: 'object',
  properties: {
    shots: {
      type: 'array',
      items: { type: 'object', properties: { criterion: { type: 'integer' }, file: STR, note: STR }, required: ['criterion', 'file'] },
    },
    skipped: STR,
  },
  required: ['shots'],
};

export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    title: STR,
    ask: STR,
    kind: { type: 'string', enum: ['feature', 'bug'] },
    track: { type: 'string', enum: ['full', 'express'] },
    priority: { type: 'string', enum: ['high', 'normal', 'low'] },
    criteria: { type: 'array', maxItems: 8, items: STR },
    rules: { type: 'array', maxItems: 8, items: STR },
    edgeCases: { type: 'array', maxItems: 8, items: STR },
    gaps: { type: 'array', maxItems: 5, items: STR },
  },
  required: ['title', 'ask', 'kind', 'track', 'priority', 'criteria', 'rules', 'edgeCases', 'gaps'],
};

const PLAIN = 'Write for a project manager who may not be a developer: plain words, short sentences, no jargon.';

/** Extra facts a role needs: the project's own rule files, and the repo the ticket works in. */
export interface PromptContext {
  rules: string[];
  repo?: RepoInfo;
}

function rulesText(ctx?: PromptContext): string {
  if (!ctx?.rules.length) return '';
  return `\n\nThis project has its own rules: instruction files, and the team's wiki pages (business rules, definition of done) under .squad/board/context/wiki. Read them first and follow them:\n${ctx.rules.map((r) => `- ${r}`).join('\n')}`;
}

function reposText(meta: BoardMeta): string {
  if (!meta.repos?.length) return '';
  return `\n\nThis workspace holds several code repos, each with its own git:\n${meta.repos
    .map((r) => `- ${r.path} (branch ${r.base})${r.summary ? `: ${r.summary}` : ''}`)
    .join('\n')}`;
}

function projectContext(meta: BoardMeta, decisions: Decision[], ctx?: PromptContext): string {
  const map = meta.map.length ? meta.map.map((m) => `- ${m.area}: ${m.detail}`).join('\n') : '- (not read yet)';
  const rules = decisions.filter((d) => !d.replacedBy);
  const adrs = rules.length ? rules.map((d) => `- ${d.id} ${d.title}. Chosen: ${d.chosen}. Why: ${d.why}`).join('\n') : '- (none yet)';
  const old = decisions.filter((d) => d.replacedBy);
  const replaced = old.length ? `\n\nReplaced decisions, no longer rules (do not follow):\n${old.map((d) => `- ${d.id} ${d.title}, replaced by ${d.replacedBy}`).join('\n')}` : '';
  const lessons = meta.lessons.length ? meta.lessons.map((l) => `- ${l.text}`).join('\n') : '- (none yet)';
  const c = ctx?.repo?.commands ?? reposOf(meta)[0]?.commands ?? {};
  const commands = Object.entries(c).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- (none set up yet)';
  return [
    `Project: ${meta.project}${reposText(meta)}`,
    `Project map:\n${map}`,
    `Saved decisions every ticket must follow:\n${adrs}${replaced}`,
    `Lessons from past tickets:\n${lessons}`,
    `${ctx?.repo && meta.repos?.length ? `Commands for ${ctx.repo.path}` : 'Project commands'}:\n${commands}${rulesText(ctx)}`,
  ].join('\n\n');
}

function ticketContext(t: Ticket): string {
  const files = t.attachments?.length ? `\nAttached files (read them):\n${t.attachments.map((a) => `- ${a}`).join('\n')}` : '';
  const list = (head: string, items?: string[]) => (items?.length ? `\n${head}:\n${items.map((x) => `- ${x}`).join('\n')}` : '');
  const brief = t.brief
    ? list('Acceptance criteria the person wrote (keep every one)', t.brief.criteria) +
      list('Business rules the person wrote (follow every one)', t.brief.rules) +
      list('Edge cases the person wrote (handle every one)', t.brief.edgeCases)
    : '';
  return `Ticket ${t.id}: ${t.title}\n${t.kind === 'bug' ? 'This is a bug report.' : 'This is a feature request.'}\nWhat was asked:\n${t.ask}${brief}${files}${notesText(t.notes ?? [])}`;
}

const NOTE_HEAD = { note: 'Note', criterion: 'Acceptance criterion (must be done and proven)', rule: 'Business rule (follow it)' } as const;

/** Notes the person added to the ticket. They outrank the plan where they disagree. */
export function notesText(notes: TicketNote[], fresh = false): string {
  if (!notes.length) return '';
  const head = fresh
    ? 'The person added these notes to the ticket since your last step. Take them into account now; they outrank the plan where they disagree'
    : 'Notes the person added to the ticket (they outrank the plan where they disagree)';
  return `\n${head}:\n${notes.map((n) => `- ${NOTE_HEAD[n.kind]}${n.to ? ` to the ${n.to}` : ''}: ${n.text}`).join('\n')}`;
}

/** The plan's "done when" list, plus every acceptance criterion the person added later as a note. */
function doneWhen(t: Ticket): string {
  const plan = (t.criteria ?? []).map((c) => `Given ${c.given}, when ${c.when}, then ${c.then}.`);
  const added = (t.notes ?? []).filter((n) => n.kind === 'criterion').map((n) => `${n.text} (added by the person)`);
  return [...plan, ...added].map((c, i) => `${i + 1}. ${c}`).join('\n');
}

function answersText(t: Ticket): string {
  if (!t.questions?.length) return 'No questions were needed.';
  return t.questions
    .map((q, i) => {
      const a = q.answer;
      const value = a ? (a.value ? `${a.choice.replace(/:$/, '')}: ${a.value}` : a.choice) : 'not answered';
      return `${i + 1}. ${q.text} → ${value}`;
    })
    .join('\n');
}

export function scanPrompt(meta: BoardMeta, nested: RepoInfo[], ctx?: PromptContext): string {
  const repos = nested.length
    ? `\nThis folder is a workspace with several code repos inside, each with its own git:\n${nested.map((r) => `- ${r.path}`).join('\n')}
For each repo, fill one entry in repos with its path, a one-line summary, and its commands (run inside that repo's folder).
Leave the top-level commands empty.\n`
    : '';
  return `You are the Architect of a software squad, reading this project for the first time.
Look at the files (README, package files, project files, folders). Do not change anything.${rulesText(ctx)}
${repos}
Produce:
- empty: true if the folder has no real code yet.
- summary: one sentence on what this project is.
- map: 4 to 8 rows of "area" and "detail", like "Front end: Angular 17, in web/".
- decisions: the technical choices already made (language, frameworks, database, test tools), each with a short why.
- commands: only the ones you are sure of from the files. setup installs dependencies, test runs the tests,
  lint checks code style, build builds it, start runs the app for a browser, url is where it opens.
  Leave a command empty if the project does not have it.

Project name: ${meta.project}. ${PLAIN}`;
}

export function intakePrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, ctx?: PromptContext): string {
  return `You are the Analyst and the Architect of a software squad. A person wrote the ticket below.
Read the project to understand it (it may be empty). Do not write or change any files.

${projectContext(meta, decisions, ctx)}

${ticketContext(t)}

Your job now: ask the person only the questions whose answers change what gets built or how.
- The Analyst asks about the business: who uses it, what rules apply, what "done" looks like.
- The Architect asks business questions that decide the technical design, for example "do staff share computers?",
  never "which database?". If no saved decision settles the technology this ticket needs, the Architect asks first:
  "Must you use a technology the client chose?" with options ["No, you choose", "Yes:"] and typedOption "Yes:".
- Each question has 2 to 4 short options. Use typedOption only for an option that needs a typed value.
- Ask at most 5 questions in total. If the ticket is already clear, ask none.
- summary: one sentence on what you understood.
${PLAIN}`;
}

export function replyPrompt(q: Question, n: number, ask: string): string {
  const role = q.from === 'analyst' ? 'Analyst' : 'Architect';
  return `The person asks about your question ${n} ("${q.text}"): "${ask}"
Answer as the ${role} in 2 or 3 plain sentences. Explain why you ask and what each option would mean. Do not ask new questions and do not change files.`;
}

export function planPrompt(t: Ticket, change?: string, meta?: BoardMeta): string {
  const repo = meta?.repos?.length
    ? `\n- repo: the folder of the ONE code repo this ticket changes, exactly as written in the list (${meta.repos.map((r) => r.path).join(', ')}).`
    : '';
  const head = change
    ? `The person read your plan.\n${changeText(change)}\n\nWrite the whole plan again with this.`
    : t.track === 'express'
      ? 'This ticket is on the Express track: a small change the person wants done fast, with no questions. Write a short plan, as the Architect and the Spec writer. Where something is unclear, take the simplest choice that fits and say it in the story. Keep it small: few steps, no new technical decisions unless needed.'
      : `The person answered your questions:\n${answersText(t)}\n\nNow write the plan, as the Architect and the Spec writer.`;
  return `${head}

- story: "As a <who>, I want <what>, so <why>."
- criteria: 2 to 5 "done when" checks in Given / When / Then form. Each must be testable.
- decision: only if this ticket makes a technical choice later tickets must follow. Give 2 options you considered,
  mark the chosen one, and say why in plain words tied to the person's answers. If the client forces a technology,
  check it against the business needs and write the result in clientCheck ("no conflict" or the conflict).
${DECISION_LINKS}
- steps: 3 to 7 small steps in order, one sentence each. The last step writes the tests.
- tests: how many tests you expect to add. screens: how many "done when" can be shown in a screenshot (0 without a UI).
- releaseNote: one line for release notes, like "**Dark mode.** Switch the dashboard to dark."
- commands: only if the project has no way yet to set up, test, build or start it, or this ticket changes that.
  For a new project, choose simple, common tools and give every command, including start and url.${repo}
${PLAIN}`;
}

/** A one-line change is quoted; a review (comments, edits) or a new direction is passed as it is. */
function changeText(change: string): string {
  return change.includes('\n') ? change : `They asked for this change: "${change}"`;
}

export function specPrompt(t: Ticket, change?: string, fromChat = false): string {
  const head = fromChat
    ? `You and the person talked it through in this conversation. Now write the spec from everything you agreed${t.story ? ', the whole spec again' : ''}. Where the talk changed something, follow the talk. Write what to build and how we know it is done, not how to build it.`
    : change
    ? `The person read your spec.\n${changeText(change)}\n\nWrite the whole spec again with this.`
    : `The person answered your questions:\n${answersText(t)}\n\nNow write the spec, as the Analyst: what to build and how we know it is done. Not how to build it; the Architect designs that next, after the person approves this.`;
  return `${head}

- story: "As a <who>, I want <what>, so <why>."
- criteria: 2 to 5 "done when" checks in Given / When / Then form. Each must be testable, in the person's words.
- releaseNote: one line for release notes, like "**Dark mode.** Switch the dashboard to dark."
${PLAIN}`;
}

export function designPrompt(t: Ticket, change?: string, meta?: BoardMeta, fromChat = false): string {
  const repo = meta?.repos?.length
    ? `\n- repo: the folder of the ONE code repo this ticket changes, exactly as written in the list (${meta.repos.map((r) => r.path).join(', ')}).`
    : '';
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
  check it against the business needs and write the result in clientCheck ("no conflict" or the conflict).
${DECISION_LINKS}
- steps: 3 to 7 small steps in order, one sentence each. The last step writes the tests.
- tests: how many tests you expect to add. screens: how many "done when" can be shown in a screenshot (0 without a UI).
- commands: only if the project has no way yet to set up, test, build or start it, or this ticket changes that.
  For a new project, choose simple, common tools and give every command, including start and url.${repo}
${MOCKUP_RULE}
${ASK_RULE}
${PLAIN}`;
}

const DECISION_LINKS = `  area: one of ${DECISION_AREAS.join(', ')}. replaces: only if it changes a saved decision, that decision's id
  (like "ADR-004"); the old one stops being a rule once this is approved.
- follows: the ids of the saved decisions this ticket's design relies on (like ["ADR-003", "ADR-005"]). Only real
  ones from the list, only those that shape this ticket. Empty if none.`;

const MOCKUP_RULE = `- mockup: when screens is 1 or more, one self-contained HTML page showing how the main screen will look after this
  ticket, using the project's own look where you can see it (colors, fonts, layout). Inline CSS and a little inline
  JavaScript for clicks are fine; no links to other sites, no images from the web. The person approves the look with
  the design, before anything is built. Leave it out when nothing on screen changes.`;

export function buildPrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, ctx?: PromptContext): string {
  const steps = (t.steps ?? []).map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  const criteria = doneWhen(t);
  const decision = t.decision ? `\nDecision for this ticket: ${t.decision.title}. Why: ${t.decision.why}` : '';
  return `You are the Builder of a software squad. Build the approved plan below in this folder.

${projectContext(meta, decisions, ctx)}

${ticketContext(t)}

Story: ${t.story}
Done when:
${criteria}${decision}

Steps:
${steps}

Rules:
- Before you start each step, print a line that says exactly ">> step N" (N is the step number).
- Follow the saved decisions and the project's existing style.
- Write tests that check every "done when", and run the tests before you finish.
- Never commit, push, switch branches, or change files outside this folder.
- Wait for every command to finish (installs too). Never leave anything running in the background; this step ends when you answer.
- If the plan does not cover a small choice, take the simplest one and say so in notes.
${ASK_RULE}`;
}

const ASK_RULE = `- Ask the person only when something important is unclear and a wrong guess would waste the work or break a business rule:
  then stop, fill "question" (one plain sentence, 2 to 4 short options, and why it matters), and leave the rest for later.
  They answer in this same conversation. Never ask about code style or small choices.
  To show what you mean, put full paths of files you made in "files": screenshots, a wireframe, or one self-contained
  HTML page as a clickable mockup (inline CSS, no links to other sites).`;

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

export function fixChecksPrompt(failures: { name: string; command: string; output: string }[]): string {
  const text = failures.map((f) => `"${f.name}" (${f.command}) failed:\n${f.output}`).join('\n\n');
  return `squad-kit ran the project checks and some failed.

${text}

Print ">> fix" first. Fix the cause in the code. Do not delete or weaken tests to make them pass. Run the checks again before you finish.`;
}

export function reviewFixPrompt(comments: string[]): string {
  return `The Reviewer asked for these changes:\n${comments.map((c) => `- ${c}`).join('\n')}\n\nPrint ">> fix" first, then make the changes and run the tests again.`;
}

export function clashPrompt(base: string, files: string[]): string {
  return `Someone changed the same lines in ${base} since this ticket started. squad-kit has merged ${base} into this folder, and these files have clash markers (<<<<<<<, =======, >>>>>>>):\n${files.map((f) => `- ${f}`).join('\n')}\n\nPrint ">> clash" first. In each file, keep both changes working together and remove every marker. Do not run git commands; squad-kit saves the merge. Then run the tests again.`;
}

export function changeFixPrompt(note: string): string {
  return `The person checked the result and said: "${note}"\n\nPrint ">> fix" first, then fix it and run the tests again.`;
}

export function reviewPrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, round: number, ctx?: PromptContext): string {
  const criteria = doneWhen(t);
  if (round > 1) {
    return `The Builder made changes after your review. Look again at what changed since commit ${t.baseCommit} (run "git status" and "git diff ${t.baseCommit}", and read new files). Approve if your comments are handled.`;
  }
  return `You are the Reviewer of a software squad: a second pair of eyes on the Builder's work. Do not edit files.

${projectContext(meta, decisions, ctx)}

${ticketContext(t)}

Story: ${t.story}
Done when:
${criteria}

Look at everything that changed since commit ${t.baseCommit}: run "git status" and "git diff ${t.baseCommit}", and read new files.
Check: does it do every "done when"? Does it follow the saved decisions? Real bugs, security holes, missing tests?
Approve unless there is a real problem. Small style notes do not block. Each comment is one concrete sentence.
${ASK_RULE}`;
}

export function proofPrompt(meta: BoardMeta, t: Ticket, outDir: string, when: 'before' | 'after', ctx?: PromptContext, appRunning = false, appUrl?: string): string {
  const criteria = doneWhen(t);
  const base = ctx?.repo?.commands ?? meta.commands ?? {};
  // squad-kit may run the ticket's copy on another port when the usual one is taken.
  const c = appUrl ? { ...base, url: appUrl } : base;
  return `You are the Tester of a software squad. Take screenshots that show each "done when" below ${
    when === 'before' ? 'as the app is BEFORE the change (some may not exist yet; show the closest screen)' : 'working AFTER the change'
  }.

Done when:
${criteria}

${
  appRunning
    ? `The app is already running at ${c.url}; squad-kit started it and will stop it. Do not start or stop it yourself.`
    : `How to run the app: ${c.setup ? `set up with "${c.setup}", then ` : ''}start it with "${c.start}" and wait until ${c.url} answers. Stop it when you are done.`
}
For each "done when" that shows on a screen, save one 1280x800 PNG named ${t.id.toLowerCase()}-${when}-<number>.png in ${outDir}.
Use the project's Playwright if it has one, or "npx -y playwright screenshot --viewport-size=1280,800 <url> <file>".
If you need clicks or typing first, write a short Playwright script in a temporary folder outside the project.
If browsers are missing, run "npx -y playwright install chromium".
Do not change project files. In shots, give the "done when" number and file name for each screenshot.${rulesText(ctx)}`;
}

/** Turns a rough idea, a forwarded chat message or one line of business into a ticket the person checks before saving. */
export function draftPrompt(meta: BoardMeta, text: string, files: string[], ctx?: PromptContext): string {
  const attached = files.length ? `\nThe person also attached these files (read them, they may be screenshots of a chat):\n${files.map((f) => `- ${f}`).join('\n')}\n` : '';
  return `You are the Analyst of a software squad. A person pasted the text below: maybe an idea, a forwarded chat
message (WhatsApp or similar), or one line of business. Turn it into a clear ticket for project ${meta.project}.
You may read the project to use its real words and screens. Do not write or change any files.${rulesText(ctx)}

What the person pasted:
"""
${text.trim() || '(no text, only the attached files)'}
"""
${attached}
Produce:
- title: a short name for the ticket, at most 8 words, like "Show hearing time in local time".
- ask: who needs it and why, in one to three sentences.
- kind: "bug" if something that worked is broken, else "feature".
- track: "express" only for a tiny, clear change (a typo, a label, a small obvious bug) that needs no questions; else "full".
- priority: "high" only if the text says it is urgent or blocks people, "low" if it is a nice-to-have, else "normal".
- criteria: 2 to 6 acceptance criteria, each one testable sentence that starts with a person doing or seeing something.
- rules: the business rules the text states or clearly implies (limits, who may do what, numbers). Empty if none.
- edgeCases: the unusual cases the builder must handle (empty lists, wrong input, no access, two people at once).
- gaps: what the text leaves unclear, as short questions. Do not invent answers for them.
Only use what the text says or the project shows. Write in the same language as the text. ${PLAIN}`;
}

const CHAT_ROLE: Record<string, string> = {
  analyst: 'the Analyst: you make sure the squad understands what the person wants before anything is written',
  architect: 'the Architect: you choose how to build the approved spec',
  builder: 'the Builder: you are building this ticket in this folder',
  reviewer: "the Reviewer: you check the Builder's work",
  tester: 'the Tester: you prove each "done when" with the running app',
};

/**
 * One turn of a chat with the person. The agent only talks and reads: it changes no files, and it never moves the
 * ticket on. The person does that with a button.
 */
export function chatPrompt(agent: string, message: string | null, next: string, attached = ''): string {
  const head = message === null
    ? `The person wants to talk this ticket through with you before you go on. You are ${CHAT_ROLE[agent] ?? agent}.
Open the talk: say in a few short lines what you understand so far and where you are, then ask about what is most unclear.`
    : `The person says: "${message}"${attached ? `\n${attached}` : ''}`;
  return `${head}

Rules for this talk:
- Answer in plain words, in the person's language, in a few short paragraphs at most. Ask one or two questions at a time.
- Do not write or change any files. Read the code only when it helps you answer.
- Do not start the next step yourself. ${next}
- Set "ready" to true only when you think you understand enough for that next step; say so in your reply.`;
}

/** What the person's buttons do after the talk, told to the agent so it can say so. */
export function chatNext(agent: string, hasSpec: boolean, specApproved: boolean): string {
  if (agent === 'analyst') return `When the person is happy, they press "${hasSpec ? 'Update' : 'Write'} the spec" and you write it from this talk.`;
  if (agent === 'architect') return specApproved ? `When the person is happy, they press "Write the design" and you write it from this talk.` : 'The design comes after the person approves the spec.';
  return 'When the person presses Done, you carry on with your work as you agreed.';
}

export function chatCarryOnPrompt(agent: string): string {
  if (agent === 'builder') return 'You and the person talked it through above, and they pressed Done. Carry on with the work as you agreed, then run the tests.';
  if (agent === 'reviewer') return 'You and the person talked it through above, and they pressed Done. Finish your review with what you agreed in mind.';
  return 'You and the person talked it through above, and they pressed Done. Carry on as you agreed.';
}

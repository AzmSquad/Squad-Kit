import type { BoardMeta, Decision, Question, RepoInfo, Ticket } from '../board/types.js';
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
      },
      required: ['title', 'options', 'why'],
    },
    steps: { type: 'array', minItems: 1, maxItems: 8, items: STR },
    tests: { type: 'integer' },
    screens: { type: 'integer' },
    releaseNote: STR,
    commands: COMMANDS,
    repo: STR,
  },
  required: ['story', 'criteria', 'steps', 'tests', 'screens', 'releaseNote'],
};

export const BUILD_SCHEMA = {
  type: 'object',
  properties: { summary: STR, testsAdded: { type: 'integer' }, notes: STR },
  required: ['summary'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, summary: STR, comments: { type: 'array', items: STR } },
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

const PLAIN = 'Write for a project manager who may not be a developer: plain words, short sentences, no jargon.';

/** Extra facts a role needs: the project's own rule files, and the repo the ticket works in. */
export interface PromptContext {
  rules: string[];
  repo?: RepoInfo;
}

function rulesText(ctx?: PromptContext): string {
  if (!ctx?.rules.length) return '';
  return `\n\nThis project has its own rules for AI tools. Read them first and follow them:\n${ctx.rules.map((r) => `- ${r}`).join('\n')}`;
}

function reposText(meta: BoardMeta): string {
  if (!meta.repos?.length) return '';
  return `\n\nThis workspace holds several code repos, each with its own git:\n${meta.repos
    .map((r) => `- ${r.path} (branch ${r.base})${r.summary ? `: ${r.summary}` : ''}`)
    .join('\n')}`;
}

function projectContext(meta: BoardMeta, decisions: Decision[], ctx?: PromptContext): string {
  const map = meta.map.length ? meta.map.map((m) => `- ${m.area}: ${m.detail}`).join('\n') : '- (not read yet)';
  const adrs = decisions.length
    ? decisions.map((d) => `- ${d.id} ${d.title}. Chosen: ${d.chosen}. Why: ${d.why}`).join('\n')
    : '- (none yet)';
  const lessons = meta.lessons.length ? meta.lessons.map((l) => `- ${l.text}`).join('\n') : '- (none yet)';
  const c = ctx?.repo?.commands ?? reposOf(meta)[0]?.commands ?? {};
  const commands = Object.entries(c).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- (none set up yet)';
  return [
    `Project: ${meta.project}${reposText(meta)}`,
    `Project map:\n${map}`,
    `Saved decisions every ticket must follow:\n${adrs}`,
    `Lessons from past tickets:\n${lessons}`,
    `${ctx?.repo && meta.repos?.length ? `Commands for ${ctx.repo.path}` : 'Project commands'}:\n${commands}${rulesText(ctx)}`,
  ].join('\n\n');
}

function ticketContext(t: Ticket): string {
  const files = t.attachments?.length ? `\nAttached files (read them):\n${t.attachments.map((a) => `- ${a}`).join('\n')}` : '';
  return `Ticket ${t.id}: ${t.title}\n${t.kind === 'bug' ? 'This is a bug report.' : 'This is a feature request.'}\nWhat was asked:\n${t.ask}${files}`;
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
    ? `The person read your plan and asked for this change: "${change}". Write the whole plan again with the change.`
    : `The person answered your questions:\n${answersText(t)}\n\nNow write the plan, as the Architect and the Spec writer.`;
  return `${head}

- story: "As a <who>, I want <what>, so <why>."
- criteria: 2 to 5 "done when" checks in Given / When / Then form. Each must be testable.
- decision: only if this ticket makes a technical choice later tickets must follow. Give 2 options you considered,
  mark the chosen one, and say why in plain words tied to the person's answers. If the client forces a technology,
  check it against the business needs and write the result in clientCheck ("no conflict" or the conflict).
- steps: 3 to 7 small steps in order, one sentence each. The last step writes the tests.
- tests: how many tests you expect to add. screens: how many "done when" can be shown in a screenshot (0 without a UI).
- releaseNote: one line for release notes, like "**Dark mode.** Switch the dashboard to dark."
- commands: only if the project has no way yet to set up, test, build or start it, or this ticket changes that.
  For a new project, choose simple, common tools and give every command, including start and url.${repo}
${PLAIN}`;
}

export function buildPrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, ctx?: PromptContext): string {
  const steps = (t.steps ?? []).map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  const criteria = (t.criteria ?? []).map((c, i) => `${i + 1}. Given ${c.given}, when ${c.when}, then ${c.then}.`).join('\n');
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
- If the plan does not cover a choice, take the simplest one and say so in notes.`;
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

export function changeFixPrompt(note: string): string {
  return `The person checked the result and said: "${note}"\n\nPrint ">> fix" first, then fix it and run the tests again.`;
}

export function reviewPrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, round: number, ctx?: PromptContext): string {
  const criteria = (t.criteria ?? []).map((c, i) => `${i + 1}. Given ${c.given}, when ${c.when}, then ${c.then}.`).join('\n');
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
Approve unless there is a real problem. Small style notes do not block. Each comment is one concrete sentence.`;
}

export function proofPrompt(meta: BoardMeta, t: Ticket, outDir: string, when: 'before' | 'after', ctx?: PromptContext): string {
  const criteria = (t.criteria ?? []).map((c, i) => `${i + 1}. Given ${c.given}, when ${c.when}, then ${c.then}.`).join('\n');
  const c = ctx?.repo?.commands ?? meta.commands ?? {};
  return `You are the Tester of a software squad. Take screenshots that show each "done when" below ${
    when === 'before' ? 'as the app is BEFORE the change (some may not exist yet; show the closest screen)' : 'working AFTER the change'
  }.

Done when:
${criteria}

How to run the app: ${c.setup ? `set up with "${c.setup}", then ` : ''}start it with "${c.start}" in the background and wait until ${c.url} answers.
For each "done when" that shows on a screen, save one 1280x800 PNG named ${t.id.toLowerCase()}-${when}-<number>.png in ${outDir}.
Use the project's Playwright if it has one, or "npx -y playwright screenshot --viewport-size=1280,800 <url> <file>".
If you need clicks or typing first, write a short Playwright script in a temporary folder outside the project.
If browsers are missing, run "npx -y playwright install chromium".
Stop the app when you are done. Do not change project files. In shots, give the "done when" number and file name for each screenshot.${rulesText(ctx)}`;
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UnreadableTicket, readMeta, readTicket, ticketDir, type BoardPaths } from '../board/store.js';
import { shapeTroubles, ticketDocs, type TicketDocs } from '../board/docs.js';
import { hasDesign, hasSpec } from '../board/outside-step.js';
import type { Ticket } from '../board/types.js';
import { copiesOf } from './copies.js';
import { git, isRepo } from './git.js';
import { reposOf } from './repos.js';

/**
 * What an agent in any AI tool needs to run a story by the project's own structure: the guide in `.squad`, written from the
 * code that reads the files, so the shapes it shows are the shapes squad-kit reads; the prompt a person copies, which says
 * where the story is now; and what a conversation can ask about its own files.
 */

export const GUIDE_FILE = 'how-to-work-here.md';

/** A story in every file a conversation writes, through the code that writes them. */
export const SAMPLE_DOCS: TicketDocs = ticketDocs({
  id: 'SK-1',
  title: 'Sign in with a phone number',
  story: 'People with no email can sign in with their phone number.',
  criteria: [
    { given: 'someone on the sign-in page', when: 'they enter their phone number and the code sent to it', then: 'they are signed in' },
    { given: 'someone on the sign-in page', when: 'they enter a wrong code three times', then: 'they wait ten minutes before trying again' },
  ],
  releaseNote: 'You can now sign in with your phone number.',
  questions: [{ id: 'q1', from: 'analyst', text: 'Should a code expire?', options: ['After 5 minutes', 'After 30 minutes'], answer: { choice: 'After 5 minutes' } }],
  decision: {
    title: 'Where the codes are kept',
    area: 'Data',
    options: [
      { name: 'In the database', note: 'Survives a restart', chosen: true },
      { name: 'In memory', note: 'Simple, but lost on a restart' },
    ],
    why: 'A code must still work after a restart.',
  },
  steps: [
    { title: 'Add the codes table', status: 'todo' },
    { title: 'Send a code and check it', status: 'todo' },
    { title: 'Add the phone number to the sign-in page', status: 'todo' },
  ],
});

function shape(file: string): string {
  return `\`\`\`\`markdown\n${SAMPLE_DOCS[file]!.trimEnd()}\n\`\`\`\``;
}

/** The project's own commands, from its settings. */
function commandsOf(bp: BoardPaths): string {
  const meta = readMeta(bp);
  const repos = reposOf(meta);
  const lines = repos.flatMap((r) => {
    const said = Object.entries(r.commands ?? {}).filter(([, v]) => typeof v === 'string' && v.trim());
    const where = repos.length > 1 ? `${r.path}: ` : '';
    return said.length ? said.map(([k, v]) => `- ${where}${k}: \`${String(v).trim()}\``) : [`- ${where}none written down yet. Find them in the project's own files.`];
  });
  return lines.join('\n');
}

export function guideText(bp: BoardPaths): string {
  return `# How to work on this project in a conversation

squad-kit wrote this file and writes it again when it changes, so do not edit it.

A story usually runs through the squad on squad-kit's board. It can also run here, in a conversation in any AI tool. Follow this guide and the story's folder ends up the same as if the squad had done it. The board shows the story at its real step whenever someone opens it.

squad-kit counts only what it ran itself. A story worked on here carries a label on its record. The person can press Check to have squad-kit run its own checks, review and proof on it. What you spend in this conversation is not counted by squad-kit, and squad-kit's guard and limits do not apply here, so take care.

## Rules

- Run every \`squad\` command from the project's top folder, the one that holds \`.squad\`.
- Stop and ask the person where the squad would: open questions, the spec, the design, and the finished work. Never guess an answer.
- Build only in the story's copy of the code, never in the project's top folder.
- Never commit to the main branch, never merge it, never push. squad-kit does those when the person accepts.
- Write only \`spec.md\`, \`questions.md\` and \`design.md\` in the story's folder. Never edit \`ticket.md\`: squad-kit keeps it.
- Never write a password, a key or a client's private data in these files. They can end up in git.

## Read first

- \`.squad/knowledge/\`: what is known about this project.
- \`.squad/decisions/\`: what was decided before. Follow it.
- \`.squad/rules/\`: how each role works here: \`analyst.md\`, \`architect.md\`, \`builder.md\`, \`reviewer.md\`, \`tester.md\`. Work the way each says when you do that role's step.
- The project's own \`CLAUDE.md\` or \`AGENTS.md\`, if it has one.

## The steps

### 1. Start

- A new story: \`squad outside new "A short title" --ask "What the person asked, in their words"\`. It prints the story's id, like SK-1.
- A story already on the board: \`squad outside start SK-1\`. The squad stops on it and waits.

The story's folder is \`.squad/tickets/SK-1/\` in the project's top folder. Its files stay there, even while you build in the copy. \`ticket.md\` holds what was asked. \`notes.md\` holds what people added: read it too.

Then \`squad outside show SK-1\` says where it is and what comes next. Skip the steps that are done.

### 2. Questions, if you have any

Ask the person, and keep each question and its answer in \`questions.md\`. Leave the file out if there are none.

${shape('questions.md')}

### 3. The spec: what to build

Write \`spec.md\` in exactly this shape. Each "done when" is one numbered line: Given, when, then.

${shape('spec.md')}

Show it to the person. When they approve it: \`squad outside approved SK-1 spec\`

### 4. The design: how to build it

Write \`design.md\` in exactly this shape. One option is marked \`[x]\`. The steps are short, in order. A small change can have only the \`## Steps\` part.

${shape('design.md')}

Show it to the person. When they approve it: \`squad outside approved SK-1 design\`

### 5. The build

\`squad outside copy SK-1\` makes the story's copy of the code, on the story's own branch, set up and ready. It prints the folder. Work and commit only there. On a project of several repos, name the repo for each one you change: \`squad outside copy SK-1 <repo>\`.

### 6. The checks

Run the project's checks in the copy, and fix what fails:

${commandsOf(bp)}

### 7. The review

Read the whole change against the spec, the way \`.squad/rules/reviewer.md\` says, and fix what you find.

### 8. Show the person

Tell them what you built, and how to try it: which page, and what to do there. Do not write \`proof.md\`: squad-kit makes that file itself, with its own screenshots, when the person presses Check.

### 9. Back to the board

\`squad outside back SK-1\` hands the story back. The board shows it with its label. The person chooses what comes next: Check, Looks right, or more work.

Only if the person tells you to accept it: \`squad approve SK-1\`. squad-kit merges it. Only if they tell you to release: \`squad release\`.

## Check your files

Run \`squad outside show SK-1\` after you write any file. It says which file is wrong and why. A file squad-kit cannot read takes the story off the board until it is fixed.

squad-kit writes these files again in its own exact form when it saves the story. It may add a line, or put quotes around a value that starts with a quote mark. That is normal, and the value is the same. Read a file again before you edit it.
`;
}

/** The guide is on disk and says what this version says. It stays out of git: it holds this computer's own version of the words. */
export function writeGuide(bp: BoardPaths): string {
  const file = path.join(bp.squadDir, GUIDE_FILE);
  const text = guideText(bp);
  let old: string | undefined;
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {
    // Not written yet.
  }
  if (old !== text) fs.writeFileSync(file, text, 'utf8');
  keepOutOfGit(bp);
  return file;
}

function keepOutOfGit(bp: BoardPaths): void {
  if (!isRepo(bp.root)) return;
  const common = git(bp.root, ['rev-parse', '--git-common-dir'], { allowFail: true });
  const top = git(bp.root, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!common || !top) return;
  const exclude = path.join(path.resolve(bp.root, common), 'info', 'exclude');
  const line = `/${path.relative(fs.realpathSync(top), fs.realpathSync(path.join(bp.squadDir, GUIDE_FILE))).split(path.sep).join('/')}`;
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim() === line)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8');
}

/** How a conversation runs squad-kit on this computer: by name when it is installed, else by its full path. */
export function squadCommand(): string {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['squad'], { stdio: 'ignore' });
    return 'squad';
  } catch {
    const cli = process.argv[1];
    return cli ? `"${process.execPath}" "${cli}"` : 'npx squad-kit';
  }
}

/** Where the story stands, and what comes next, in plain lines. */
export function whereAndNext(meta: Parameters<typeof copiesOf>[0], t: Ticket): { done: string[]; next: string } {
  const done: string[] = [];
  if (hasSpec(t)) done.push(t.specApproved ? 'The spec is written and approved.' : 'The spec is written, and not approved yet.');
  if (hasDesign(t)) done.push(t.takenOver?.free?.designApproved || t.decision?.adr || ['implement', 'test', 'review'].includes(t.stage) ? 'The design is written and approved.' : 'The design is written, and not approved yet.');
  const copies = copiesOf(meta, t);
  if (copies.length) done.push(`The copy of the code: ${copies.map((c) => c.dir).join(', ')}, on the branch ${t.branch ?? 'of the story'}.`);
  if (t.stage === 'test' || t.stage === 'review') done.push('The code is built.');
  let next = 'Write the spec, after any questions you have.';
  if (hasSpec(t) && !t.specApproved) next = 'Show the spec to the person. When they approve it, record that.';
  else if (hasSpec(t) && !hasDesign(t)) next = 'Write the design.';
  else if (hasDesign(t) && !copies.length && !t.takenOver?.free?.designApproved && !t.decision?.adr) next = 'Show the design to the person. When they approve it, record that.';
  else if (hasDesign(t) && !copies.length) next = 'Make the copy and build it.';
  else if (copies.length) next = 'Build what is left in the copy, run the checks, review the change, and show the person how to try it.';
  return { done, next };
}

/** Why the squad stopped on it, and what is still open, so the conversation starts where the story is. */
function openPoints(t: Ticket): string[] {
  const out: string[] = [];
  if (t.stuck) out.push(`It stopped here: ${t.stuck.question}`);
  for (const n of t.reviewNotes ?? []) out.push(`The Reviewer asked for this: ${n}`);
  if (t.changeRequest) out.push(`The person asked for this change: ${t.changeRequest}`);
  if (t.setupTrouble) out.push(`Setting up the copy failed on this computer (${t.setupTrouble.command}). Sort that out first.`);
  if (t.notes?.length) out.push(`People added notes: read notes.md.`);
  return out;
}

/** The prompt a person copies. With no story: start a new one. */
export function outsidePrompt(bp: BoardPaths, t?: Ticket): string {
  const meta = readMeta(bp);
  const guide = writeGuide(bp);
  const run = squadCommand();
  const head = `You are working in the project at ${bp.root}. It uses squad-kit, which keeps its stories in the .squad folder. Instead of squad-kit's own agents, you run this story here, in this conversation.

First read ${guide} and follow it exactly. It has the steps, the commands, and the exact shape of each file.

Run squad-kit's commands from ${bp.root}${run === 'squad' ? '' : `. Write them as ${run}, where the guide says squad`}.`;
  if (!t) {
    return `${head}

This is a new story. If I have not said what I want yet, ask me. Then start it with the guide's first step, and go through the steps. Stop and ask me where the guide says to.`;
  }
  const { done, next } = whereAndNext(meta, t);
  const open = openPoints(t);
  return `${head}

The story: ${t.id}, "${t.title}". Its folder is ${ticketDir(bp, t.id)}. What was asked is in ticket.md there.
${done.length ? `\nWhere it is now:\n${done.map((d) => `- ${d}`).join('\n')}\n` : ''}${open.length ? `\nStill open:\n${open.map((d) => `- ${d}`).join('\n')}\n` : ''}
Next: ${next}

Go on through the steps from there. Stop and ask me where the guide says to. When we are done, or when I tell you, hand it back: squad outside back ${t.id}`;
}

export interface OutsideLook {
  ticket: Ticket | null;
  problems: { file: string; problem: string }[];
}

/** A story's files as squad-kit reads them: what is wrong in which file, for the agent that wrote them. */
export function lookAtFiles(bp: BoardPaths, id: string): OutsideLook {
  const folder = ticketDir(bp, id);
  const known = ['ticket.md', 'spec.md', 'questions.md', 'design.md', 'notes.md', 'proof.md'];
  const docs: TicketDocs = {};
  const problems: { file: string; problem: string }[] = [];
  if (!fs.existsSync(folder)) return { ticket: null, problems: [{ file: id.toUpperCase(), problem: 'There is no story with that id.' }] };
  for (const e of fs.readdirSync(folder)) {
    if (known.includes(e)) docs[e] = fs.readFileSync(path.join(folder, e), 'utf8').replace(/\r\n/g, '\n');
    else if (e.endsWith('.md')) problems.push({ file: e, problem: 'squad-kit does not read this file, so what it says will not show on the board. Its files are spec.md, questions.md and design.md.' });
  }
  let ticket: Ticket | null = null;
  try {
    ticket = readTicket(bp, id);
  } catch (err) {
    if (!(err instanceof UnreadableTicket)) throw err;
    problems.push({ file: err.file, problem: err.detail });
  }
  problems.push(...shapeTroubles(docs));
  return { ticket, problems };
}

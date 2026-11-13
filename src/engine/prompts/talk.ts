import type { AgentName, BoardMeta, ChatMessage, Decision, Ticket } from '../../board/types.js';
import { pagesOf, squadWorks, waitsAtReview, whereItStands } from '../../board/at-review.js';
import { asData, doneWhen, LOOK, projectContext, type PromptContext, ticketContext } from './context.js';

/**
 * "Something is wrong" on the overview: the person tells the Architect what it got wrong. The Architect talks and
 * reads only; the person then has it read the project again with what they said.
 */
export function overviewTalkPrompt(meta: BoardMeta, decisions: Decision[], understood: string, messages: ChatMessage[]): string {
  const last = messages.at(-1);
  const head =
    last?.who === 'you'
      ? `The person says: "${last.text}"`
      : 'The person pressed "Something is wrong" on the overview. Open the talk: in two short lines, ask what squad-kit got wrong.';
  const found = decisions.filter((d) => !d.replacedBy).map((d) => `- ${d.id} ${d.title}${d.proposed ? ' (proposed, not approved yet)' : ''}`).join('\n') || '- (none)';
  return `You are the Architect of a software squad. You read project ${meta.project} and wrote an overview of it for the
person to check before the first ticket. They think something in it is wrong.

${asData('What you wrote about the project', understood)}

The rules you found in the code:
${found}${earlierTalk(messages.slice(0, -1))}

${head}

Rules for this talk:
- Answer in plain words, in the person's language, in a few short lines. Ask one question at a time.
- Do not write or change any files. Read the code only when it helps you answer.
- Say plainly what you would change in the overview or the rules. When you both agree, tell the person to press
  "Read it again with this": you then read the project again with what they said.
- Set "ready" to true once you know what to change.
${LOOK}`;
}

/** The answer was missing or did not fit its shape: the agent hands it in again, in the same conversation. */
export function answerAgainPrompt(problem: string, help?: string): string {
  return `squad-kit did not get a complete answer from you (${problem}). Do not do the work again: hand in your whole answer now, in the shape this step asks for.${help ? `\n${help}` : ''}`;
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
export function chatPrompt(agent: string, message: string | null, next: string, attached = '', beside = false): string {
  const head = message === null
    ? beside
      ? `The person wants to ask you about this ticket. You are ${CHAT_ROLE[agent] ?? agent}.
Open the talk: say in two or three short lines where the ticket is now, then ask what they want to know.`
      : `The person wants to talk this ticket through with you before you go on. You are ${CHAT_ROLE[agent] ?? agent}.
Open the talk: say in a few short lines what you understand so far and where you are, then ask about what is most unclear.`
    : `The person says: "${message}"${attached ? `\n${attached}` : ''}`;
  return `${head}

Rules for this talk:
- Answer in plain words, in the person's language, in a few short paragraphs at most. Ask one or two questions at a time.
- Do not write or change any files. Read the code only when it helps you answer, with your read, find and search
  tools; in the shell only simple read commands work, and anything else is refused.
- ${beside ? next : `Do not start the next step yourself. ${next}`}
- ${beside ? 'Set "ready" to false.' : 'Set "ready" to true only when you think you understand enough for that next step; say so in your reply.'}
- The reply is Markdown: short lists, tables, checklists and code blocks are fine. A flow can be a \`\`\`mermaid flowchart.
- When you ask one question with clear answers, put up to 4 short answers in "options", your recommended one first.
- To show the person a picture, recording, PDF, Markdown file or HTML mockup that already exists in this ticket's folders, put its full path in "files".`;
}

/**
 * What a talk beside the work can do, told to the agent so it can say so. `review` is a ticket that waits for the
 * person's check: the proof is ready, or it stopped at a gate. `stands` is where a ticket the squad is not working on
 * stands now ("RO-7 waits in the queue"): Ask a question leaves it there.
 */
export function besideNext(released: boolean, review?: 'proof' | 'stuck', stands?: string): string {
  if (released) {
    return 'This ticket is accepted, so this talk is for questions only: nothing said here changes it. A change becomes a new linked ticket or a bug report; tell the person to press "Propose a change" for that.';
  }
  if (review === 'proof') {
    return 'This ticket waits for the person to check the work, and nothing is merged yet. This talk is for questions only: nothing said here changes the ticket or moves it on. When they want something changed, tell them to press "Something\'s wrong" and say what. To click through the change themselves, "Try it yourself" runs this ticket\'s own copy of the app.';
  }
  if (review === 'stuck') {
    return 'This ticket stopped at a check and waits for the person to pick a way out on its card. This talk is for questions only: nothing said here changes the ticket or moves it on. To click through the change so far, "Try it yourself" runs this ticket\'s own copy of the app.';
  }
  if (stands) {
    return `This talk is for questions only: nothing said here changes the ticket or moves it on, and it stays where it is ("${stands}"). When the person wants something changed, tell them which of the ticket's own buttons on its card does it; never say this talk changed anything.`;
  }
  return 'This talk is beside the work: the squad keeps working, and nothing said here changes the ticket. To change what gets built, tell the person to press "Propose a change": the Analyst writes it into the spec and they approve it.';
}

/** What an agent needs to tell the person where to look in the app. */
export interface ReviewLook {
  /** The address of this ticket's own copy, only while it runs now. */
  tryUrl?: string;
  /** Try it yourself can start this ticket's copy now. */
  canTry?: boolean;
  /** The ticket is accepted: its change is in the app under Your apps. */
  accepted?: boolean;
  /** The files the ticket changed, in its own copy of the code. */
  changed: string[];
}

/**
 * Whether this ticket's own copy of the app runs right now, as a plain fact: with the one address that works, or that
 * none does and what the person does then. An agent never gives a local address it was not handed.
 */
export function copyNow(look: ReviewLook): string {
  const at = look.tryUrl?.replace(/\/+$/, '');
  if (at) return `This ticket's own copy of the app is running now, at ${at}. That is the one address that works: give full addresses there.`;
  const how = look.accepted
    ? 'tell the person to press Start under Your apps in the sidebar, then open the page'
    : look.canTry
      ? 'tell the person to press **Try it yourself**, then open the page'
      : 'tell the person it can be tried once the ticket waits for their check';
  return `This ticket's own copy of the app is NOT running now, so no address works. Never say the app is running, and never give a local address (localhost, 127.0.0.1 or a port), whatever the code, the README or the project's settings say. To see it, ${how}. Name each page by its path, like /book, and by what it is called.`;
}

/**
 * Where to look: whether the ticket's own copy runs now, each "done when" the Tester proved with the pages of its after
 * pictures, and the files it changed, for the agent to read the routes and answer "which page do I open?".
 */
export function whereToLook(t: Ticket, look: ReviewLook): string {
  const at = look.tryUrl?.replace(/\/+$/, '');
  const shots = (t.proof ?? []).map((p) => {
    const pages = pagesOf(p);
    return `  - "${p.criterion}": ${pages.length ? `${pages.length > 1 ? 'pages' : 'page'} ${pages.join(', ')}` : 'no page saved'}`;
  });
  const first = (t.proof ?? []).flatMap(pagesOf)[0];
  const lines = [
    'Where to look in the app. The person will ask which page to open and what to do there.',
    `- ${copyNow(look)}`,
    ...(shots.length ? ['- The proof, with the pages its after pictures were taken on:', ...shots] : ['- No screenshots were taken, so no page is saved: find the pages in the code.']),
    ...(look.changed.length
      ? [`- The files this ticket changed${t.worktree ? `, in its copy of the code (${t.storyDir ?? t.worktree})` : ''}:`, ...look.changed.map((f) => `  - ${f}`)]
      : ['- No changed files could be read.']),
    `Read the routes or pages in those files to find which page shows each change.${at ? ` Give full addresses the person can open${first ? `, like ${at}${first}` : `, starting with ${at}`}.` : ''} Say what to click or type there.`,
  ];
  return lines.join('\n');
}

/**
 * The opening of a talk beside the work, in a side conversation of its own: who the agent is, the ticket as it stands,
 * and where the squad is right now, said plainly in every state. `look` is where to look in the app, when the ticket
 * has a copy of the code or pages in its proof. The conversation that does the work is never touched.
 */
export function besidePrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, agent: AgentName, released: boolean, ctx?: PromptContext, look?: ReviewLook): string {
  const steps = (t.steps ?? []).map((s, i) => `${i + 1}. ${s.title} (${s.status === 'done' ? 'done' : s.status === 'doing' ? 'doing now' : 'to do'})`).join('\n');
  const recent = t.activity.slice(0, 8).map((a) => `- ${a.who}: ${a.text}`).join('\n');
  const where = released
    ? `This ticket is ${t.stage === 'done' ? 'released' : 'accepted'}${t.release ? ` (${t.release})` : ''}.`
    : waitsAtReview(t)
      ? t.waiting?.kind === 'proof'
        ? "The work on this ticket is done and waits for the person to check it: Looks right merges it, Something's wrong sends it back to the Builder. Nothing is merged yet."
        : 'This ticket stopped at a check and waits for the person to decide how to go on. Nothing is merged yet.'
      : squadWorks(t)
        ? 'The squad is working on this ticket right now, and goes on while you talk.'
        : `Where the ticket stands, as the person sees it: "${whereItStands(t)}". Talking here never moves it or changes it.`;
  return `You are ${CHAT_ROLE[agent] ?? agent}. ${where}
Read the project${t.worktree ? ` and the ticket's copy of the code (${t.storyDir ?? t.worktree})` : ''} when it helps you answer. Do not write or change any files.

${projectContext(meta, decisions, { rules: [], ...ctx, noAddress: true })}

${ticketContext(t)}

${t.story ? `The spec:\nStory: ${t.story}\nDone when:\n${doneWhen(t)}` : 'There is no spec yet.'}${t.decision ? `\n\nDecision: ${t.decision.title}. Why: ${t.decision.why}` : ''}${steps ? `\n\nThe design, step by step:\n${steps}` : ''}

Where it is now: ${t.status}
Latest activity:
${recent || '- (none yet)'}
${look ? `\n${whereToLook(t, look)}\n` : ''}
${LOOK}`;
}

/** What the person and the agent said earlier in a chat on this ticket, for a side conversation that starts fresh. */
export function earlierTalk(messages: ChatMessage[]): string {
  if (!messages.length) return '';
  return `\n\nEarlier in this chat (things may have moved on since):\n${messages.map((m) => `- ${m.who === 'you' ? 'The person' : m.who === 'squad' ? 'squad-kit' : 'You'}: ${m.text.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n')}`;
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

import type { BoardMeta, Decision, Question, Ticket } from '../../board/types.js';
import { asData, LOOK, PLAIN, projectContext, type PromptContext, rulesText, ticketContext } from './context.js';

export function intakePrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, ctx?: PromptContext): string {
  return `You are the Analyst and the Architect of a software squad. A person wrote the ticket below.
Read the project to understand it (it may be empty). Do not write or change any files.

${projectContext(meta, decisions, ctx)}

${ticketContext(t)}

Your job now: ask the person only the questions whose answers change what gets built or how.
- The Analyst asks about the business: who uses it, what rules apply, what "done" looks like.
- The Architect asks business questions that decide the technical design, for example "do staff share computers?",
  never "which database?". ${
    meta.scan?.empty
      ? 'This project has no code yet: the Architect picks the technology itself when it plans this ticket, and asks nothing about it.'
      : `If no saved decision settles the technology this ticket needs, the Architect asks first:
  "Must you use a technology the client chose?" with options ["No, you choose", "Yes:"] and typedOption "Yes:".`
  }
- Each question has 2 to 4 short options. Use typedOption only for an option that needs a typed value.
- Each question has a kind: "gap" (something the business has not said that changes what gets built) or "clash" (two
  requirements that disagree). Ask about the business only: never about files, settings, commands, ports, installs or
  other technical things. Decide those yourself; squad-kit turns technical questions back to you.
- Ask at most 5 questions in total. If the ticket is already clear, ask none.
- summary: one sentence on what you understood.
${PLAIN}
${LOOK}`;
}

export function replyPrompt(q: Question, n: number, ask: string): string {
  const role = q.from === 'analyst' ? 'Analyst' : 'Architect';
  return `The person asks about your question ${n} ("${q.text}"): "${ask}"
Answer as the ${role} in 2 or 3 plain sentences. Explain why you ask and what each option would mean. Do not ask new questions and do not change files.`;
}

/** Turns a rough idea, a forwarded chat message or one line of business into a ticket the person checks before saving. */
export function draftPrompt(meta: BoardMeta, text: string, files: string[], ctx?: PromptContext): string {
  const attached = files.length ? `\nThe person also attached these files (read them, they may be screenshots of a chat):\n${files.map((f) => `- ${f}`).join('\n')}\n` : '';
  return `You are the Analyst of a software squad. A person pasted the text below: maybe an idea, a forwarded chat
message (WhatsApp or similar), or one line of business. Turn it into a clear ticket for project ${meta.project}.
You may read the project to use its real words and screens. Do not write or change any files.${rulesText(ctx)}

${asData('What the person pasted', text.trim() || '(no text, only the attached files)')}
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
Only use what the text says or the project shows. Write in the same language as the text. ${PLAIN}
${LOOK}`;
}

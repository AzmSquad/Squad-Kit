import type { BoardMeta, ChatMessage, Decision, SpecChange, Step, Ticket } from '../../board/types.js';
import { LOOK, PLAIN, projectContext, type PromptContext, STEP_LINE, theirLanguage, ticketContext } from './context.js';
import { hasKinds } from '../../board/proof-rows.js';
import { CHANGE_KINDS } from '../proof-kinds/prompts.js';

/** The parts a change touches, in words for an agent: what each said and what it says now. */
export function changeLines(c: SpecChange): string {
  return (c.parts ?? [])
    .map((p) => {
      const name = p.part === 'story' ? 'The story' : p.index === undefined ? 'A new "done when"' : `"Done when" ${p.index + 1}`;
      if (!p.before) return `- ${name}: "${p.after}"`;
      if (!p.after) return `- ${name} goes: it said "${p.before}"`;
      return `- ${name} said "${p.before}" and now says "${p.after}"`;
    })
    .join('\n');
}

function stepList(steps: Step[]): string {
  return steps.map((s, i) => `${i + 1}. ${s.title}${s.status === 'done' ? ' (built)' : s.status === 'doing' ? ' (being built)' : ''}`).join('\n');
}

/** The Analyst writes a change the person proposed into the approved spec, and says whether it is small or big. */
export function changePrompt(meta: BoardMeta, decisions: Decision[], t: Ticket, c: SpecChange, chat: ChatMessage[], ctx?: PromptContext): string {
  const criteria = (t.criteria ?? []).map((x, i) => `${i + 1}. Given ${x.given}, when ${x.when}, then ${x.then}.`).join('\n');
  const talk = chat.length
    ? `\nIt came from their chat with the ${c.from}. The last messages:\n${chat.map((m) => `- ${m.who === 'you' ? 'Person' : m.who}: ${m.text.slice(0, 600)}`).join('\n')}\n`
    : '';
  return `You are the Analyst of a software squad. The person wants to change the approved spec of the ticket below.
Read the project if it helps. Do not write or change any files.

${projectContext(meta, decisions, ctx)}

${ticketContext(t)}

The approved spec:
Story: ${t.story ?? '(none)'}
Done when:
${criteria || '(none)'}

${t.steps?.length ? `The approved design${t.decision ? ` (${t.decision.title})` : ''}, step by step:\n${stepList(t.steps)}` : 'There is no approved design yet.'}
Where the work is now: ${t.status}

The change the person proposes:
"${c.ask}"
${talk}
Write the change into the spec, as the Analyst:
- story: the whole new story when the change touches it, else an empty string.
- criteria: only the "done when" items that change. For each: number (its number above, or 0 for a new one), action
  ("change", "add" or "remove"), and the new given, when and then for change and add. Every change shows in the
  spec: at least one item here, or a new story.${hasKinds(t) ? `\n${CHANGE_KINDS}` : ''}
- size: "small" when the approved design still holds and the Builder can fit it into the work as it is (a wording, a
  limit, one more check on a screen it builds anyway). "big" when the design must change: a new screen or page, other
  data, a new technical decision, or steps to add or redo.
- why: one or two plain sentences on why it is small or big.
- summary: one line on what changes, like "The limit goes from 3 to 5 bookings a day".
${PLAIN}
${LOOK}`;
}

/**
 * A big change: the Builder paused after its step, and the Architect updates the design for it. Every step is marked,
 * so the Builder redoes only what the change touches.
 */
export function changeDesignPrompt(t: Ticket, c: SpecChange, fresh?: { meta: BoardMeta; decisions: Decision[]; ctx?: PromptContext }): string {
  // A new conversation needs the project and the ticket first; the Architect's own one has them already.
  const intro = fresh ? `You are the Architect of a software squad.\n\n${projectContext(fresh.meta, fresh.decisions, fresh.ctx)}\n\n${ticketContext(t)}\n\n` : '';
  return `${intro}The person approved a big change to the spec of ${t.id} (change ${c.id}): ${c.summary ?? c.ask}
${changeLines(c)}

The Builder has built part of the approved design${t.worktree ? ` in ${t.worktree}` : ''} and paused after its step. As the
Architect, update the design for this change. Read the code built so far first. Do not write or change any files.

The design now, step by step:
${stepList(t.steps ?? []) || '(no steps yet)'}

- steps: the whole new list of steps, in order, one sentence each. Mark each one: "same" when it stays as it is (keep
  its words exactly), "changed" when the Builder must redo it, "new" for a step to add. Leave out a step that is no
  longer needed. Change as little as you can: the Builder redoes only the changed and new steps.
- summary: one or two plain sentences on what changes in the design, and why.
${PLAIN}${theirLanguage(t)}
${LOOK}`;
}

/** A small change reaches the Builder at the start of its next step, before what that step was going to do. */
export function smallChangePrompt(c: SpecChange): string {
  return `The person approved a small change to the spec while you worked (change ${c.id}): ${c.summary ?? c.ask}
${changeLines(c)}

Print ">> change" first. Make it part of the work now, and keep everything else as it is. Then run the tests.`;
}

/** After a big change's design update is approved: the Builder redoes only the steps it touches. */
export function changeRedoPrompt(c: SpecChange, steps: Step[]): string {
  const redo = steps.flatMap((s, i) => (s.status === 'done' ? [] : [i + 1]));
  return `The person approved a big change to the spec (change ${c.id}): ${c.summary ?? c.ask}
${changeLines(c)}

The Architect updated the design for it${c.design?.summary ? `: ${c.design.summary}` : ''}. The person approved it. The steps now:
${steps.map((s, i) => `${i + 1}. ${s.title}${s.status === 'done' ? ' (done, keep it)' : ' (do it now)'}`).join('\n')}

Redo only ${redo.length === 1 ? 'step' : 'steps'} ${redo.join(', ')}. The other steps are done: leave their code as it is unless the change needs it.
${STEP_LINE} Then run the tests.`;
}

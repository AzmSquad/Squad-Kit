import path from 'node:path';
import { listDecisions, listTickets, readMeta, readTicket, type BoardPaths } from '../board/store.js';
import type { Ticket } from '../board/types.js';
import { STEPS, agentInstructions, readAgent, type AgentRole } from './agents.js';
import * as P from './prompts.js';
import { repoFor, rulesFiles } from './repos.js';

/**
 * The core prompts of a role, read only, filled in from a real ticket so the team sees exactly what the agent reads.
 * The team's own instructions for each step are shown next to them: they are added, never swapped in.
 */

export interface CorePrompt {
  step: string;
  name: string;
  prompt: string;
  /** What the team adds for this step (general and step instructions), as the agent gets it. */
  team: string;
}

/** A plain example ticket for boards with nothing written yet. */
function example(): Ticket {
  return {
    id: 'EXAMPLE',
    title: 'Limit bookings per day',
    ask: 'Clerks book too many slots for one person.',
    kind: 'feature',
    source: { type: 'manual' },
    priority: 'normal',
    stage: 'specs',
    status: '',
    waiting: null,
    createdAt: new Date().toISOString(),
    createdBy: 'you',
    activity: [],
    questions: [{ id: 'q1', from: 'analyst', text: 'How many bookings a day?', options: ['3', '5'], answer: { choice: '3' } }],
    story: 'As a clerk, I want at most 3 bookings a day per person, so one person cannot take every slot.',
    criteria: [{ given: 'a person with 3 bookings today', when: 'they book again', then: 'they see an error' }],
    steps: [
      { title: 'Add the count query', status: 'todo' },
      { title: 'Write the tests', status: 'todo' },
    ],
  };
}

/** The ticket asked for, else the newest one with a story, else an example. */
export function previewTicket(bp: BoardPaths, id?: string): Ticket {
  const asked = id ? readTicket(bp, id) : null;
  if (asked) return asked;
  const real = listTickets(bp)
    .filter((t) => t.story)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return real ?? example();
}

export function corePrompts(bp: BoardPaths, role: AgentRole, ticketId?: string): { ticket: { id: string; title: string }; prompts: CorePrompt[] } {
  const meta = readMeta(bp);
  const decisions = listDecisions(bp);
  const t = previewTicket(bp, ticketId);
  const root = path.dirname(path.dirname(bp.dir));
  const ctx: P.PromptContext = { rules: rulesFiles(root), repo: repoFor(meta, t) };
  const text: Record<string, () => string> = {
    questions: () => P.intakePrompt(meta, decisions, t, ctx),
    spec: () => P.specPrompt(t),
    scan: () => P.scanPrompt(meta, [], ctx),
    design: () => P.designPrompt(t, undefined, meta),
    build: () => P.buildPrompt(meta, decisions, t, ctx),
    fix: () =>
      [
        P.fixChecksPrompt([{ name: 'Tests', command: repoFor(meta, t).commands.test ?? 'npm test', output: '(the failing output goes here)' }]),
        P.reviewFixPrompt(['(the Reviewer\'s comments go here)']),
        P.changeFixPrompt('(what you found goes here)'),
      ].join('\n\n────────\n\n'),
    review: () => P.reviewPrompt(meta, decisions, t, 1, ctx),
    proof: () => P.proofPrompt(meta, t, '<the proof folder>', 'after', ctx),
  };
  const agent = readAgent(bp, role);
  return {
    ticket: { id: t.id, title: t.title },
    prompts: STEPS[role].map((s) => ({ step: s.id, name: s.name, prompt: text[s.id]?.() ?? '', team: agentInstructions(agent, s.id) })),
  };
}

import type { Quality, StuckChoice } from '../board/types.js';
import type { AgentUsage } from '../modules/ai-tool/types.js';
import type { StepCaps } from './levels.js';

/**
 * A step that reached one of its caps (turns or spend, from the Quality setting) is not a failed try: the work so far
 * is kept, and the person picks Give it more (the same step goes on with twice the caps) or Stop.
 */

const QUALITY_NAME: Record<Quality, string> = { best: 'Best', balanced: 'Balanced', thrifty: 'Thrifty' };

/** Thrown when a run stopped on a cap. The ticket shows the cap card instead of an error. */
export class CapReached extends Error {
  constructor(
    readonly role: string,
    readonly step: string,
    readonly by: 'turns' | 'spend',
    readonly caps: StepCaps,
    readonly quality: Quality,
    /** The role for people: "Builder". */
    readonly who: string,
    /** The run it ended: its conversation, to carry on in, and what it used. */
    readonly run?: { sessionId?: string; usage?: AgentUsage },
  ) {
    super(capWords(who, by, caps, quality));
    this.name = 'CapReached';
  }
}

/** "The Builder used the 300 turns one step may take on Best, so squad-kit paused it." */
export function capWords(who: string, by: 'turns' | 'spend', caps: StepCaps, quality: Quality): string {
  const what = by === 'turns' ? `used the ${caps.turns} turns one step may take` : `reached the $${caps.spendUsd} one step may spend`;
  return `The ${who} ${what} on ${QUALITY_NAME[quality]}, so squad-kit paused it. Its work so far is kept.`;
}

/** The card for a step paused on a cap: two ways out, both safe. */
export function capCard(cap: CapReached): StuckChoice {
  return {
    gate: 'cap',
    question: cap.message,
    options: [
      { do: 'more', name: 'Give it more', note: 'It carries on where it stopped, with twice the turns and spend for this step.' },
      { do: 'stop', name: 'Stop', note: 'Leave it here. Nothing is lost: you can carry on later, fix it yourself or send it back to the plan.' },
    ],
  };
}

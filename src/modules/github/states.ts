import type { ItemStage } from '../tracker/types.js';
import { STAGES } from './settings.js';

/**
 * squad-kit's four stages on a Project board's Status options. Each stage takes the option whose name fits it best
 * (To do, In progress, Done…); the person can pick another in Settings. Items only ever move forward.
 */

const WORDS: Record<ItemStage, RegExp[]> = {
  'not-started': [/^to ?do$/i, /^backlog$/i, /^(new|ready|open|not started)$/i, /to ?do|backlog|ready|new/i],
  'in-progress': [/^in progress$/i, /^(doing|active)$/i, /progress|doing|active|working|building/i],
  resolved: [/^(resolved|merged)$/i, /merged|resolved|ready for release/i, /^done$/i, /done|complete/i],
  closed: [/^(closed|released)$/i, /released|closed|shipped/i, /^done$/i, /done|complete/i],
};

/** The option that fits a stage best, by name. */
export function bestOption(stage: ItemStage, options: string[]): string | undefined {
  for (const word of WORDS[stage]) {
    const hit = options.find((o) => word.test(o.trim()));
    if (hit) return hit;
  }
  return undefined;
}

/** The option for each stage: the person's choice when the board still has it, else the best fit. */
export function stageOptions(options: string[], chosen: Partial<Record<ItemStage, string>>): Partial<Record<ItemStage, string>> {
  const has = (o: string | undefined) => options.find((x) => x.toLowerCase() === o?.toLowerCase());
  return Object.fromEntries(STAGES.map((s) => [s, has(chosen[s]) ?? bestOption(s, options)]).filter(([, o]) => o));
}

/** How far along an option is: the furthest stage it stands for, or between them by its place in the list. */
function rankOf(option: string, map: Partial<Record<ItemStage, string>>, options: string[]): number {
  const stages = STAGES.filter((s) => map[s]?.toLowerCase() === option.toLowerCase());
  if (stages.length) return STAGES.indexOf(stages[stages.length - 1]!);
  // Not one of the four: it sits after the last mapped option above it in the board's own order.
  const at = options.findIndex((o) => o.toLowerCase() === option.toLowerCase());
  let rank = -1;
  for (const s of STAGES) {
    const i = options.findIndex((o) => o.toLowerCase() === map[s]?.toLowerCase());
    if (i >= 0 && i < at) rank = STAGES.indexOf(s);
  }
  return rank + 0.5;
}

/** The option to set for a stage, or null when the item is there or further on already. */
export function forwardTo(stage: ItemStage, current: string | null | undefined, options: string[], map: Partial<Record<ItemStage, string>>): string | null {
  const target = map[stage];
  if (!target) return null;
  if (!current) return target;
  return rankOf(current, map, options) >= STAGES.indexOf(stage) ? null : target;
}

/** Whether an option means the work is merged or released: such items are not in the backlog any more. */
export function isFinished(option: string | null | undefined, map: Partial<Record<ItemStage, string>>, options: string[]): boolean {
  return Boolean(option) && rankOf(option!, map, options) >= STAGES.indexOf('resolved');
}

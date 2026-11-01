import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { EFFORTS, MODEL_LEVELS, type Effort, type ModelLevel } from '../modules/ai-tool/types.js';
import { squadHome } from '../core/home.js';

/**
 * Which model level each step runs on (ADR-001, section 3): strong models where a mistake is expensive, cheaper ones
 * where the work is already well defined. Three layers, the last one set wins: squad-kit's defaults, the project's
 * choices (in its agent files) and each person's own (in ~/.squad-kit/settings.yaml).
 */

export interface LevelChoice {
  level?: ModelLevel;
  effort?: Effort;
  /** An exact model; wins over the level. */
  model?: string;
}

/** One layer's choices, by role ("builder") or by role and step ("builder.fix"); a step's choice beats its role's. */
export type LevelOverrides = Record<string, LevelChoice>;

export type LevelSource = 'squad-kit' | 'project' | 'you';

export interface ResolvedLevel {
  level: ModelLevel;
  effort?: Effort;
  model?: string;
  from: LevelSource;
  /** Why squad-kit changed its own default for this run. */
  why?: string;
}

const strong = (effort: Effort): LevelChoice => ({ level: 'strongest', effort });
const balanced = (effort: Effort): LevelChoice => ({ level: 'balanced', effort });
const fast = (effort: Effort): LevelChoice => ({ level: 'fast', effort });

/**
 * squad-kit's defaults per role and step. They ship inside squad-kit and improve with each release. Besides the
 * roles' own steps: "chat" is talking a ticket through, "draft" is filling in a new ticket from pasted text.
 */
export const DEFAULT_LEVELS: Record<string, Record<string, LevelChoice>> = {
  analyst: { questions: strong('high'), spec: strong('high'), chat: strong('medium'), draft: fast('low') },
  architect: { scan: strong('medium'), design: strong('high'), blueprint: strong('high'), chat: strong('medium') },
  builder: { build: balanced('medium'), fix: balanced('medium'), chat: balanced('medium') },
  reviewer: { review: strong('medium'), chat: strong('medium') },
  tester: { proof: fast('low'), chat: fast('low') },
};

/** The Builder's fixes run on the strongest level from this failed try on. */
export const STEP_UP_AFTER_TRIES = 2;

export interface LevelContext {
  role: string;
  step: string;
  /** Express track: little to decide, so every role runs balanced. */
  express?: boolean;
  /** Failed check runs so far. */
  tries?: number;
}

function choiceIn(layer: LevelOverrides | undefined, role: string, step: string): LevelChoice | undefined {
  const forRole = layer?.[role];
  const forStep = layer?.[`${role}.${step}`];
  if (!forRole && !forStep) return undefined;
  return { ...forRole, ...forStep };
}

export function resolveLevel(ctx: LevelContext, project?: LevelOverrides, person?: LevelOverrides): ResolvedLevel {
  const base = ctx.express ? balanced('medium') : (DEFAULT_LEVELS[ctx.role]?.[ctx.step] ?? balanced('medium'));
  let r: ResolvedLevel = { level: base.level!, ...(base.effort ? { effort: base.effort } : {}), from: 'squad-kit', ...(ctx.express ? { why: 'Express track' } : {}) };
  for (const [layer, from] of [
    [project, 'project'],
    [person, 'you'],
  ] as const) {
    const c = choiceIn(layer, ctx.role, ctx.step);
    if (!c || (!c.level && !c.effort && !c.model)) continue;
    r = { ...r, ...(c.level ? { level: c.level } : {}), ...(c.effort ? { effort: c.effort } : {}), ...(c.model ? { model: c.model } : {}), from };
    delete r.why;
  }
  // Cheap first, strong only when needed: a fix that keeps failing gets the strongest level, unless someone pinned a model.
  if (ctx.step === 'fix' && (ctx.tries ?? 0) >= STEP_UP_AFTER_TRIES && !r.model && r.level !== 'strongest') {
    r = { ...r, level: 'strongest', effort: 'high', why: `after ${ctx.tries} failed tries` };
  }
  return r;
}

/** One run's model in words: "Sonnet (balanced, medium effort)", and who chose it when it was not squad-kit. */
export function describeLevel(r: ResolvedLevel, tool: { modelFor(level: ModelLevel): string; supportsEffort: boolean }): string {
  const model = r.model || tool.modelFor(r.level) || `the ${r.level} model`;
  const parts = [r.model ? 'pinned' : r.level, ...(r.effort && tool.supportsEffort ? [`${r.effort} effort`] : []), ...(r.from === 'project' ? ['set by the project'] : r.from === 'you' ? ['set by you'] : []), ...(r.why ? [r.why] : [])];
  return `${model} (${parts.join(', ')})`;
}

/** A level or effort written by a person, or undefined when it is not one. */
export function parseLevel(v: string | undefined): ModelLevel | undefined {
  return MODEL_LEVELS.find((l) => l === v?.trim().toLowerCase());
}

export function parseEffort(v: string | undefined): Effort | undefined {
  return EFFORTS.find((e) => e === v?.trim().toLowerCase());
}

/* ── This person's own choices, on this computer ─────────── */

export { squadHome } from '../core/home.js';

interface PersonSettings {
  levels?: LevelOverrides;
}

function personFile(): string {
  return path.join(squadHome(), 'settings.yaml');
}

function readPerson(): PersonSettings {
  try {
    return (yaml.load(fs.readFileSync(personFile(), 'utf8')) as PersonSettings) ?? {};
  } catch {
    return {};
  }
}

/** This person's own level choices, for every project on this computer. */
export function personLevels(): LevelOverrides {
  return readPerson().levels ?? {};
}

/** Sets or clears this person's choice for a role or one of its steps. Empty fields are cleared. */
export function setPersonLevel(key: string, choice: LevelChoice): LevelOverrides {
  const s = readPerson();
  const levels = { ...s.levels };
  const clean: LevelChoice = {
    ...(choice.level ? { level: choice.level } : {}),
    ...(choice.effort ? { effort: choice.effort } : {}),
    ...(choice.model?.trim() ? { model: choice.model.trim() } : {}),
  };
  if (Object.keys(clean).length) levels[key] = clean;
  else delete levels[key];
  fs.mkdirSync(squadHome(), { recursive: true });
  fs.writeFileSync(personFile(), yaml.dump({ ...s, levels }), 'utf8');
  return levels;
}

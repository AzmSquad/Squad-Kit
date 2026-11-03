import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { EFFORTS, MODEL_LEVELS, type Effort, type ModelLevel } from '../modules/ai-tool/types.js';
import type { Quality } from '../board/types.js';
import { squadHome } from '../core/home.js';

/**
 * Which model level each step runs on (ADR-001, section 3): strong models where a mistake is expensive, cheaper ones
 * where the work is already well defined. Three layers, the last one set wins: squad-kit's defaults for the project's
 * Quality setting, the project's choices (in its agent files) and each person's own (in ~/.squad-kit/settings.yaml).
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
 * Thrifty: squad-kit's levels from before the Quality setting. A lighter model builds; the strongest one asks, designs
 * and reviews. Besides the roles' own steps: "chat" is talking a ticket through, "draft" is filling in a new ticket from
 * pasted text. Reading the project (scan, blueprint) is well-defined work, so it runs balanced in every setting.
 */
const THRIFTY: Record<string, Record<string, LevelChoice>> = {
  analyst: { questions: strong('high'), spec: strong('high'), chat: strong('medium'), draft: fast('low') },
  architect: { scan: balanced('medium'), design: strong('high'), blueprint: balanced('medium'), chat: strong('medium') },
  builder: { build: balanced('medium'), fix: balanced('medium'), chat: balanced('medium') },
  reviewer: { review: strong('medium'), chat: strong('medium') },
  tester: { proof: fast('low'), chat: fast('low') },
};

/** Best: the strongest model builds and reviews, at high effort. */
const BEST: Record<string, Record<string, LevelChoice>> = {
  ...THRIFTY,
  builder: { ...THRIFTY.builder, build: strong('high'), fix: strong('high') },
  reviewer: { ...THRIFTY.reviewer, review: strong('high') },
};

/** Balanced: the strongest model builds at medium effort. */
const BALANCED: Record<string, Record<string, LevelChoice>> = {
  ...BEST,
  builder: { ...THRIFTY.builder, build: strong('medium'), fix: strong('medium') },
};

interface Preset {
  /** Each role's level per step. */
  levels: Record<string, Record<string, LevelChoice>>;
  /** The Express track has little to decide: each role's level for every step of it. */
  express: Record<string, LevelChoice>;
  /** The Builder's level once this many of its runs failed on a ticket. */
  stepUp: { after: number; to: LevelChoice };
  /** The Reviewer never runs on a weaker level or effort than the Builder. */
  reviewerFloor: boolean;
}

/** The Express track on Best and Balanced: the plan and the build on balanced at high, the review still on the strongest. */
const EXPRESS: Record<string, LevelChoice> = { analyst: balanced('high'), architect: balanced('high'), builder: balanced('high'), reviewer: strong('high'), tester: fast('low') };

/** squad-kit's defaults for each Quality setting. They ship inside squad-kit and improve with each release. */
export const QUALITY_PRESETS: Record<Quality, Preset> = {
  best: { levels: BEST, express: EXPRESS, stepUp: { after: 1, to: strong('xhigh') }, reviewerFloor: true },
  balanced: { levels: BALANCED, express: EXPRESS, stepUp: { after: 1, to: strong('high') }, reviewerFloor: true },
  thrifty: {
    levels: THRIFTY,
    express: Object.fromEntries(Object.keys(THRIFTY).map((role) => [role, balanced('medium')])),
    stepUp: { after: 2, to: strong('high') },
    reviewerFloor: false,
  },
};

export const QUALITIES: Quality[] = ['best', 'balanced', 'thrifty'];
/** Most people run squad-kit on a subscription, where a stronger model uses the plan's limits, not more money. */
export const DEFAULT_QUALITY: Quality = 'best';

/** Each setting in one line, for people. */
export const QUALITY_NOTE: Record<Quality, string> = {
  best: "The strongest model builds and reviews. Uses your plan's limits faster.",
  balanced: 'The strongest model at medium effort.',
  thrifty: 'A lighter model builds. Cheapest.',
};

/** squad-kit's defaults per role and step, for the default Quality setting. Every setting has the same steps. */
export const DEFAULT_LEVELS = QUALITY_PRESETS[DEFAULT_QUALITY].levels;

export interface LevelContext {
  role: string;
  step: string;
  /** The project's Quality setting; best when left out. */
  quality?: Quality;
  /** Express track: little to decide, so roles run lighter. */
  express?: boolean;
  /** The Builder's failed runs on this ticket so far: the run itself failed, or the checks or the Reviewer turned it back. */
  fails?: number;
  /** For the Reviewer: the level the Builder runs on now (see builderLevel). */
  builder?: LevelChoice;
}

function choiceIn(layer: LevelOverrides | undefined, role: string, step: string): LevelChoice | undefined {
  const forRole = layer?.[role];
  const forStep = layer?.[`${role}.${step}`];
  if (!forRole && !forStep) return undefined;
  return { ...forRole, ...forStep };
}

/** squad-kit's own level for a step, before the project's and the person's choices. */
export function standardLevel(ctx: Pick<LevelContext, 'role' | 'step' | 'quality' | 'express'>): LevelChoice {
  const preset = QUALITY_PRESETS[ctx.quality ?? DEFAULT_QUALITY];
  return (ctx.express ? preset.express[ctx.role] : undefined) ?? preset.levels[ctx.role]?.[ctx.step] ?? balanced('medium');
}

/** A choice raised to at least the floor's level and effort, each on its own. */
function atLeast<T extends LevelChoice>(c: T, floor: LevelChoice): T {
  const up = <V>(list: V[], v: V | undefined, min: V | undefined) => (min !== undefined && (v === undefined || list.indexOf(min) < list.indexOf(v)) ? min : v);
  const level = up(MODEL_LEVELS, c.level, floor.level);
  const effort = up(EFFORTS, c.effort, floor.effort);
  return { ...c, ...(level ? { level } : {}), ...(effort ? { effort } : {}) };
}

export function resolveLevel(ctx: LevelContext, project?: LevelOverrides, person?: LevelOverrides): ResolvedLevel {
  const preset = QUALITY_PRESETS[ctx.quality ?? DEFAULT_QUALITY];
  const base = standardLevel(ctx);
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
  // Cheap first, strong only when needed: a Builder run that failed (its own run, the checks or the review) makes the
  // next one stronger, unless someone pinned a model. A project with no tests never fails a check, so any failure counts.
  const fails = ctx.fails ?? 0;
  if (ctx.role === 'builder' && (ctx.step === 'build' || ctx.step === 'fix') && fails >= preset.stepUp.after && !r.model) {
    const up = atLeast(r, preset.stepUp.to);
    if (up.level !== r.level || up.effort !== r.effort) r = { ...up, why: `after ${fails} failed ${fails === 1 ? 'try' : 'tries'}` };
  }
  // A second opinion is only worth it from a model at least as strong as the one that did the work.
  if (ctx.role === 'reviewer' && ctx.step === 'review' && preset.reviewerFloor && ctx.builder && !r.model) {
    const up = atLeast(r, ctx.builder);
    if (up.level !== r.level || up.effort !== r.effort) r = { ...up, why: 'as strong as the Builder' };
  }
  return r;
}

/** The strongest level the Builder runs on for a ticket now, over its build and fix steps: the Reviewer's floor. */
export function builderLevel(ctx: Omit<LevelContext, 'role' | 'step' | 'builder'>, project?: LevelOverrides, person?: LevelOverrides): LevelChoice {
  const runs = ['build', 'fix'].map((step) => resolveLevel({ ...ctx, role: 'builder', step }, project, person)).filter((r) => !r.model);
  return runs.reduce<LevelChoice>((floor, r) => atLeast(floor, { level: r.level, ...(r.effort ? { effort: r.effort } : {}) }), {});
}

/** Every tool with efforts takes these; extra high only where its module says so. */
const BASIC_EFFORTS: Effort[] = ['high', 'medium', 'low'];

type EffortTool = { supportsEffort: boolean; efforts?: readonly Effort[] };

/** The efforts a tool takes, hardest first; none when it has no effort setting. */
export function toolEfforts(tool: EffortTool): Effort[] {
  if (!tool.supportsEffort) return [];
  return EFFORTS.filter((e) => (tool.efforts ?? BASIC_EFFORTS).includes(e));
}

/** The effort a step runs on with a tool: the one asked for, or the next one down that the tool has. */
export function effortOn(tool: EffortTool, effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined;
  const has = toolEfforts(tool);
  return EFFORTS.slice(EFFORTS.indexOf(effort)).find((e) => has.includes(e));
}

/** An effort in words: "extra high" for xhigh. */
export function effortName(e: Effort): string {
  return e === 'xhigh' ? 'extra high' : e;
}

/** One run's model in words: "Sonnet (balanced, medium effort)", and who chose it when it was not squad-kit. */
export function describeLevel(r: ResolvedLevel, tool: { modelFor(level: ModelLevel): string } & EffortTool): string {
  const model = r.model || tool.modelFor(r.level) || `the ${r.level} model`;
  const effort = effortOn(tool, r.effort);
  const parts = [r.model ? 'pinned' : r.level, ...(effort ? [`${effortName(effort)} effort`] : []), ...(r.from === 'project' ? ['set by the project'] : r.from === 'you' ? ['set by you'] : []), ...(r.why ? [r.why] : [])];
  return `${model} (${parts.join(', ')})`;
}

/** A level, effort or Quality setting written by a person, or undefined when it is not one. */
export function parseLevel(v: string | undefined): ModelLevel | undefined {
  return MODEL_LEVELS.find((l) => l === v?.trim().toLowerCase());
}

export function parseEffort(v: string | undefined): Effort | undefined {
  const s = v?.trim().toLowerCase();
  return s === 'extra high' || s === 'extra-high' ? 'xhigh' : EFFORTS.find((e) => e === s);
}

export function parseQuality(v: string | undefined): Quality | undefined {
  return QUALITIES.find((q) => q === v?.trim().toLowerCase());
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

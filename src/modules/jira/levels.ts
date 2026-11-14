import { ModuleError } from '../errors.js';
import type { ItemLevel, TrackerLevels } from '../tracker/types.js';
import type { IssueType, JiraContext } from './context.js';

/**
 * Which of the project's own issue types a breakdown's levels become. Jira nests three levels on every site: Epic, then
 * Story or Task, then Sub-task. So an epic is an Epic, a feature a Story (or Task) under it, and a story a Sub-task under
 * its feature. A story straight under an epic (a breakdown without features) is a Story under the Epic, as Jira only
 * puts a Sub-task under a Story. Levels some sites have above Epic are not used. No type is made up: a project without
 * one of these is told so before anything is sent.
 */

interface LevelPlan {
  epic: IssueType;
  /** The project's Story type, else Task: what features become, and stories straight under an epic. */
  standard: IssueType;
  /** Its Sub-task type, when the site has sub-tasks on. */
  subtask?: IssueType;
  /** Its Bug type, when it has one. */
  bug?: IssueType;
}

const pick = (types: IssueType[], ...names: RegExp[]) => names.map((re) => types.find((t) => re.test(t.name.trim()))).find(Boolean) ?? types[0];

function planOf(types: IssueType[], project: string): LevelPlan {
  const epic = pick(types.filter((t) => t.level === 1 && !t.subtask), /^epic$/i);
  const standards = types.filter((t) => t.level === 0 && !t.subtask);
  const standard = pick(standards.filter((t) => !/\bbug\b/i.test(t.name)), /^(user )?story$/i, /^task$/i);
  if (!epic || !standard) {
    throw new ModuleError(
      `Project ${project} on Jira has no ${epic ? 'Story or Task' : 'Epic'} issue type, so squad-kit cannot make a breakdown's items there. A Jira admin can add it to the project.`,
      'not-found',
    );
  }
  const subtask = pick(types.filter((t) => t.subtask || t.level === -1), /^sub-?task$/i);
  const bug = standards.find((t) => /^bug$/i.test(t.name.trim()));
  return { epic, standard, ...(subtask ? { subtask } : {}), ...(bug ? { bug } : {}) };
}

export async function levelPlan(ctx: JiraContext): Promise<LevelPlan> {
  const project = ctx.project();
  return planOf(await ctx.types(project), project);
}

/** The type a new item gets: a story is a Sub-task under a feature, and a Story under an epic or on its own. */
export async function typeFor(ctx: JiraContext, level: ItemLevel, parentLevel: number | null): Promise<IssueType> {
  const plan = await levelPlan(ctx);
  if (level === 'epic') return plan.epic;
  if (level === 'feature' || parentLevel === null || parentLevel >= 1) return plan.standard;
  if (!plan.subtask) {
    throw new ModuleError(
      `Project ${ctx.project()} on Jira has no Sub-task issue type, so a story cannot go under its feature there. A Jira admin can turn sub-tasks on, or the breakdown can put its stories straight under their epics.`,
      'not-found',
    );
  }
  return plan.subtask;
}

export async function levelsOf(ctx: JiraContext): Promise<TrackerLevels> {
  const plan = await levelPlan(ctx);
  const project = await ctx.client.call<{ key: string; name?: string; style?: string }>('GET', `/rest/api/3/project/${encodeURIComponent(ctx.project())}`);
  return {
    epic: plan.epic.name,
    feature: plan.standard.name,
    story: (plan.subtask ?? plan.standard).name,
    process: project?.style === 'next-gen' ? 'team-managed' : 'company-managed',
    project: project?.name ?? ctx.project(),
  };
}

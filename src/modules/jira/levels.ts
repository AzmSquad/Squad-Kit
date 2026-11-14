import { ModuleError } from '../errors.js';
import type { ItemLevel, TrackerLevels } from '../tracker/types.js';
import type { IssueType, JiraContext } from './context.js';

/**
 * Which of the project's own issue types a breakdown's levels become. A story is always a Story (else a Task): the
 * level Jira ranks, puts in sprints and lists in the backlog, so every story sent can be built.
 *
 * - With a type above Epic (hierarchy level 2, like Initiative): epic, that type; feature, Epic; story, Story. A story
 *   straight under an epic cannot sit under the level-2 item, so it is linked to it (epic-links.ts).
 * - Without one: epic and feature are both Epics, and a story is a Story under its feature's Epic. Jira puts no Epic
 *   under an Epic, so a feature is linked to its epic instead. A story straight under an epic is a Story under it.
 *
 * No type is made up: a project without an Epic or a Story or Task type is told so before anything is sent.
 */

interface LevelPlan {
  epic: IssueType;
  feature: IssueType;
  story: IssueType;
  /** Its Bug type, when it has one. */
  bug?: IssueType;
}

const pick = (types: IssueType[], ...names: RegExp[]) => names.map((re) => types.find((t) => re.test(t.name.trim()))).find(Boolean) ?? types[0];

function planOf(types: IssueType[], project: string): LevelPlan {
  const epic = pick(types.filter((t) => t.level === 1 && !t.subtask), /^epic$/i);
  const standards = types.filter((t) => t.level === 0 && !t.subtask);
  const story = pick(standards.filter((t) => !/\bbug\b/i.test(t.name)), /^(user )?story$/i, /^task$/i);
  if (!epic || !story) {
    throw new ModuleError(
      `Project ${project} on Jira has no ${epic ? 'Story or Task' : 'Epic'} issue type, so squad-kit cannot make a breakdown's items there. A Jira admin can add it to the project.`,
      'not-found',
    );
  }
  const above = pick(types.filter((t) => t.level === 2), /^initiative$/i);
  const bug = standards.find((t) => /^bug$/i.test(t.name.trim()));
  return { epic: above ?? epic, feature: epic, story, ...(bug ? { bug } : {}) };
}

export async function levelPlan(ctx: JiraContext): Promise<LevelPlan> {
  const project = ctx.project();
  return planOf(await ctx.types(project), project);
}

export async function typeFor(ctx: JiraContext, level: ItemLevel): Promise<IssueType> {
  return (await levelPlan(ctx))[level];
}

/** Jira nests an item only right under the level above it. */
export function nests(childLevel: number, parentLevel: number): boolean {
  return parentLevel === childLevel + 1;
}

export async function levelsOf(ctx: JiraContext): Promise<TrackerLevels> {
  const plan = await levelPlan(ctx);
  const project = await ctx.client.call<{ key: string; name?: string; style?: string }>('GET', `/rest/api/3/project/${encodeURIComponent(ctx.project())}`);
  const linked = [...(nests(plan.feature.level, plan.epic.level) ? [] : (['feature'] as const)), ...(nests(plan.story.level, plan.epic.level) ? [] : (['story'] as const))];
  return {
    epic: plan.epic.name,
    feature: plan.feature.name,
    story: plan.story.name,
    process: project?.style === 'next-gen' ? 'team-managed' : 'company-managed',
    project: project?.name ?? ctx.project(),
    ...(linked.length ? { linked } : {}),
  };
}

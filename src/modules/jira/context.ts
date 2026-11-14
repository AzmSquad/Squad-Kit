import { ModuleError } from '../errors.js';
import type { JiraClient } from './client.js';
import type { JiraSettings } from './settings.js';

/**
 * What every part of the Jira tracker shares: the client, the settings, and what it read from the site once already:
 * its fields (story points, acceptance criteria, sprint), each project's issue types with their hierarchy levels and
 * create fields, the statuses of each type's workflow, and the link types.
 */

export interface IssueType {
  id: string;
  name: string;
  /** Jira's hierarchy level: 1 Epic, 0 Story, Task and Bug, -1 Sub-task, 2 or more a level above Epic. */
  level: number;
  subtask: boolean;
}

export interface Status {
  name: string;
  /** Jira's status category: new, indeterminate or done. */
  category: string;
}

interface CreateField {
  fieldId: string;
  name: string;
  allowedValues?: { id: string; name?: string; value?: string }[];
}

export interface SiteFields {
  /** Story points: "Story point estimate" and "Story Points" both, as sites keep either. */
  points: string[];
  /** A field named like Acceptance Criteria, and whether it holds rich text (ADF) or one plain line. */
  criteria?: { id: string; rich: boolean };
  sprint?: string;
}

interface RawField {
  id: string;
  name: string;
  schema?: { type?: string; custom?: string };
}

const READ_ONLY = 'squad-kit only reads Jira for this project until you connect it again: press Save and check in Settings, or run squad config set tracker --type jira';
const NO_PROJECT = 'Pick the Jira project the stories come from in Settings, then press Save and check.';

/** A read kept while it is good; a failed one is asked again next time. */
function kept<T>(map: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let p = map.get(key);
  if (!p) {
    p = read().catch((err: unknown) => {
      map.delete(key);
      throw err;
    });
    map.set(key, p);
  }
  return p;
}

export class JiraContext {
  private reads = new Map<string, Promise<unknown>>();

  constructor(
    readonly client: JiraClient,
    readonly settings: JiraSettings,
  ) {}

  private once<T>(key: string, read: () => Promise<T>): Promise<T> {
    return kept(this.reads as Map<string, Promise<T>>, key, read);
  }

  /** Stops a write while squad-kit may only read Jira (a setup from before this version). */
  writing(): void {
    if (this.settings.readOnly) throw new ModuleError(READ_ONLY, 'sign-in');
  }

  /** The project's key; a setup without one says where to pick it. */
  project(): string {
    if (!this.settings.project) throw new ModuleError(NO_PROJECT);
    return this.settings.project;
  }

  fields(): Promise<SiteFields> {
    return this.once('fields', async () => {
      const all = (await this.client.call<RawField[]>('GET', '/rest/api/3/field')) ?? [];
      const by = (test: (f: RawField) => boolean) => all.find(test);
      const criteria = by((f) => /^acceptance criteria$/i.test(f.name.trim())) ?? by((f) => /acceptance criteria/i.test(f.name));
      const sprint = by((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint') ?? by((f) => /^sprint$/i.test(f.name.trim()));
      const points = all.filter((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:jsw-story-points' || /^story ?points?( estimate)?$/i.test(f.name.trim())).map((f) => f.id);
      return {
        points,
        // A paragraph field takes ADF; a one-line text field takes plain words.
        ...(criteria ? { criteria: { id: criteria.id, rich: !/:textfield$/.test(criteria.schema?.custom ?? '') } } : {}),
        ...(sprint ? { sprint: sprint.id } : {}),
      };
    });
  }

  /** The project's issue types, with their place in Jira's hierarchy. */
  types(project = this.project()): Promise<IssueType[]> {
    return this.once(`types/${project}`, async () => {
      const page = await this.client.call<{ issueTypes?: RawType[]; values?: RawType[] }>('GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes?maxResults=100`);
      return (page?.issueTypes ?? page?.values ?? []).map((t) => ({
        id: String(t.id),
        name: t.name,
        subtask: Boolean(t.subtask),
        // An older answer without levels: sub-tasks below, Epic above, the rest in between.
        level: typeof t.hierarchyLevel === 'number' ? t.hierarchyLevel : t.subtask ? -1 : /^epic$/i.test(t.name) ? 1 : 0,
      }));
    });
  }

  /** The fields a type's create screen has in the project, with the values a choice field takes. */
  createFields(project: string, typeId: string): Promise<CreateField[]> {
    return this.once(`create/${project}/${typeId}`, async () => {
      const page = await this.client.call<{ fields?: CreateField[]; results?: CreateField[] }>(
        'GET',
        `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(typeId)}?maxResults=200`,
      );
      return page?.fields ?? page?.results ?? [];
    });
  }

  /** The statuses of a type's workflow in a project, in Jira's order. */
  statuses(project: string, typeName: string): Promise<Status[]> {
    return this.once(`statuses/${project}`, async () => {
      const list = await this.client.call<{ name: string; statuses: { name: string; statusCategory?: { key?: string } }[] }[]>('GET', `/rest/api/3/project/${encodeURIComponent(project)}/statuses`);
      return list ?? [];
    }).then((list) => (list.find((t) => t.name === typeName) ?? list[0])?.statuses.map((s) => ({ name: s.name, category: s.statusCategory?.key ?? '' })) ?? []);
  }

  /** The site's link type that fits, such as Blocks ("is blocked by") or Relates. */
  linkType(test: (t: { name: string; inward: string; outward: string }) => boolean): Promise<{ name: string; inward: string; outward: string } | undefined> {
    return this.once('links', async () => (await this.client.call<{ issueLinkTypes?: { name: string; inward: string; outward: string }[] }>('GET', '/rest/api/3/issueLinkType'))?.issueLinkTypes ?? []).then(
      (types) => types.find(test),
    );
  }
}

interface RawType {
  id: string | number;
  name: string;
  subtask?: boolean;
  hierarchyLevel?: number;
}

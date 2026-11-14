import { ModuleError } from '../errors.js';
import type { JiraClient } from './client.js';
import { projectOf } from './refs.js';
import { typeLevel, type RawIssue } from './rows.js';
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

/** Per site: whether Jira's issue link call takes its two sides the other way round, once a link showed it. */
const LINK_SIDES = new Map<string, boolean>();

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

  /** The project's key, checked before it goes into a query; a setup without one says where to pick it. */
  project(): string {
    const key = this.settings.project;
    if (!key) throw new ModuleError(NO_PROJECT);
    if (projectOf(key) !== key) throw new ModuleError(`"${key}" is not a Jira project key. ${NO_PROJECT}`);
    return key;
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
        level: typeLevel(t),
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

  /** The fields an issue's edit screen has now: what an update may set. */
  editFields(key: string): Promise<string[]> {
    return this.once(`edit/${key}`, async () => {
      const meta = await this.client.call<{ fields?: Record<string, unknown> }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/editmeta`);
      return Object.keys(meta?.fields ?? {});
    });
  }

  /**
   * Links two issues through Jira's issue link call: `from` reads the link type's outward words to `to` ("PAY-41 blocks
   * PAY-44"). Jira's docs leave its two sides unclear, so on a site whose way is not known yet, the one link this call
   * made is read back from `from` (by its id, new since the call): if it landed the other way round, it is made again
   * the right way, and every later link on that site is sent that way. When no single new link can be told apart,
   * nothing is decided and nothing is taken away.
   */
  async link(type: string, from: string, to: string): Promise<void> {
    const site = this.settings.site;
    const flipped = LINK_SIDES.get(site);
    const send = (out: string, into: string) => this.client.call('POST', '/rest/api/3/issueLink', { type: { name: type }, outwardIssue: { key: out }, inwardIssue: { key: into } });
    if (flipped !== undefined) {
      await (flipped ? send(to, from) : send(from, to));
      return;
    }
    const linksOf = async () => (await this.client.call<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(from)}?fields=issuelinks`))?.fields.issuelinks ?? [];
    const before = new Set((await linksOf()).map((l) => l.id));
    await send(from, to);
    const made = (await linksOf()).filter((l) => l.id && !before.has(l.id) && l.type?.name === type && (l.outwardIssue?.key === to || l.inwardIssue?.key === to));
    if (made.length !== 1) return;
    // Seen from `from`, as Jira shows an issue's links: `to` on the outward side means "from <outward words> to".
    const right = made[0]!.outwardIssue?.key === to;
    LINK_SIDES.set(site, !right);
    if (right) return;
    await this.client.call('DELETE', `/rest/api/3/issueLink/${encodeURIComponent(made[0]!.id!)}`);
    await send(to, from);
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

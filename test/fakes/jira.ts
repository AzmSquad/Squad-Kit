import { adfProblem } from './adf-check.js';

/**
 * Jira Cloud as far as squad-kit uses it, in memory, answering in the shapes of Atlassian's REST docs (platform v3 and
 * Agile 1.0). Site acme.atlassian.net, project PAY: epic PAY-10 "Booking", story PAY-40 "Hold a slot" under it in the
 * running sprint 7 with an attachment and acceptance criteria, task PAY-41, bug PAY-42, a finished story PAY-43, story
 * PAY-44 blocked by PAY-41, and sub-task PAY-45 under PAY-40. Board 1 is Scrum (sprints 5, 6 closed, 7 running, 8 next),
 * board 2 Kanban. Searches go only through POST /rest/api/3/search/jql, paged with nextPageToken; the old search is
 * gone (410). An attachment is a 303 to Atlassian's media host, which must get no sign-in.
 */


type Adf = Record<string, unknown>;

interface Issue {
  key: string;
  id: string;
  type: string;
  summary: string;
  description: Adf | null;
  status: string;
  labels: string[];
  priority?: string;
  assignee?: string;
  points?: number;
  sprint?: number;
  parent?: string;
  criteria?: Adf | string | null;
  attachments: { id: string; filename: string; size: number }[];
  rank: number;
  created: number;
  comments: Adf[];
  /** Searches that do not find it yet. */
  unseen?: number;
  /** Jira's issue properties: data an app keeps on an issue, unseen by people. */
  props?: Record<string, unknown>;
}

export interface FakeJiraOptions {
  /** The workflow has In Review (in progress) between In Progress and Done. */
  review?: boolean;
  /** The workflow only goes a step at a time, as many company-managed workflows do. */
  steps?: boolean;
  /** The site has sub-tasks turned off. */
  noSubtask?: boolean;
  /** The site has Initiative, a level above Epic (Jira Premium's plans). */
  initiative?: boolean;
  /** The site renamed its "Relates" link type, as an admin may: only a link that reads the same both ways is left. */
  noRelates?: boolean;
  /**
   * Stories and Tasks follow their own workflow, a step at a time: To Do, In Progress, QA (in progress too), Done. 'way':
   * QA goes on to Done; 'dead-end': QA only goes back. Bugs keep the usual workflow.
   */
  qa?: 'way' | 'dead-end';
  /** The way to Done asks for a resolution on a screen: 'also' beside a plain way, 'only' as the one way. */
  screen?: 'also' | 'only';
  /** No Labels field on the create and edit screens. */
  noLabels?: boolean;
  /** The Acceptance Criteria field is on Story's create screen only, not its edit screen. */
  criteriaOnCreateOnly?: boolean;
  /** Jira's search catches up late: a new issue is missing from this many searches after it is made. */
  lag?: number;
  /** The issue link call takes its two sides the other way round from what squad-kit assumes first. */
  reversedLinks?: boolean;
  /** Answer as this site instead of acme.atlassian.net. */
  site?: string;
  /** No field called Acceptance Criteria on the site. */
  noCriteria?: boolean;
  /** This many more stories in the backlog, for paging. */
  extra?: number;
  /** Jira's paging bug: every page gives the same next token and never says it is the last. */
  stuckPaging?: boolean;
  /** 429 with Retry-After: once with a short wait, or always with a long one. */
  busy?: 'once' | 'always';
  /** The site has these projects besides PAY. */
  projects?: { key: string; name: string }[];
}

export const SITE = 'acme.atlassian.net';
export const EMAIL = 'sara@acme.test';
const MEDIA = 'api.media.atlassian.com';

const TYPES = [
  { id: '10000', name: 'Epic', subtask: false, hierarchyLevel: 1 },
  { id: '10001', name: 'Story', subtask: false, hierarchyLevel: 0 },
  { id: '10002', name: 'Task', subtask: false, hierarchyLevel: 0 },
  { id: '10004', name: 'Bug', subtask: false, hierarchyLevel: 0 },
  { id: '10003', name: 'Subtask', subtask: true, hierarchyLevel: -1 },
  { id: '10005', name: 'Initiative', subtask: false, hierarchyLevel: 2 },
];
const CATEGORY: Record<string, { id: number; key: string; colorName: string; name: string }> = {
  new: { id: 2, key: 'new', colorName: 'blue-gray', name: 'To Do' },
  indeterminate: { id: 4, key: 'indeterminate', colorName: 'yellow', name: 'In Progress' },
  done: { id: 3, key: 'done', colorName: 'green', name: 'Done' },
};
const LINK_TYPES = [
  { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  { id: '10001', name: 'Cloners', inward: 'is cloned by', outward: 'clones' },
  { id: '10002', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
  { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' },
];
const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'].map((name, i) => ({ id: String(i + 1), name }));
const SPRINTS = [
  { id: 5, state: 'closed', name: 'PAY Sprint 5', startDate: '2026-10-05T09:00:00.000Z', endDate: '2026-10-19T09:00:00.000Z' },
  { id: 6, state: 'closed', name: 'PAY Sprint 6', startDate: '2026-10-19T09:00:00.000Z', endDate: '2026-11-02T09:00:00.000Z' },
  { id: 7, state: 'active', name: 'PAY Sprint 7', startDate: '2026-11-02T09:00:00.000Z', endDate: '2026-11-16T09:00:00.000Z' },
  { id: 8, state: 'future', name: 'PAY Sprint 8' },
];
const BOARDS = [
  { id: 1, name: 'PAY board', type: 'scrum' },
  { id: 2, name: 'PAY flow', type: 'kanban' },
];
const POINTS = 'customfield_10016';
const SPRINT = 'customfield_10020';
const CRITERIA = 'customfield_10050';

const doc = (...paragraphs: string[]): Adf => ({ type: 'doc', version: 1, content: paragraphs.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) });

export interface FakeJira {
  fetch: typeof fetch;
  token: string;
  issues: Map<string, Issue>;
  /** "source blocks target", "source relates to target". */
  links: { id: string; type: string; source: string; target: string }[];
  /** Each request: method, address and whether it carried a sign-in. */
  requests: { method: string; url: string; signedIn: boolean }[];
  comments(key: string): string[];
}

export function fakeJira(token = 'secret', opts: FakeJiraOptions = {}): FakeJira {
  const auth = `Basic ${Buffer.from(`${EMAIL}:${token}`).toString('base64')}`;
  const statuses = [
    { id: '10000', name: 'To Do', cat: 'new' },
    { id: '3', name: 'In Progress', cat: 'indeterminate' },
    ...(opts.review ? [{ id: '10001', name: 'In Review', cat: 'indeterminate' }] : []),
    { id: '10002', name: 'Done', cat: 'done' },
    { id: '10003', name: "Won't Do", cat: 'done' },
    ...(opts.qa ? [{ id: '10004', name: 'QA', cat: 'indeterminate' }] : []),
  ];
  /** Each type's workflow: its statuses in order, and where each one may go. */
  const flowOf = (type: string): { names: string[]; to(from: string): string[] } => {
    if (opts.qa && (type === 'Story' || type === 'Task')) {
      const ways: Record<string, string[]> = { 'To Do': ['In Progress'], 'In Progress': ['QA', 'To Do'], QA: opts.qa === 'way' ? ['Done', 'In Progress'] : ['In Progress'], Done: ['To Do'] };
      return { names: ['To Do', 'In Progress', 'QA', 'Done', "Won't Do"], to: (from) => [...(ways[from] ?? []), "Won't Do"].filter((n) => n !== from) };
    }
    const names = statuses.filter((x) => x.name !== 'QA').map((x) => x.name);
    const line = names.filter((n) => n !== "Won't Do");
    return {
      names,
      to: (from) => names.filter((n) => n !== from && (!opts.steps || n === "Won't Do" || Math.abs(line.indexOf(n) - line.indexOf(from)) === 1)),
    };
  };
  const types = TYPES.filter((t) => !(opts.noSubtask && t.subtask) && (opts.initiative || t.name !== 'Initiative'));
  const linkTypes = opts.noRelates ? LINK_TYPES.map((t) => (t.name === 'Relates' ? { ...t, name: 'Related work', inward: 'goes with', outward: 'goes with' } : t)) : LINK_TYPES;
  let linkIds = 30000;
  const projects = [{ key: 'PAY', name: 'Payments' }, ...(opts.projects ?? [])];
  const issues = new Map<string, Issue>();
  const links: FakeJira['links'] = [{ id: String(linkIds++), type: 'Blocks', source: 'PAY-41', target: 'PAY-44' }];
  const requests: FakeJira['requests'] = [];
  let counter = 0;
  const add = (i: Partial<Issue> & Pick<Issue, 'key' | 'type' | 'summary'>) =>
    issues.set(i.key, { id: String(10000 + Number(i.key.split('-')[1])), description: null, status: 'To Do', labels: [], attachments: [], rank: ++counter, created: counter, comments: [], ...i });
  add({ key: 'PAY-10', type: 'Epic', summary: 'Booking', description: doc('Guests book rooms online.') });
  add({
    key: 'PAY-40',
    type: 'Story',
    summary: 'Hold a slot',
    parent: 'PAY-10',
    sprint: 7,
    points: 3,
    priority: 'High',
    labels: ['ready'],
    assignee: 'Sara Ali',
    description: doc('As a guest, I want to hold a slot, so that nobody takes it.'),
    criteria: doc('Given a free slot', 'When I hold it, then it is mine for 10 minutes'),
    attachments: [{ id: '10100', filename: 'slot.png', size: 4 }],
  });
  add({ key: 'PAY-41', type: 'Task', summary: 'Pay at the desk', priority: 'Medium' });
  add({ key: 'PAY-42', type: 'Bug', summary: 'Friday shows open', priority: 'Highest', sprint: 7 });
  add({ key: 'PAY-43', type: 'Story', summary: 'Show prices', status: 'Done' });
  add({ key: 'PAY-44', type: 'Story', summary: 'Check out', parent: 'PAY-10' });
  if (!opts.noSubtask) add({ key: 'PAY-45', type: 'Subtask', summary: 'Hold timer', parent: 'PAY-40' });
  for (let n = 0; n < (opts.extra ?? 0); n += 1) add({ key: `PAY-${100 + n}`, type: 'Story', summary: `Extra story ${n + 1}` });
  let next = 100 + (opts.extra ?? 0);
  let busy = opts.busy;

  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  const no = (status: number, messages: string[], errors: Record<string, string> = {}) => json({ errorMessages: messages, errors }, status);
  const typeOf = (name: string) => types.find((t) => t.name === name)!;
  const statusOf = (name: string) => {
    const s = statuses.find((x) => x.name === name)!;
    return { self: `https://${SITE}/rest/api/3/status/${s.id}`, name: s.name, id: s.id, statusCategory: CATEGORY[s.cat] };
  };
  const brief = (i: Issue) => ({
    id: i.id,
    key: i.key,
    self: `https://${SITE}/rest/api/3/issue/${i.id}`,
    fields: { summary: i.summary, status: statusOf(i.status), priority: i.priority ? PRIORITIES.find((p) => p.name === i.priority) : null, issuetype: typeOf(i.type) },
  });
  /** What each type's create screen holds, and its edit screen. */
  const screen = (type: string, edit = false) => [
    'summary',
    'issuetype',
    'project',
    'description',
    ...(opts.noLabels ? [] : ['labels']),
    'parent',
    'priority',
    ...(type === 'Story' && !opts.noCriteria && !(edit && opts.criteriaOnCreateOnly) ? [CRITERIA] : []),
  ];

  function fieldsOf(i: Issue): Record<string, unknown> {
    const issuelinks = links
      .filter((l) => l.source === i.key || l.target === i.key)
      .map((l) => {
        const type = linkTypes.find((t) => t.name === l.type)!;
        // Seen from this issue: the other one is outward when this one is the source ("this blocks that").
        return { id: l.id, type, ...(l.source === i.key ? { outwardIssue: brief(issues.get(l.target)!) } : { inwardIssue: brief(issues.get(l.source)!) }) };
      });
    const sprint = SPRINTS.find((s) => s.id === i.sprint);
    return {
      summary: i.summary,
      issuetype: typeOf(i.type),
      status: statusOf(i.status),
      priority: i.priority ? PRIORITIES.find((p) => p.name === i.priority) : null,
      labels: i.labels,
      assignee: i.assignee ? { accountId: 'a1', displayName: i.assignee } : null,
      description: i.description,
      attachment: i.attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size, mimeType: 'image/png', content: `https://${SITE}/rest/api/3/attachment/content/${a.id}` })),
      ...(i.parent ? { parent: brief(issues.get(i.parent)!) } : {}),
      issuelinks,
      project: { key: 'PAY', name: 'Payments' },
      [POINTS]: i.points ?? null,
      [SPRINT]: sprint ? [{ id: sprint.id, name: sprint.name, state: sprint.state, boardId: 1 }] : null,
      ...(opts.noCriteria ? {} : { [CRITERIA]: i.criteria ?? null }),
    };
  }

  function view(i: Issue, wanted: string | null) {
    const all = fieldsOf(i);
    const keep = wanted ? wanted.split(',') : Object.keys(all);
    return { id: i.id, key: i.key, self: `https://${SITE}/rest/api/3/issue/${i.id}`, fields: Object.fromEntries(keep.filter((k) => k in all).map((k) => [k, all[k]])) };
  }

  /** The few JQL clauses squad-kit writes; anything else is an error, as Jira would say about a word it does not know. */
  function search(jql: string): Issue[] | string {
    const [where, order = ''] = jql.split(/ ORDER BY /i);
    let list = [...issues.values()].filter((i) => !(i.unseen && i.unseen-- > 0));
    for (const clause of where!.split(/ AND /)) {
      let m: RegExpExecArray | null;
      if ((m = /^project = "?(\w+)"?$/.exec(clause))) list = list.filter((i) => i.key.startsWith(`${m![1]}-`));
      else if ((m = /^issuetype in \(([\d, ]+)\)$/.exec(clause))) {
        const ids = m[1]!.split(',').map((s) => s.trim());
        list = list.filter((i) => ids.includes(typeOf(i.type).id));
      } else if ((m = /^issuetype = (\d+)$/.exec(clause))) list = list.filter((i) => typeOf(i.type).id === m![1]);
      else if ((m = /^sprint = (\d+)$/.exec(clause))) list = list.filter((i) => i.sprint === Number(m![1]));
      else if (clause === 'statusCategory != Done') list = list.filter((i) => statuses.find((s) => s.name === i.status)!.cat !== 'done');
      else if ((m = /^description ~ "((?:[^"\\]|\\.)+)"$/.exec(clause))) {
        // Jira's text search: every word in the text, whatever the case.
        const words = m[1]!.replace(/\\(.)/g, '$1').toLowerCase().split(/\s+/);
        list = list.filter((i) => words.every((w) => JSON.stringify(i.description ?? '').toLowerCase().includes(w)));
      } else if ((m = /^labels = "((?:[^"\\]|\\.)+)"$/.exec(clause))) {
        const label = m[1]!.replace(/\\(.)/g, '$1');
        list = list.filter((i) => i.labels.includes(label));
      }
      else return `Error in the JQL Query: the clause "${clause}" is not understood.`;
    }
    if (/created DESC/i.test(order)) return list.sort((a, b) => b.created - a.created);
    return list.sort((a, b) => a.rank - b.rank);
  }

  function steps(i: Issue) {
    const step = (id: string, name: string, to: string, hasScreen = false) => ({ id, name, hasScreen, isGlobal: !opts.steps, isInitial: false, isAvailable: true, isConditional: false, isLooped: false, to: statusOf(to) });
    return flowOf(i.type)
      .to(i.status)
      .flatMap((to) => {
        const id = String(11 + statuses.findIndex((x) => x.name === to) * 10);
        if (to !== 'Done' || !opts.screen) return [step(id, to, to)];
        // The way to Done with a resolution screen: listed first, as Jira lists it.
        return [step('91', 'Resolve', to, true), ...(opts.screen === 'also' ? [step(id, to, to)] : [])];
      });
  }

  /** A parent fits Jira's hierarchy: one level up, a Sub-task always under a Story or Task. */
  function parentProblem(type: string, parent: string | undefined): string | null {
    const level = typeOf(type).hierarchyLevel;
    if (!parent) return level === -1 ? 'Parent is required for a sub-task.' : null;
    const p = issues.get(parent);
    if (!p) return `Issue ${parent} does not exist.`;
    return typeOf(p.type).hierarchyLevel === level + 1 ? null : `Issue type ${type} cannot have a parent of type ${p.type}.`;
  }

  /** Sets fields as Jira checks them: on the type's screen, labels without spaces, a parent that fits. */
  function setFields(i: Issue, fields: Record<string, unknown>, isNew = false): Record<string, string> | null {
    for (const k of Object.keys(fields)) if (!screen(i.type, !isNew).includes(k)) return { [k]: `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.` };
    for (const k of ['description', CRITERIA]) {
      const problem = fields[k] && typeof fields[k] === 'object' ? adfProblem(fields[k]) : null;
      if (problem) return { [k]: `Operation value must be an Atlassian Document (see the Atlassian Document Format): ${problem}` };
    }
    if (typeof fields.summary === 'string' && (fields.summary.length > 255 || /[\r\n]/.test(fields.summary))) return { summary: 'Summary must be less than 255 characters, on one line.' };
    const labels = fields.labels as string[] | undefined;
    const spaced = labels?.find((l) => /\s/.test(l));
    if (spaced) return { labels: `The label '${spaced}' contains spaces which is invalid.` };
    // null takes the parent away.
    if (fields.parent === null && !isNew) i.parent = undefined;
    const parent = (fields.parent as { key?: string } | null | undefined)?.key;
    const problem = (parent !== undefined || isNew) && fields.parent !== null ? parentProblem(i.type, parent) : null;
    if (problem) return { parent: problem };
    if (typeof fields.summary === 'string') i.summary = fields.summary;
    if ('description' in fields) i.description = fields.description as Adf;
    if (labels) i.labels = labels;
    if (parent) i.parent = parent;
    if (CRITERIA in fields) i.criteria = fields[CRITERIA] as Adf;
    const priority = (fields.priority as { id?: string } | undefined)?.id;
    if (priority) i.priority = PRIORITIES.find((p) => p.id === priority)?.name;
    return null;
  }

  function update(i: Issue, upd: Record<string, { add?: unknown; remove?: unknown }[]>): Record<string, string> | null {
    if (upd.labels && !screen(i.type, true).includes('labels')) return { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." };
    for (const op of upd.labels ?? []) {
      if (op.remove !== undefined) {
        i.labels = i.labels.filter((l) => l !== op.remove);
        continue;
      }
      const label = String(op.add);
      if (/\s/.test(label)) return { labels: `The label '${label}' contains spaces which is invalid.` };
      if (!i.labels.includes(label)) i.labels.push(label);
    }
    // squad-kit links issues through POST /issueLink only.
    if (upd.issuelinks) return { issuelinks: 'This fake takes links only through POST /rest/api/3/issueLink.' };
    return null;
  }

  async function answer(method: string, url: URL, body: Record<string, unknown> | undefined): Promise<Response> {
    const p = url.pathname;
    const q = url.searchParams;
    let m: RegExpExecArray | null;
    if (p === '/rest/api/3/myself') return json({ accountId: '5b10a2844c20165700ede21g', emailAddress: EMAIL, displayName: 'Sara Ali', active: true, timeZone: 'Asia/Riyadh', accountType: 'atlassian' });
    if (p === '/rest/api/3/search' || p === '/rest/api/2/search') return no(410, ['The requested API has been removed. Please migrate to the /rest/api/3/search/jql API.']);
    if (p === '/rest/api/3/search/jql' && method === 'POST') {
      if (body?.startAt !== undefined) return no(400, ['Invalid request payload. Refer to the REST API documentation and try again.']);
      const found = search(String(body?.jql ?? ''));
      if (typeof found === 'string') return no(400, [found]);
      const from = body?.nextPageToken ? Number(Buffer.from(String(body.nextPageToken), 'base64').toString()) : 0;
      const max = Math.min(100, Number(body?.maxResults ?? 50));
      const page = found.slice(from, from + max);
      const more = from + max < found.length;
      const token = opts.stuckPaging ? Buffer.from('0').toString('base64') : Buffer.from(String(from + max)).toString('base64');
      const wanted = (body?.fields as string[] | undefined)?.join(',') ?? 'summary';
      return json({ issues: page.map((i) => view(i, wanted)), ...(more || opts.stuckPaging ? { nextPageToken: token } : {}), isLast: opts.stuckPaging ? false : !more });
    }
    if (p === '/rest/api/3/field') {
      return json([
        { id: 'summary', key: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
        { id: POINTS, key: POINTS, name: 'Story point estimate', custom: true, schema: { type: 'number', custom: 'com.pyxis.greenhopper.jira:jsw-story-points', customId: 10016 } },
        { id: SPRINT, key: SPRINT, name: 'Sprint', custom: true, schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint', customId: 10020 } },
        ...(opts.noCriteria ? [] : [{ id: CRITERIA, key: CRITERIA, name: 'Acceptance Criteria', custom: true, schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea', customId: 10050 } }]),
      ]);
    }
    if ((m = /^\/rest\/api\/3\/issue\/createmeta\/(\w+)\/issuetypes$/.exec(p))) {
      if (!projects.some((x) => x.key === m![1])) return no(404, ['No project could be found with key or id.']);
      return json({ maxResults: 50, startAt: 0, total: types.length, issueTypes: types.map((t) => ({ self: `https://${SITE}/rest/api/3/issuetype/${t.id}`, ...t, description: '', iconUrl: '' })) });
    }
    if ((m = /^\/rest\/api\/3\/issue\/createmeta\/(\w+)\/issuetypes\/(\d+)$/.exec(p))) {
      const type = types.find((t) => t.id === m![2]);
      if (!type) return no(404, ['Issue type not found.']);
      const fields = screen(type.name).map((id) => ({ fieldId: id, key: id, name: id, required: id === 'summary', operations: ['set'], schema: { type: 'string' }, ...(id === 'priority' ? { allowedValues: PRIORITIES } : {}) }));
      return json({ maxResults: 50, startAt: 0, total: fields.length, fields });
    }
    if ((m = /^\/rest\/api\/3\/project\/(\w+)\/statuses$/.exec(p))) {
      return json(types.map((t) => ({ self: '', id: t.id, name: t.name, subtask: t.subtask, statuses: flowOf(t.name).names.map((n) => ({ ...statusOf(n), description: '', iconUrl: '', untranslatedName: n })) })));
    }
    if (p === '/rest/api/3/project/search') {
      const all = projects.map((x, n) => ({ id: String(10000 + n), key: x.key, name: x.name, projectTypeKey: 'software', style: 'classic', simplified: false }));
      const start = Number(q.get('startAt') ?? 0);
      const max = Number(q.get('maxResults') ?? 50);
      return json({ self: '', maxResults: max, startAt: start, total: all.length, isLast: start + max >= all.length, values: all.slice(start, start + max) });
    }
    if ((m = /^\/rest\/api\/3\/project\/(\w+)$/.exec(p))) {
      const project = projects.find((x) => x.key === m![1]!.toUpperCase());
      return project ? json({ id: '10000', key: project.key, name: project.name, projectTypeKey: 'software', style: 'classic', simplified: false }) : no(404, [`No project could be found with key '${m[1]}'.`]);
    }
    if (p === '/rest/api/3/issueLinkType') return json({ issueLinkTypes: linkTypes.map((t) => ({ ...t, self: '' })) });
    if (p === '/rest/api/3/issueLink' && method === 'POST') {
      // "outwardIssue <outward words> inwardIssue": PAY-41 blocks PAY-44.
      const from = (body?.outwardIssue as { key?: string })?.key ?? '';
      const to = (body?.inwardIssue as { key?: string })?.key ?? '';
      const type = (body?.type as { name?: string })?.name ?? '';
      if (!issues.has(from) || !issues.has(to)) return no(404, [`Issue ${issues.has(from) ? to : from} does not exist or you do not have permission to see it.`]);
      if (!linkTypes.some((t) => t.name === type)) return no(404, [`No issue link type with name '${type}' found.`]);
      links.push({ id: String(linkIds++), type, ...(opts.reversedLinks ? { source: to, target: from } : { source: from, target: to }) });
      return new Response(null, { status: 201 });
    }
    if ((m = /^\/rest\/api\/3\/issueLink\/(\d+)$/.exec(p)) && method === 'DELETE') {
      const at = links.findIndex((l) => l.id === m![1]);
      if (at < 0) return no(404, ['No issue link with this id exists.']);
      links.splice(at, 1);
      return json(undefined, 204);
    }
    if (p === '/rest/agile/1.0/board') {
      const values = q.get('projectKeyOrId') === 'PAY' ? BOARDS.map((b) => ({ ...b, self: '', location: { projectKey: 'PAY', projectName: 'Payments' } })) : [];
      return json({ maxResults: 50, startAt: 0, total: values.length, isLast: true, values });
    }
    if ((m = /^\/rest\/agile\/1\.0\/board\/(\d+)(\/sprint)?$/.exec(p))) {
      const board = BOARDS.find((b) => b.id === Number(m![1]));
      if (!board) return no(404, ['Board does not exist or you do not have permission to see it.']);
      if (!m[2]) return json({ ...board, self: '' });
      if (board.type === 'kanban') return no(400, ['The board does not support sprints']);
      const start = Number(q.get('startAt') ?? 0);
      const max = Number(q.get('maxResults') ?? 50);
      const values = SPRINTS.slice(start, start + max).map((s) => ({ ...s, self: '', originBoardId: 1 }));
      return json({ maxResults: max, startAt: start, isLast: start + max >= SPRINTS.length, values });
    }
    if ((m = /^\/rest\/api\/3\/attachment\/content\/(\d+)$/.exec(p))) {
      return new Response(null, { status: 303, headers: { location: `https://${MEDIA}/file/9a1f-uuid/binary?token=one-time&client=c1&name=slot.png` } });
    }
    if (p === '/rest/api/3/issue' && method === 'POST') {
      const f = (body?.fields ?? {}) as Record<string, unknown>;
      const type = types.find((t) => t.id === (f.issuetype as { id?: string })?.id);
      if (!type) return no(400, [], { issuetype: 'Specify a valid issue type' });
      const project = (f.project as { key?: string })?.key;
      if (!projects.some((x) => x.key === project)) return no(400, [], { project: 'Specify a valid project ID or key' });
      const key = `${project}-${next++}`;
      const made: Issue = { key, id: String(20000 + next), type: type.name, summary: '', description: null, status: 'To Do', labels: [], attachments: [], rank: ++counter, created: counter, comments: [] };
      const problem = setFields(made, Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'project' && k !== 'issuetype')), true);
      if (problem) return no(400, [], problem);
      if (opts.lag) made.unseen = opts.lag;
      issues.set(key, made);
      return json({ id: made.id, key, self: `https://${SITE}/rest/api/3/issue/${made.id}` }, 201);
    }
    if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/properties\/([\w.-]+)$/.exec(p))) {
      const i = issues.get(m[1]!);
      if (!i) return no(404, ['Issue does not exist or you do not have permission to see it.']);
      const props = (i.props ??= {});
      if (method === 'PUT') {
        const made = !(m[2]! in props);
        props[m[2]!] = body;
        return json(undefined, made ? 201 : 200);
      }
      if (method === 'DELETE') {
        delete props[m[2]!];
        return json(undefined, 204);
      }
      return m[2]! in props ? json({ key: m[2], value: props[m[2]!] }) : no(404, [`The property with key '${m[2]}' does not exist.`]);
    }
    if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/editmeta$/.exec(p))) {
      const i = issues.get(m[1]!);
      if (!i) return no(404, ['Issue does not exist or you do not have permission to see it.']);
      return json({ fields: Object.fromEntries(screen(i.type, true).filter((f) => f !== 'project' && f !== 'issuetype').map((f) => [f, { required: false, name: f, key: f, operations: ['set'] }])) });
    }
    if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/comment|\/transitions)?$/.exec(p))) {
      const i = issues.get(m[1]!);
      if (!i) return no(404, ['Issue does not exist or you do not have permission to see it.']);
      if (m[2] === '/comment' && method === 'POST') {
        const problem = adfProblem(body?.body);
        if (problem) return no(400, [], { comment: `Comment body is not valid Atlassian Document Format: ${problem}` });
        i.comments.push(body?.body as Adf);
        return json({ id: String(i.comments.length), body: body?.body }, 201);
      }
      if (m[2] === '/transitions' && method === 'GET') return json({ expand: 'transitions', transitions: steps(i) });
      if (m[2] === '/transitions' && method === 'POST') {
        const step = steps(i).find((s) => s.id === (body?.transition as { id?: string })?.id);
        if (!step) return no(400, [`Transition id '${(body?.transition as { id?: string })?.id}' is not valid for this issue.`]);
        if (step.hasScreen) return no(400, [], { resolution: 'Resolution is required.' });
        i.status = step.to.name;
        return json(undefined, 204);
      }
      if (method === 'PUT') {
        const problem = setFields(i, (body?.fields ?? {}) as Record<string, unknown>) ?? update(i, (body?.update ?? {}) as Record<string, { add?: unknown; remove?: unknown }[]>);
        return problem ? no(400, [], problem) : json(undefined, 204);
      }
      if (method === 'GET') return json(view(i, q.get('fields')));
    }
    return no(404, [`No fake answer for ${method} ${p}`]);
  }

  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const signedIn = headers.has('authorization');
    requests.push({ method, url: url.href, signedIn });
    if (url.host === MEDIA) return new Response(Buffer.from('PNG!'), { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.host !== (opts.site ?? SITE)) throw new TypeError('fetch failed');
    if (busy) {
      if (busy === 'once') busy = undefined;
      return json({ errorMessages: ['Rate limit exceeded.'], errors: {} }, 429, { 'retry-after': opts.busy === 'once' ? '1' : '30' });
    }
    if (headers.get('authorization') !== auth) return new Response('Client must be authenticated to access this resource.', { status: 401, headers: { 'content-type': 'text/plain' } });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    return answer(method, url, body);
  }) as typeof fetch;

  return {
    fetch: fetchFake,
    token,
    issues,
    links,
    requests,
    comments: (key) => (issues.get(key)?.comments ?? []).map((c) => JSON.stringify(c)),
  };
}

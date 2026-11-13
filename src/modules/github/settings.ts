import { buildPaths } from '../../core/paths.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import type { ItemStage, SetupField } from '../tracker/types.js';
import { splitRepo } from './refs.js';

/**
 * A project's GitHub tracker settings, in `.squad/config.yaml` for the whole team: the repo, and where its stories come
 * from (the repo's Issues, or a Project board). No sign-in is kept: GitHub's own tool, gh, holds it.
 */

export const STAGES: ItemStage[] = ['not-started', 'in-progress', 'resolved', 'closed'];

export interface BoardRef {
  owner: string;
  number: number;
}

export interface GithubSettings {
  /** owner/name: where new issues go, and whose issues are "#40". */
  repo: string;
  from: 'issues' | 'project';
  /** Issues only: they have every one of these labels. */
  labels: string[];
  /** Issues only: assigned to this login. */
  assignee?: string;
  /** Project only. */
  board?: BoardRef & { id: string; title: string };
  /** Project only: the board's view whose filter picks the stories, or one Status value. */
  view?: string;
  status?: string;
  /** Project only: the Status option for each of squad-kit's stages. */
  stages: Partial<Record<ItemStage, string>>;
  /** Project only: the board's iteration field, when it has one. Its iterations are the sprints. */
  sprints?: string;
  /** Stories written by anyone, not only by people the repo knows. Off unless the person turns it on. */
  anyone: boolean;
  /**
   * Set up before this version (0.x), and not connected again since: squad-kit only reads GitHub, and keeps its
   * updates until the person connects once more.
   */
  readOnly: boolean;
}

const ON_BOARD = { key: 'from', is: ['project'] };
const ON_ISSUES = { key: 'from', is: ['issues'] };
const STAGE_LABEL: Record<ItemStage, string> = { 'not-started': 'Not started', 'in-progress': 'In progress', resolved: 'Merged', closed: 'Released' };

export const FIELDS: SetupField[] = [
  { key: 'repo', label: 'Repository', placeholder: 'owner/name' },
  {
    key: 'from',
    label: 'Stories from',
    options: [
      { value: 'issues', label: 'Issues' },
      { value: 'project', label: 'A Project' },
    ],
  },
  { key: 'labels', label: 'Labels', placeholder: 'Any. Or e.g. ready, squad', when: ON_ISSUES },
  { key: 'assignee', label: 'Assigned to', placeholder: 'Anyone. Or a login, or @me', when: ON_ISSUES },
  { key: 'board', label: 'Project', choice: true, typed: true, placeholder: 'Pick one, or type its number or address', when: ON_BOARD },
  { key: 'view', label: 'View', choice: true, when: ON_BOARD },
  { key: 'status', label: 'Only with Status', choice: true, when: ON_BOARD },
  ...STAGES.map((s) => ({ key: `stage-${s}`, label: `Status when ${STAGE_LABEL[s].toLowerCase()}`, choice: true, when: ON_BOARD, more: true })),
  {
    key: 'anyone',
    label: 'Stories from anyone',
    options: [
      { value: '', label: 'Only the team' },
      { value: 'yes', label: 'Anyone' },
    ],
    more: true,
  },
];

/** Saved by every save in this version: squad-kit may write to GitHub. A setup from before has no such mark. */
const WRITES = 'on';

/** "AzmSquad/2", "2" (the repo owner's) or the board's address. */
export function parseBoard(text: string, repo: string): BoardRef | null {
  const t = text.trim();
  const page = /github\.com\/(?:orgs|users)\/([\w.-]+)\/projects\/(\d+)/i.exec(t);
  const short = /^(?:([\w.-]+)\/)?#?(\d+)$/.exec(t);
  const owner = page?.[1] ?? short?.[1] ?? splitRepo(repo).owner;
  const number = Number(page?.[2] ?? short?.[2]);
  return owner && number > 0 ? { owner, number } : null;
}

/** The settings saved for the project, or null when its tracker is not GitHub. */
export function readSettings(root: string): GithubSettings | null {
  const file = buildPaths(root).configFile;
  let tracker;
  try {
    tracker = loadConfig(file).tracker;
  } catch {
    return null;
  }
  if (tracker.type !== 'github' || !tracker.workspace || !tracker.project) return null;
  const o = tracker.options ?? {};
  const repo = `${tracker.workspace}/${tracker.project}`;
  const ref = o.board ? parseBoard(o.board, repo) : null;
  return {
    repo,
    from: o.from === 'project' && ref && o.boardId ? 'project' : 'issues',
    labels: (o.labels ?? '').split(',').map((l) => l.trim()).filter(Boolean),
    ...(o.assignee?.trim() ? { assignee: o.assignee.trim() } : {}),
    ...(ref && o.boardId ? { board: { ...ref, id: o.boardId, title: o.boardTitle ?? `#${ref.number}` } } : {}),
    ...(o.view?.trim() ? { view: o.view.trim() } : {}),
    ...(o.status?.trim() ? { status: o.status.trim() } : {}),
    stages: Object.fromEntries(STAGES.filter((s) => o[`stage-${s}`]).map((s) => [s, o[`stage-${s}`]!])),
    ...(o.sprints ? { sprints: o.sprints } : {}),
    anyone: o.anyone === 'yes',
    readOnly: o.updates !== WRITES,
  };
}

/** The values the Settings form shows. */
export function formValues(s: GithubSettings): Record<string, string> {
  return {
    repo: s.repo,
    from: s.from,
    labels: s.labels.join(', '),
    assignee: s.assignee ?? '',
    board: s.board ? `${s.board.owner}/${s.board.number}` : '',
    view: s.view ?? '',
    status: s.status ?? '',
    ...Object.fromEntries(STAGES.map((st) => [`stage-${st}`, s.stages[st] ?? ''])),
    anyone: s.anyone ? 'yes' : '',
  };
}

export function writeSettings(root: string, s: GithubSettings): void {
  const file = buildPaths(root).configFile;
  const config = loadConfig(file);
  const { owner, name } = splitRepo(s.repo);
  const options: Record<string, string> = { from: s.from, updates: WRITES };
  if (s.anyone) options.anyone = 'yes';
  if (s.from === 'issues') {
    if (s.labels.length) options.labels = s.labels.join(', ');
    if (s.assignee) options.assignee = s.assignee;
  } else if (s.board) {
    Object.assign(options, { board: `${s.board.owner}/${s.board.number}`, boardId: s.board.id, boardTitle: s.board.title });
    if (s.view) options.view = s.view;
    if (s.status) options.status = s.status;
    for (const st of STAGES) if (s.stages[st]) options[`stage-${st}`] = s.stages[st]!;
    if (s.sprints) options.sprints = s.sprints;
  }
  saveConfig(file, { ...config, tracker: { type: 'github', workspace: owner, project: name, options } });
}

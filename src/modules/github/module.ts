import { ModuleError } from '../errors.js';
import type { ItemStage, SetupChoice, TrackerModule } from '../tracker/types.js';
import { realCalls, type GithubCalls } from './calls.js';
import { boardByNumber, boardsOf, type Board } from './project.js';
import { repoOf, splitRepo } from './refs.js';
import { FIELDS, STAGES, formValues, parseBoard, readSettings, writeSettings, type GithubSettings } from './settings.js';
import { realProbe, signInSteps, type SignInProbe } from './sign-in.js';
import { bestOption, stageOptions } from './states.js';
import { GithubTracker } from './tracker.js';

/** GitHub in the tracker list: its settings, the lists the Settings page picks from, and the save that checks them. */

function cleanRepo(text: string | undefined): string {
  const t = (text ?? '').trim();
  return repoOf(t) ?? t.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

function words(text: string | undefined): string | undefined {
  return text?.trim() || undefined;
}

/** The repo must be one this sign-in can see; a board, one of its owner's. */
async function checked(calls: GithubCalls, values: Record<string, string | undefined>): Promise<GithubSettings> {
  const typed = cleanRepo(values.repo);
  if (!/^[\w.-]+\/[\w.-]+$/.test(typed)) throw new ModuleError('Enter the repository as owner/name, for example AzmSquad/roomflow.');
  let repo: string;
  try {
    // GitHub's own spelling of the name, so the issues' names match it.
    repo = (await calls.rest<{ full_name?: string }>(`/repos/${typed}`)).full_name ?? typed;
  } catch (err) {
    if (err instanceof ModuleError && err.kind === 'not-found') throw new ModuleError(`GitHub has no repository ${typed} that your sign-in can see.`, 'not-found');
    throw err;
  }
  // Saved in this version: squad-kit may write to GitHub from now on.
  const always = { anyone: values.anyone === 'yes', readOnly: false };
  if (values.from !== 'project') {
    const labels = (values.labels ?? '').split(',').map((l) => l.trim()).filter(Boolean);
    const assignee = words(values.assignee);
    return { repo, from: 'issues', labels, ...(assignee ? { assignee } : {}), stages: {}, ...always };
  }
  const ref = parseBoard(values.board ?? '', repo);
  if (!ref) throw new ModuleError('Pick the GitHub Project the stories come from, or type its number or address.');
  const board = await boardByNumber(calls, ref);
  const options = board.status?.options.map((o) => o.name) ?? [];
  const view = words(values.view);
  const status = words(values.status);
  if (view && !board.views.some((v) => v.name === view)) throw new ModuleError(`GitHub Project ${board.title} has no view called "${view}".`);
  if (status && !options.includes(status)) throw new ModuleError(`GitHub Project ${board.title} has no Status "${status}". It has: ${options.join(', ')}.`);
  const chosen: Partial<Record<ItemStage, string>> = Object.fromEntries(STAGES.map((s) => [s, words(values[`stage-${s}`])]).filter(([, o]) => o));
  const wrong = Object.values(chosen).find((o) => !options.includes(o!));
  if (wrong) throw new ModuleError(`GitHub Project ${board.title} has no Status "${wrong}". It has: ${options.join(', ')}.`);
  return {
    repo,
    from: 'project',
    labels: [],
    board: { ...ref, id: board.id, title: board.title },
    ...(view ? { view } : {}),
    ...(status ? { status } : {}),
    stages: stageOptions(options, chosen),
    ...(board.iteration ? { sprints: board.iteration.name } : {}),
    ...always,
  };
}

/** A choice list that starts with "" for the automatic or empty pick. */
function withNone(none: string, names: string[]): SetupChoice[] {
  return [{ value: '', label: none }, ...names.map((n) => ({ value: n, label: n }))];
}

async function choicesFor(calls: GithubCalls, values: Record<string, string>): Promise<Record<string, SetupChoice[]>> {
  const repo = cleanRepo(values.repo);
  if (values.from !== 'project' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return {};
  const owner = splitRepo(repo).owner;
  const lists: Record<string, SetupChoice[]> = {
    board: (await boardsOf(calls, owner)).map((b) => ({ value: `${owner}/${b.number}`, label: `#${b.number} ${b.title}` })),
  };
  const ref = parseBoard(values.board ?? '', repo);
  if (!ref) return lists;
  const board: Board = await boardByNumber(calls, ref);
  const options = board.status?.options.map((o) => o.name) ?? [];
  lists.view = withNone('Every item', board.views.map((v) => v.name));
  lists.status = withNone('Any status', options);
  for (const s of STAGES) {
    const best = bestOption(s, options);
    lists[`stage-${s}`] = withNone(best ? `${best} (best fit)` : 'Leave as it is', options);
  }
  return lists;
}

export function githubTrackerModule(calls: GithubCalls = realCalls, probe: SignInProbe = realProbe): TrackerModule {
  return {
    name: 'github',
    label: 'GitHub',
    about:
      "Stories and bugs come from GitHub Issues or from a GitHub Project. squad-kit moves them along as the squad works and writes on each one. It signs in with GitHub's own tool, gh, and keeps no token.",
    hint: 'Projects need gh to have the project right.',
    fields: FIELDS,
    open(root) {
      const settings = readSettings(root);
      return settings ? new GithubTracker(calls, settings) : null;
    },
    read(root) {
      const settings = readSettings(root);
      return { values: settings ? formValues(settings) : {}, hasSecret: false, ...(settings?.readOnly ? { note: 'Connect again to let squad-kit update GitHub.' } : {}) };
    },
    async save(root, values) {
      writeSettings(root, await checked(calls, values));
    },
    guess(remoteUrl) {
      const repo = repoOf(remoteUrl);
      return repo ? { repo, from: 'issues' } : null;
    },
    setupSteps: (values) => signInSteps(values.from === 'project', probe),
    choices: (values) => choicesFor(calls, values),
  };
}

export const githubTracker = githubTrackerModule();

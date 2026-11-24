import type { BoardMeta, ProjectCommands, RepoInfo, Ticket } from '../../board/types.js';
import { kindsOfCommands } from '../find-commands.js';
import { reposOf } from '../repos.js';
import { kindsOf, placesOf, type PlaceKinds, type Platform, type ProjectKind } from './kinds.js';

/**
 * What each place of a project is, for the Tools page and for the steps that need a tool: its files first. A repo whose
 * files show no app anywhere yet (a new repo, before its first story makes the app) takes what its saved commands run: a
 * repo whose checks run `flutter` becomes a Flutter app before it has a pubspec.yaml. Commands that run `fvm` need FVM,
 * whatever the files say.
 */

/** The kinds that say what the app is. Where the code is kept, a pin or a compose file say nothing about it. */
const APP: ProjectKind[] = ['web', 'flutter', 'react-native', 'ios', 'android'];
const FVM_COMMAND = /(?:^|[\s;&|(])fvm\s/m;

/** The repo a place is in: "project/app" is in the repo "project". */
function repoOf(meta: BoardMeta | null, place: string): RepoInfo | undefined {
  if (!meta) return undefined;
  const repos = reposOf(meta);
  return repos.find((x) => x.path === place) ?? repos.find((x) => x.path !== '.' && place.startsWith(`${x.path}/`)) ?? repos.find((x) => x.path === '.');
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const commandText = (c: ProjectCommands) => Object.values(c).filter((v): v is string => typeof v === 'string').join('\n');

/** The kinds of every place of a project, or of one story, from its files and its saved commands. Places with no kind are left out. */
export function placesWithKinds(root: string, meta: BoardMeta | null, story?: Pick<Ticket, 'parts' | 'repo' | 'worktree' | 'copies'>): PlaceKinds[] {
  const read = placesOf(root, meta, story).map((p) => ({ p, repo: repoOf(meta, p.place), ...kindsOf(p.dir) }));
  // A repo with no app in any of its places yet (before its first story makes it): its commands say what it becomes.
  const shown = new Set(read.filter((x) => x.kinds.some((k) => APP.includes(k))).map((x) => x.repo?.path));
  return read
    .map(({ p, repo, kinds, platforms }) => {
      const commands = repo?.commands ?? {};
      if (!shown.has(repo?.path)) {
        const said = kindsOfCommands(commands);
        kinds = uniq<ProjectKind>([...said.kinds, ...kinds]);
        platforms = uniq<Platform>([...platforms, ...said.platforms]);
      }
      if (FVM_COMMAND.test(commandText(commands)) && !kinds.includes('fvm')) kinds = [...kinds, 'fvm'];
      return { place: p.place, ...(p.part ? { part: p.part } : {}), kinds, platforms };
    })
    .filter((p) => p.kinds.length);
}

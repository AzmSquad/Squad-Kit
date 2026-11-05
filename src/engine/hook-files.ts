import path from 'node:path';
import { projectHooksPath } from './git.js';

/**
 * Where a project keeps its commit hooks and their settings. A hook runs on every commit, on this computer and on the
 * person's own, so an agent never changes these: the check itself stays the person's or an engineer's to change. What a
 * hook calls (the tests, the linter's rules) is the project's code like any other, and the Reviewer reads it.
 */
const CONFIG_ENDS = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'];
const DATA_ENDS = ['', '.json', '.yaml', '.yml'];

export const HOOK_FILES = [
  '.husky/',
  '.githooks/',
  '.git-hooks/',
  '.lefthook/',
  '.pre-commit-config.yaml',
  '.pre-commit-config.yml',
  '.overcommit.yml',
  ...[...DATA_ENDS, ...CONFIG_ENDS].flatMap((e) => [`.lintstagedrc${e}`, `.commitlintrc${e}`]),
  ...CONFIG_ENDS.flatMap((e) => [`lint-staged.config${e}`, `commitlint.config${e}`]),
  ...['.yml', '.yaml', '.toml', '.json'].flatMap((e) => [`lefthook${e}`, `.lefthook${e}`, `lefthook-local${e}`, `.lefthook-local${e}`]),
  ...['.js', '.cjs', '.json'].flatMap((e) => [`simple-git-hooks${e}`, `.simple-git-hooks${e}`]),
];

/** Hook settings a project may keep inside its package.json, which the Builder may otherwise change. */
export const HOOK_PACKAGE_KEYS = ['lint-staged', 'commitlint', 'husky', 'simple-git-hooks', 'pre-commit', 'gitHooks'];

/** The names git runs as hooks: in a folder that is otherwise the project's own code, only these are the check. */
const GIT_HOOKS = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change'];

/**
 * The hook files of a copy: the usual places, and the real hooks in the folder this repo's git runs them from. That
 * folder can have any name (`hooks`, `scripts`), and hold the project's own work as well, so a name that starts with "/"
 * counts from the top of the copy only, and nothing else in that folder is the check. "." is no folder of hooks at all.
 */
export function hookFiles(dir: string): string[] {
  const where = projectHooksPath(dir).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const inside = where && where !== '.' && !path.isAbsolute(where) && !where.startsWith('~') && !where.startsWith('..');
  return [...new Set([...HOOK_FILES, ...(inside && !isHookFile(`${where}/x`) ? GIT_HOOKS.map((h) => `/${where}/${h}`) : [])])];
}

/** True for a path in a copy that is a hook file, from the lists above (`names`, with the repo's own hooks folder). */
export function isHookFile(rel: string, names: string[] = HOOK_FILES): boolean {
  const file = rel.split(path.sep).join('/');
  if (file.startsWith('package.json (')) return true;
  return names.some((n) => (n.startsWith('/') ? file === n.slice(1) : n.endsWith('/') ? `/${file}`.includes(`/${n}`) : path.posix.basename(file) === n));
}

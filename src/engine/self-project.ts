import fs from 'node:fs';
import path from 'node:path';
import { readMeta, type BoardPaths } from '../board/store.js';
import type { BoardMeta, ProductPart, ProjectCommands } from '../board/types.js';
import { reposOf } from './repos.js';
import { git } from './git.js';
import { shellArg } from '../utils/text.js';

/**
 * squad-kit's own code as a project: someone builds squad-kit with squad-kit. It is known by its package (named
 * squad-kit, with the `squad` command), never by its folder's name. squad-kit then says so once, on the setup and the
 * Overview, tells every agent, checks what fits one story, starts a separate sample board for the pictures, and leaves
 * releases to squad-kit's maintainers. ADR-003 in the plan says why.
 */

const PACKAGE = 'squad-kit';
const COMMAND = 'squad';

/** What the person sees once, on the setup and the Overview. */
export const SELF_NOTE = "This is squad-kit's own code. Each story runs its own separate squad-kit, with sample data, so this board and your other projects are never touched.";

/** The Releases page of squad-kit's own code. */
export const SELF_RELEASES =
  "squad-kit's maintainers make its releases: a release on GitHub publishes squad-kit to npm. So squad-kit does not cut a release or a tag here. Your merged stories wait on main; send them as a pull request.";

/** Why the project documents stay out of git on squad-kit's own code: the Settings switch and a hand over say it. */
export const SELF_DOCS_OFF = "On squad-kit's own code the project documents stay on this computer, so a pull request to squad-kit carries code only.";

/** A merged story's line on squad-kit's own code, after "Merged into main · ". */
export const SELF_MERGED = 'send it as a pull request';

/** Why a release is refused on squad-kit's own code, for the button's call and the terminal. */
export const SELF_NO_RELEASE = "This is squad-kit's own code: its maintainers make the releases, as a release on GitHub publishes it to npm. Send your work as a pull request instead.";

/**
 * The sample board a story of squad-kit starts: its port when free, and the link's token. The board holds only sample
 * data, in a home folder of the story's own (engine/own-home.ts), so its token guards nothing of the person's: it is the
 * same every time, so the Tester's pictures can open its pages.
 */
export const SAMPLE_PORT = 4580;
export const SAMPLE_TOKEN = 'a86b956ecee10b400e9edc38c7e4d41c24bedaa39d60fde22829fd04ee3c0af8';

/** The test files that always run beside the changed ones: the board's server, so every story shows it still starts. */
const ALWAYS_TESTS = ['test/console-server.test.ts'];

/** True when the folder holds squad-kit's own code. */
export function isSquadKitCode(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; bin?: unknown };
    const bin = pkg.bin;
    return pkg.name === PACKAGE && typeof bin === 'object' && bin !== null && typeof (bin as Record<string, unknown>)[COMMAND] === 'string';
  } catch {
    return false;
  }
}

/** The repo squad-kit's own package says it comes from, as a git address, or ''. */
export function packageRepo(dir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { repository?: string | { url?: string } };
    return (typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')).replace(/^git\+/, '');
  } catch {
    return '';
  }
}

/**
 * Where the work of squad-kit's own code goes by pull request: its `upstream` remote, else the repo its package names
 * (ADR-008). '' for any other project: its pull requests stay in its own repo, a fork's too.
 */
export function selfUpstream(dir: string, remote: string): string {
  if (!isSquadKitCode(dir)) return '';
  const upstream = remote === 'upstream' ? '' : git(dir, ['config', '--get', 'remote.upstream.url'], { allowFail: true }).trim();
  return upstream || packageRepo(dir);
}

/** The repo of the project that holds squad-kit's own code ('.' when the project is that repo), or null. */
export function selfRepo(root: string, meta: BoardMeta): string | null {
  return reposOf(meta).find((r) => isSquadKitCode(path.join(root, r.path)))?.path ?? null;
}

/** True when the project is squad-kit's own code, or has it as one of its repos. */
export function isSelfProject(bp: BoardPaths, meta?: BoardMeta): boolean {
  try {
    return selfRepo(bp.root, meta ?? readMeta(bp)) !== null;
  } catch {
    return false;
  }
}

/**
 * How squad-kit checks and runs its own code, instead of a guess from its scripts. The setup installs both packages from
 * their lock files. The tests are the ones the story's changes reach, from the commit the story started on, plus the
 * board's server; the whole suite (4,000+ tests, about 9 minutes) stays with the maintainers' CI. Lint is both type
 * checks; the build ends with the package's size limit. The app is a sample board, built from the story's code, on the
 * story's own port and home: no AI, no sign-in, never the person's board.
 */
export function selfCommands(base: string): ProjectCommands {
  return {
    setup: 'pnpm install --frozen-lockfile && pnpm -C console-ui install --frozen-lockfile',
    // vitest's --changed reads `git diff <base>...HEAD` (from where the story started) and what is not committed yet. A
    // plain command, so a run of one test file (failed-tests.ts fileAlone) can be made from it.
    test: `pnpm exec vitest run --changed ${shellArg(base)} && pnpm exec vitest run ${ALWAYS_TESTS.join(' ')}`,
    lint: 'pnpm -s lint && pnpm -C console-ui lint',
    build: 'pnpm -s build && pnpm -s size:guard',
    start: `pnpm -s build && node dist/cli.js demo --port \${PORT:-${SAMPLE_PORT}} --no-open --token ${SAMPLE_TOKEN}`,
    url: `http://127.0.0.1:${SAMPLE_PORT}/?t=${SAMPLE_TOKEN}`,
  };
}

/** squad-kit's way to check and run the code in this folder when it is squad-kit's own, else nothing. */
export function selfCommandsIn(dir: string, base = 'main'): ProjectCommands {
  return isSquadKitCode(dir) ? selfCommands(base) : {};
}

/**
 * The parts a read found in squad-kit's own code, with no address of their own: the read gives them the person's board
 * (port 4571), which no picture or check may reach. The sample board's address is the repo's own start (selfCommands).
 */
export function selfParts(root: string, meta: BoardMeta, parts: ProductPart[]): ProductPart[] {
  const own = selfRepo(root, meta);
  if (own === null) return parts;
  return parts.map((p) => {
    if (p.repo !== own || !p.url) return p;
    const { url: _url, ...rest } = p;
    return rest;
  });
}

/**
 * The commands a design hands in. On squad-kit's own code none apply: the way it checks and runs is fixed above, and a
 * change to it is the person's, in Settings, never a question to them in the middle of a story.
 */
export function designCommands(bp: BoardPaths, meta: BoardMeta, given: ProjectCommands): ProjectCommands {
  return isSelfProject(bp, meta) ? {} : given;
}

/** What every agent on squad-kit's own code is told, before the team's own rules. Empty for any other project. */
export function selfRule(bp: BoardPaths): string {
  if (!isSelfProject(bp)) return '';
  return [
    '## This project is squad-kit itself',
    "The code in your folder is squad-kit's own source code. The squad-kit that runs this board, and runs you, is a separate installed copy.",
    '- Change only the code in your folder. Never change, restart or stop the squad-kit that runs this board.',
    "- Never run `squad` or `node dist/cli.js` against this board, and never read or change ~/.squad-kit: it is the person's own board, with their projects and sign-ins. squad-kit's guard hides it.",
    `- To see a change, use the window (start_app, take_screenshots, look_at_page). squad-kit builds your copy and starts a separate sample board from it (\`squad demo\`): its own home folder, sample data, no AI, no sign-in. Its address carries \`?t=${SAMPLE_TOKEN}\`: keep that \`?t=…\` on the first page of every picture, for example \`/?t=${SAMPLE_TOKEN}\`. The first page is Home; the sample project's board is one click away (Open board).`,
    '- The checks are the type check of the engine and of the board (console-ui), the tests your changes reach plus the board server test, the build and the npm size limit (`pnpm -s size:guard`, under 5 MB). The whole suite (4,000+ tests, about 9 minutes) is for the maintainers: run one test file at a time with run_checks.',
    '- A test that needs what the guard hides (a sandbox inside the sandbox, Docker database tools, squad-kit\'s own browser) skips itself in the guard and says why. That is expected.',
    '- No release, no version bump and no tag: squad-kit\'s maintainers release it. A plain line under `## [Unreleased]` in CHANGELOG.md is welcome for a change people see.',
    '- A story that passes merges into main on this computer and goes on as a pull request: the story shows "Send it as a pull request", with the push of its branch and the page that opens the request.',
  ].join('\n');
}

import type { ToolEvent } from '../modules/ai-tool/types.js';
import { describeToolEvent } from '../modules/registry.js';

/**
 * What an agent is doing, in the person's words: the one place a tool call becomes a status line or a card's live line.
 * A browser test run says "Running the tests", and a search for a raw pattern says "Reading the code". The exact command
 * stays one click away for engineers: the Conversation tab's full log and the ticket's Developer tab.
 */

export const DOING = {
  tests: 'Running the tests',
  check: 'Checking the code',
  copy: 'Making a copy of the code. On a big project this takes a while.',
  setup: "Setting up this story's copy",
  start: 'Starting the app',
  build: 'Building the app',
  read: 'Reading the code',
  plan: 'Reading the plan',
  shots: 'Looking at the screenshots',
  write: 'Writing the code',
  lookup: 'Looking something up',
  other: 'Working…',
} as const;

/** squad-kit's own checks, by name, while they run. */
export const CHECK_DOING: Record<string, string> = { test: DOING.tests, lint: DOING.check, build: DOING.build, start: DOING.start };

type Kind = keyof typeof DOING;

/** Which line wins when one command line does several things. */
const WINS: Kind[] = ['tests', 'setup', 'start', 'build', 'check', 'read', 'other'];

/** One command line cut into its simple commands, leaving what is quoted whole. A here-document's text is no command. */
function simpleCommands(line: string): string[][] {
  const cut = line.replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, '');
  const out: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote = '';
  const endWord = () => {
    if (word) words.push(word);
    word = '';
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < cut.length; i += 1) {
    const c = cut[i]!;
    if (quote) {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ';' || c === '\n' || c === '|' || c === '(' || c === ')') endCommand();
    else if (c === '&') {
      // "2>&1" stays with its redirect; "&&" and "&" end the command.
      if (cut[i - 1] === '>') word += c;
      else endCommand();
    } else if (c === ' ' || c === '\t') endWord();
    else word += c;
  }
  endCommand();
  return out;
}

const WRAPPERS = new Set(['time', 'timeout', 'gtimeout', 'nice', 'nohup', 'exec', 'env', 'sudo', 'command', 'do', 'then', 'else']);
/** Reads, and what a read is piped through. */
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'ls', 'tree', 'wc', 'stat', 'file', 'pwd', 'which', 'diff', 'jq', 'awk', 'sed', 'cut', 'sort', 'uniq', 'tr', 'xargs', 'echo', 'printf', 'true', 'basename', 'dirname', 'realpath']);
const TEST_TOOLS = new Set(['vitest', 'jest', 'mocha', 'ava', 'pytest', 'py.test', 'rspec', 'phpunit', 'tox', 'nox', 'karma', 'wdio']);
const CHECK_TOOLS = new Set(['tsc', 'eslint', 'prettier', 'biome', 'stylelint', 'ruff', 'mypy', 'flake8', 'black', 'pylint', 'pyright', 'isort', 'rubocop', 'golangci-lint', 'shellcheck', 'git', 'gh']);
const BUILD_TOOLS = new Set(['tsup', 'webpack', 'rollup', 'esbuild', 'parcel', 'turbo', 'make', 'gmake', 'cmake', 'ng']);
const START_TOOLS = new Set(['nodemon', 'uvicorn', 'gunicorn', 'hypercorn', 'flask', 'streamlit']);
const INSTALL_WORDS = new Set(['install', 'i', 'ci', 'add', 'update', 'up', 'sync', 'restore', 'fetch', 'upgrade', 'remove', 'rm', 'uninstall', 'link', 'rebuild', 'bootstrap', 'dedupe']);
const INSTALLERS = new Set(['pip', 'pip3', 'pipx', 'poetry', 'uv', 'pipenv', 'bundle', 'gem', 'composer', 'brew', 'apt', 'apt-get', 'conda']);
const MIGRATORS = new Set(['prisma', 'drizzle-kit', 'knex', 'sequelize', 'typeorm', 'alembic', 'flyway', 'liquibase']);

/** A script of the project, by its name: "test:e2e", "dev", "lint". */
function scriptKind(name: string): Kind {
  if (/test|e2e|spec|cypress|playwright/i.test(name)) return 'tests';
  if (/^(dev|start|serve|preview|watch)\b/i.test(name)) return 'start';
  if (/lint|check|type|format|fmt|prettier/i.test(name)) return 'check';
  if (/build|compile|bundle|dist/i.test(name)) return 'build';
  if (/install|setup|prepare|migrate|seed|bootstrap|generate/i.test(name)) return 'setup';
  return 'other';
}

/** A program run by name, with its words after it. */
function toolKind(tool: string, rest: string[]): Kind | null {
  const first = rest.find((w) => !w.startsWith('-')) ?? '';
  if (tool === 'playwright' || tool === 'cypress') {
    if (first === 'install') return 'setup';
    return first === 'test' || first === 'run' ? 'tests' : first === 'open' || first === 'show-report' ? 'other' : 'tests';
  }
  if (TEST_TOOLS.has(tool)) return 'tests';
  if (CHECK_TOOLS.has(tool)) return 'check';
  if (BUILD_TOOLS.has(tool)) return first === 'test' ? 'tests' : first === 'serve' || first === 'dev' ? 'start' : 'build';
  if (START_TOOLS.has(tool)) return 'start';
  if (MIGRATORS.has(tool)) return 'setup';
  if (INSTALLERS.has(tool)) return INSTALL_WORDS.has(first) ? 'setup' : first === 'run' || first === 'exec' ? commandKind(rest.slice(rest.indexOf(first) + 1)) : 'other';
  if (tool === 'next' || tool === 'vite' || tool === 'nuxt' || tool === 'astro' || tool === 'remix') return first === 'build' ? 'build' : 'start';
  return null;
}

/** A package manager's words: its own script, or a program it runs. */
function packageKind(tool: string, rest: string[]): Kind {
  const words = rest.filter((w) => !w.startsWith('-'));
  const first = words[0] ?? '';
  if (!first) return tool === 'yarn' ? 'setup' : 'other';
  if (tool === 'npx' || tool === 'pnpx' || tool === 'bunx') return commandKind(words);
  if (INSTALL_WORDS.has(first)) return 'setup';
  if (first === 'run' || first === 'run-script') return scriptKind(words[1] ?? '');
  if (first === 'exec' || first === 'dlx' || first === 'x') return commandKind(words.slice(1));
  if (first === 't') return 'tests';
  if (tool === 'npm' && !['test', 'start', 'stop', 'restart'].includes(first)) return 'other';
  return toolKind(first, words.slice(1)) ?? scriptKind(first);
}

/** One simple command, as its words: what it does, or null for what says nothing by itself (cd, an assignment). */
function commandKind(all: string[]): Kind {
  let words = all;
  while (words.length) {
    const w = words[0]!;
    if (/^\w+=/.test(w) || /^\d+[smh]?$/.test(w) || WRAPPERS.has(w) || (w.startsWith('-') && words !== all)) words = words.slice(1);
    else break;
  }
  const tool = (words[0] ?? '').split('/').pop() ?? '';
  const rest = words.slice(1);
  if (!tool) return 'other';
  if (tool === 'bash' || tool === 'sh' || tool === 'zsh') {
    const at = rest.indexOf('-c');
    return at >= 0 && rest[at + 1] ? plainKind(rest[at + 1]!) : 'other';
  }
  if (tool === 'npm' || tool === 'pnpm' || tool === 'yarn' || tool === 'bun' || tool === 'npx' || tool === 'pnpx' || tool === 'bunx') return packageKind(tool, rest);
  if (tool === 'sed') return rest.some((r) => /^-i/.test(r)) ? 'other' : 'read';
  if (tool === 'cat' && rest.some((r) => r.startsWith('>'))) return 'other';
  if (READERS.has(tool)) return 'read';
  if (/^python[\d.]*$/.test(tool)) {
    const at = rest.indexOf('-m');
    if (at >= 0 && rest[at + 1]) {
      const mod = rest[at + 1]!;
      if (mod === 'unittest') return 'tests';
      if (mod === 'venv') return 'setup';
      return toolKind(mod, rest.slice(at + 2)) ?? 'other';
    }
    if (/(^|\/)manage\.py$/.test(rest[0] ?? '')) {
      const what = rest[1] ?? '';
      return what === 'test' ? 'tests' : what === 'runserver' ? 'start' : what === 'migrate' || what === 'makemigrations' ? 'setup' : 'other';
    }
    return 'other';
  }
  const known = toolKind(tool, rest);
  if (known) return known;
  // Build tools of other languages: "go test ./...", "cargo build", "dotnet run", "./gradlew test".
  if (['go', 'cargo', 'dotnet', 'mvn', 'mvnw', 'gradle', 'gradlew', 'rails', 'rake', 'swift', 'php', 'artisan'].includes(tool)) {
    const first = rest.find((w) => !w.startsWith('-')) ?? '';
    if (/^(test|spec)/.test(first)) return 'tests';
    if (/^(run|serve|server|s|bootRun)$/.test(first)) return 'start';
    if (/^(vet|clippy|check|fmt)$/.test(first)) return 'check';
    if (/^(build|package|compile|publish|assemble)$/.test(first)) return 'build';
    if (/^(mod|restore|fetch|get|migrate)$/.test(first)) return 'setup';
  }
  return 'other';
}

function plainKind(command: string): Kind {
  const kinds = simpleCommands(command)
    // "cd the-project &&" says nothing about what is done there.
    .filter((w) => w[0] !== 'cd' && w[0] !== 'pushd' && w[0] !== 'popd' && w[0] !== 'export')
    .map(commandKind);
  return WINS.find((k) => kinds.includes(k)) ?? 'other';
}

/** A command as the person reads it. */
export function plainCommand(command: string): string {
  return DOING[plainKind(command)];
}

/** One line a tool's module described ("Reading src/app.ts", "Searching for "x"", "Running npm test") as the person reads it. */
export function plainDoing(line: string): string {
  const reading = /^Reading\s+(.*)$/.exec(line);
  if (reading) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(reading[1]!.trim())) return DOING.shots;
    return /(^|\/)\.squad\//.test(reading[1]!) ? DOING.plan : DOING.read;
  }
  if (/^(Searching for|Looking for|Listing)\b/.test(line)) return DOING.read;
  if (/^(Editing|Writing)\b/.test(line)) return DOING.write;
  if (/^Looking up\b/.test(line)) return DOING.lookup;
  if (/^Running\s/.test(line)) return plainCommand(line.replace(/^Running\s+/, ''));
  return DOING.other;
}

/** One tool call as the person reads it, or null when its module says nothing about it. The whole command decides, not only its first line. */
export function plainToolLine(e: ToolEvent, cwd: string): string | null {
  const line = describeToolEvent(e, cwd);
  if (!line) return null;
  return typeof e.input.command === 'string' && line.startsWith('Running ') ? plainCommand(e.input.command) : plainDoing(line);
}

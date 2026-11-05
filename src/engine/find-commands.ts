import fs from 'node:fs';
import path from 'node:path';
import type { ProjectCommands } from '../board/types.js';
import { findPortVariables } from './port-vars.js';

/**
 * How to test and run a project, read from its own files with no AI: its package.json scripts and the equivalents in
 * other languages. A project that started empty has nothing saved until the Builder set it up, so squad-kit reads this
 * after the build and nobody is asked. Only what the files really say: a project with no test script has no test
 * command here.
 */

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const has = (dir: string, name: string) => fs.existsSync(path.join(dir, name));

/** "http://localhost:3000" for a port, when one is known. */
const at = (port: number | null | undefined) => (port ? `http://localhost:${port}` : undefined);

/** The usual port of a web tool, by the package that brings it. */
const USUAL_PORT: [RegExp, number][] = [
  [/^next$/, 3000],
  [/^react-scripts$/, 3000],
  [/^nuxt$/, 3000],
  [/^@remix-run\//, 3000],
  [/^@angular\/cli$/, 4200],
  [/^astro$/, 4321],
  [/^gatsby$/, 8000],
  [/^@sveltejs\/kit$/, 5173],
  [/^vite$/, 5173],
  [/^express$|^fastify$|^koa$|^hono$/, 3000],
];

/** The port a script says: "--port 8080", "-p 8080", "PORT=8080". */
function portInScript(script: string): number | null {
  const m = /(?:--port[= ]|\s-p[= ]?|\bPORT=)(\d{2,5})\b/.exec(` ${script}`);
  return m ? Number(m[1]) : null;
}

/** The port the project's own code or README names for itself. */
function portInFiles(dir: string): number | null {
  const own = findPortVariables(dir).flatMap((v) => v.defaults)[0];
  if (own) return own;
  const words = /(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*['"]?|\.listen\(\s*)(\d{2,5})\b/;
  for (const f of ['server.js', 'server.ts', 'server.mjs', 'app.js', 'app.ts', 'index.js', 'index.ts', 'main.js', 'main.ts', 'src/server.js', 'src/server.ts', 'src/app.js', 'src/app.ts', 'src/index.js', 'src/index.ts', 'src/main.js', 'src/main.ts']) {
    const m = words.exec(read(path.join(dir, f)));
    if (m) return Number(m[1]);
  }
  const said = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\b/.exec(read(path.join(dir, 'README.md')));
  return said ? Number(said[1]) : null;
}

/** A script that runs tests in a real browser, on its own: run after the others, and never one that opens a window. */
const BROWSER_SCRIPT = /^(?:test[:-])?(?:e2e|browser|playwright|cypress)(?:[:-]test)?$/i;
const SHOWS_A_WINDOW = /--ui\b|--headed\b|--debug\b|cypress open|\bcodegen\b/;
/** npm's own placeholder, and a project's way of saying it has none. */
const NO_TESTS = /no test specified|no tests? yet|echo\s+['"]?no tests?\b/i;
/** A command or script that runs browser tests by itself. */
const RUNS_BROWSER = /playwright\s+test|cypress\s+run/;

function browserScript(scripts: Record<string, string>): string | undefined {
  return Object.keys(scripts).find((k) => BROWSER_SCRIPT.test(k) && !SHOWS_A_WINDOW.test(scripts[k]!) && !NO_TESTS.test(scripts[k]!));
}

/** A package.json's scripts. */
function scriptsOf(dir: string): Record<string, string> | null {
  if (!has(dir, 'package.json')) return null;
  try {
    const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return null;
  }
}

function runnerOf(dir: string): { install: string; run: (s: string) => string; test: string; start: string } {
  if (has(dir, 'pnpm-lock.yaml')) return { install: 'pnpm install', run: (s) => `pnpm run ${s}`, test: 'pnpm test', start: 'pnpm start' };
  if (has(dir, 'yarn.lock')) return { install: 'yarn install', run: (s) => `yarn ${s}`, test: 'yarn test', start: 'yarn start' };
  if (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) return { install: 'bun install', run: (s) => `bun run ${s}`, test: 'bun run test', start: 'bun run start' };
  return { install: 'npm install', run: (s) => `npm run ${s}`, test: 'npm test', start: 'npm start' };
}

/** A project's full test command: the test script, with its separate browser tests after it. */
function nodeTests(dir: string, scripts: Record<string, string>): string | undefined {
  const r = runnerOf(dir);
  const main = scripts.test && !NO_TESTS.test(scripts.test) ? r.test : scripts['test:unit'] ? r.run('test:unit') : undefined;
  const browser = browserScript(scripts);
  if (!main) return browser ? r.run(browser) : undefined;
  return withBrowserTests(dir, main);
}

function nodeCommands(dir: string, scripts: Record<string, string>): ProjectCommands {
  const r = runnerOf(dir);
  const lint = ['lint', 'typecheck', 'type-check', 'check-types', 'types'].find((s) => scripts[s]);
  const startScript = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
  const test = nodeTests(dir, scripts);
  const deps = (() => {
    try {
      const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as { dependencies?: object; devDependencies?: object };
      return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    } catch {
      return [];
    }
  })();
  const usual = USUAL_PORT.find(([re]) => deps.some((d) => re.test(d)))?.[1];
  const script = startScript ? scripts[startScript]! : '';
  const port = startScript ? (portInScript(script) ?? portInFiles(dir) ?? usual ?? null) : null;
  const url = at(port);
  return {
    ...(Object.keys(scripts).length || deps.length ? { setup: r.install } : {}),
    ...(test ? { test } : {}),
    ...(lint ? { lint: r.run(lint) } : {}),
    ...(scripts.build ? { build: r.run('build') } : {}),
    ...(startScript ? { start: startScript === 'start' ? r.start : r.run(startScript) } : {}),
    ...(url ? { url } : {}),
  };
}

/** A Python project: its requirements, and how the entry file it has starts. */
function pythonCommands(dir: string): ProjectCommands | null {
  const reqs = has(dir, 'requirements.txt');
  const pyproject = has(dir, 'pyproject.toml');
  const manage = has(dir, 'manage.py');
  const entry = ['app.py', 'main.py', 'server.py', 'wsgi.py', 'asgi.py'].find((f) => has(dir, f));
  if (!reqs && !pyproject && !manage && !entry) return null;
  const text = `${read(path.join(dir, 'requirements.txt'))}\n${read(path.join(dir, 'pyproject.toml'))}`;
  const entered = entry ? read(path.join(dir, entry)) : '';
  const tests = has(dir, 'conftest.py') || /\bpytest\b/i.test(text) || fs.existsSync(path.join(dir, 'tests'));
  const out: ProjectCommands = {
    ...(reqs ? { setup: 'pip install -r requirements.txt' } : pyproject ? { setup: 'pip install -e .' } : {}),
    ...(manage ? { test: 'python manage.py test' } : tests ? { test: 'python -m pytest' } : {}),
    ...(/\bruff\b/i.test(text) ? { lint: 'ruff check .' } : /\bflake8\b/i.test(text) ? { lint: 'flake8' } : {}),
  };
  if (manage) return { ...out, start: 'python manage.py runserver', url: 'http://localhost:8000' };
  if (entry && (/\bfastapi\b/i.test(text) || /\bFastAPI\(/.test(entered))) return { ...out, start: `uvicorn ${entry.replace(/\.py$/, '')}:app`, url: 'http://localhost:8000' };
  if (entry && (/\bflask\b/i.test(text) || /\bFlask\(/.test(entered))) return { ...out, start: `python ${entry}`, url: at(portInFiles(dir) ?? 5000)! };
  if (entry && /__main__/.test(entered)) {
    const url = at(portInFiles(dir));
    return { ...out, start: `python ${entry}`, ...(url ? { url } : {}) };
  }
  return out;
}

/** True when a file directly in a folder, or one down, matches. */
function anyFile(dir: string, test: (name: string) => boolean): boolean {
  const list = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  return list(dir).some((e) => (e.isFile() ? test(e.name) : e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && list(path.join(dir, e.name)).some((x) => x.isFile() && test(x.name))));
}

function otherCommands(dir: string): ProjectCommands | null {
  if (has(dir, 'go.mod')) return { ...(anyFile(dir, (f) => f.endsWith('_test.go')) ? { test: 'go test ./...' } : {}), lint: 'go vet ./...', build: 'go build ./...' };
  if (has(dir, 'Cargo.toml')) return { test: 'cargo test', build: 'cargo build' };
  if (has(dir, 'pom.xml')) return { test: 'mvn test', build: 'mvn package' };
  if (has(dir, 'gradlew')) return { test: './gradlew test', build: './gradlew build' };
  if (anyFile(dir, (f) => f.endsWith('.csproj') || f.endsWith('.sln'))) return { ...(anyFile(dir, (f) => /tests?\.csproj$/i.test(f)) ? { test: 'dotnet test' } : {}), build: 'dotnet build' };
  if (has(dir, 'Makefile')) {
    const targets = read(path.join(dir, 'Makefile'));
    const target = (name: string) => new RegExp(`^${name}\\s*:`, 'm').test(targets);
    const out: ProjectCommands = { ...(target('test') ? { test: 'make test' } : {}), ...(target('lint') ? { lint: 'make lint' } : {}), ...(target('build') ? { build: 'make build' } : {}) };
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/** What the project's own files say about how to test and run it. Empty when they say nothing. */
export function findCommands(dir: string): ProjectCommands {
  const scripts = scriptsOf(dir);
  if (scripts) return nodeCommands(dir, scripts);
  return pythonCommands(dir) ?? otherCommands(dir) ?? {};
}

/**
 * The test command to save, given one the setup step found: a project with a separate browser or e2e test script gets
 * it too ("npm test && npm run test:e2e"). A command that already names it, or runs it, stays as it is.
 */
export function withBrowserTests(dir: string, test: string | undefined): string | undefined {
  const scripts = scriptsOf(dir);
  const command = test?.trim();
  if (!scripts || !command) return command || undefined;
  const browser = browserScript(scripts);
  if (!browser || command.includes(browser) || RUNS_BROWSER.test(command)) return command;
  // "npm test" that already runs them, by itself or through the other script.
  const usesTestScript = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b(?!:)/.test(command);
  if (usesTestScript && (RUNS_BROWSER.test(scripts.test ?? '') || (scripts.test ?? '').includes(browser))) return command;
  return `${command} && ${runnerOf(dir).run(browser)}`;
}

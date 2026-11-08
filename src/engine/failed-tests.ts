import fs from 'node:fs';
import path from 'node:path';

/**
 * The tests a check's output names as failed, and the command that runs one of them on its own with the project's own
 * test tool. A whole suite of browser tests takes minutes; one test takes seconds. squad-kit uses this to run only what
 * failed the second time, to run a failed test on main's code, and for the Builder's run of one test file.
 *
 * Everything here is careful: when squad-kit cannot be sure it named every failed test, or cannot be sure how the
 * project runs one, it says nothing, and the callers do what they did before. What a test printed never becomes part of
 * a command: every word taken from it is quoted, so a test's name can never run anything.
 */

export type TestTool = 'playwright' | 'vitest' | 'jest' | 'pytest' | 'go';

export interface FailedTest {
  tool: TestTool;
  /** The test's file, as the tool printed it (go: the file of the first line it printed, when it said one). */
  file: string;
  /** The line the test starts on, where the tool says it (Playwright). */
  line?: number;
  /** The test's name with the names of the groups it is in, as the tool joins them: "Orders › a drag changes the order". */
  name?: string;
  /** Playwright's or Vitest's project the test ran in, when the output names one. */
  project?: string;
  /** go: the package the test is in, as go names it ("example.com/shop/billing"). */
  pkg?: string;
}

/** One failed test, the same in every run: its file and its name. The line moves when the file changes. */
export function testKey(t: FailedTest): string {
  return `${t.pkg ?? t.file}::${t.name ?? ''}`;
}

/** A failed test as a person reads it: its name, or its file when it has none. */
export function testTitle(t: FailedTest): string {
  const said = (t.name ?? t.file).replace(/\s+/g, ' ').trim();
  return said.length > 140 ? `${said.slice(0, 139)}…` : said;
}

const PLAYWRIGHT_LINE = /^(?:\[(.+?)\] › )?(.+?):(\d+):(\d+) › (.+?)[\s─]*$/;

/** Playwright: the list under "N failed" at the end. Tests that did not run, or errors outside any test, say it is not all. */
function playwrightFailed(lines: string[]): FailedTest[] | null {
  const out: FailedTest[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i]!.match(/^ {2}(\d+) (failed|interrupted|did not run)\s*$/);
    if (!head) continue;
    if (head[2] !== 'failed') return null;
    const listed: FailedTest[] = [];
    for (let j = i + 1; j < lines.length && /^ {4}\S/.test(lines[j]!); j += 1) {
      const m = lines[j]!.trim().match(PLAYWRIGHT_LINE);
      if (!m) return null;
      listed.push({ tool: 'playwright', file: m[2]!, line: Number(m[3]), name: m[5]!, ...(m[1] ? { project: m[1] } : {}) });
    }
    if (listed.length !== Number(head[1])) return null;
    out.push(...listed);
  }
  if (lines.some((l) => /^ {2}\d+ errors? (was|were) not a part of any test/.test(l))) return null;
  return out;
}

/** Vitest: the FAIL lines under "Failed Tests" and "Failed Suites", checked against its own counts. */
function vitestFailed(lines: string[]): FailedTest[] | null {
  if (!lines.some((l) => /^\s*Test Files\s+.*\(\d+\)\s*$/.test(l))) return [];
  // Errors outside any test fail the run with every test green: no test to name.
  if (lines.some((l) => /Unhandled Errors?\s*⎯|unhandled errors? during the test run/i.test(l))) return null;
  const tests = new Map<string, FailedTest>();
  const suites = new Map<string, FailedTest>();
  for (const line of lines) {
    const m = line.match(/^\s*FAIL\s+(?:\|([^|]+)\|\s+)?(\S+)\s+(?:>\s+(.+?)|\[ .+ \])\s*$/);
    if (!m) continue;
    const t: FailedTest = { tool: 'vitest', file: m[2]!, ...(m[3] ? { name: m[3] } : {}), ...(m[1] ? { project: m[1] } : {}) };
    (m[3] ? tests : suites).set(`${m[1] ?? ''}|${testKey(t)}`, t);
  }
  const count = (re: RegExp) => lines.map((l) => l.match(re)).find(Boolean)?.[1];
  const failed = count(/^\s*Tests\s+(\d+)\s+failed\b/);
  const broken = count(/Failed Suites (\d+)\s*⎯/);
  if (Number(failed ?? 0) !== tests.size || Number(broken ?? 0) !== suites.size) return null;
  return [...suites.values(), ...tests.values()];
}

/** Jest: the "●" names under each FAIL file, checked against its own count. */
function jestFailed(lines: string[]): FailedTest[] | null {
  if (!lines.some((l) => /^Test Suites:\s/.test(l))) return [];
  const tests = new Map<string, FailedTest>();
  const suites = new Map<string, FailedTest>();
  let file: string | null = null;
  for (const line of lines) {
    const head = line.match(/^\s*(FAIL|PASS)\s+(.+?)(?:\s+\([\d.]+\s*m?s\))?\s*$/);
    if (head) {
      // Vitest's own FAIL lines name the test after the file: they are not Jest's.
      const words = head[2]!.split(/\s+/);
      file = head[1] === 'FAIL' && !/ > |\[ /.test(head[2]!) ? words[words.length - 1]! : null;
      continue;
    }
    const m = file ? line.match(/^ {2}● (.+?)\s*$/) : null;
    if (!m) continue;
    if (m[1] === 'Test suite failed to run') suites.set(file!, { tool: 'jest', file: file! });
    else tests.set(`${file}::${m[1]}`, { tool: 'jest', file: file!, name: m[1]! });
  }
  const failed = lines.map((l) => l.match(/^Tests:\s+(\d+) failed\b/)).find(Boolean)?.[1];
  if (Number(failed ?? 0) !== tests.size) return null;
  return [...suites.values(), ...tests.values()];
}

/** pytest: the short summary's FAILED and ERROR lines, checked against its last line. A run it stopped early is not all. */
function pytestFailed(lines: string[]): FailedTest[] | null {
  // "===== 1 failed, 33 passed in 1.20s =====", or the same without the lines when it runs quietly.
  const last = [...lines].reverse().find((l) => /^=*\s*\d+ \w+.*\bin [\d.]+s\b/.test(l) && /\b\d+ (passed|failed|errors?|skipped|deselected|xfailed|xpassed)\b/.test(l));
  if (!last) return [];
  if (lines.some((l) => /^!+ .*(Interrupted|stopping after)/.test(l))) return null;
  const out = new Map<string, FailedTest>();
  let failedLines = 0;
  let errorLines = 0;
  for (const line of lines) {
    const m = line.match(/^(FAILED|ERROR) (.+?)(?: - .*)?$/);
    if (!m) continue;
    if (m[1] === 'FAILED') failedLines += 1;
    else errorLines += 1;
    const [file, ...rest] = m[2]!.trim().split('::');
    const t: FailedTest = { tool: 'pytest', file: file!, ...(rest.length ? { name: rest.join('::') } : {}) };
    out.set(testKey(t), t);
  }
  const n = (word: RegExp) => Number(last.match(word)?.[1] ?? 0);
  if (n(/(\d+) failed/) !== failedLines || n(/(\d+) errors?\b/) !== errorLines) return null;
  return [...out.values()];
}

/** go test: each "--- FAIL" of a whole test, with the package its FAIL line names. A package that did not build is not all. */
function goFailed(lines: string[]): FailedTest[] | null {
  const out: FailedTest[] = [];
  let pending: { name: string; file: string }[] = [];
  let current: { name: string; file: string } | null = null;
  for (const line of lines) {
    const top = line.match(/^--- FAIL: (\S+) \(/);
    if (top) {
      current = { name: top[1]!, file: '' };
      pending.push(current);
      continue;
    }
    const at = current && !current.file ? line.match(/^\s+(\S+_test\.go):\d+:/) : null;
    if (at) current!.file = at[1]!;
    if (/^FAIL\s+\S+\s+\[(build|setup) failed\]/.test(line)) return null;
    const pkg = line.match(/^FAIL\t(\S+)\t/) ?? line.match(/^FAIL\s+(\S+)\s+[\d.]+s\s*$/);
    if (pkg) {
      // A package that failed with no test named (a TestMain that exits, a panic outside a test): no test to run.
      if (!pending.length) return null;
      out.push(...pending.map((p) => ({ tool: 'go' as const, file: p.file, name: p.name, pkg: pkg[1]! })));
      pending = [];
      current = null;
    }
  }
  // A failed test with no package after it: the output was cut, or is not go's.
  if (pending.length) return null;
  return out;
}

/**
 * The failed tests a check's output names: Playwright, Vitest, Jest, pytest and go test. One command may run two of
 * them (npm test && npm run test:e2e). Empty when it names none it knows, or when squad-kit cannot be sure it found every
 * one: a run its tool stopped early, an error outside any test, or counts that do not add up.
 */
export function failedTests(output: string): FailedTest[] {
  // Without its colors, as checks.ts reads it: some tools print them even when asked not to.
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').split('\n');
  const found: FailedTest[] = [];
  for (const read of [playwrightFailed, vitestFailed, jestFailed, pytestFailed, goFailed]) {
    const some = read(lines);
    if (some === null) return [];
    found.push(...some);
  }
  return found;
}

/* ── Running one test on its own ─────────────────────────── */

/** A word for the shell, in single quotes, where the shell reads nothing. */
function quoted(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Text a test tool reads as a pattern, matching only itself. */
function exactly(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A command's words, as the shell splits them, with its quotes taken off. Null when it has more than words and quotes:
 * a variable, a pipe, a redirect, another command after it. squad-kit only reads what it can be sure of.
 */
function wordsOf(text: string): string[] | null {
  const out: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (word !== null) out.push(word);
      word = null;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? '') + text.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      let inside = '';
      for (; j < text.length && text[j] !== '"'; j += 1) {
        if ('$`'.includes(text[j]!)) return null;
        if (text[j] === '\\' && j + 1 < text.length) j += 1;
        inside += text[j];
      }
      if (j >= text.length) return null;
      word = (word ?? '') + inside;
      i = j;
    } else if (ch === '\\') {
      if (i + 1 >= text.length) return null;
      i += 1;
      word = (word ?? '') + text[i];
    } else if ('$`|;&<>(){}#\n'.includes(ch)) return null;
    else word = (word ?? '') + ch;
  }
  if (word !== null) out.push(word);
  return out;
}

/** A command cut at each "&&" outside quotes. */
function splitAnd(text: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"') i += 1;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') i += 1;
    else if (ch === '&' && text[i + 1] === '&') {
      parts.push(text.slice(start, i));
      start = i + 2;
      i += 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

function scriptsIn(dir: string): Record<string, string> | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return null;
  }
}

/** The test tools a package manager also runs by their own name, with no script of that name: "pnpm vitest". */
const TOOL_BINS = new Set(['playwright', 'vitest', 'jest', 'pytest', 'py.test']);
/** Programs that may run anything, so a part of a chain that is one of them could hide a test tool. */
const MAY_RUN_ANYTHING = new Set(['npm', 'pnpm', 'yarn', 'bun', 'bunx', 'npx', 'cd', 'pushd', 'sh', 'bash', 'zsh', 'make', 'turbo', 'nx', 'lerna', 'env', 'exec', 'eval', 'xargs', 'concurrently', 'npm-run-all', 'run-s', 'run-p', 'dotenv', 'env-cmd', 'cross-env-shell', 'poetry', 'uv', 'pipenv', 'tox', 'nox']);

/**
 * A package script a part runs ("npm test", "npm run test:e2e", "pnpm test", "yarn e2e"), as the commands it stands for:
 * its pre and post scripts around it, and the words after it added at its end, as npm does. Undefined when the part runs
 * no script; null when it does and squad-kit cannot tell which.
 */
function scriptOf(words: string[], scripts: Record<string, string> | null): string[] | null | undefined {
  const [tool, ...rest] = words;
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(tool!)) return undefined;
  let i = 0;
  while (rest[i]?.startsWith('-')) i += 1;
  let name = rest[i];
  if (!name) return null;
  // "pnpm exec vitest" finds a tool, it runs no script.
  if (name === 'exec' || name === 'dlx' || name === 'x') return undefined;
  if (name === 'run' || name === 'run-script') {
    i += 1;
    while (rest[i]?.startsWith('-')) i += 1;
    name = rest[i];
  } else if (tool === 'npm' && name === 't') name = 'test';
  else if (tool === 'npm' && !['test', 'start'].includes(name)) return null;
  else if (tool === 'bun' && name === 'test') return null;
  if (!name || !scripts) return null;
  const text = scripts[name];
  // pnpm and yarn run a tool by its name when no script has it: "pnpm vitest".
  if (text === undefined) return tool !== 'npm' && TOOL_BINS.has(name) ? [rest.slice(i).map(quoted).join(' ')] : null;
  const extra = rest.slice(i + 1).filter((w, k) => !(k === 0 && w === '--'));
  return [scripts[`pre${name}`], `${text}${extra.length ? ` ${extra.map(quoted).join(' ')}` : ''}`, scripts[`post${name}`]].filter((s): s is string => Boolean(s?.trim()));
}

/** The simple commands a test command runs one after another, through the package scripts it names. Null when unsure. */
function chainOf(dir: string, command: string, scripts = scriptsIn(dir), depth = 0): string[][] | null {
  if (depth > 5) return null;
  const out: string[][] = [];
  for (const part of splitAnd(command)) {
    const words = wordsOf(part);
    if (!words?.length) return null;
    const script = scriptOf(words, scripts);
    if (script === null) return null;
    if (script === undefined) {
      out.push(words);
      continue;
    }
    for (const text of script) {
      const inner = chainOf(dir, text, scripts, depth + 1);
      if (!inner) return null;
      out.push(...inner);
    }
  }
  return out;
}

/** How a part of the chain runs a test tool: the values it sets first, and the settings it gives the tool. */
interface ToolRun {
  tool: TestTool;
  /** NAME=value words before it, quoted again. */
  env: string[];
  /** The settings it passes the tool, which a run of one test needs too (the config file, the project), quoted again. */
  carry: string[];
  /** Playwright and Vitest projects it names, so a test of one project runs in it. */
  projects: string[];
}

/** The settings each tool is given that one test needs as well. Others (which files, how to report) are left out. */
const CARRY: Record<TestTool, { value: string[]; flag: string[] }> = {
  playwright: { value: ['-c', '--config', '--retries'], flag: [] },
  vitest: { value: ['-c', '--config', '-r', '--root', '--dir', '--mode', '--environment'], flag: [] },
  jest: { value: ['-c', '--config', '--rootDir', '--selectProjects', '--env'], flag: ['-i', '--runInBand'] },
  pytest: { value: ['-c', '--rootdir', '-p', '--ds', '--dc', '-o', '--confcutdir'], flag: [] },
  go: { value: ['-tags'], flag: ['-race'] },
};

/** The test tool a part of the chain runs. 'other' for a program that is none; null when squad-kit cannot tell. */
function toolRunOf(words0: string[]): ToolRun | 'other' | null {
  let words = [...words0];
  const env: string[] = [];
  const takeEnv = () => {
    while (words[0] && /^[A-Za-z_]\w*=/.test(words[0])) {
      const [name, ...value] = words.shift()!.split('=');
      env.push(`${name}=${quoted(value.join('='))}`);
    }
  };
  takeEnv();
  if (words[0] === 'cross-env') {
    words.shift();
    takeEnv();
  }
  // What only finds the tool: npx, pnpm exec, yarn, bunx.
  if (words[0] === 'npx' || words[0] === 'bunx') {
    words.shift();
    while (words[0]?.startsWith('-')) words.shift();
  } else if ((words[0] === 'pnpm' || words[0] === 'yarn' || words[0] === 'npm') && words[1] === 'exec') {
    words = words.slice(2);
    if (words[0] === '--') words.shift();
  } else if ((words[0] === 'pnpm' || words[0] === 'yarn') && TOOL_BINS.has(words[1] ?? '')) words.shift();
  const program = path.basename(words[0] ?? '');
  let tool: TestTool | null = null;
  let args: string[] = [];
  if (program === 'playwright' && words[1] === 'test') [tool, args] = ['playwright', words.slice(2)];
  else if (program === 'vitest' && (!words[1] || words[1] === 'run' || words[1].startsWith('-'))) [tool, args] = ['vitest', words.slice(words[1] === 'run' ? 2 : 1)];
  else if (program === 'jest') [tool, args] = ['jest', words.slice(1)];
  else if (program === 'pytest' || program === 'py.test') [tool, args] = ['pytest', words.slice(1)];
  else if (/^python(\d+(\.\d+)?)?$/.test(program) && words[1] === '-m' && words[2] === 'pytest') [tool, args] = ['pytest', words.slice(3)];
  else if (program === 'go' && words[1] === 'test') [tool, args] = ['go', words.slice(2)];
  // Getting a tool ready, or looking at the code, runs no test: "playwright install", "go vet".
  if (!tool && ((program === 'playwright' && words[1] === 'install') || (program === 'go' && ['vet', 'build', 'fmt'].includes(words[1] ?? '')))) return 'other';
  if (!tool) return MAY_RUN_ANYTHING.has(program) || TOOL_BINS.has(program) || program === 'go' ? null : 'other';
  const carry: string[] = [];
  const projects: string[] = [];
  const { value, flag } = CARRY[tool];
  for (let i = 0; i < args.length; i += 1) {
    const [name, given] = args[i]!.includes('=') ? [args[i]!.slice(0, args[i]!.indexOf('=')), args[i]!.slice(args[i]!.indexOf('=') + 1)] : [args[i]!, undefined];
    const isProject = name === '--project' && (tool === 'playwright' || tool === 'vitest');
    if (flag.includes(name)) carry.push(name);
    else if (value.includes(name) || isProject) {
      const v = given ?? args[(i += 1)];
      if (v === undefined) return null;
      // A short one takes its value as the next word: some tools read "-c=x" as the value "=x". go takes both.
      if (isProject) projects.push(v);
      else carry.push(tool === 'go' || name.startsWith('--') ? `${name}=${quoted(v)}` : `${name} ${quoted(v)}`);
    }
  }
  return { tool, env, carry, projects };
}

/** The test tools a test command runs, in order. Null when squad-kit cannot be sure what it runs. */
function toolRuns(dir: string, command: string): (ToolRun | 'other')[] | null {
  const chain = chainOf(dir, command);
  if (!chain?.length) return null;
  const runs: (ToolRun | 'other')[] = [];
  for (const words of chain) {
    const run = toolRunOf(words);
    if (run === null) return null;
    runs.push(run);
  }
  return runs;
}

/** The tool is really there in this folder, so running it never downloads anything. The Python to run pytest with. */
function installed(dir: string, tool: TestTool): { python?: string } | null {
  if (tool === 'go') return fs.existsSync(path.join(dir, 'go.mod')) ? {} : null;
  if (tool === 'pytest') {
    for (const venv of ['.venv', 'venv', 'env']) {
      if (fs.existsSync(path.join(dir, venv, 'bin', 'pytest')) && fs.existsSync(path.join(dir, venv, 'bin', 'python'))) return { python: `${venv}/bin/python` };
    }
    return null;
  }
  return fs.existsSync(path.join(dir, 'node_modules', '.bin', tool)) ? {} : null;
}

/** The go module's name, from go.mod. */
function goModule(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** A go package's folder in the module: "example.com/shop/billing" is ./billing. Null when it is not this module's. */
function goFolder(dir: string, pkg: string): string | null {
  const mod = goModule(dir);
  if (!mod) return null;
  if (pkg === mod) return '.';
  return pkg.startsWith(`${mod}/`) ? `./${pkg.slice(mod.length + 1)}` : null;
}

/** The command for one test with this tool, as the chain's part runs it. */
function commandFor(dir: string, run: ToolRun, t: Pick<FailedTest, 'file' | 'line' | 'name' | 'project' | 'pkg'>): string | null {
  const has = installed(dir, run.tool);
  if (!has) return null;
  const env = run.env.length ? `${run.env.join(' ')} ` : '';
  const carry = run.carry.length ? ` ${run.carry.join(' ')}` : '';
  const projects = (t.project ? [t.project] : run.projects).map((p) => ` --project=${quoted(p)}`).join('');
  // The Node tools run from the folder's own node_modules, where npx finds them. Every command here is the project's own
  // test run: squad-kit runs it itself with runCommand, inside its guard, like every check. No agent's shell runs it.
  switch (run.tool) {
    case 'playwright':
      // Playwright reads the file as a pattern, then the line after it.
      return `${env}npx playwright test${carry}${projects} ${quoted(`${exactly(t.file)}${t.line ? `:${t.line}` : ''}`)}`;
    case 'vitest':
      return `${env}npx vitest run${carry}${projects} ${quoted(t.file)}${t.name ? ` -t ${quoted(`${exactly(t.name.split(' > ').join(' '))}$`)}` : ''}`;
    case 'jest':
      return `${env}npx jest${carry} ${quoted(exactly(t.file))}${t.name ? ` -t ${quoted(`^${exactly(t.name.split(' › ').join(' '))}$`)}` : ''}`;
    case 'pytest':
      return `${env}${has.python} -m pytest${carry} ${quoted(t.name ? `${t.file}::${t.name}` : t.file)}`;
    case 'go': {
      const folder = t.pkg ? goFolder(dir, t.pkg) : null;
      if (!folder || !t.name) return null;
      // Only the whole test: its cases run inside it. -count=1, as go keeps a test's last pass otherwise.
      return `${env}go test${carry} -count=1 -run ${quoted(`^${exactly(t.name.split('/')[0]!)}$`)} ${quoted(folder)}`;
    }
  }
}

/**
 * The command that runs one failed test on its own in `dir`, with the project's own test tool, the way `testCommand`
 * runs it: the config file and the values it gives the tool are carried. Only when the tool that printed it runs last in
 * the command, and runs only there: in "npm test && npm run test:e2e" a failure in the first part means the second never
 * ran, so running only that test would skip the rest. Null when squad-kit cannot be sure: then the whole command runs.
 */
export function testAlone(dir: string, testCommand: string, t: FailedTest): string | null {
  const runs = toolRuns(dir, testCommand);
  const last = runs?.[runs.length - 1];
  if (!runs || !last || last === 'other' || last.tool !== t.tool) return null;
  if (runs.slice(0, -1).some((r) => r !== 'other' && r.tool === t.tool)) return null;
  if (t.file.startsWith('-') || t.name?.startsWith('-')) return null;
  return commandFor(dir, last, t);
}

/** Playwright's test folder in its config, relative to `dir`, when it says one plainly. */
function playwrightFolder(dir: string, run: ToolRun): string | null {
  const said = run.carry.map((c) => c.match(/^(?:-c |--config=)'(.*)'$/)?.[1]).find(Boolean);
  const files = said ? [said] : ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'];
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const folder = text.match(/testDir\s*:\s*['"`]([^'"`$]+)['"`]/)?.[1];
      return folder ? path.normalize(path.join(path.dirname(f), folder)) : null;
    } catch {
      // Not this name.
    }
  }
  return null;
}

/**
 * The command that runs one test file (or a file at a line, for Playwright) on its own, as the Builder asks with
 * run_checks. When the test command runs two tools (Vitest, then Playwright), the file goes to the one whose tests it
 * is: Playwright's own test folder says. Null when squad-kit cannot tell, or the file is not in the copy.
 */
export function fileAlone(dir: string, testCommand: string, asked: string): { command: string; tool: TestTool } | null {
  const m = asked.trim().match(/^(.+?)(?::(\d+))?$/);
  if (!m) return null;
  const file = path.normalize(m[1]!).replace(/^\.\//, '');
  if (!file || file.startsWith('-') || file.startsWith('..') || path.isAbsolute(file) || !fs.existsSync(path.join(dir, file))) return null;
  const runs = (toolRuns(dir, testCommand) ?? []).filter((r): r is ToolRun => r !== 'other' && r.tool !== 'go');
  const kinds = [...new Set(runs.map((r) => r.tool))];
  let tool: TestTool | undefined = kinds.length === 1 ? kinds[0] : undefined;
  if (kinds.length === 2 && kinds.includes('playwright')) {
    const folder = playwrightFolder(dir, runs.find((r) => r.tool === 'playwright')!);
    if (folder && folder !== '.') tool = file === folder || file.startsWith(`${folder}${path.sep}`) ? 'playwright' : kinds.find((k) => k !== 'playwright');
  }
  const run = runs.find((r) => r.tool === tool);
  if (!run) return null;
  const command = commandFor(dir, run, { file, ...(m[2] && run.tool === 'playwright' ? { line: Number(m[2]) } : {}) });
  return command ? { command, tool: run.tool } : null;
}

/**
 * True when the story changed the failed test's own file: then it is not the same test as on main, and running it there
 * says nothing. A tool may print the file from its own folder, so a changed file that ends with it counts. go names a
 * package: any test file of that package counts.
 */
export function inChanged(t: FailedTest, changed: string[], dir: string): boolean {
  if (t.tool === 'go') {
    const folder = t.pkg ? goFolder(dir, t.pkg) : null;
    if (!folder) return true;
    const rel = folder === '.' ? '' : `${folder.slice(2)}/`;
    return changed.some((f) => f.startsWith(rel) && !f.slice(rel.length).includes('/') && f.endsWith('_test.go'));
  }
  const file = t.file.replace(/^\.\//, '');
  return changed.some((f) => f === file || f.endsWith(`/${file}`));
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git } from './git.js';

/**
 * Weakened checks: a change that makes the tests easier to pass instead of making the code right. Before the checks
 * run, squad-kit compares the ticket's copy with its base and stops on deleted tests, fewer tests, changed test scripts
 * or test settings, and tests switched off (`.skip`, `.only`, `xit` and the like, in the common languages). Only the
 * person can go past it, with a reason on the record. It reads only the changed files, so it takes a moment.
 */

export interface Weakening {
  kind: 'deleted' | 'fewer' | 'config' | 'skip';
  file: string;
  /** Plain words for the card: "test/booking.test.ts was deleted (4 tests)." */
  text: string;
  /** The same weakening has the same key on the next run, so a Continue anyway is remembered for it. */
  key: string;
}

/** One changed file: its text at the base and in the copy now (null when it is not there), and its old name. */
export interface FileChange {
  path: string;
  from?: string;
  before: string | null;
  after: string | null;
}

const CODE = /\.(?:[cm]?[jt]sx?|py|go|java|kt|cs|rb|rs|php)$/i;
const TEST_NAMES = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,
  /(?:^|\/)test_[^/]*\.py$/,
  /_test\.(?:py|go|rb)$/,
  /_spec\.rb$/,
  /(?:Test|Tests|IT)\.(?:java|kt|cs)$/,
  /Test\.php$/,
];
const TEST_DIRS = /(?:^|\/)(?:__tests__|tests?|specs?|[\w.-]+\.Tests?)\//;

/** A file of tests, by its name or folder, in the common languages. */
export function isTestFile(file: string): boolean {
  return CODE.test(file) && (TEST_NAMES.some((r) => r.test(file)) || TEST_DIRS.test(file));
}

const lang = (file: string): 'js' | 'py' | 'go' | 'jvm' | 'cs' | 'rb' | 'rs' | 'php' | null => {
  const ext = path.extname(file).toLowerCase();
  if (/^\.[cm]?[jt]sx?$/.test(ext)) return 'js';
  return ({ '.py': 'py', '.go': 'go', '.java': 'jvm', '.kt': 'jvm', '.cs': 'cs', '.rb': 'rb', '.rs': 'rs', '.php': 'php' } as const)[ext] ?? null;
};

/** What starts one test, per language. */
const CASES: Record<NonNullable<ReturnType<typeof lang>>, RegExp[]> = {
  js: [/(?<![\w.$])(?:it|test|xit|fit|xtest|ftest)(?:\.(?:only|skip|todo|concurrent|each|fails|failing|fixme|skipIf|runIf|sequential))*\s*\(/g],
  py: [/^\s*(?:async\s+)?def\s+test\w*\s*\(/gm],
  go: [/^func\s+(?:\([^)]*\)\s*)?Test\w*\s*\(/gm],
  jvm: [/@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/g],
  cs: [/\[\s*(?:Fact|Theory|Test|TestMethod|TestCase)\b/g],
  rb: [/^\s*(?:it|specify|scenario|example|xit|fit)\b[\s(]/gm, /^\s*def\s+test_\w*/gm],
  rs: [/#\[(?:tokio::)?test\b/g],
  php: [/function\s+test\w*\s*\(/g, /@test\b/g, /#\[Test\]/g],
};

/** What switches a test off, or runs only some of them, per language. */
const SKIPS: Record<NonNullable<ReturnType<typeof lang>>, RegExp[]> = {
  js: [
    /(?<![\w.$])(?:describe|it|test|context|suite|specify)\.(?:skip|only|fixme|skipIf)\b/g,
    /(?<![\w.$])(?:xit|xdescribe|xtest|xcontext|xspecify|fit|fdescribe|ftest|fcontext)\s*\(/g,
  ],
  py: [/@pytest\.mark\.(?:skip|skipif|xfail)\b/g, /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/g, /\bpytest\.skip\s*\(/g, /\.skipTest\s*\(/g],
  go: [/\b\w+\.Skip(?:Now|f)?\s*\(/g],
  jvm: [/@(?:Disabled|Ignore)\b/g],
  cs: [/\[\s*(?:Ignore|Explicit)\b/g, /\b(?:Fact|Theory)\s*\(\s*Skip\s*=/g],
  rb: [/^\s*(?:xit|xdescribe|xcontext|xspecify|fit|fdescribe|fcontext|skip|pending)\b/gm, /\bfocus:\s*true\b/g],
  rs: [/#\[ignore\b/g],
  php: [/->markTest(?:Skipped|Incomplete)\s*\(/g],
};

/** Test settings kept in a file of their own. */
const CONFIG_FILES = [
  /^(?:vitest|jest|karma|playwright|cypress|ava|wdio)\.(?:config|conf|workspace)\.[\w.]+$/,
  /^vitest\.(?:workspace|projects?)\.[\w.]+$/,
  /^cypress\.json$/,
  /^\.mocharc(?:\.[\w]+)?$/,
  /^\.(?:nycrc|c8rc)(?:\.[\w]+)?$/,
  /^(?:pytest\.ini|\.coveragerc|\.rspec)$/,
  /^phpunit\.xml(?:\.dist)?$/,
];

/** Files with test settings beside other settings: only their test part counts. */
const MIXED_FILES = /^(?:package\.json|pyproject\.toml|setup\.cfg|tox\.ini|vite\.config\.[\w.]+)$/;
/** Build files, where a test switch-off is a setting: skipTests, ignoreFailures, `-x test`. */
const BUILD_FILES = /^(?:pom\.xml|build\.gradle(?:\.kts)?)$/;
const BUILD_SKIPS = [/skipTests|maven\.test\.skip|testFailureIgnore|ignoreFailures\s*=\s*true|-x\s+test\b/g];

function count(text: string | null, patterns: RegExp[]): number {
  if (!text) return 0;
  return patterns.reduce((n, p) => n + (text.match(p)?.length ?? 0), 0);
}

/** How many tests a file holds. */
export function testCases(file: string, text: string | null): number {
  const l = lang(file);
  return l ? count(text, CASES[l]) : 0;
}

/** The markers that switch tests off in a file, by marker: { "it.skip": 2 }. */
function skipMarkers(file: string, text: string | null): Map<string, number> {
  const l = lang(file);
  const out = new Map<string, number>();
  if (!l || !text) return out;
  for (const p of SKIPS[l]) {
    for (const m of text.matchAll(p)) {
      let word = m[0].trim().replace(/[\s(=]+$/, '');
      if (/^#?\[/.test(word) && !word.endsWith(']')) word += ']';
      out.set(word, (out.get(word) ?? 0) + 1);
    }
  }
  return out;
}

/** True when a file only holds test settings. */
export function isTestConfig(file: string): boolean {
  return CONFIG_FILES.some((r) => r.test(path.basename(file)));
}

/** The test part of a file that mixes test settings with others, as text to compare. Null when it has none. */
function testPart(file: string, text: string | null, scripts: string[] = []): string | null {
  if (text === null) return null;
  const name = path.basename(file);
  if (name === 'package.json') {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    const own = Object.entries((pkg.scripts ?? {}) as Record<string, unknown>).filter(([k]) => /test|spec|e2e|coverage/i.test(k) || scripts.includes(k));
    const keys = ['jest', 'mocha', 'ava', 'c8', 'nyc', 'vitest'].filter((k) => pkg[k] !== undefined).map((k) => [k, pkg[k]] as const);
    const all = [...own.map(([k, v]) => [`scripts.${k}`, v] as const), ...keys];
    return all.length ? JSON.stringify(Object.fromEntries(all)) : null;
  }
  if (/^(?:pyproject\.toml|setup\.cfg|tox\.ini)$/.test(name)) {
    const parts = sections(text).filter(([head]) => /^\[(?:tool\.pytest|tool:pytest|pytest|tool\.coverage|coverage)/.test(head));
    return parts.length ? parts.map(([h, body]) => `${h}\n${body}`).join('\n') : null;
  }
  if (/^vite\.config\./.test(name)) return block(text, /\btest\s*:\s*\{/);
  return null;
}

/** "[section]" headers with their lines, for ini and toml files. */
function sections(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const chunk of text.split(/^(?=\[)/m)) {
    const nl = chunk.indexOf('\n');
    const head = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
    if (head.startsWith('[')) out.push([head, (nl < 0 ? '' : chunk.slice(nl + 1)).trim()]);
  }
  return out;
}

/** The text of the `{ … }` block that starts where `start` matches, braces counted. */
function block(text: string, start: RegExp): string | null {
  const m = start.exec(text);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(m.index, i + 1).replace(/\s+/g, ' ');
  }
  return text.slice(m.index).replace(/\s+/g, ' ');
}

const short = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 8);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A file squad-kit looks at: tests, test settings, or Rust code (its tests live beside the code). */
export function worthReading(file: string): boolean {
  const name = path.basename(file);
  return isTestFile(file) || isTestConfig(file) || MIXED_FILES.test(name) || BUILD_FILES.test(name) || /\.rs$/.test(file);
}

/** The package.json scripts a test command runs: "npm run check" runs "check", "npm test" runs "test". */
export function scriptsOf(command: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (command ?? '').matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:-\S+\s+)*([\w:.-]+)/g)) {
    if (!['install', 'ci', 'exec', 'dlx', 'x'].includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * A story that changes what a gate runs: a file its command names, or the package.json script it runs. A file the base
 * does not have is new work, not a changed gate. `who`: the gate, in words.
 */
export function gateChanged(dir: string, base: string, command: string, who: string): Weakening[] {
  const changed = new Set(git(dir, ['diff', '--name-only', '--relative', base], { allowFail: true }).split('\n').filter(Boolean));
  if (!changed.size) return [];
  const out: Weakening[] = [];
  for (const word of new Set(command.split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '')))) {
    if (!changed.has(word) || !git(dir, ['rev-parse', '--verify', '-q', `${base}:./${word}`], { allowFail: true })) continue;
    const now = fs.existsSync(path.join(dir, word)) ? fs.readFileSync(path.join(dir, word), 'utf8') : '';
    out.push({ kind: 'config', file: word, text: `${word} changed, and ${who} runs it.`, key: `gate:${word}:${short(now)}` });
  }
  if (changed.has('package.json')) {
    const scriptIn = (text: string, s: string): string | undefined => {
      try {
        return ((JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {})[s];
      } catch {
        return undefined;
      }
    };
    const was = git(dir, ['show', `${base}:./package.json`], { allowFail: true });
    const nowText = fs.existsSync(path.join(dir, 'package.json')) ? fs.readFileSync(path.join(dir, 'package.json'), 'utf8') : '';
    for (const s of scriptsOf(command)) {
      const now = scriptIn(nowText, s);
      if (scriptIn(was, s) !== now) out.push({ kind: 'config', file: 'package.json', text: `The "${s}" script in package.json changed, and ${who} runs it.`, key: `gate:${s}:${short(now ?? '')}` });
    }
  }
  return out;
}

/**
 * What weakens the tests in a set of changed files. Pure: the files' text before and after comes in. `scripts` are the
 * package.json scripts the project's test command runs, whatever their names.
 */
export function findWeakening(changes: FileChange[], scripts: string[] = []): Weakening[] {
  const out: Weakening[] = [];
  // Fewer tests: counted over every changed test file, so tests moved to another file or renamed are no alarm.
  const tests = changes.filter((c) => isTestFile(c.path) || (c.from && isTestFile(c.from)) || /\.rs$/.test(c.path));
  const before = tests.reduce((n, c) => n + testCases(c.from ?? c.path, c.before), 0);
  const after = tests.reduce((n, c) => n + testCases(c.path, c.after), 0);
  if (after < before) {
    for (const c of tests) {
      const was = testCases(c.from ?? c.path, c.before);
      const now = testCases(c.path, c.after);
      if (now >= was) continue;
      if (c.after === null) out.push({ kind: 'deleted', file: c.path, text: `${c.path} was deleted (${plural(was, 'test')}).`, key: `deleted:${c.path}` });
      else out.push({ kind: 'fewer', file: c.path, text: `${c.path} has fewer tests: ${was} before, ${now} now.`, key: `fewer:${c.path}:${now}` });
    }
  }
  for (const c of changes) {
    // Tests switched off: only markers that are new in this change count.
    if (isTestFile(c.path) || /\.rs$/.test(c.path)) {
      const was = skipMarkers(c.from ?? c.path, c.before);
      const added = [...skipMarkers(c.path, c.after)].filter(([word, n]) => n > (was.get(word) ?? 0)).map(([word]) => word);
      if (added.length) {
        const only = added.filter((w) => /only|^f\w+$|focus/.test(w));
        const off = added.filter((w) => !only.includes(w));
        const parts = [off.length ? `tests switched off with ${off.join(', ')}` : '', only.length ? `only some tests run because of ${only.join(', ')}` : ''].filter(Boolean);
        out.push({ kind: 'skip', file: c.path, text: `In ${c.path}: ${parts.join('; ')}.`, key: `skip:${c.path}:${added.join(',')}:${count(c.after, SKIPS[lang(c.path)!])}` });
      }
    }
    // Test scripts and settings: a change to ones that were there before. New ones (tests set up now) are fine.
    const name = path.basename(c.path);
    if (isTestConfig(c.path) && c.before !== null && c.before.trim() !== (c.after ?? '').trim()) {
      out.push({ kind: 'config', file: c.path, text: c.after === null ? `The test settings in ${c.path} were deleted.` : `The test settings in ${c.path} changed.`, key: `config:${c.path}:${short(c.after ?? '')}` });
    } else if (MIXED_FILES.test(name)) {
      const was = testPart(c.from ?? c.path, c.before, scripts);
      const now = testPart(c.path, c.after, scripts);
      if (was !== null && was !== now && !grewOnly(name, was, now)) {
        const what = name === 'package.json' ? `The test scripts or settings in ${c.path} changed` : `The test settings in ${c.path} changed`;
        out.push({ kind: 'config', file: c.path, text: `${what}${scriptChange(name, was, now)}.`, key: `config:${c.path}:${short(now ?? '')}` });
      }
    } else if (BUILD_FILES.test(name)) {
      const now = count(c.after, BUILD_SKIPS);
      if (now > count(c.before, BUILD_SKIPS)) out.push({ kind: 'config', file: c.path, text: `Tests are skipped or their failures ignored in ${c.path}.`, key: `config:${c.path}:${now}` });
    }
  }
  return out;
}

/** package.json: only new test scripts or settings were added, and every one that was there is the same. */
function grewOnly(name: string, was: string, now: string | null): boolean {
  if (name !== 'package.json' || now === null) return false;
  const a = JSON.parse(was) as Record<string, unknown>;
  const b = JSON.parse(now) as Record<string, unknown>;
  return Object.keys(a).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** For package.json, the script that changed in words: `: "test" was "vitest run", now "vitest run --passWithNoTests"`. */
function scriptChange(name: string, was: string, now: string | null): string {
  if (name !== 'package.json') return '';
  const a = JSON.parse(was) as Record<string, unknown>;
  const b = (now ? JSON.parse(now) : {}) as Record<string, unknown>;
  const k = Object.keys(a).find((x) => x.startsWith('scripts.') && JSON.stringify(a[x]) !== JSON.stringify(b[x]));
  if (!k) return '';
  const script = k.slice('scripts.'.length);
  return b[k] === undefined ? `: the "${script}" script was removed` : `: "${script}" was "${String(a[k])}", now "${String(b[k])}"`;
}

const MAX_FILES = 400;
const MAX_BYTES = 1024 * 1024;

/**
 * The ticket's copy against its base commit: changed, deleted, renamed and new files that hold tests or test settings.
 * `skip` holds folders never looked at (squad-kit's own). Empty when git cannot tell (no base, not a repo).
 */
export function changedTestFiles(dir: string, base: string, skip: string[] = []): FileChange[] {
  const fields = git(dir, ['diff', '--name-status', '-z', '--find-renames', base], { allowFail: true }).split('\0').filter(Boolean);
  const listed: { status: string; path: string; from?: string }[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++]![0]!;
    if (status === 'R' || status === 'C') {
      const from = fields[i++]!;
      listed.push({ status: 'R', from, path: fields[i++]! });
    } else listed.push({ status, path: fields[i++]! });
  }
  for (const f of git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { allowFail: true }).split('\0').filter(Boolean)) listed.push({ status: 'A', path: f });
  // A file moved with the shell, not git: deleted here and new there, under the same name. It counts as moved.
  for (const added of listed.filter((l) => l.status === 'A')) {
    const gone = listed.find((l) => l.status === 'D' && path.basename(l.path) === path.basename(added.path));
    if (!gone) continue;
    listed.splice(listed.indexOf(gone), 1);
    Object.assign(added, { status: 'R', from: gone.path });
  }
  const out: FileChange[] = [];
  for (const l of listed) {
    if (skip.some((s) => l.path.startsWith(s))) continue;
    if (!worthReading(l.path) && !(l.from && worthReading(l.from))) continue;
    if (out.length >= MAX_FILES) break;
    out.push({
      path: l.path,
      ...(l.from ? { from: l.from } : {}),
      before: l.status === 'A' ? null : blob(dir, base, l.from ?? l.path),
      after: l.status === 'D' ? null : readText(path.join(dir, l.path)),
    });
  }
  return out;
}

function blob(dir: string, base: string, file: string): string | null {
  const text = git(dir, ['show', `${base}:${file}`], { allowFail: true });
  return text || null;
}

function readText(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MAX_BYTES ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/** What weakens the tests in the ticket's copy, against its base commit. `testCommand` is the project's own. */
export function weakenedChecks(dir: string, base: string, opts: { skip?: string[]; testCommand?: string } = {}): Weakening[] {
  return findWeakening(changedTestFiles(dir, base, opts.skip), scriptsOf(opts.testCommand));
}

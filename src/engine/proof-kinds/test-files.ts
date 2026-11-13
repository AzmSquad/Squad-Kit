import fs from 'node:fs';
import path from 'node:path';

/**
 * The test files a story added or changed, with the tests in them, for the Tester that names the test of each Test
 * line: squad-kit reads them itself, so the Tester needs no git of its own. A test's place under its groups shows by
 * its indent, as written in the file.
 */

const MAX_FILES = 8;
const MAX_TITLES = 40;

/** A test file by its name or its folder: Vitest, Jest, Playwright, pytest and go. */
const TEST_FILE = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]+\.py$/;
/** A group or a test with its title, as most JavaScript test tools write it. */
const JS_TITLE = /^(\s*)(describe|context|suite|it|test)(?:\.(?:only|skip|concurrent|each\([^)]*\)))*\(\s*(['"`])((?:\\.|(?!\3).)*)\3/;
/** A pytest or go test by its name. */
const OTHER_TITLE = /^(\s*)(?:def (test_\w+)|func (Test\w+)\()/;

export interface StoryTestFile {
  file: string;
  /** Each group or test, in the file's order. */
  titles: { indent: number; title: string; group: boolean }[];
}

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file.replace(/\\/g, '/'));
}

/** The test files among the story's changed files, each with its groups and tests. */
export function storyTestFiles(dir: string, changed: string[]): StoryTestFile[] {
  const out: StoryTestFile[] = [];
  for (const file of changed.filter(isTestFile).slice(0, MAX_FILES)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const titles: StoryTestFile['titles'] = [];
    for (const line of text.split('\n')) {
      const js = line.match(JS_TITLE);
      const other = js ? null : line.match(OTHER_TITLE);
      if (js) titles.push({ indent: js[1]!.length, title: js[4]!.slice(0, 160), group: /^(describe|context|suite)$/.test(js[2]!) });
      else if (other) titles.push({ indent: other[1]!.length, title: (other[2] ?? other[3])!, group: false });
      if (titles.length >= MAX_TITLES) break;
    }
    out.push({ file, titles });
  }
  return out;
}

/** The list as the Tester reads it: each file, then its groups and tests, indented as in the file. */
export function testFilesText(files: StoryTestFile[]): string {
  if (!files.length) return 'This story added or changed no test file.';
  return files
    .map((f) => [f.file, ...f.titles.map((x) => `  ${' '.repeat(Math.min(x.indent, 12))}${x.title}${x.group ? ' (group)' : ''}`)].join('\n'))
    .join('\n');
}

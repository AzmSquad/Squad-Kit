import fs from 'node:fs';
import path from 'node:path';

/**
 * A stand-in for Playwright, put in a folder's node_modules/.bin as the real one is. Its drag test fails while
 * src/shelves.txt says "broken"; on its own it passes when the folder has a file named passes-alone, and with all the
 * tests it fails only the first time when the folder has a file named fails-once. Run with no file it runs "all 70
 * tests"; with one, only that one. It prints what Playwright prints, and notes each run in `log`: the folder's name and
 * its words.
 */

export const DRAG = 'tests/e2e/shelves.spec.ts:387:7 › Putting shelves in order › laptop: a mouse drag changes the order';
export const DRAG_TITLE = 'Putting shelves in order › laptop: a mouse drag changes the order';
export const DRAG_ALONE = "npx playwright test 'tests/e2e/shelves\\.spec\\.ts:387'";

export function playwrightScript(log: string): string {
  return `#!/bin/sh
echo "$(basename "$PWD") $*" >> '${log}'
broken=no
grep -q broken src/shelves.txt 2>/dev/null && broken=yes
failed() {
  printf '  1) %s \\n\\n    Error: expect(locator).toHaveText(expected) failed\\n\\n    Expected: "Fruit"\\n    Received: "Bread"\\n\\n  1 failed\\n    %s \\n' '${DRAG}' '${DRAG}'
}
if [ "$#" -le 1 ]; then
  echo "Running 70 tests using 1 worker"
  if [ -f fails-once ]; then [ -f ran-all-once ] && broken=no; touch ran-all-once; fi
  if [ $broken = yes ]; then failed; echo "  69 passed (2.8m)"; exit 1; fi
  echo "  70 passed (2.8m)"
  exit 0
fi
echo "Running 1 test using 1 worker"
if [ $broken = yes ] && [ ! -f passes-alone ]; then failed; exit 1; fi
echo "  1 passed (3.0s)"
`;
}

/** Puts the stand-in in `dir`'s node_modules/.bin. */
export function installPlaywright(dir: string, log: string): void {
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'playwright'), playwrightScript(log), { mode: 0o755 });
}

/**
 * A quick stand-in for npx, first on the PATH until the returned function puts it back: it runs the tool from the
 * folder's own node_modules/.bin, as npx does for a tool that is installed, without npm's seconds of starting up.
 */
export function quickNpx(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'npx'), '#!/bin/sh\nexec "./node_modules/.bin/$@"\n', { mode: 0o755 });
  const was = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${was ?? ''}`;
  return () => {
    process.env.PATH = was;
  };
}

/** Each run the stand-in noted: "copy test", "xx-1-before test tests/e2e/…". */
export function runsIn(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

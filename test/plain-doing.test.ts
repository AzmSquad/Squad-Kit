import { describe, it, expect } from 'vitest';
import { DOING, plainCommand, plainDoing, plainToolLine } from '../src/engine/plain-doing.js';

/**
 * The status line and the card say what an agent is doing in plain words, never a raw command, pattern or path. The
 * sentences here are the real ones from the release-gate run's status log.
 */

describe('commands, as the release-gate log had them', () => {
  for (const [command, words] of [
    ['npx playwright test tests/e2e/sign-up.spec.ts', 'Running the tests'],
    ['npx playwright test tests/e2e/sign-up.spec.ts 2>&1 | tail -40; npm run', 'Running the tests'],
    ['npm test 2>&1 | tail -30; git status --short', 'Running the tests'],
    ['npm test 2>&1 | tail -25', 'Running the tests'],
    ['git -C /private/tmp/claude-501/-Users-momen-Workspace-squad-kit-dev-en', 'Checking the code'],
    ['git log --oneline main..HEAD; git diff main --stat; git status --short', 'Checking the code'],
    ['git status --short && git diff aed5cddac4e2fc7ee4d20493394c1668524ef0a', 'Checking the code'],
    ['npm install && npx prisma migrate dev && npx playwright install chromium', "Setting up this story's copy"],
    ['npm install --save-dev typescript tsx @types/node@22 jsdom @types/jsdo', "Setting up this story's copy"],
    ['sleep 290', 'Working…'],
    ["python3 - <<'EOF'", 'Working…'],
    ["cat > pw.tmp.config.ts <<'EOF'", 'Working…'],
    ["node -e '", 'Working…'],
    ['for z in Africa/Cairo America/Los_Angeles Pacific/Auckland; do TZ=$z n', 'Working…'],
    ['cat .squad/tickets/CM-1/design.md .squad/tickets/CM-1/spec.md; git dif', 'Checking the code'],
    ['grep -n "^a\\b\\|^a:\\|a {" -A6 src/app/globals.css | head -30', 'Reading the code'],
    ['sed -n 90,110p tests/e2e/booking-link.spec.ts; grep -n "viewport\\|devi', 'Reading the code'],
    ['cat playwright.config.ts', 'Reading the code'],
    ['ls -la && cat README.md && ls -la .squad && cat .squad/config.yaml', 'Reading the code'],
    ['grep -c \'"Sara Ali"\' data/visitors.json; grep \'"date"\' data/visitors.j', 'Reading the code'],
    ['rm -f pw.tmp.config.ts; rm -rf test-results; git status --short', 'Checking the code'],
  ] as const) {
    it(`"${command.slice(0, 50)}" is "${words}"`, () => {
      expect(plainCommand(command)).toBe(words);
    });
  }

  it('the usual kinds of command, in any language', () => {
    expect(plainCommand('cd /a/b && CI=1 pnpm exec vitest run')).toBe('Running the tests');
    expect(plainCommand('python3 -m pytest -q')).toBe('Running the tests');
    expect(plainCommand('python manage.py test')).toBe('Running the tests');
    expect(plainCommand('go test ./...')).toBe('Running the tests');
    expect(plainCommand('npm run test:e2e')).toBe('Running the tests');
    expect(plainCommand('npm start')).toBe('Starting the app');
    expect(plainCommand('npm run dev')).toBe('Starting the app');
    expect(plainCommand('python manage.py runserver')).toBe('Starting the app');
    expect(plainCommand('npm run lint')).toBe('Checking the code');
    expect(plainCommand('npx tsc --noEmit')).toBe('Checking the code');
    expect(plainCommand('npm run build')).toBe('Building the app');
    expect(plainCommand('pip install -r requirements.txt')).toBe("Setting up this story's copy");
    expect(plainCommand('sh -c "npm test"')).toBe('Running the tests');
    // A word inside quotes or a file name is not what runs.
    expect(plainCommand('grep -rn "npm test" src')).toBe('Reading the code');
    expect(plainCommand('cat tests/unit/support.test.ts')).toBe('Reading the code');
    expect(plainCommand('sed -i "s/a/b/" file.txt')).toBe('Working…');
  });
});

describe('reading and searching', () => {
  it('never shows a raw pattern or a path', () => {
    for (const line of [
      'Searching for "id="(upcoming|up-)[^"]*""',
      'Searching for ""version"|axe-core/playwright"',
      'Searching for "^a(:|\\s|,)|\\ba\\s*\\{|--mawid-muted:|--maw"',
      'Reading src/app/sign-up/sign-up-form.tsx',
      'Looking for {src,public,tests}/**/*',
      'Looking for *',
      'Listing the folder',
    ]) {
      expect(plainDoing(line)).toBe(DOING.read);
    }
    expect(plainDoing('Reading .squad/tickets/CN-1/design.md')).toBe('Reading the plan');
    expect(plainDoing('Reading cm-1-after-1.png')).toBe('Looking at the screenshots');
    expect(plainDoing('Editing src/lib/i18n.ts')).toBe('Writing the code');
    expect(plainDoing('Writing tests/visitor-list-page-first-version.spec.ts')).toBe('Writing the code');
    expect(plainDoing('Running npm test')).toBe('Running the tests');
    expect(plainDoing('Something new')).toBe('Working…');
  });

  it('a tool call: the whole command decides, past its first line, and an unknown tool says nothing', () => {
    expect(plainToolLine({ name: 'Bash', input: { command: 'echo start\nnpm test' } }, '/p')).toBe('Running the tests');
    expect(plainToolLine({ name: 'Grep', input: { pattern: 'id="(upcoming|up-)[^"]*"' } }, '/p')).toBe('Reading the code');
    expect(plainToolLine({ name: 'Read', input: { file_path: '/p/src/app.ts' } }, '/p')).toBe('Reading the code');
    expect(plainToolLine({ name: 'SomethingElse', input: {} }, '/p')).toBeNull();
  });
});

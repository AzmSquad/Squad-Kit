import type { BoardMeta, Track } from '../board/types.js';
import type { BoardPaths } from '../board/store.js';
import { BUILDS_BY_ITSELF, MAX_BASE_TRIES, MAX_DECIDED, MAX_LANDING_WAIT_MS } from '../board/auto.js';
import { MAX_UPLOADS, MAX_UPLOAD_BYTES } from '../board/actions.js';
import { WARN_AT } from '../board/budget.js';
import { MAX_PARTS } from '../board/parts.js';
import { parallelLimit } from '../core/settings.js';
import type { AgentRole } from './agents.js';
import { BRD_READ_MS, BRD_WRITE_MS } from './breakdown-job.js';
import { MAX_QUESTIONS } from './breakdown-prompts.js';
import { CHECK_MS, CHECK_SILENT_MS } from './checks.js';
import { SEEN_DAYS, WEEK_DAYS, harnessSeen, type Need, type Seen, type StoryLink } from './harness-seen.js';
import { DOCKER_WAIT_MS } from './compose-run.js';
import { guardSupport } from './project-guard.js';
import { reposOf, rulesFiles } from './repos.js';
import { HOOK_MS, NETWORK_GIT_MS } from './git.js';
import { DEFAULT_QUALITY, QUALITIES, QUALITY_NOTE, QUALITY_PRESETS } from './levels.js';
import { BEFORE_SHOTS_MS, BLIP_WAITS_MIN, BUILD_STEP_MS, MAX_CHECK_TRIES, MAX_REVIEW_ROUNDS, PROOF_STEP_MS, REVIEW_STEP_MS, WORDS_STEP_MS } from './live.js';
import { MAX_NOTE_BYTES } from './media.js';
import { WAIT_LIMIT_MS } from './product-lock.js';
import { MIN_SIZE } from './proof-check.js';
import { MAX_PICTURES, MAX_PICTURES_PER_DONE_WHEN, MAX_PROOF_ROUNDS, MAX_RETAKES } from './proof-verdict.js';
import { TECHNICAL_TRIES, type NotAllowed } from './question-filter.js';
import { PIPELINE_MS } from './release.js';
import { NEVER } from './report.js';
import { APP_WAIT_MS, SETUP_MS } from './run-app.js';
import { PACKAGE_HOSTS, PRIVATE, sandboxStatus } from './sandbox.js';
import { TRY_YIELDS_AFTER_MS } from './try-app.js';
import { RETRY_MS } from './usage-limit.js';
import { LONG_MS, QUIET_MS } from './watchdog.js';
import { MAX_API_CALLS, MAX_SHOTS_PER_CALL, MAX_STUCK, MISTAKES_TO_STOP, REFUSALS_TO_STOP, type WindowTool } from './window.js';

/**
 * The Harness page's words: every gate, limit and safety rule the engine keeps, in plain words, with the real values
 * from the code that keeps them. It only describes: nothing here changes how a story runs. test/harness.test.ts fails
 * when a gate or a limit in the engine has no row here and no written reason.
 */

export interface HarnessRow {
  id: string;
  name: string;
  what: string;
  /** What happens if it fails. */
  fail?: string;
  /** For an always-on rule: what follows. */
  then?: string;
  /** The person decides this one. */
  you?: boolean;
  skip?: Track[];
  /** How it goes on one track. */
  note?: Partial<Record<Track, string>>;
  /** What really runs, for the Details button: label and value. */
  d?: [string, string][];
  /** What it really did, counted from this project's stories. No entry, no number. */
  seen?: Seen;
  /** Stories that wait for you on this one now. */
  needs?: Need[];
  /** What each track does here, made from `on`, `skip` and `note`. */
  cells?: Record<Track, { word: string; note?: string }>;
}

export interface HarnessStage {
  id: string;
  name: string;
  about: string;
  /** `off`: this stage is no part of the track unless you choose it. */
  on: Record<Track, { kind: 'you' | 'squad' | 'skip'; sub: string; off?: boolean }>;
  gates: HarnessRow[];
  /** How many stories its gates stopped in the last week. */
  stopped?: number;
}

export interface HarnessLimit {
  id: string;
  group: 'tries' | 'pictures' | 'asks' | 'time' | 'sizes';
  n: string;
  name: string;
  what: string;
  /** The last story that reached it. */
  hit?: StoryLink;
}

/** The line, stage by stage. Row ids name the engine's own gates and stops where it has one. */
function lineStages(): HarnessStage[] {
  const you = (sub: string) => ({ kind: 'you' as const, sub });
  const squad = (sub: string) => ({ kind: 'squad' as const, sub });
  const skip = (sub: string) => ({ kind: 'skip' as const, sub });
  const on = (full: HarnessStage['on']['full'], express = full, auto = full) => ({ full, express, auto });
  const stage = (id: string, name: string, about: string, when: HarnessStage['on'], gates: HarnessRow[]): HarnessStage => ({ id, name, about, on: when, gates });
  const g = (id: string, name: string, what: string, fail?: string, more?: Partial<HarnessRow>): HarnessRow => ({ id, name, what, ...(fail ? { fail } : {}), ...more });
  const y = (id: string, name: string, what: string, fail?: string, more?: Partial<HarnessRow>) => g(id, name, what, fail, { you: true, ...more });
  const ON_ITS_OWN: Track[] = ['express', 'auto'];
  const floor = QUALITIES.filter((q) => QUALITY_PRESETS[q].reviewerFloor).map((q) => q.charAt(0).toUpperCase() + q.slice(1)).join(' and ');
  return [
    stage('setup', 'Setup', 'Once for each project, before any story.', on(you('You confirm')), [
      g('tool-ready', 'Your AI tool is here', 'It must be installed, or nothing runs.', 'It says what to do.'),
      g('first-run', 'A first run on untouched code', "Your tests and app run once in squad-kit's own copy. What already fails is noted, so the Builder leaves other screens alone.", 'The setup goes on. A story must still pass its checks.'),
      y('overview', 'You confirm what it found', 'The Architect explains your project in plain words.', 'You say what is wrong, and it reads again.'),
      g('project-rules', "Your project's own rules", "Every agent first reads your rule files and your team's wiki."),
    ]),
    stage('breakdown', 'Breakdown', 'Your requirements become a tree of stories. Skip it if you start from one story.', on({ ...skip('Optional'), off: true }, { ...skip('Optional'), off: true }, you('You approve')), [
      g('brd-questions', 'Only real gaps and clashes', `At most ${MAX_QUESTIONS} questions on a document, where it leaves a gap or disagrees with itself.`, 'A technical one goes back to the agent.'),
      y('brd-approve', 'You approve the breakdown', 'Nothing is built or sent to your tracker before that. Every story needs its "done when".', 'Approve is refused and says what to fix.'),
      g('brd-queue', 'Stories start in order', 'The next starts when what it needs is merged and a place is free.', 'Your budget or AI limit holds the queue, with a reason.'),
    ]),
    stage('story', 'Story', 'The Analyst reads your story and asks only what it leaves open.', on(you('You answer'), skip('No questions'), skip('Approved before')), [
      g('questions', 'Only business questions reach you', 'The Analyst asks about gaps and clashes. Asks about settings, secrets or code history are refused before you see them.', undefined, { skip: ON_ITS_OWN }),
      y('spec', 'You approve what gets built', 'The story and its "done when" list wait for you.', 'You ask for a change and it is rewritten.', { skip: ON_ITS_OWN, note: { auto: 'Approved with the breakdown.' } }),
      y('ask', 'An agent can stop and ask you', 'The Architect, Builder or Reviewer can ask one plain question. It passes the same filter.', undefined, { note: { auto: 'Only for a critical gap or a clash. Small choices go under Decided for you.' } }),
      y('chat', 'Talk it through', 'With any agent that worked on the story. It waits while you talk.'),
    ]),
    stage('plan', 'Plan', 'The Architect reads your project and writes the plan in plain words.', on(you('You approve'), skip('On its own'), skip('On its own')), [
      y('plan', 'You approve the plan', 'Nothing is built before you approve how.', 'You ask for a change and it is rewritten.', { skip: ON_ITS_OWN }),
      g('decisions', 'Saved decisions stay rules', 'Each plan says which ones it follows or replaces.'),
      y('depends', 'Stories that depend on each other', 'A story that needs unmerged work waits: build on it, build anyway, or wait.'),
      y('change', 'A big change comes back to you', 'The Builder pauses, and the updated design waits for your yes.'),
    ]),
    stage('build', 'Build', 'The Builder writes the code in small steps, in a locked room.', on(squad('Builder')), [
      g('sandbox', 'The guard', "Each story has its own copy. The Builder and Tester can't read your keys, sign-ins or .env files, and reach only package sites and websites you allow.", 'Blocked, with a line on the story.'),
      g('guard', 'A second guard for your project', 'Your tests, app, setup and release run locked in too, with keys hidden and Docker closed.', 'A card: an engineer allows the file, or the plan changes.'),
      g('lane', 'Files no agent can change', "squad-kit's folder, AI instruction files, commit hooks, files an engineer locked. No commit, push or branch change.", 'A file goes back, with a line. A moved branch stops the step.'),
      g('local-files', 'Test values, not your own', 'A file marked local gets values kept for stories. No agent can read it.'),
    ]),
    stage('checks', 'Checks', "squad-kit runs your project's own checks. No agent is asked if they passed.", on(squad('squad-kit')), [
      g('checks', "Your project's own checks", "Test, lint and build. The Builder's word doesn't count. A failed check runs once more, so a flaky test doesn't stop the story.", `The Builder fixes it, up to ${MAX_CHECK_TRIES} tries. Then a card.`),
      g('weakened', 'Weakened tests', 'Tests deleted, switched off or reduced, or test settings changed.', 'It stops. Only you can go past it, with a reason on the record.'),
      g('no-tests', 'No tests, no green', 'No tests never means a green pass. Lint, build and the app starting must still pass.', 'Asked once per project: add tests, or go on without.'),
      g('test-change', 'Test commands stay strong', 'A new test command stays only if it passes and runs at least as many tests.', "If squad-kit can't tell, you choose."),
    ]),
    stage('review', 'Review', "A Reviewer that never saw the build reads the Builder's work.", on(squad('Reviewer')), [
      g('review', 'A fresh Reviewer', 'It checks every "done when" and saved decision, and looks for bugs, security holes and missing or weakened tests. It changes nothing.', `Back to the Builder, up to ${MAX_REVIEW_ROUNDS} rounds. Then you decide.`),
      g('reviewer-floor', 'Never weaker than the Builder', `On ${floor}, its model is at least as strong.`),
      g('also-changed', 'Also changed', 'It names what the change touches beyond the story and plan.', "It doesn't block. It shows at Your check."),
    ]),
    stage('proof', 'Proof', 'The Tester runs your real app and shows each "done when" working.', on(squad('Tester')), [
      g('proof', 'Pictures of the real app', `Up to ${MAX_PICTURES_PER_DONE_WHEN} for each "done when".`, 'None: a card, and you decide.'),
      g('bad-proof', 'squad-kit checks each picture', `Real, at least ${MIN_SIZE.width} by ${MIN_SIZE.height}, not blank, taken in this step.`, 'Back to the Tester once. Then a card.'),
      g('not-shown', 'A second look at every "done when"', 'A separate run judges its pictures: met, not working, not shown, or not on a screen.', `Not shown: up to ${MAX_RETAKES} retakes. Then a card.`),
      g('broken', 'Not working yet', 'Pictures that show it does not work never pass.', `Back to the Builder ${MAX_PROOF_ROUNDS - 1 === 1 ? 'once' : `${MAX_PROOF_ROUNDS - 1} times`}. Then a card.`),
      g('off-screen', 'Not on a screen', 'Takes two voices: the Tester and the check. If every "done when" ends that way, you decide.'),
      g('api-proof', 'Answers from your API', "Work with no screen can show a saved answer from this story's own API."),
      g('window', 'Fixed tools only', "The Tester uses squad-kit's own tools, on this story's app only.", `Refused. ${REFUSALS_TO_STOP} refusals stop it.`),
    ]),
    stage('yours', 'Your check', 'You look at the proof, try the app, and ask anything.', on(you('You decide'), you('You decide'), skip('On its own')), [
      y('looks-right', 'You look and decide', "Where to look, Try it yourself, Ask a question, Something's wrong. Nothing merges before Looks right.", "Something's wrong sends it back with your words.", { skip: ['auto'], note: { auto: 'It merges when the checks, review and proof pass. If not, it comes to you.' } }),
      y('take-over', 'Take it over', "Work in the story's copy yourself. The squad keeps off until you give it back."),
      g('accept-order', 'First things first', 'A story built on another is accepted after it, and an open change is settled first.', 'Accept says what comes first.'),
    ]),
    stage('merge', 'Merge', 'The story joins the rest of your code.', on(squad('squad-kit')), [
      g('hook', 'Your check on every save', 'Your commit hooks run on every save, inside the guard.', 'The Builder fixes it, or you save without it and say why.'),
      g('merge', 'A clean merge', 'The latest code comes in first. A clash is never forced.', 'A card.', { note: { auto: `Up to ${MAX_BASE_TRIES} tries first.` } }),
      g('pull-request', 'Pull requests', 'squad-kit opens and merges them. Waiting for an approver is a normal wait.', 'Try again, or let the release merge the work.'),
      g('checkout', 'Your own copy is safe', 'With changes in the same files, the merge waits. It never overwrites them.'),
    ]),
    stage('release', 'Release', 'You choose what goes out and when. Every track stops here.', on(you('You decide')), [
      y('release', 'Release stays yours', 'Deploying never happens by itself.', "If it can't be sent, it isn't marked as sent. Push again finishes it."),
      y('leave-out', 'Leave a story out', 'It stays in your code and goes out with the next release.'),
      g('release-clash', 'Nothing moves on a clash', 'Every merge is tried first. What the others rely on goes first.', 'A clash: one card, nothing moved. A failed part: the ones after it wait.'),
      g('release-lock', 'One release at a time', 'One cut off by a restart is finished or rolled back on the next start.'),
    ]),
  ];
}

/** What watches the whole line and belongs to no stage. */
function alwaysOnRows(): HarnessRow[] {
  const a = (id: string, name: string, what: string, then?: string): HarnessRow => ({ id, name, what, ...(then ? { then } : {}) });
  return [
    a('watchdog', 'Nothing hangs in silence', 'When a step goes quiet, the watchdog looks at what is really running, to tell busy from stuck.', 'You get a card with ways out.'),
    a('usage-limit', 'Your AI limit is respected', 'At the limit every project waits together, then carries on from the same step.', 'Never a failed try, and you can end the wait yourself.'),
    a('step-up', 'A stronger model after a failed try', 'The Builder moves up, unless someone chose an exact model.', `On Thrifty, after ${QUALITY_PRESETS.thrifty.stepUp.after} failed tries.`),
    a('cap', "A run can't go on forever", 'Each run has a most it can use. See Limits.', 'It pauses with its work kept. Give it more doubles it.'),
    a('budget', 'Your budget', `If you pay per use, a story and a month can have one. At ${WARN_AT * 100}% the board says so.`, 'At 100% the story stops between two steps, never mid-step.'),
    a('ways-out', 'Every stop has a way out', 'Try again, do it yourself, go around it, or stop. Only you can go past a failed check.', 'Your reason stays on the story, the pull request and the release notes.'),
    a('plain-words', 'Plain words only', 'Raw errors never reach you.', 'The exact error goes to the engineer details and the log.'),
    a('interrupted', 'An interruption is not a failure', 'A restart, a Stop or a sleeping computer never counts as a failed try.', 'The step carries on where it was.'),
    a('blips', 'A lost connection is not a failure', 'The step runs again by itself.', 'If it does not pass, you get a card.'),
    a('leftovers', 'Nothing left behind', 'A program a step leaves running is stopped. Programs of your own are never touched.', 'On Windows it stops only what it started itself.'),
    a('product-lock', 'One story runs the product at a time', 'Stories that need the whole product take turns, and say who they wait for.'),
    a('save-trouble', 'A full disk holds the work', "If squad-kit can't save its files, the project waits and says so on every page.", 'It carries on once saving works.'),
    a('board-lock', 'Your board is locked', "It opens only on your own computer's address, with your link's key.", 'A request from any other website is refused.'),
    a('report', 'Reports leave your secrets out', NEVER),
  ];
}

/** A limit's row: `{ MAX_RETAKES }` names the engine's own constant and gives its value. */
function limitRows(meta?: BoardMeta): HarnessLimit[] {
  const row = (group: HarnessLimit['group'], show: (v: number) => string = String) => (limit: Record<string, number>, name: string, what = ''): HarnessLimit => {
    const [id, n] = Object.entries(limit)[0]!;
    return { id, group, n: show(n), name, what };
  };
  const tries = row('tries');
  const pics = row('pictures');
  const asks = row('asks');
  const time = row('time', (ms) => `${ms / 60_000} min`);
  const size = row('sizes');
  const bytes = row('sizes', (b) => `${b / 1024 / 1024} MB`);
  return [
    tries({ MAX_CHECK_TRIES }, 'Tries at the checks', 'Then a card.'),
    tries({ MAX_REVIEW_ROUNDS }, 'Review rounds', 'Then you decide.'),
    tries({ MAX_RETAKES }, 'Retakes', 'For a "done when" the pictures don\'t show clearly.'),
    tries({ MAX_PROOF_ROUNDS: MAX_PROOF_ROUNDS - 1 }, 'Returns after a broken picture', 'To the Builder. Then you decide.'),
    tries({ MAX_BASE_TRIES }, 'Clash retries', 'On Builds by itself, while the code keeps moving.'),
    tries({ BLIP_WAITS_MIN: BLIP_WAITS_MIN.length }, 'Waits after a lost connection', `After ${BLIP_WAITS_MIN.join(', ')} minutes. Then a card.`),
    pics({ MAX_PICTURES_PER_DONE_WHEN }, 'Pictures for each "done when"', 'So each part can show.'),
    pics({ MAX_PICTURES }, 'Pictures in one proof step', 'Counting each one taken again.'),
    pics({ MAX_SHOTS_PER_CALL }, 'Pictures in one call', 'More has to be split over calls.'),
    pics({ MAX_API_CALLS }, 'Calls to your API in one proof', "Only this story's own app."),
    asks({ REFUSALS_TO_STOP }, 'Refusals', 'Forbidden asks, then the agent is stopped.'),
    asks({ MISTAKES_TO_STOP }, 'Calls in the wrong shape', 'Harmless, but past this the step ends.'),
    asks({ MAX_STUCK }, 'Times a run can say it is stuck', 'After that, squad-kit says it already tried.'),
    asks({ TECHNICAL_TRIES }, 'Tries for a technical question', 'Back to its agent, never to you. Then it stops.'),
    asks({ MAX_QUESTIONS }, 'Questions on one document', 'Only real gaps and clashes.'),
    asks({ MAX_DECIDED }, 'Small choices in one answer', 'Logged under Decided for you.'),
    time({ WORDS_STEP_MS }, 'Analyst and Architect', 'One run of words: questions, a spec, a design.'),
    time({ BUILD_STEP_MS }, 'Builder', 'One run of building or fixing.'),
    time({ REVIEW_STEP_MS }, 'Reviewer', 'One round, or one look at the pictures.'),
    time({ PROOF_STEP_MS }, 'Tester'),
    time({ BRD_READ_MS }, 'Reading a document'),
    time({ BRD_WRITE_MS }, 'Writing a breakdown'),
    time({ CHECK_MS }, 'One check'),
    time({ CHECK_SILENT_MS }, 'A silent check', 'It prints nothing for this long.'),
    time({ APP_WAIT_MS }, 'Waiting for your app'),
    time({ SETUP_MS }, 'Setting up your app'),
    time({ DOCKER_WAIT_MS }, 'Starting in Docker'),
    time({ BEFORE_SHOTS_MS }, 'Before pictures', 'Beside the build, holding nothing up.'),
    time({ HOOK_MS }, 'Your check on a save'),
    time({ NETWORK_GIT_MS }, 'Reaching your code host', 'One push, pull or fetch.'),
    time({ PIPELINE_MS }, 'Your release pipeline', 'Inside the guard, after a release.'),
    time({ MAX_LANDING_WAIT_MS }, 'Waiting for a story to merge', 'On Builds by itself.'),
    time({ WAIT_LIMIT_MS }, 'Waiting for the product'),
    time({ TRY_YIELDS_AFTER_MS }, 'Trying a story yourself', 'Once another story needs it.'),
    time({ QUIET_MS }, 'Quiet before a look', 'Then the watchdog looks.'),
    time({ LONG_MS }, 'Busy before Taking long', 'Working, with no progress.'),
    time({ RETRY_MS }, 'Looking again at your AI limit', "When your AI tool doesn't say when it ends."),
    size({ parallel: parallelLimit(meta?.parallel) }, 'Stories at once', 'Across your projects. Change it in Settings.'),
    size({ MAX_PARTS }, 'Parts of one product'),
    size({ MAX_UPLOADS }, 'Files on one story'),
    bytes({ MAX_UPLOAD_BYTES }, 'One file'),
    bytes({ MAX_NOTE_BYTES }, 'One voice or video note'),
  ];
}

/** Each step's most, in the order of the page's table. */
const HARNESS_CAP_NAME: Record<string, string> = { analyst: 'Analyst', architect: 'Architect', builder: 'Builder', 'builder.fix': 'Builder, fixes', reviewer: 'Reviewer', tester: 'Tester', chat: 'Talking a story through' };

const HARNESS_PRIVATE_NAME: Record<string, string> = { '.ssh': 'SSH keys', '.aws': 'AWS sign-in', '.gnupg': 'GPG keys', '.config/gh': 'GitHub sign-in', '.azure': 'Azure sign-in', '.kube': 'Kubernetes sign-in', '.docker/config.json': 'Docker sign-in', '.netrc': 'Saved website passwords', '.git-credentials': 'Saved git passwords' };

const HARNESS_REFUSED: Record<NotAllowed, string> = { settings: "Change a squad-kit setting or a protected file", secret: 'Hand over a password or a key', history: 'Change the history of the code' };

const HARNESS_TOOL_NAME: Record<WindowTool, string> = { take_screenshots: 'Take pictures', look_at_page: 'Look at a page', start_app: 'Start the app', stop_app: 'Stop the app', app_status: 'See if the app runs', run_checks: "Run the project's checks", add_part: 'Add a part of the product', ask_api: 'Ask your API', i_am_stuck: 'Say it is stuck' };

/** A package site by what people call it; a new one shows as itself. */
function packageSiteName(host: string): string {
  const named: [RegExp, string][] = [[/npm|yarn/, 'npm'], [/pypi|pythonhosted/, 'PyPI'], [/maven|gradle/, 'Maven and Gradle'], [/nuget/, 'NuGet'], [/rubygems/, 'RubyGems'], [/crates/, 'crates.io'], [/golang/, 'Go modules'], [/github/, 'GitHub downloads'], [/playwright/, 'Browsers for browser tests']];
  return named.find(([re]) => re.test(host))?.[1] ?? host;
}

/** What each role may do: the permissions and tools its steps get in engine/live.ts. test/harness.test.ts compares them. */
function agentPowers(): Record<AgentRole, { can: [string, boolean][] }> {
  const yes = (label: string): [string, boolean] => [label, true];
  const no = (label: string): [string, boolean] => [label, false];
  const reads = [yes('Read your project'), no('Change code'), no('Run commands'), no('No internet')];
  return {
    analyst: { can: reads },
    architect: { can: reads },
    builder: { can: [yes('Read your project'), yes('Change code'), yes('Run commands'), yes('Package sites and websites you allow'), yes("squad-kit's tools: pictures, checks, the app")] },
    reviewer: { can: [...reads, yes("Look at a page of this story's app")] },
    tester: { can: [...reads, yes("squad-kit's tools: pictures, the app, your API")] },
  };
}

/** What really runs behind each row: real commands and values, and where to look. Each row names its own code. */
function rowDetails(meta: BoardMeta | undefined, root: string | undefined): Record<string, [string, string][]> {
  const min = (ms: number) => `${ms / 60_000} min`;
  const repos = meta ? reposOf(meta) : [];
  const run = (...keys: ('setup' | 'test' | 'lint' | 'build' | 'start' | 'deploy')[]) =>
    repos.map((r) => [repos.length > 1 ? `${r.path}: ` : '', keys.map((k) => r.commands[k]).filter(Boolean).join(', ')]).filter(([, c]) => c).map(([p, c]) => `${p}${c}`).join('; ') || 'Not set yet';
  const guard = guardSupport();
  const tools = sandboxStatus();
  const state = (on: boolean, why: string) => `${on ? 'On' : 'Off'}: ${why}`;
  const names = (list?: { path: string }[]) => list?.map((f) => f.path).join(', ') || 'None yet';
  const tab = (name: string) => `The story's ${name} tab`;
  const code = (file: string, ...more: [string, string][]): [string, string][] => [...more, ['In the code', `src/${file}`]];
  return {
    'tool-ready': code('engine/onboard.ts', ['Found', meta?.tools?.map((t) => `${t.name}: ${t.ready ? 'ready' : 'not found'}`).join(', ') || 'Not looked yet']),
    'first-run': code('engine/onboard.ts', ['Runs', run('setup', 'test', 'start')], ['See it in', 'The Overview page']),
    overview: code('board/first-run.ts', ['See it in', 'The Overview page']),
    'project-rules': code('engine/repos.ts', ['Reads', (root ? rulesFiles(root).map((f) => f.slice(root.length + 1)) : []).join(', ') || 'None found yet']),
    'brd-questions': code('engine/breakdown-job.ts', ['Limit', `${MAX_QUESTIONS} questions`]),
    'brd-approve': code('board/requirements-actions.ts', ['See it in', 'The Requirements page']),
    'brd-queue': code('board/requirements-build.ts', ['Places', `${parallelLimit(meta?.parallel)} at once`]),
    questions: code('engine/question-filter.ts', ['Refused', Object.values(HARNESS_REFUSED).join(', ')], ['Tries', `${TECHNICAL_TRIES} back to its agent`]),
    spec: code('board/actions.ts', ['See it in', tab('Spec')]),
    ask: code('engine/live.ts'),
    chat: code('board/actions.ts'),
    plan: code('board/actions.ts', ['See it in', tab('Design')]),
    decisions: code('board/actions.ts', ['See it in', 'The Architecture page']),
    depends: code('board/depends.ts'),
    change: code('board/actions.ts'),
    sandbox: code('engine/sandbox.ts', ['On this computer', tools.map((t) => state(t.available, t.why)).join(', ') || 'Off'], ['Also allowed', meta?.allowedHosts?.join(', ') || 'None yet']),
    guard: code('engine/project-guard.ts', ['On this computer', state(guard.on, guard.why)], ['Also allowed', [...(meta?.guard?.allowRead ?? []), ...(meta?.guard?.allowWrite ?? [])].join(', ') || 'None yet']),
    lane: code('engine/lane.ts', ['Locked here', names(meta?.lockedFiles)]),
    'local-files': code('engine/local-files.ts', ['Local here', names(meta?.localFiles)]),
    checks: code('engine/checks.ts', ['Runs', run('test', 'lint', 'build')], ['Limit', `${MAX_CHECK_TRIES} tries, ${min(CHECK_MS)} each, ${min(CHECK_SILENT_MS)} with no output`], ['Decided by', 'The exit code, never an agent'], ['See it in', tab('Developer')]),
    weakened: code('engine/weakened.ts', ['Looks at', 'Deleted tests, skip marks, fewer tests, test settings'], ['See it in', tab('Changes')]),
    'no-tests': code('engine/not-checked.ts', ['Here', meta?.noTests ? 'You chose to go on without tests' : 'Not asked yet']),
    'test-change': code('engine/test-change.ts', ['Runs', run('test')], ['Compares', 'Pass or fail, and how many tests ran']),
    review: code('engine/live.ts', ['Limit', `${MAX_REVIEW_ROUNDS} rounds, ${min(REVIEW_STEP_MS)} each`], ['See it in', tab('Conversation')]),
    'reviewer-floor': code('engine/levels.ts'),
    'also-changed': code('board/also-changed.ts', ['Blocks', 'Nothing']),
    proof: code('engine/live.ts', ['Runs', run('start')], ['Limit', `${MAX_PICTURES_PER_DONE_WHEN} for each, ${MAX_PICTURES} in one step, ${min(PROOF_STEP_MS)}`]),
    'bad-proof': code('engine/proof-check.ts'),
    'not-shown': code('engine/proof-verdict.ts', ['Limit', `${MAX_RETAKES} retakes`]),
    broken: code('engine/proof-verdict.ts', ['Limit', `${MAX_PROOF_ROUNDS} rounds`]),
    'off-screen': code('engine/proof-verdict.ts'),
    'api-proof': code('engine/window.ts', ['Limit', `${MAX_API_CALLS} calls in one proof`]),
    window: code('engine/window.ts', ['Limit', `${REFUSALS_TO_STOP} refusals, ${MISTAKES_TO_STOP} calls in the wrong shape`]),
    'looks-right': code('board/actions.ts', ['See it in', 'The proof page']),
    'take-over': code('board/actions.ts'),
    'accept-order': code('board/depends.ts'),
    hook: code('engine/git.ts', ['Limit', min(HOOK_MS)]),
    merge: code('board/auto.ts', ['Limit', `${MAX_BASE_TRIES} tries on Builds by itself`]),
    'pull-request': code('engine/sync.ts', ['Limit', `${min(NETWORK_GIT_MS)} to reach your code host`]),
    checkout: code('board/auto.ts'),
    release: code('engine/release.ts', ['Runs', run('deploy')], ['Limit', min(PIPELINE_MS)]),
    'leave-out': code('engine/leave-out.ts'),
    'release-clash': code('engine/release.ts'),
    'release-lock': code('board/lock.ts'),
    watchdog: code('engine/watchdog.ts', ['Limit', `Looks after ${min(QUIET_MS)} quiet, says taking long after ${min(LONG_MS)}`]),
    'usage-limit': code('engine/usage-limit.ts', ['Looks again', `Every ${min(RETRY_MS)} when the tool does not say when`]),
    'step-up': code('engine/levels.ts'),
    cap: code('engine/caps.ts'),
    budget: code('board/budget.ts', ['Set in', 'Settings']),
    'ways-out': code('board/actions.ts'),
    'plain-words': code('engine/plain-stop.ts'),
    interrupted: code('engine/interrupt.ts'),
    blips: code('engine/live.ts', ['Waits', `${BLIP_WAITS_MIN.join(', ')} min`]),
    leftovers: code('engine/leftovers.ts'),
    'product-lock': code('engine/product-lock.ts', ['Limit', min(WAIT_LIMIT_MS)]),
    'save-trouble': code('engine/save-trouble.ts'),
    'board-lock': code('console/auth.ts'),
    report: code('engine/report.ts'),
  };
}

/** What a track does at a gate, made from the stage's `on` and the gate's `skip` and `note`, and nothing else. */
function trackCell(stage: HarnessStage, g: HarnessRow, track: Track): { word: string; note?: string } {
  const note = g.note?.[track] ? { note: g.note[track] } : {};
  if (g.skip?.includes(track)) return { word: 'By itself', ...note };
  if (stage.on[track].off) return { word: 'Not used' };
  return { word: g.you ? 'You' : 'Runs', ...note };
}

/** Everything the Harness page shows, for this project: the words, the real values, and what really happened on its stories. */
export function harnessView(meta?: BoardMeta, bp?: BoardPaths) {
  const quality = meta?.quality ?? DEFAULT_QUALITY;
  const caps = QUALITY_PRESETS[quality].caps;
  const seen = meta && bp ? harnessSeen(bp, meta) : undefined;
  const details = rowDetails(meta, bp?.root);
  const fill = (r: HarnessRow): HarnessRow => {
    const needs = seen?.needs.filter((n) => n.row === r.id);
    return { ...r, d: details[r.id] ?? [], ...(seen?.rows[r.id] ? { seen: seen.rows[r.id]! } : {}), ...(needs?.length ? { needs } : {}) };
  };
  const stages = lineStages().map((s) => ({
    ...s,
    gates: s.gates.map((g) => ({ ...fill(g), cells: { full: trackCell(s, g, 'full'), express: trackCell(s, g, 'express'), auto: trackCell(s, g, 'auto') } })),
    stopped: new Set(s.gates.flatMap((g) => seen?.weekIds[g.id] ?? [])).size,
  }));
  const always = alwaysOnRows().map(fill);
  const rows = [...stages.flatMap((s) => s.gates), ...always];
  const offHere = (sandboxStatus().some((t) => t.available) ? 0 : 1) + (guardSupport().on ? 0 : 1);
  return {
    quality,
    qualityNote: QUALITY_NOTE,
    /** What the counts cover. */
    range: { days: SEEN_DAYS, weekDays: WEEK_DAYS, stories: seen?.stories ?? 0 },
    tiles: { working: rows.length - offHere, stopped: rows.filter((r) => r.seen?.week).length, needs: seen?.needs ?? [] },
    tracks: [
      { id: 'full', name: 'Full', words: 'On Full you answer the questions and approve the plan.' },
      { id: 'express', name: 'Express', words: 'On Express there are no questions and the plan is approved on its own. You still check the work.' },
      { id: 'auto', name: BUILDS_BY_ITSELF, words: 'Approved in advance, it merges when the checks, the review and the proof pass. Release stays yours.' },
    ],
    stages,
    alwaysOn: always,
    limits: limitRows(meta).map((l) => (seen?.hits[l.id] ? { ...l, hit: seen.hits[l.id]! } : l)),
    caps: Object.keys(HARNESS_CAP_NAME).map((key) => ({ key, name: HARNESS_CAP_NAME[key], ...caps[key]! })),
    agents: agentPowers(),
    safety: {
      hidden: [...PRIVATE.map((p) => HARNESS_PRIVATE_NAME[p] ?? p), "Your AI tools' sign-ins", 'Browser sign-ins', 'Keys in package settings', '.env files', "squad-kit's own folder and keys"],
      locked: ["squad-kit's own folder", 'AI instruction files', 'Commit hooks and their settings', 'Code history: commit, push, branches'],
      sites: [...new Set(PACKAGE_HOSTS.map(packageSiteName))],
      refused: Object.values(HARNESS_REFUSED),
      tools: Object.values(HARNESS_TOOL_NAME),
      local: (meta?.localFiles ?? []).map((f) => f.path),
      lockedByYou: (meta?.lockedFiles ?? []).map((f) => f.path),
    },
  };
}

import { Command, Option } from 'commander';
import * as ui from './ui/index.js';
import { isSquadExit } from './core/cli-exit.js';
import { runInit, type InitOptions } from './commands/init.js';
import { runNewStory } from './commands/new-story.js';
import { runNewPlan } from './commands/new-plan.js';
import { runStatus } from './commands/status.js';
import { runList } from './commands/list.js';
import { runTrackerLink } from './commands/tracker-link.js';
import { runDoctor } from './commands/doctor.js';
import { runMigrate } from './commands/migrate.js';
import { runUpgrade } from './commands/upgrade.js';
import { runConsole } from './commands/console.js';
import {
  runAnswer,
  runApprove,
  runBoard,
  runBug,
  runChange,
  runNote,
  runChat,
  runAgent,
  runSendBack,
  runEditPlan,
  runStartOver,
  runMessage,
  runTakeOver,
  runGiveBack,
  runReply,
  runChanges,
  runOpen,
  runDecide,
  runDemo,
  runInbox,
  runNew,
  runPull,
  runBacklog,
  runUnstick,
  runRelease,
  runShow,
  runStop,
  runWatch,
} from './commands/board.js';
import {
  runConfigShow,
  runConfigSetPlanner,
  runConfigSetTracker,
  runConfigUnsetPlanner,
  runConfigUnsetTracker,
  runConfigRemoveCredential,
} from './commands/config/index.js';
import { runRmFeature, runRmPlan, runRmStory } from './commands/rm/index.js';
import { runAuthLogin, runAuthStatus, runAuthLogout } from './commands/auth/index.js';
import { readInstalledPackage } from './core/package-info.js';

/** Collects a repeatable option into a list. */
function more(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name('squad')
  .description('You write the ticket. Your squad does the rest.')
  .version(readInstalledPackage().version);

program
  .command('init')
  .description('Bootstrap .squad/ in the current directory')
  .option('--agents <list>', 'Comma-separated agent list: claude-code,cursor,copilot,gemini')
  .option('--tracker <type>', 'Tracker type: none|github|jira|azure')
  .option(
    '--tracker-workspace <hostOrOrg>',
    'Jira host or Azure org (non-interactive default; also written to config for jira/azure)',
  )
  .option('--tracker-project <name>', 'Azure project name (non-interactive; written to config when set)')
  .option('--name <name>', 'Project name')
  .option('--language <lang>', 'Primary language')
  .option('--force', 'Overwrite existing files', false)
  .option('-y, --yes', 'Accept defaults (non-interactive)', false)
  .option(
    '--skip-secrets-prompt',
    'Do not prompt for tracker or planner API keys (leaves .squad/secrets.yaml unchanged)',
    false,
  )
  .option(
    '--planner <provider>',
    'Enable direct planner and set provider (anthropic|openai|google). Implies non-interactive enable.',
  )
  .option('--no-planner', 'Disable direct planner in non-interactive mode (default when -y).', false)
  .action(
    wrap(
      (opts: InitOptions & { noPlanner?: boolean; planner?: string; agents?: string; skipSecretsPrompt?: boolean }) => {
        const { noPlanner, skipSecretsPrompt, ...rest } = opts;
        const noPromptSecrets =
          Boolean(skipSecretsPrompt) || process.argv.includes('--no-prompt-secrets');
        return runInit({
          ...rest,
          noPromptSecrets,
          planner: noPlanner ? false : rest.planner,
        });
      },
    ),
  );

program
  .command('new-story [feature-slug]')
  .description('Scaffold a new story intake under .squad/stories/<feature>/<id>/')
  .option('--id <id>', 'Tracker work-item id (used for folder name and auto-fetch when configured)')
  .option('--title <title>', 'Short title hint (placed at top of intake)')
  .option('-y, --yes', 'Fail fast instead of prompting for missing values', false)
  .option('--no-fetch', 'Skip tracker auto-fetch even when tracker and credentials are configured')
  .option('--no-attachments', 'Fetch issue metadata but do not download attachments')
  .option('--attachment-mb <n>', 'Override attachment size cap in MB (default 10)', (v) => parseInt(v, 10))
  .option(
    '--no-tracker',
    'Skip tracker fetch AND drop the tracker-id requirement for this story',
  )
  .action(wrapArgs(runNewStory));

program
  .command('new-plan [intake-path]')
  .description('Generate a plan (via direct API when configured, otherwise copy-paste)')
  .option('--no-clipboard', 'Do not copy the composed prompt to clipboard (copy-paste mode only)')
  .option('--feature <slug>', 'Filter picker by feature slug')
  .option('--all', 'Include already-planned intakes in the picker', false)
  .option('-y, --yes', 'Skip confirmation prompts', false)
  .option('--api', 'Force direct planner API (fails if not configured)', false)
  .option('--copy', 'Force copy-paste mode even when planner API is configured', false)
  .option('--no-scout', 'Disable the scout stage (draft only)', false)
  .option('--scout-model <id>', 'Override scout model id (cheap tier default from PLANNER_MODEL_MAP)')
  .option(
    '--max-scout-files <n>',
    'Maximum files the scout can pre-select (default from config or 12)',
    (v) => parseInt(v, 10),
  )
  .option('--no-validation', 'Disable post-write validation', false)
  .option('--strict-validation', 'Write partial plan when validation finds issues', false)
  .addOption(
    new Option('--anthropic-runtime <mode>', 'Anthropic only: agent-sdk or legacy vercel AI SDK').choices([
      'agent-sdk',
      'vercel',
    ]),
  )
  .addOption(
    new Option('--effort <name>', 'Anthropic Agent SDK: draft-stage effort').choices([
      'minimal',
      'medium',
      'high',
    ]),
  )
  .addOption(
    new Option('--scout-effort <name>', 'Anthropic Agent SDK: scout-stage effort').choices([
      'minimal',
      'medium',
      'high',
    ]),
  )
  .option('--no-thinking', 'Anthropic Agent SDK: disable extended thinking for this run', false)
  .action(wrapArgs(runNewPlan));

program.command('status').description('Show squad-kit workspace status').action(wrap(runStatus));

program
  .command('doctor')
  .description('Run a health check on the local .squad/ workspace and its external integrations')
  .option('--fix', 'Apply non-destructive repairs (gitignore, permissions, missing dirs)', false)
  .option('--json', 'Emit results as JSON to stdout (for scripting)', false)
  .action(wrap(runDoctor));

program
  .command('migrate')
  .description('Apply one-shot structural migrations to bring .squad/ to the latest version')
  .option('--dry-run', 'Show what would change without touching the filesystem', false)
  .option('-y, --yes', 'Skip the confirmation prompt', false)
  .action(wrap(runMigrate));

program
  .command('upgrade')
  .description('Check for and install the latest squad-kit release')
  .option('--check', 'Only check for updates; do not install', false)
  .option('-y, --yes', 'Skip the confirmation prompt', false)
  .action(wrap(runUpgrade));

program
  .command('console')
  .description('Open the board in your browser. Every button there is also a command here')
  .option(
    '--port <number>',
    'Port to bind on 127.0.0.1 (default 4571; falls back to next free port)',
    (v) => parseInt(v, 10),
  )
  .option('--no-open', 'Do not auto-open the browser; print the URL instead')
  .option('--token <hex>', 'Reuse a specific session token (advanced; default: the same link as last time)')
  .option('--restart', 'Stop the board that is already running for this project, then start a fresh one')
  .action(wrap(runConsole));

program
  .command('demo')
  .description('Open a sample board where the squad works on its own, to try squad-kit v1')
  .option('--speed <n>', 'How fast the squad works: 1 is normal, 2 is twice as fast', (v) => parseFloat(v))
  .option('--project <name>', 'Project name on the sample board')
  .option('--port <number>', 'Port to bind on 127.0.0.1', (v) => parseInt(v, 10))
  .option('--no-open', 'Do not open the browser; print the URL instead')
  .option('--keep', 'Keep the current sample board instead of starting fresh', false)
  .option('--token <hex>', 'Reuse a specific session token (advanced)')
  .action(wrap(runDemo));

program.command('inbox').description('List everything waiting for you').action(wrap(runInbox));
program.command('board').description('Show every open ticket by stage').action(wrap(runBoard));
program
  .command('show <ticket>')
  .description('Show a ticket: its story, plan, steps, gates and proof')
  .action(wrapArgs(runShow));
program
  .command('answer <ticket>')
  .description("Answer the squad's questions on a ticket")
  .option('--skip', 'Let the squad guess every answer', false)
  .action(wrapArgs(runAnswer));
program
  .command('approve <ticket>')
  .description('Approve what a ticket is waiting on: the spec, the design (plan) or the proof')
  .action(wrapArgs(runApprove));
program
  .command('change <ticket> [note...]')
  .description('Ask for a change to the spec or design, or send the proof back with a note')
  .action(wrapArgs(runChange));
program
  .command('changes <ticket>')
  .description("Show what a ticket changed against main, read from the ticket's own copy")
  .option('--full', 'Print the whole diff', false)
  .action(wrapArgs(runChanges));
program
  .command('open <ticket>')
  .description("Open the ticket's copy of the code in Cursor or VS Code")
  .option('--editor <name>', 'cursor or code')
  .action(wrapArgs(runOpen));
program
  .command('reply <ticket> [answer...]')
  .description('Answer a question the Builder or Reviewer asked in the middle of its work')
  .action(wrapArgs(runReply));
program
  .command('note <ticket> [text...]')
  .description('Add a note, business rule or acceptance criterion to a ticket; every agent on it reads it')
  .option('--criterion', 'An acceptance criterion: it joins the "done when" list and must be proven', false)
  .option('--rule', 'A business rule the squad must follow', false)
  .action(wrapArgs(runNote));
program
  .command('chat <ticket> [message...]')
  .description('Talk a ticket through with an agent. /write writes the spec or design from the talk, /done ends it')
  .option('--with <agent>', 'analyst, architect, builder, reviewer or tester', 'analyst')
  .option('--write', 'Write (or update) the spec or design from the talk')
  .option('--done', 'Done talking; the squad carries on')
  .action(wrapArgs(runChat));
program
  .command('agent <role>')
  .description("See or change an agent's instructions per step, or read its core prompts (read only)")
  .option('--step <step>', 'One step, like questions, spec, scan, design, build, fix, review or proof')
  .option('--set <text>', 'Save the team instructions (for --step, or for every step)')
  .option('--prompt', 'Print the core prompts, filled in from a real ticket')
  .option('--ticket <id>', 'With --prompt: the ticket to fill them in from')
  .action(wrapArgs(runAgent));
program
  .command('send-back <ticket> <comments...>')
  .description('Send a spec or design back with comments on its parts, like "step 2: use the cache" "story: …"')
  .action(wrapArgs(runSendBack));
program
  .command('edit <ticket> <part> <text...>')
  .description('Edit a part of the waiting spec or design yourself: "story", "step N" or "done when N"')
  .action(wrapArgs(runEditPlan));
program
  .command('start-over <ticket> [direction...]')
  .description('Throw away the waiting spec or design and write it again from zero with a new direction')
  .action(wrapArgs(runStartOver));
program
  .command('message <ticket> [text...]')
  .description('Message an agent on a ticket; it reads it at its next step and the work goes on')
  .option('--to <agent>', 'analyst, architect, builder, reviewer or tester', 'builder')
  .action(wrapArgs(runMessage));
program
  .command('take-over <ticket>')
  .description("Stop the squad on a ticket and work in the Builder's Claude Code session yourself")
  .action(wrapArgs(runTakeOver));
program
  .command('give-back <ticket> [note...]')
  .description('Give a ticket back to the squad; the checks, review and proof run again')
  .action(wrapArgs(runGiveBack));
program
  .command('decide <ticket> [choice]')
  .description('Decide for the squad when it is stuck: try again, fix it yourself, continue anyway or back to the plan')
  .option('--note <text>', 'With "Try again": a note the squad reads first')
  .option('--reason <text>', 'With "Continue anyway": why. It shows on the ticket, the pull request and the release notes')
  .action(wrapArgs(runDecide));
program
  .command('stop <ticket>')
  .description('Stop the squad on a ticket; the work so far is kept')
  .action(wrapArgs(runStop));
program
  .command('unstick <ticket>')
  .description('End the command a ticket looks stuck on, so the squad carries on')
  .option('--keep-waiting', 'It is just slow: stay quiet about it for 10 minutes')
  .action(wrapArgs(runUnstick));
program
  .command('watch <ticket>')
  .description('Follow a ticket live until it needs you')
  .action(wrapArgs(runWatch));
program
  .command('release [version]')
  .description('Release the tickets that are ready')
  .option('-y, --yes', 'Skip the confirmation', false)
  .action(wrapArgs(runRelease));
program
  .command('bug [what...]')
  .description('Report a bug; it becomes a ticket linked to the release')
  .option('--in <version>', 'The release where you found it (default: the latest)')
  .option('--severity <level>', 'stops-work, annoying or small')
  .option('--how <steps>', 'How to see it')
  .option('--expected <text>', 'What you expected')
  .action(wrapArgs(runBug));
program
  .command('new [title...]')
  .description('Write a new ticket in plain words')
  .option('--ask <text>', 'What you want, in a sentence or two')
  .option('--priority <level>', 'high, normal or low')
  .option('--bug', 'It is a bug, not a new feature')
  .option('--express', 'Express track: no questions and the plan is approved on its own; build, checks, review and Looks right still run')
  .option('--full', 'Full track (the default): every step, with your approvals')
  .option('--talk', 'Talk it through with the Analyst first, instead of questions: squad chat <ticket>')
  .option('--criteria <text>', 'An acceptance criterion (repeat for more)', more, [])
  .option('--rule <text>', 'A business rule (repeat for more)', more, [])
  .option('--edge <text>', 'An edge case to handle (repeat for more)', more, [])
  .option('--attach <file>', 'Attach a file: a screenshot, a document (repeat for more)', more, [])
  .option('--from <text>', 'Paste an idea or a chat message; the Analyst fills in the ticket for you to check')
  .action(wrapArgs(runNew));
program
  .command('pull <ref>')
  .description('Start a ticket from an Azure DevOps work item, for example 35 or AB#35')
  .action(wrapArgs(runPull));
program
  .command('backlog')
  .description("Show the sprint's stories and bugs from Azure DevOps")
  .option('--sprint <name>', 'Which sprint, for example "Sprint 1" (default: the current one)')
  .option('--all', 'Everything open, in every sprint')
  .action(wrapArgs(runBacklog));

program
  .command('list')
  .description('List stories and their plan state')
  .option('--feature <slug>', 'Filter by feature slug')
  .action(wrap(runList));

const rm = program.command('rm').description('Delete stories, plans, or entire features safely');

rm
  .command('story [story-path-or-id]')
  .description('Delete a story: intake folder + matching plan file + overview row')
  .option('--feature <slug>', 'Scope the picker or lookup to one feature')
  .option('--dry-run', 'Show what would be deleted without touching the filesystem', false)
  .option('--trash', 'Move into .squad/.trash/<ts>/ instead of permanent delete', false)
  .option('-y, --yes', 'Skip the confirmation prompt', false)
  .action(wrapArgs(runRmStory));

rm
  .command('plan [plan-path-or-sequence]')
  .description('Delete a single plan file; leaves the intake for regeneration with new-plan')
  .option('--feature <slug>', 'Scope the picker to one feature')
  .option('--dry-run', 'Show what would be deleted without touching the filesystem', false)
  .option('--trash', 'Move into .squad/.trash/<ts>/ instead of permanent delete', false)
  .option('-y, --yes', 'Skip the confirmation prompt', false)
  .action(wrapArgs(runRmPlan));

rm
  .command('feature [feature-slug]')
  .description('Delete an entire feature: every story, every plan, the overview file')
  .option('--dry-run', 'Show what would be deleted without touching the filesystem', false)
  .option('--trash', 'Move into .squad/.trash/<ts>/ instead of permanent delete', false)
  .option('-y, --yes', 'Skip the confirmation prompt', false)
  .action(wrapArgs(runRmFeature));

const tracker = program.command('tracker').description('Tracker id helpers');
tracker
  .command('link [story-path] [tracker-id]')
  .description('Attach/update a tracker id on an existing story intake')
  .option('-y, --yes', 'Fail fast instead of prompting for missing values', false)
  .action(wrapArgs(runTrackerLink));

const auth = program
  .command('auth')
  .description(
    'Sign in to Anthropic with your Claude subscription, inspect it, or clear the stored token. ' +
      'Precedence, CI setup, usage limits, and troubleshooting: https://squad-kit.com/docs/auth',
  );

auth
  .command('login')
  .description(
    'Run the Anthropic browser authorization flow and store the resulting token in .squad/secrets.yaml. ' +
      'Prefer not to store a token? Run `claude` and use `/login` instead — squad-kit picks up the OS ' +
      'credential store automatically under `auth: subscription`.',
  )
  .option('--token <value>', 'Use a `claude setup-token` value you already have (CI / remote machines; no browser)')
  .option('--print-only', 'Run the flow, print the token, store nothing and change no config', false)
  .option('-y, --yes', 'Overwrite an already-stored token without confirming', false)
  .action(wrap(runAuthLogin));

auth
  .command('status')
  .description('Show the resolved auth mode, the credential behind it, and the signed-in account')
  .option('--json', 'Emit a stable JSON object for scripting (never contains the token)', false)
  .option('--offline', 'Skip the live account check; report only what resolves locally', false)
  .action(wrap(runAuthStatus));

auth
  .command('logout')
  .description('Remove only the OAuth token squad-kit stored; your Claude Code login is untouched')
  .option('-y, --yes', 'Skip the confirmation prompt', false)
  .action(wrap(runAuthLogout));

const config = program.command('config').description('Inspect and change .squad/ settings');

config
  .command('show')
  .description('Show the current .squad/config.yaml and .squad/secrets.yaml state (secrets masked)')
  .option('--json', 'Emit as JSON to stdout (secrets still masked)', false)
  .action(wrap(runConfigShow));

const set = config.command('set').description('Interactively change a section');
set
  .command('planner')
  .description('Set or change the planner provider, model override, and credentials')
  .option('--provider <name>', 'Skip the provider prompt (anthropic|openai|google)')
  .option('-y, --yes', 'Fail fast instead of prompting for missing values', false)
  .action(wrap(runConfigSetPlanner));
set
  .command('tracker')
  .description('Set or change the tracker type, workspace, and credentials')
  .option('--type <name>', 'Skip the tracker-type prompt (none|jira|azure|github)')
  .option('-y, --yes', 'Fail fast instead of prompting for missing values', false)
  .action(wrap(runConfigSetTracker));

const unset = config.command('unset').description('Disable or clear a section');
unset
  .command('planner')
  .description('Disable the direct planner (keeps provider credentials unless --remove-credentials)')
  .option('--remove-credentials', 'Also delete planner keys from .squad/secrets.yaml', false)
  .option('-y, --yes', 'Skip the confirmation prompt', false)
  .action(wrap(runConfigUnsetPlanner));
unset
  .command('tracker')
  .description('Set tracker.type back to "none" (keeps credentials unless --remove-credentials)')
  .option('--remove-credentials', 'Also delete tracker credentials from .squad/secrets.yaml', false)
  .option('-y, --yes', 'Skip the confirmation prompt', false)
  .action(wrap(runConfigUnsetTracker));

config
  .command('remove-credential <section>')
  .description('Delete credentials for "planner" or "tracker" from .squad/secrets.yaml without touching config.yaml')
  .option('-y, --yes', 'Skip the confirmation prompt', false)
  .action(
    wrapArgs(
      (section: string, opts: { yes?: boolean }) => runConfigRemoveCredential(section, { yes: opts.yes }),
    ),
  );

program.parseAsync(process.argv).catch((err) => {
  if (isSquadExit(err)) {
    if (err.message.trim()) ui.info(err.message);
    process.exit(err.exitCode);
  }
  ui.renderError(err);
  process.exit(1);
});

function wrap<T>(fn: (opts: T) => Promise<void>) {
  return async (opts: T) => {
    try {
      await fn(opts);
    } catch (err) {
      if (isSquadExit(err)) {
        if (err.message.trim()) ui.info(err.message);
        process.exit(err.exitCode);
      }
      ui.renderError(err);
      process.exit(1);
    }
  };
}

function wrapArgs<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (isSquadExit(err)) {
        if (err.message.trim()) ui.info(err.message);
        process.exit(err.exitCode);
      }
      ui.renderError(err);
      process.exit(1);
    }
  };
}

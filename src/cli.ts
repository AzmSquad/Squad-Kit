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
import { runApp, runConsole } from './commands/console.js';
import { runProjects } from './commands/projects.js';
import { runParts } from './commands/parts.js';
import { runFiles } from './commands/files.js';
import { runAsk, runTicketStatus, runWait } from './commands/now.js';
import { runLogs, runReport, runTryNow } from './commands/support.js';
import { runAppFind, runAppRestart, runAppSet, runAppStart, runAppStatus, runAppStop } from './commands/app.js';
import { runTry } from './commands/try.js';
import { runOutsideApproved, runOutsideBack, runOutsideCheck, runOutsideCopy, runOutsideNew, runOutsidePrompt, runOutsideShow, runOutsideStart } from './commands/outside.js';
import { runMcpBridge } from './commands/mcp-bridge.js';
import { runOverview, runSetup } from './commands/overview.js';
import {
  runAnswer,
  runApprove,
  runBoard,
  runBug,
  runChange,
  runPropose,
  runNote,
  runChat,
  runAgent,
  runSendBack,
  runEditPlan,
  runStartOver,
  runMessage,
  runTakeOver,
  runGiveBack,
  runHandOver,
  runTakeBack,
  runReply,
  runChanges,
  runOpen,
  runDecide,
  runTestCommand,
  runDemo,
  runInbox,
  runNew,
  runPull,
  runQuality,
  runBacklog,
  runUnstick,
  runRelease,
  runShow,
  runStop,
  runStartTicket,
  runWatch,
} from './commands/board.js';
import { runGuardAllow, runHosts } from './commands/sandbox.js';
import {
  runConfigShow,
  runConfigSetPlanner,
  runConfigSetTracker,
  runConfigUnsetPlanner,
  runConfigUnsetTracker,
  runConfigRemoveCredential,
} from './commands/config/index.js';
import { runRmFeature, runRmPlan, runRmStory } from './commands/rm/index.js';
import { runArchive, runDelete } from './commands/delete.js';
import { runBranches, runBringIn, runBuild, runDepends } from './commands/depends.js';
import { runDecided } from './commands/decided.js';
import { runConfigBudget, runConfigPayment, runCost } from './commands/cost.js';
import { runAuthLogin, runAuthStatus, runAuthLogout } from './commands/auth/index.js';
import { requirementsCommand } from './commands/requirements.js';
import { readInstalledPackage } from './core/package-info.js';
import { chooseProject } from './core/paths.js';
import { findProject } from './core/projects.js';

/** Collects a repeatable option into a list. */
function more(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name('squad')
  .description('Your AI Engineering Squad. One Unified Harness. Run squad on its own to open squad-kit with all your projects.')
  .version(readInstalledPackage().version)
  // squad's own options come before a command, so `squad console --port` stays the console's.
  .enablePositionalOptions()
  .option('--port <number>', 'Port to bind on 127.0.0.1 (default 4571; falls back to next free port)', (v) => parseInt(v, 10))
  .option('--no-open', 'Do not auto-open the browser; print the URL instead')
  .option('--token <hex>', 'Reuse a specific session token (advanced; default: the same link as last time)')
  .option('--restart', 'Stop squad-kit if it runs already, then start a fresh one')
  .action(
    wrap(async (opts: Parameters<typeof runApp>[0]) => {
      if (program.args.length) program.error(`squad: unknown command '${program.args[0]}'. See them all: squad --help`);
      await runApp(opts);
    }),
  );

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

program
  .command('status [ticket]')
  .description('Show squad-kit workspace status, or with a ticket what is happening on it now')
  .action(wrapArgs((ticket?: string) => (ticket ? runTicketStatus(ticket) : runStatus())));

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
  .description("Open this folder's project in squad-kit (it starts squad-kit if it is not open). Every button there is also a command here")
  .option(
    '--port <number>',
    'Port to bind on 127.0.0.1 (default 4571; falls back to next free port)',
    (v) => parseInt(v, 10),
  )
  .option('--no-open', 'Do not auto-open the browser; print the URL instead')
  .option('--token <hex>', 'Reuse a specific session token (advanced; default: the same link as last time)')
  .option('--restart', "Stop squad-kit if it runs already (or this project's own board), then start a fresh one")
  .option('-y, --yes', 'Set up a folder without squad-kit without asking first')
  .action(wrap(runConsole));

program
  .command('demo')
  .description('Open a sample board where the squad works on its own, to try squad-kit v1')
  .option('--speed <n>', 'How fast the squad works: 1 is normal, 2 is twice as fast', (v) => parseFloat(v))
  .option('--project <name>', 'Project name on the sample board')
  .option('--port <number>', 'Port to bind on 127.0.0.1', (v) => parseInt(v, 10))
  .option('--no-open', 'Do not open the browser; print the URL instead')
  .option('--keep', 'Keep the current sample board instead of starting fresh', false)
  .option('--first-run', 'Start the sample project at its first open: the setup, then the Overview to approve', false)
  .option('--token <hex>', 'Reuse a specific session token (advanced)')
  .action(wrap(runDemo));

program
  .command('projects')
  .description('List the projects in squad-kit, with what waits for you in each')
  .option('--remove <name>', 'Take a project out of squad-kit; its files stay in its folder')
  .option('--new <name>', 'Start a new project from a BRD (--brd) or an idea (--idea); squad-kit makes its folder')
  .option('--where <folder>', 'With --new: the folder it goes in (default: Documents)')
  .option('--idea <text>', 'With --new: what you want to build')
  .option('--brd <file>', 'With --new: the BRD, as a PDF, Word, Markdown or text file')
  .action(wrap(runProjects));

program
  .command('parts')
  .description("What the product is made of: its parts, what each needs and where it opens. The same as Settings")
  .option('--add <name>', 'Add a part')
  .option('--set <part>', 'Change a part: its id or name')
  .option('--off <part>', 'Mark a part Not used: no story starts it')
  .option('--on <part>', 'Use a part again')
  .option('--remove <part>', 'Take out a part an engineer added or changed')
  .option('--name <name>', 'With --set: its new name')
  .option('--shared', 'With --add: a service the parts share, like a database')
  .option('--repo <folder>', 'With --add or --set: the repo it is in')
  .option('--folder <folder>', 'With --add or --set: the folder inside that repo')
  .option('--needs <parts>', 'With --add or --set: what it cannot run without, separated by commas ("" for nothing)')
  .option('--url <address>', 'With --add or --set: where it opens ("" for none)')
  .option('--delivery <how>', 'How finished work goes out: pr, push (one plain commit per story, no pull request), or auto')
  .option('--at-once <n>', 'How many of this project\'s stories run at once, 1 to 5 ("all" for the app\'s own limit)')
  .action(wrap(runParts));

program
  .command('files')
  .description('The files agents may not touch: local files they cannot read, and locked files they cannot change. The same as Settings')
  .option('--local <path>', 'A file git does not carry, like .env.dev: in each story\'s copy, and no agent can read it')
  .option('--lock <path>', 'A file in git, like docker-compose.yml: agents can read it and never change it')
  .option('--lock-docker', 'Lock every Docker file in git')
  .option('--use-mine <path>', "Start a local file's values for stories from the one in your folder")
  .option('--remove <path>', 'Take a file off the list')
  .option('--repo <folder>', 'The repo the file is in, when the project has several')
  .action(wrap(runFiles));

// The first run and the Overview: the setup page and the Overview page, button for button.
program
  .command('setup')
  .description("Show the project's first run step by step: what squad-kit read, ran and opened, with each step's time")
  .option('--follow', 'Keep printing each step until the overview is ready')
  .option('--stop', 'Stop the step running now; the setup waits until you start it again')
  .option('--again [step]', 'Try again from a step: tool, read, commands, tests or app (default: read)')
  .action(wrap(runSetup));
program
  .command('overview')
  .description('What squad-kit understood about the project: who uses it, what it does, its parts, its rules and three ticket ideas')
  .option('--approve', 'Looks right, start working: the rules it found become the rules every agent follows')
  .option('--idea <n>', 'Make ticket idea 1, 2 or 3 a ticket')
  .option('--again', 'Read the project again, and check the overview again')
  .option('--with-talk', 'With --again: the Architect reads it again with what you told it')
  .option('--wrong [what...]', 'Something is wrong: tell the Architect what')
  .option('--build <what...>', 'A project with no code: tell the Architect what you want to build')
  .action(wrap(runOverview));

// Your apps: each app of the project, run from squad-kit's own copy of main (the board's sidebar does the same).
const appCmd = program.command('app').description("Run your apps from squad-kit's own copy of main: start, stop, restart, status");
appCmd.command('status').description('Show each app: running or not, its address, and a new version to run').action(wrap(runAppStatus));
appCmd
  .command('start [name]')
  .description('Start the app on the newest main (outside squad-kit: here, until Ctrl-C)')
  .option('--next-port', 'No longer needed: squad-kit moves the app to a free port by itself')
  .option('--stop-other', 'Its port is in use by a program squad-kit started: stop that first')
  .action(wrapArgs(runAppStart));
appCmd.command('stop [name]').description('Stop the app, and everything it started').action(wrapArgs(runAppStop));
appCmd
  .command('restart [name]')
  .description('Stop it, then start it on the newest main: run the new version after Looks right')
  .option('--next-port', 'No longer needed: squad-kit moves the app to a free port by itself')
  .option('--stop-other', 'Its port is in use by a program squad-kit started: stop that first')
  .action(wrapArgs(runAppRestart));
appCmd
  .command('set [name]')
  .description("Save how the app starts in the project's settings")
  .option('--start <command>', 'The command that starts it, for example "npm run dev"')
  .option('--url <address>', 'Where it answers, for example http://localhost:3000')
  .action(wrapArgs(runAppSet));
appCmd.command('find').description('Ask the Architect to read the project again and find how to start its apps').action(wrap(runAppFind));

program.command('inbox').description('List everything waiting for you (outside a project folder: in every project)').action(wrap(runInbox));
program
  .command('board')
  .description('Show every open ticket by stage')
  .option('--archived', 'Show archived tickets too')
  .action(wrap(runBoard));
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
  .command('try <ticket>')
  .description("Try it yourself: run the ticket's own copy of the app, with the change in it, before Looks right. Nothing is merged")
  .option('--stop', 'Stop the copy, and everything it started')
  .option('--status', 'Show whether the copy runs, and its address')
  .action(wrapArgs(runTry));
program
  .command('propose <ticket> [text...]')
  .description('Propose a change to the spec; the work goes on while the Analyst writes it, then you approve or decline it')
  .option('--approve', 'Approve the change that waits (the proposal, or a big change\'s design update)')
  .option('--decline', 'Decline the change that waits; any text is the reason')
  .option('--withdraw', 'Take back an approved change the squad has not built yet; any text is the reason')
  .option('--retry', 'Let the Analyst write the change again after it could not')
  .option('--as <kind>', 'For accepted work: make the change a new linked "ticket" or a "bug" report')
  .action(wrapArgs(runPropose));
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
  .command('decided <ticket> [id] [text...]')
  .description('Show what the squad decided for you on a ticket that builds by itself, or change one (d2 "<text>")')
  .action(wrapArgs(runDecided));
program
  .command('note <ticket> [text...]')
  .description('Add a note, business rule or acceptance criterion to a ticket; every agent on it reads it')
  .option('--criterion', 'An acceptance criterion: it joins the "done when" list and must be proven', false)
  .option('--rule', 'A business rule the squad must follow', false)
  .action(wrapArgs(runNote));
program
  .command('chat <ticket> [message...]')
  .description('Talk a ticket through with an agent. /write writes the spec or design from the talk, /done ends it')
  .option('--with <agent>', 'analyst, architect, builder, reviewer or tester (default: analyst)')
  .option('--ask', 'Ask a question: questions only, with whoever knows the story best; the ticket stays where it is')
  .option('--write', 'Write (or update) the spec or design from the talk')
  .option('--done', 'Done talking; the squad carries on')
  .option('--stop', 'Stop the answer the agent is writing; the talk stays open')
  .option('--retry', 'Ask the last question again, after a stop or a failed answer')
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
const outsideCmd = program.command('outside').description('Work on a story in a conversation in any AI tool, outside squad-kit, and bring it back');
outsideCmd.command('prompt [ticket]').description('Print the words to paste in the conversation. With no ticket: for a new story').action(wrapArgs(runOutsidePrompt));
outsideCmd
  .command('new <title...>')
  .description('Make a new story for this conversation. The squad keeps off it')
  .option('--ask <text>', 'What the person asked, in their words')
  .option('--bug', 'It is a bug')
  .action(wrapArgs(runOutsideNew));
outsideCmd.command('start <ticket>').description('Stop the squad on a story and move it to a conversation').action(wrapArgs(runOutsideStart));
outsideCmd.command('show <ticket>').description('Where the story is, what comes next, and which of its files is wrong').action(wrapArgs(runOutsideShow));
outsideCmd.command('copy <ticket> [repo]').description("Make the story's own copy of the code, and print the folder").action(wrapArgs(runOutsideCopy));
outsideCmd.command('approved <ticket> <what>').description('Record that the person approved the spec or the design in the conversation').action(wrapArgs(runOutsideApproved));
outsideCmd.command('back <ticket>').description('Bring the story back to the board, at its real step').action(wrapArgs(runOutsideBack));
outsideCmd.command('check <ticket>').description("Run squad-kit's own checks, review and proof on work done outside").action(wrapArgs(runOutsideCheck));
program
  .command('hand-over <ticket> [name...]')
  .description("Hand a ticket to a teammate: push its branch with the code and documents, and name the new owner")
  .option('--note <text>', 'A note for them; every agent on the ticket reads it too')
  .action(wrapArgs(runHandOver));
program
  .command('take-back <ticket>')
  .description('Take a ticket from its owner when they cannot work on it: a misspelled name, or someone who left')
  .requiredOption('--reason <text>', 'Why. It stays on the ticket')
  .action(wrapArgs(runTakeBack));
program
  .command('decide <ticket> [choice]')
  .description('Decide for the squad when it is stuck: try again, fix it yourself, continue anyway or back to the plan')
  .option('--note <text>', 'With "Try again": a note the squad reads first')
  .option('--reason <text>', 'With "Continue anyway": why. It shows on the ticket, the pull request and the release notes')
  .action(wrapArgs(runDecide));
program
  .command('test-command <ticket>')
  .description("The Architect's design changes the test command: use the new one, or keep the current one")
  .option('--use', 'Use the new test command for the project')
  .option('--keep', 'Keep the current test command')
  .action(wrapArgs(runTestCommand));
program
  .command('stop <ticket>')
  .description('Stop the squad on a ticket; the work so far is kept')
  .option('--again', 'Stop the running step and start it again at once')
  .action(wrapArgs(runStop));
program
  .command('start <ticket>')
  .description('Start a story squad-kit made, which waits on the board until you start it')
  .action(wrapArgs(runStartTicket));
program
  .command('wait <ticket>')
  .description('A slow step is fine: stay quiet about it for a while. Its time limit stays')
  .option('--more <time>', 'How much longer, like 10m or 1h', '10m')
  .action(wrapArgs(runWait));
program
  .command('ask <ticket> [question...]')
  .description('Ask about a ticket: is there a problem, when will it be ready, what is it doing. Answered at once, no AI cost')
  .action(wrapArgs(runAsk));
program
  .command('delete <ticket>')
  .description('Delete a ticket that is not merged: its copy of the code, branch, files, chats and screenshots. Its cost stays in Usage')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('--remote', 'Also delete its pushed branch on the remote')
  .action(wrapArgs(runDelete));
program
  .command('archive <ticket>')
  .description('Take a merged or released ticket off the board; its history stays')
  .option('--undo', 'Bring an archived ticket back to the board')
  .action(wrapArgs(runArchive));
program
  .command('unstick <ticket>')
  .description('End the command a ticket looks stuck on, so the squad carries on')
  .option('--keep-waiting', 'It is just slow: stay quiet about it for 10 minutes')
  .option('--free-port', "The app's port is held by a program squad-kit started: stop it and try the step again")
  .action(wrapArgs(runUnstick));
program
  .command('watch <ticket>')
  .description('Follow a ticket live until it needs you')
  .action(wrapArgs(runWatch));
program
  .command('report [ticket]')
  .description('Save one file to send to whoever helps you with squad-kit: the ticket, its conversations, the log and the versions. Never tokens or passwords')
  .option('--note <text>', 'What happened, in your words')
  .option('--out <folder>', 'Where to save it (default: your Downloads folder)')
  .action(wrapArgs(runReport));
program
  .command('logs')
  .description("Show where squad-kit's own log is")
  .option('--tail [lines]', 'Print its last lines (40 by default)')
  .action(wrap(runLogs));
program
  .command('cost [ticket]')
  .description("What the squad's work costs, the way you pay: a ticket's cost, or the month, the budgets and the averages per Quality setting")
  .action(wrapArgs(runCost));
program
  .command('try-now')
  .description('Stop waiting for the AI usage limit to reset: the squad carries on now')
  .action(wrap(runTryNow));
program
  .command('release [version]')
  .description('Release the tickets that are ready')
  .option('-y, --yes', 'Skip the confirmation', false)
  .option('--push-again', 'Send a release whose push failed: its commits and tag go to the remote now')
  .option('--mark-sent', 'Close a release whose push failed because it reached the remote another way, such as merged by hand. Needs --reason')
  .option('--reason <how>', 'With --mark-sent: how it reached the remote. It stays in the release log')
  .option('--go-on <why>', "Go out past a team's release check that failed or could not run. The reason stays on the record")
  .option('--anyway', 'With --mark-sent: mark it even when squad-kit cannot find it on the remote, or cannot reach the remote')
  .option('--without <ticket>', 'Take a ticket out of the release before it is made; it goes out with the next one (repeat for more)', more, [])
  .option('--put-back <ticket>', 'Put a ticket you took out back into the release (repeat for more)', more, [])
  .action(wrapArgs(runRelease));
program
  .command('depends <ticket>')
  .description('Show or set the open tickets a ticket needs; it waits for them before it is built')
  .option('--on <ticket>', 'A ticket it depends on (repeat for more)', more, [])
  .option('--none', 'It depends on no other ticket')
  .action(wrapArgs(runDepends));
program
  .command('build <ticket>')
  .description('Choose how to build a ticket whose dependency is not merged yet')
  .option('--on-branch', "Start its copy from the dependency's branch; main comes in once that one is merged")
  .option('--anyway', 'Build from main without it; this stays on the record')
  .option('--wait', 'Wait: the build starts by itself once the dependency is merged')
  .action(wrapArgs(runBuild));
program
  .command('bring-in <ticket>')
  .description("Bring the latest main into a ticket's copy of the code; the checks, review and proof run again")
  .action(wrapArgs(runBringIn));
program
  .command('branches')
  .description('Show the old branches of released tickets')
  .option('--clean', 'Delete them on this computer (never one with work that is not in main)')
  .option('--remote', 'With --clean: delete them on the remote too')
  .action(wrap(runBranches));
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
  .option('--severity <level>', 'For a bug: stops-work, annoying or small')
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
program.addCommand(requirementsCommand());

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
set
  .command('quality [setting]')
  .description('Show or set how strong the squad\'s models are: best (default), balanced or thrifty')
  .action(wrapArgs(runQuality));
set
  .command('hosts [hosts...]')
  .description('Show or set the hosts the Builder and Tester may reach besides the package registries')
  .option('--clear', 'Allow only the package registries again', false)
  .action(wrapArgs(runHosts));
set
  .command('allow-read [paths...]')
  .description("Show or set files outside its copy that the project's own commands (tests, setup, the app) may read")
  .option('--clear', 'Allow none again', false)
  .action(wrapArgs((paths: string[], opts: { clear?: boolean }) => runGuardAllow('read', paths, opts)));
set
  .command('allow-write [paths...]')
  .description("Show or set folders outside its copy that the project's own commands may write in")
  .option('--clear', 'Allow none again', false)
  .action(wrapArgs((paths: string[], opts: { clear?: boolean }) => runGuardAllow('write', paths, opts)));
set
  .command('payment [how]')
  .description('Show or set how you pay for the AI: subscription, api-key, or auto to let squad-kit find out')
  .action(wrapArgs(runConfigPayment));
set
  .command('budget')
  .description('Show or set the budgets for an API key, in US dollars: --ticket 5 --month 50 (off takes one away)')
  .option('--ticket <usd>', 'The budget per ticket')
  .option('--month <usd>', 'The budget per month, for this project')
  .action(wrap(runConfigBudget));

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

// squad-kit's own tools for an agent that takes MCP only over stdio: started by squad-kit for one run, never by people.
program
  .command('mcp-bridge', { hidden: true })
  .description("Forward an agent's calls to squad-kit's own tools for its run (started by squad-kit)")
  .action(wrap(runMcpBridge));

// Commands that act on one project find it from the folder they run in, or take --project (ADR-001).
const NOT_ON_ONE_PROJECT = new Set(['init', 'demo', 'upgrade', 'projects', 'help', 'logs', 'try-now', 'mcp-bridge']);
const leaves = (c: Command): Command[] => (c.commands.length ? c.commands.flatMap(leaves) : [c]);
for (const c of program.commands.filter((x) => !NOT_ON_ONE_PROJECT.has(x.name())).flatMap(leaves)) {
  if (!c.options.some((o) => o.long === '--project')) c.option('--project <name>', 'The project: its name, id or folder (default: the one this folder is in)');
}
program.hook('preAction', (_squad, action) => {
  const ref = action.opts().project as unknown;
  if (typeof ref === 'string' && ref.trim() && !NOT_ON_ONE_PROJECT.has(action.name())) chooseProject(findProject(ref));
});

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

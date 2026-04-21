import { Command } from 'commander';
import kleur from 'kleur';
import { runInit } from './commands/init.js';
import { runNewStory } from './commands/new-story.js';
import { runNewPlan } from './commands/new-plan.js';
import { runStatus } from './commands/status.js';
import { runList } from './commands/list.js';
import { runTrackerLink } from './commands/tracker-link.js';

const program = new Command();

program
  .name('squad')
  .description('Plan once, execute cheap. A 3-step SDD workflow CLI.')
  .version('0.1.0');

program
  .command('init')
  .description('Bootstrap .squad/ in the current directory')
  .option('--agents <list>', 'Comma-separated agent list: claude-code,cursor,copilot,gemini')
  .option('--tracker <type>', 'Tracker type: none|github|linear|jira|azure')
  .option('--name <name>', 'Project name')
  .option('--language <lang>', 'Primary language')
  .option('--force', 'Overwrite existing files', false)
  .option('-y, --yes', 'Accept defaults (non-interactive)', false)
  .action(wrap(runInit));

program
  .command('new-story <feature-slug>')
  .description('Scaffold a new story intake under .squad/stories/<feature>/<id>/')
  .option('--id <id>', 'Tracker work-item id (required when tracker is not none and naming.includeTrackerId is true)')
  .option('--title <title>', 'Short title hint (placed at top of intake)')
  .option('-y, --yes', 'Fail fast instead of prompting for missing values', false)
  .action(wrapArgs(runNewStory));

program
  .command('new-plan <intake-path>')
  .description('Compose the plan-generation meta-prompt with intake content; prints to stdout and copies to clipboard')
  .option('--no-copy', 'Do not copy the composed prompt to clipboard')
  .action(wrapArgs(runNewPlan));

program.command('status').description('Show squad-kit workspace status').action(wrap(runStatus));

program
  .command('list')
  .description('List stories and their plan state')
  .option('--feature <slug>', 'Filter by feature slug')
  .action(wrap(runList));

const tracker = program.command('tracker').description('Tracker id helpers');
tracker
  .command('link <story-path> <tracker-id>')
  .description('Attach/update a tracker id on an existing story intake')
  .action(wrapArgs(runTrackerLink));

program.parseAsync(process.argv).catch((err) => {
  console.error(kleur.red(`error: ${(err as Error).message}`));
  process.exit(1);
});

function wrap<T>(fn: (opts: T) => Promise<void>) {
  return async (opts: T) => {
    try {
      await fn(opts);
    } catch (err) {
      console.error(kleur.red(`error: ${(err as Error).message}`));
      process.exit(1);
    }
  };
}

function wrapArgs<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(kleur.red(`error: ${(err as Error).message}`));
      process.exit(1);
    }
  };
}

import fs from 'node:fs';
import { select } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadConfig, saveConfig, type SquadConfig, type TrackerType } from '../../core/config.js';
import { loadSecrets, saveSecrets, mergeSecrets, type SquadSecrets } from '../../core/secrets.js';
import { clientFor, overlayTrackerEnv } from '../../tracker/index.js';
import { probeJiraConnectivity, probeAzureConnectivity } from '../../core/probes.js';
import { isInteractive } from '../../ui/tty.js';
import { promptJiraCredentials, promptAzureCredentials } from './shared.js';

const TYPES: TrackerType[] = ['none', 'github', 'jira', 'azure'];

function parseType(t: string | undefined): TrackerType {
  if (!t) {
    throw new Error(
      'Pass --type (none|jira|azure|github) with --yes, or run `squad config set tracker` without --yes in a TTY to pick a type.',
    );
  }
  if (!TYPES.includes(t as TrackerType)) {
    throw new Error(
      `Invalid --type "${t}". Use none | jira | azure | github, or run \`squad config set tracker\` interactively.`,
    );
  }
  return t as TrackerType;
}

function jiraError(): Error {
  return new Error(
    `Jira configuration is incomplete. Set JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN (or run \`squad config set tracker\` without --yes to enter credentials interactively).`,
  );
}

function azureError(): Error {
  return new Error(
    `Azure DevOps configuration is incomplete. Set AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT, AZURE_DEVOPS_PAT (or run \`squad config set tracker\` without --yes to enter credentials interactively).`,
  );
}

export interface ConfigSetTrackerOptions {
  type?: string;
  yes?: boolean;
}

export async function runConfigSetTracker(opts: ConfigSetTrackerOptions = {}): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);
  const baseSecrets: SquadSecrets = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};

  const useYes = Boolean(opts.yes);
  const interactive = !useYes && isInteractive();

  let type: TrackerType;
  if (opts.type) {
    type = parseType(opts.type);
  } else if (useYes) {
    type = parseType(undefined);
  } else {
    type = (await select({
      message: 'Issue tracker',
      choices: [
        { name: 'None', value: 'none' as TrackerType },
        { name: 'GitHub Issues', value: 'github' as TrackerType },
        { name: 'Jira', value: 'jira' as TrackerType },
        { name: 'Azure DevOps', value: 'azure' as TrackerType },
      ],
      default: config.tracker.type,
    })) as TrackerType;
  }

  let nextTracker!: SquadConfig['tracker'];

  if (type === 'none') {
    nextTracker = { type: 'none' };
  } else if (type === 'github') {
    nextTracker = { ...config.tracker, type };
  } else if (type === 'jira') {
    if (interactive) {
      ui.step('Jira Cloud credentials (stored in .squad/secrets.yaml — always git-ignored)');
      const j = await promptJiraCredentials({ host: config.tracker.workspace });
      const merged = mergeSecrets(baseSecrets, {
        tracker: { jira: { host: j.host, email: j.email, token: j.token } },
      });
      saveSecrets(paths.secretsFile, merged);
      nextTracker = { type: 'jira', workspace: j.host };
      ui.success('Jira credentials saved');
      ui.info('.squad/secrets.yaml updated (chmod 0600 on POSIX)');
    } else {
      const o = overlayTrackerEnv(baseSecrets);
      const host = (
        o.tracker?.jira?.host ??
        process.env.JIRA_HOST ??
        (config.tracker.type === 'jira' ? config.tracker.workspace : undefined)
      )?.trim();
      if (!host) {
        throw jiraError();
      }
      const candidate: SquadConfig = { ...config, tracker: { type: 'jira', workspace: host } };
      if (clientFor(candidate, o).error) {
        throw jiraError();
      }
      nextTracker = { type: 'jira', workspace: host };
    }
  } else if (type === 'azure') {
    if (interactive) {
      ui.step('Azure DevOps credentials (stored in .squad/secrets.yaml — always git-ignored)');
      const a = await promptAzureCredentials({
        organization: config.tracker.workspace,
        project: config.tracker.project,
      });
      const merged = mergeSecrets(baseSecrets, {
        tracker: {
          azure: { organization: a.organization, project: a.project, pat: a.pat },
        },
      });
      saveSecrets(paths.secretsFile, merged);
      nextTracker = { type: 'azure', workspace: a.organization, project: a.project };
      ui.success('Azure DevOps credentials saved');
      ui.info('.squad/secrets.yaml updated (chmod 0600 on POSIX)');
    } else {
      const o = overlayTrackerEnv(baseSecrets);
      const org = (o.tracker?.azure?.organization ?? process.env.AZURE_DEVOPS_ORG ?? config.tracker.workspace)?.trim();
      const project = (o.tracker?.azure?.project ?? process.env.AZURE_DEVOPS_PROJECT ?? config.tracker.project)?.trim();
      if (!org || !project) {
        throw azureError();
      }
      const candidate: SquadConfig = { ...config, tracker: { type: 'azure', workspace: org, project } };
      if (clientFor(candidate, o).error) {
        throw azureError();
      }
      nextTracker = { type: 'azure', workspace: org, project };
    }
  }

  const next: SquadConfig = { ...config, tracker: nextTracker };
  saveConfig(paths.configFile, next);

  ui.blank();
  ui.success('Tracker configuration updated.');
  ui.kv('type', next.tracker.type, 10);
  if (next.tracker.workspace) {
    ui.kv('workspace', next.tracker.workspace, 10);
  }
  if (next.tracker.project) {
    ui.kv('project', next.tracker.project, 10);
  }

  if (process.env.CI === 'true') {
    printTrackerNextSteps(next.tracker.type);
    return;
  }

  const reloaded = loadConfig(paths.configFile);
  const s = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};
  if (reloaded.tracker.type === 'jira') {
    const r = await probeJiraConnectivity(s, reloaded);
    if (r.ok) {
      ui.info('Jira connectivity check: OK');
    } else {
      ui.warning(
        r.status !== undefined
          ? `Jira connectivity check: HTTP ${r.status}`
          : `Jira connectivity check failed: ${r.detail ?? 'unknown'}`,
      );
    }
  } else if (reloaded.tracker.type === 'azure') {
    const r = await probeAzureConnectivity(s, reloaded);
    if (r.ok) {
      ui.info('Azure DevOps connectivity check: OK');
    } else {
      ui.warning(
        r.status !== undefined
          ? `Azure DevOps connectivity check: HTTP ${r.status}`
          : `Azure DevOps connectivity check failed: ${r.detail ?? 'unknown'}`,
      );
    }
  }

  printTrackerNextSteps(next.tracker.type);
}

function printTrackerNextSteps(type: string): void {
  ui.blank();
  ui.step('Next:');
  if (type === 'none') {
    ui.info('1) Tracker is off. Create stories manually with `squad new-story <slug> --no-tracker`.');
    ui.info('2) Re-enable any time with `squad config set tracker`.');
    return;
  }
  ui.info('1) Verify with `squad doctor` — tracker checks should be green.');
  ui.info(`2) Create a story: squad new-story <feature-slug> --id <${type === 'jira' ? 'JIRA-123' : 'azure-work-item-id'}>`);
  ui.info('   squad-kit auto-fetches the title, description, and attachments into the intake.');
  ui.info('3) Review the generated intake.md, then run `squad new-plan --api` to generate the plan.');
}

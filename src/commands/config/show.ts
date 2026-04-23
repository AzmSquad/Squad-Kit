import fs from 'node:fs';
import * as ui from '../../ui/index.js';
import { buildPaths, requireSquadRoot } from '../../core/paths.js';
import { loadConfig, type SquadConfig } from '../../core/config.js';
import { loadSecrets, type SquadSecrets } from '../../core/secrets.js';
import { maskPlannerCredentials, maskTrackerForShow } from './masks.js';
import type { PlannerConfig } from '../../planner/types.js';

export interface ConfigShowOptions {
  json?: boolean;
}

export type ConfigShowPayload = {
  project: SquadConfig['project'];
  tracker: SquadConfig['tracker'] & { credentials: ReturnType<typeof maskTrackerForShow> };
  naming: SquadConfig['naming'];
  agents: SquadConfig['agents'];
  planner:
    | { enabled: false }
    | (PlannerConfig & { credentials: ReturnType<typeof maskPlannerCredentials> });
};

function buildPayload(config: SquadConfig, secrets: SquadSecrets): ConfigShowPayload {
  const basePlanner = !config.planner || config.planner.enabled !== true;
  const planner: ConfigShowPayload['planner'] = basePlanner
    ? { enabled: false }
    : { ...config.planner!, enabled: true, credentials: maskPlannerCredentials(secrets.planner) };
  return {
    project: config.project,
    tracker: { ...config.tracker, credentials: maskTrackerForShow(secrets) },
    naming: config.naming,
    agents: config.agents,
    planner,
  };
}

function renderShow(root: string, payload: ConfigShowPayload): void {
  ui.divider('squad config show');
  ui.kv('workspace', root, 10);
  ui.blank();

  ui.step('Project');
  ui.kv('name', payload.project.name, 14);
  if (payload.project.primaryLanguage) {
    ui.kv('language', payload.project.primaryLanguage, 14);
  }
  if (payload.project.projectRoots?.length) {
    ui.kv('roots', payload.project.projectRoots.join(', '), 14);
  }
  ui.blank();

  ui.divider('Tracker');
  ui.kv('type', payload.tracker.type, 10);
  if (payload.tracker.workspace) {
    ui.kv('workspace', payload.tracker.workspace, 10);
  }
  if (payload.tracker.project) {
    ui.kv('project', payload.tracker.project, 10);
  }
  const tc = payload.tracker.credentials;
  if (tc.jira) {
    ui.kv('jira host', tc.jira.host ?? '(not set)', 10);
    ui.kv('jira email', tc.jira.email ?? '(not set)', 10);
    ui.kv('jira token', tc.jira.token, 10);
  }
  if (tc.azure) {
    ui.kv('azure org', tc.azure.organization ?? '(not set)', 10);
    ui.kv('azure project', tc.azure.project ?? '(not set)', 10);
    ui.kv('azure pat', tc.azure.pat, 10);
  }
  if (payload.tracker.type === 'jira' && !tc.jira) {
    ui.kv('jira', '(not configured in secrets.yaml)', 10);
  }
  if (payload.tracker.type === 'azure' && !tc.azure) {
    ui.kv('azure', '(not configured in secrets.yaml)', 10);
  }
  ui.blank();

  ui.divider('Naming');
  ui.kv('includeTrackerId', String(payload.naming.includeTrackerId), 18);
  ui.kv('globalSequence', String(payload.naming.globalSequence), 18);
  ui.blank();

  ui.divider('Agents');
  ui.kv('installed', payload.agents.length ? payload.agents.join(', ') : '(none)', 10);
  ui.blank();

  ui.divider('Planner');
  if (payload.planner.enabled === false) {
    ui.kv('enabled', 'false', 10);
  } else {
    const p = payload.planner;
    ui.kv('enabled', 'true', 10);
    ui.kv('provider', p.provider, 10);
    ui.kv('mode', p.mode, 10);
    const creds = p.credentials;
    ui.kv('key anthropic', creds.anthropic ?? 'not set', 14);
    ui.kv('key openai', creds.openai ?? 'not set', 14);
    ui.kv('key google', creds.google ?? 'not set', 14);
  }
  ui.blank();
}

export function buildConfigShowPayload(config: SquadConfig, secrets: SquadSecrets): ConfigShowPayload {
  return buildPayload(config, secrets);
}

export async function runConfigShow(opts: ConfigShowOptions): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);
  const secrets = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : ({} as SquadSecrets);

  const payload = buildPayload(config, secrets);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  renderShow(root, payload);
}

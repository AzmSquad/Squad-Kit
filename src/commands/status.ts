import fs from 'node:fs';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot } from '../core/paths.js';
import { loadConfig, type SquadConfig } from '../core/config.js';
import { modelFor, providerEnvVar, resolveProviderKey } from '../core/planner-models.js';
import { scanPlans, formatSequence } from '../core/sequence.js';
import { listStories } from '../core/stories.js';
import { loadSecrets, type SquadSecrets } from '../core/secrets.js';
import { clientFor, overlayTrackerEnv } from '../tracker/index.js';

const kw = 28;

type CredStatus =
  | { state: 'present'; detail: 'env' | 'secrets.yaml' }
  | { state: 'missing'; hint: string };

function probeTrackerCredential(config: SquadConfig, overlay: SquadSecrets): CredStatus {
  const { client, error } = clientFor(config, overlay);
  if (client) {
    const fromEnv =
      (config.tracker.type === 'jira' &&
        Boolean(process.env.JIRA_API_TOKEN || process.env.SQUAD_TRACKER_API_KEY)) ||
      (config.tracker.type === 'azure' &&
        Boolean(process.env.AZURE_DEVOPS_PAT || process.env.SQUAD_TRACKER_API_KEY));
    return { state: 'present', detail: fromEnv ? 'env' : 'secrets.yaml' };
  }
  return {
    state: 'missing',
    hint: error?.detail ?? 'Run `squad init` to enter credentials.',
  };
}

function formatCredentialStatus(s: CredStatus): string {
  if (s.state === 'present') {
    return s.detail === 'env' ? 'set via environment variable' : 'set via .squad/secrets.yaml';
  }
  return `missing — ${s.hint}`;
}

export async function runStatus(): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);
  const scan = scanPlans(paths.plansDir);

  const storyCount = listStories(paths).length;
  const planCount = scan.usedNumbers.length;

  const secrets = fs.existsSync(paths.secretsFile) ? loadSecrets(paths.secretsFile) : {};
  const overlay = overlayTrackerEnv(secrets);

  ui.banner();
  ui.step('squad-kit status');
  ui.blank();
  ui.kv('project', config.project.name, kw);
  ui.kv('tracker', buildTrackerLine(config, overlay), kw);

  if (config.tracker.type === 'jira' || config.tracker.type === 'azure') {
    const result = probeTrackerCredential(config, overlay);
    ui.kv('tracker key', formatCredentialStatus(result), kw);
  }

  ui.kv('agents', config.agents.length ? config.agents.join(', ') : '(none)', kw);
  if (config.planner?.enabled) {
    const model = modelFor(config.planner.provider, 'plan', config.planner.modelOverride);
    const overrideNote = config.planner.modelOverride?.[config.planner.provider] ? ' (override)' : '';
    ui.kv('planner', `${config.planner.provider}/${model}${overrideNote}`, kw);
    const cred = resolveProviderKey(config.planner.provider);
    ui.kv(
      'planner key',
      cred
        ? `set via ${cred.detail}`
        : `missing — set ${providerEnvVar(config.planner.provider)} or run \`squad init\``,
      kw,
    );
  } else {
    ui.kv('planner', 'disabled (copy-paste flow)', kw);
  }
  ui.kv('stories (drafts + planned)', String(storyCount), kw);
  ui.kv('plan files', String(planCount), kw);
  ui.kv('next NN', formatSequence(scan.nextGlobal), kw);
  if (scan.duplicates.length > 0) {
    ui.warning(`duplicate NN numbers: ${scan.duplicates.map(formatSequence).join(', ')}`);
  }
}

function buildTrackerLine(config: SquadConfig, overlay: SquadSecrets): string {
  if (config.tracker.type === 'none') return 'none';
  let trackerLine = config.tracker.type;
  if (config.tracker.type === 'jira') {
    if (overlay.tracker?.jira?.host) {
      trackerLine += ` · ${overlay.tracker.jira.host}`;
    } else {
      trackerLine += ' · (no host configured)';
    }
  } else if (config.tracker.type === 'azure') {
    const org = overlay.tracker?.azure?.organization ?? config.tracker.workspace;
    const proj = overlay.tracker?.azure?.project ?? config.tracker.project;
    if (org) {
      trackerLine += ` · ${org}${proj ? `/${proj}` : ''}`;
    } else {
      trackerLine += ' · (no organization configured)';
    }
  }
  return trackerLine;
}

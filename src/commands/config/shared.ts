import { input, password } from '@inquirer/prompts';
import { DEFAULT_PLANNER_MAX_OUTPUT_TOKENS } from '../../core/config.js';
import { mergeSecrets, type SquadSecrets } from '../../core/secrets.js';
import type { PlannerConfig } from '../../planner/types.js';
import type { ProviderName } from '../../planner/types.js';

const notEmpty = (v: string) => v.trim().length > 0 || 'required';

export interface ConfigSetCommonOpts {
  yes?: boolean;
}

export async function promptAzureCredentials(defaults: {
  organization?: string;
  project?: string;
} = {}): Promise<{ organization: string; project: string; pat: string }> {
  const organization = await input({
    message: 'Azure DevOps organization:',
    default: defaults.organization ?? '',
    validate: notEmpty,
  });
  const project = await input({
    message: 'Azure DevOps project:',
    default: defaults.project ?? '',
    validate: notEmpty,
  });
  const pat = await password({
    message: 'Personal Access Token (needs "Work Items (Read)" scope; input hidden):',
    validate: (v) => (v.length >= 20 ? true : 'PAT seems too short'),
  });
  return { organization: organization.trim(), project: project.trim(), pat };
}

export function newPlannerBlock(provider: ProviderName): PlannerConfig {
  return {
    enabled: true,
    provider,
    mode: 'auto',
    budget: {
      maxFileReads: 25,
      maxContextBytes: 50_000,
      maxDurationSeconds: 180,
    },
    cache: { enabled: true },
    maxOutputTokens: DEFAULT_PLANNER_MAX_OUTPUT_TOKENS,
  };
}

export function mergePlannerKeyIntoSecrets(base: SquadSecrets, provider: ProviderName, key: string): SquadSecrets {
  if (provider === 'anthropic') {
    return mergeSecrets(base, { planner: { anthropic: key } });
  }
  if (provider === 'openai') {
    return mergeSecrets(base, { planner: { openai: key } });
  }
  return mergeSecrets(base, { planner: { google: key } });
}

export function mergePlannerOauthTokenIntoSecrets(base: SquadSecrets, token: string): SquadSecrets {
  return mergeSecrets(base, { planner: { anthropicOauthToken: token } });
}

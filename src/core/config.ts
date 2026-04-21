import fs from 'node:fs';
import yaml from 'js-yaml';

export type TrackerType = 'none' | 'github' | 'linear' | 'jira' | 'azure';

export interface SquadConfig {
  version: number;
  project: {
    name: string;
    primaryLanguage?: string;
    projectRoots?: string[];
  };
  tracker: {
    type: TrackerType;
    workspace?: string;
    project?: string;
  };
  naming: {
    includeTrackerId: boolean;
    globalSequence: boolean;
  };
  agents: string[];
}

export const DEFAULT_CONFIG: SquadConfig = {
  version: 1,
  project: {
    name: 'my-project',
    primaryLanguage: 'typescript',
    projectRoots: ['.'],
  },
  tracker: { type: 'none' },
  naming: { includeTrackerId: false, globalSequence: true },
  agents: [],
};

export function loadConfig(configFile: string): SquadConfig {
  const raw = fs.readFileSync(configFile, 'utf8');
  const parsed = yaml.load(raw) as Partial<SquadConfig> | undefined;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid config at ${configFile}: expected a YAML object.`);
  }
  return mergeConfig(DEFAULT_CONFIG, parsed);
}

export function saveConfig(configFile: string, config: SquadConfig): void {
  const body = yaml.dump(config, { lineWidth: 100, noRefs: true, sortKeys: false });
  fs.writeFileSync(configFile, body, 'utf8');
}

function mergeConfig(base: SquadConfig, override: Partial<SquadConfig>): SquadConfig {
  return {
    version: override.version ?? base.version,
    project: { ...base.project, ...(override.project ?? {}) },
    tracker: { ...base.tracker, ...(override.tracker ?? {}) },
    naming: { ...base.naming, ...(override.naming ?? {}) },
    agents: override.agents ?? base.agents,
  };
}

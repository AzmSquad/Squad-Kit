import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SquadSecrets } from '../src/core/secrets.js';
import { overlayTrackerEnv } from '../src/tracker/env-overlay.js';

const KEYS = [
  'JIRA_HOST',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'AZURE_DEVOPS_ORG',
  'AZURE_DEVOPS_PROJECT',
  'AZURE_DEVOPS_PAT',
  'SQUAD_TRACKER_API_KEY',
] as const;

describe('overlayTrackerEnv', () => {
  let saved: Partial<Record<(typeof KEYS)[number], string | undefined>>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('leaves base values when no tracker env vars are set', () => {
    const base: SquadSecrets = {
      tracker: {
        jira: { host: 'h', email: 'e', token: 'jt' },
        azure: { organization: 'o', project: 'p', pat: 'ap' },
      },
    };
    const out = overlayTrackerEnv(base);
    expect(out).toEqual(base);
  });

  it('overrides jira fields from JIRA_* env vars', () => {
    process.env.JIRA_HOST = 'env-host';
    process.env.JIRA_EMAIL = 'env@example.com';
    process.env.JIRA_API_TOKEN = 'env-token';

    const base: SquadSecrets = {
      tracker: {
        jira: { host: 'file-host', email: 'file@example.com', token: 'file-token' },
      },
    };
    const out = overlayTrackerEnv(base);
    expect(out.tracker?.jira).toEqual({
      host: 'env-host',
      email: 'env@example.com',
      token: 'env-token',
    });
  });

  it('uses SQUAD_TRACKER_API_KEY as jira token and azure pat when specific vars are absent', () => {
    process.env.SQUAD_TRACKER_API_KEY = 'shared-from-env';

    const base: SquadSecrets = {
      tracker: {
        jira: { host: 'h', email: 'e', token: 'file-jira' },
        azure: { organization: 'o', project: 'p', pat: 'file-azure' },
      },
    };
    const out = overlayTrackerEnv(base);
    expect(out.tracker?.jira?.token).toBe('shared-from-env');
    expect(out.tracker?.azure?.pat).toBe('shared-from-env');
  });

  it('prefers JIRA_API_TOKEN over SQUAD_TRACKER_API_KEY for jira', () => {
    process.env.JIRA_API_TOKEN = 'explicit-jira';
    process.env.SQUAD_TRACKER_API_KEY = 'shared';

    const base: SquadSecrets = {
      tracker: { jira: { host: 'h', email: 'e', token: 'file' } },
    };
    const out = overlayTrackerEnv(base);
    expect(out.tracker?.jira?.token).toBe('explicit-jira');
  });

  it('prefers AZURE_DEVOPS_PAT over SQUAD_TRACKER_API_KEY for azure', () => {
    process.env.AZURE_DEVOPS_PAT = 'explicit-azure';
    process.env.SQUAD_TRACKER_API_KEY = 'shared';

    const base: SquadSecrets = {
      tracker: { azure: { organization: 'o', project: 'p', pat: 'file' } },
    };
    const out = overlayTrackerEnv(base);
    expect(out.tracker?.azure?.pat).toBe('explicit-azure');
  });
});

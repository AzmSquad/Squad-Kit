import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { azVersionOf, detectAll, type DetectHost, type Ran } from '../src/engine/tools/detect.js';
import { kindsOf } from '../src/engine/tools/kinds.js';
import { linesFor } from '../src/engine/tools/index.js';
import { ownAzureFolder } from '../src/core/home.js';
import { childEnv } from '../src/engine/agent-env.js';

/**
 * Microsoft's Azure tool on the Tools page (ADR-011): Optional for a project whose code is kept on Azure Repos, since a
 * pasted token works too, with Microsoft's own install steps. It is only ever asked with squad-kit's own settings folder.
 * And agents never reach the Microsoft sign-in: theirs is an empty folder.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tools-az-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mac(answers: Record<string, Ran>, seen: NodeJS.ProcessEnv[], az = true): DetectHost {
  return {
    system: 'mac',
    home: '/Users/pm',
    env: { PATH: '/opt/homebrew/bin' },
    run: async (cmd, args, opts) => {
      if (path.basename(cmd) === 'az') seen.push(opts?.env ?? {});
      return answers[`${path.basename(cmd)} ${args.join(' ')}`] ?? { ok: false, out: '', err: 'not found' };
    },
    exists: (p) => az && p === '/opt/homebrew/bin/az',
    read: () => null,
    real: (p) => p,
    list: () => [],
    writable: () => true,
  };
}

describe("Microsoft's Azure tool on the Tools page", () => {
  it("reads its version with squad-kit's own settings folder, never the person's", async () => {
    expect(azVersionOf('{\n  "azure-cli": "2.88.0",\n  "azure-cli-core": "2.88.0"\n}')).toBe('2.88.0');
    const seen: NodeJS.ProcessEnv[] = [];
    const found = await detectAll(mac({ 'az version --output json': { ok: true, out: '{"azure-cli": "2.88.0"}', err: '' } }, seen), tmp);
    expect(found.tools.az).toEqual({ state: 'found', where: '/opt/homebrew/bin/az', version: '2.88.0' });
    expect(seen).toEqual([{ AZURE_CONFIG_DIR: ownAzureFolder(tmp), AZURE_CORE_COLLECT_TELEMETRY: 'false' }]);
    expect((await detectAll(mac({}, [], false), tmp)).tools.az).toEqual({ state: 'missing' });
  });

  it('a project kept on Azure Repos gets the line, Optional, with the install steps; one on GitHub does not', () => {
    const app = path.join(tmp, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'package.json'), '{}');
    execSync('git init -q -b main && git remote add origin https://dev.azure.com/contoso/Shop/_git/shop', { cwd: app });
    expect(kindsOf(app).kinds).toEqual(['web', 'azure']);
    const book = { at: '', system: 'mac' as const, tools: { az: { state: 'missing' as const } } };
    const places = [{ place: '.', kinds: ['web', 'azure'] as ('web' | 'azure')[], platforms: ['web' as const] }];
    const line = linesFor(places, book, 'mac').find((l) => l.id === 'az')!;
    expect(line).toMatchObject({ name: "Microsoft's Azure tool (az)", priority: 'optional', state: 'missing', blocks: [], installer: 'you', link: 'https://learn.microsoft.com/cli/azure/install-azure-cli' });
    expect(line.steps[1]).toBe("Run: brew install azure-cli. Without Homebrew, follow Microsoft's install page.");
    expect(linesFor(places, book, 'windows').find((l) => l.id === 'az')!.steps[1]).toBe('Run: winget install --exact --id Microsoft.AzureCLI');
    expect(linesFor(places, book, 'linux').find((l) => l.id === 'az')!.steps[0]).toBe("Open Microsoft's install page and follow the steps for your Linux.");
    expect(linesFor([{ place: '.', kinds: ['web', 'github'], platforms: ['web'] }], book, 'mac').some((l) => l.id === 'az')).toBe(false);
  });
});

describe('agents and the Microsoft sign-in', () => {
  it("get an empty az folder of their own, never squad-kit's or the person's, and no Azure DevOps token", async () => {
    const { projectEnv } = await import('../src/engine/project-guard.js');
    const before = { ...process.env };
    Object.assign(process.env, { AZURE_CONFIG_DIR: path.join(os.homedir(), '.azure'), AZURE_DEVOPS_EXT_PAT: 'pat', AZURE_DEVOPS_PAT: 'pat' });
    try {
      const env = childEnv();
      expect(env.AZURE_CONFIG_DIR).not.toBe(process.env.AZURE_CONFIG_DIR);
      expect(env.AZURE_CONFIG_DIR).not.toBe(ownAzureFolder());
      expect(fs.readdirSync(env.AZURE_CONFIG_DIR!)).toEqual([]);
      expect(env.AZURE_CONFIG_DIR).not.toBe(env.GH_CONFIG_DIR);
      expect([env.AZURE_DEVOPS_EXT_PAT, env.AZURE_DEVOPS_PAT]).toEqual([undefined, undefined]);
      // The project's own commands too: their cleaning drops every AZURE_ variable, then sets the empty folder again.
      expect(projectEnv().AZURE_CONFIG_DIR).toBe(env.AZURE_CONFIG_DIR);
      // Emptied again before each use: what one agent left there never reaches the next.
      fs.writeFileSync(path.join(env.AZURE_CONFIG_DIR!, 'azureProfile.json'), '{}');
      expect(fs.readdirSync(childEnv().AZURE_CONFIG_DIR!)).toEqual([]);
    } finally {
      process.env = before;
    }
  });
});

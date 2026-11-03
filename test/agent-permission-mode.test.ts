import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeLaunch, claudeRunOptions } from '../src/modules/claude/index.js';
import { claudeBinary, runClaude } from '../src/modules/claude/direct.js';
import type { PermissionSet } from '../src/modules/ai-tool/types.js';

/**
 * Every step runs in a permission mode of squad-kit's own, never the person's: someone whose Claude settings say
 * "bypass permissions" would otherwise give the Reviewer and the Tester a free shell.
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-mode-')));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (permissions: PermissionSet[]) => claudeRunOptions({ cwd: tmp, prompt: 'x', permissions });

describe('the permission mode', () => {
  it('is set for every step: accept edits for the Builder, the default mode for every other step', () => {
    expect(run(['edit']).permissionMode).toBe('acceptEdits');
    for (const p of [['read'], ['read', 'git-read'], ['run']] as PermissionSet[][]) expect(run(p).permissionMode).toBe('default');
  });

  it('turns bypass off over ACP and sets the mode on the session, because the adapter ignores it in the options', () => {
    for (const [p, mode] of [[['read'], 'default'], [['run'], 'default'], [['edit'], 'acceptEdits']] as [PermissionSet[], string][]) {
      const launch = claudeLaunch(run(p), '/adapter.js', '/bin/claude');
      const options = (launch.meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options;
      expect(options.allowDangerouslySkipPermissions).toBe(false);
      expect(launch.mode).toBe(mode);
    }
  });

  it('goes to Claude Code on the command line when it runs directly', async () => {
    // A stand-in for Claude Code that answers with the arguments it got.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(process.argv.slice(2)), session_id: 's' }) + '\\n');\n`,
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv('HOME', tmp);
    // Only ever the stand-in: the real Claude Code is never started here.
    expect(claudeBinary()).toBe(path.join(bin, 'claude'));
    const args = async (p: PermissionSet[]) => JSON.parse((await runClaude({ ...run(p), timeoutMs: 20_000 })).text) as string[];
    const read = await args(['read']);
    expect(read[read.indexOf('--permission-mode') + 1]).toBe('default');
    const build = await args(['edit']);
    expect(build[build.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    // Even a run that names no mode starts in the default one.
    const bare = JSON.parse((await runClaude({ cwd: tmp, prompt: 'x', timeoutMs: 20_000 })).text) as string[];
    expect(bare[bare.indexOf('--permission-mode') + 1]).toBe('default');
  });
});

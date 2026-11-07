import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * What no agent reaches, whichever step it is on: the person's keys and sign-ins, and a push. A sandbox covers a step's
 * shell commands only, and read-only agents have none, so these rules go on every run. Real git; no real AI runs.
 */

const calls: RunOptions[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return { ok: true, structured: { map: [], stack: [], patterns: [] }, sessionId: opts.sessionId } as RunResult;
  },
}));

const { deniedTools } = await import('../src/modules/claude/direct.js');
const { claudeRunOptions } = await import('../src/modules/claude/index.js');
const { agentPrivatePlaces, guardSupport, ticketGuard, projectGuardFor, spawnProject } = await import('../src/engine/project-guard.js');
const { noPushEnv } = await import('../src/engine/sandbox.js');
const { makeNewProject } = await import('../src/engine/new-project.js');
const { readMeta, writeMeta } = await import('../src/board/store.js');
const { LiveSquad } = await import('../src/engine/live.js');
const { squadHome } = await import('../src/core/home.js');

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-private-')));
  calls.length = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the person's keys and sign-ins", () => {
  const home = '/home/sara';
  const places = () => agentPrivatePlaces(home, 'linux');

  it('names the keys, the sign-ins and squad-kit own secrets, and not its other files', () => {
    for (const p of ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.git-credentials', '.docker']) expect(places()).toContain(path.join(home, p));
    const own = squadHome();
    expect(places()).toContain(path.join(own, 'secrets.yaml'));
    expect(places()).toContain(path.join(own, 'app.json'));
    expect(places()).toContain(path.join(own, 'projects', '*', 'secrets.yaml'));
    // Agents read a story's pictures and a BRD's pages from squad-kit's own folder.
    expect(places()).not.toContain(own);
  });

  it.each([
    ['a step that only reads', ['read']],
    ['the Tester', ['read', 'run']],
    ['the Builder', ['read', 'edit', 'run']],
  ] as const)('%s is refused them, by the file and everything in a folder', (_who, permissions) => {
    const rules = deniedTools(claudeRunOptions({ cwd: tmp, prompt: 'x', permissions: [...permissions], privatePlaces: places() } as never));
    const ssh = path.join(home, '.ssh');
    expect(rules).toContain(`Read(/${ssh})`);
    expect(rules).toContain(`Read(/${ssh}/**)`);
    expect(rules).toContain(`Edit(/${ssh}/**)`);
  });

  it('the live squad puts them on a read-only run', async () => {
    const { bp } = makeNewProject({ name: 'Keys', where: tmp, idea: 'A thing' });
    writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', scan: { status: 'done', empty: false } });
    await (new LiveSquad(bp) as unknown as { readBlueprint(): Promise<void> }).readBlueprint();
    const run = calls.at(-1)!;
    expect(run.allowedTools).not.toContain('Edit');
    expect(deniedTools(run)).toContain(`Read(/${path.join(os.homedir(), '.ssh')}/**)`);
  });
});

describe('a push', () => {
  const sh = (cmd: string, cwd: string, env: NodeJS.ProcessEnv = process.env) => execSync(cmd, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let remote: string;
  let work: string;

  beforeEach(() => {
    remote = path.join(tmp, 'remote.git');
    work = path.join(tmp, 'work');
    sh(`git init -q --bare "${remote}"`, tmp);
    fs.mkdirSync(work);
    sh(`git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m one && git remote add origin "${remote}"`, work);
  });

  const noPush = (more: NodeJS.ProcessEnv = {}) => ({ ...process.env, ...more, ...noPushEnv({ ...more }) });
  const heads = () => sh('git for-each-ref refs/heads', remote);

  it.each(['origin', '../remote.git', 'https://example.invalid/a.git', 'ssh://example.invalid/a.git', 'git@example.invalid:a.git'])('to %s is refused', (to) => {
    expect(() => sh(`git push "${to}" main`, work, noPush())).toThrow();
    expect(heads()).toBe('');
  });

  it('squad-kit own git, with no such setting, still pushes', () => {
    sh('git push -q origin main', work);
    expect(heads()).toContain('refs/heads/main');
  });

  it('fetching still works, as a story needs the newest code', () => {
    sh('git push -q origin main', work);
    expect(() => sh('git fetch -q origin', work, noPush())).not.toThrow();
  });

  it('keeps what the person set in their own environment', () => {
    const env = noPush({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12' });
    expect(env.GIT_CONFIG_KEY_0).toBe('core.abbrev');
    expect(sh('git config core.abbrev', work, env)).toBe('12');
    expect(() => sh('git push origin main', work, env)).toThrow();
  });

  it('a story command run through the one gate gets it, and the release pipeline does not', async () => {
    const { bp } = makeNewProject({ name: 'Gate', where: tmp, idea: 'A thing' });
    const story = ticketGuard(bp, { cwd: work, id: 'GA-1' });
    const release = projectGuardFor(bp, { cwd: work });
    expect(story.noPush).toBe(true);
    expect(release.noPush).toBeUndefined();
    const run = (guard: typeof story | undefined) =>
      new Promise<string>((resolve) => {
        const child = spawnProject('printf "%s" "${GIT_CONFIG_COUNT:-none}"', { cwd: work, ...(guard ? { guard } : {}) });
        let out = '';
        child.stdout!.on('data', (d) => (out += String(d)));
        child.on('close', () => resolve(out));
      });
    expect(await run(undefined)).toBe('none');
    if (!guardSupport().on) return;
    expect(await run(story)).toBe(String(Object.keys(noPushEnv({})).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).length));
    expect(await run(release)).toBe('none');
  });
});

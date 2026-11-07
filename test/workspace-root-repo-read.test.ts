import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * The first read decides what the project is for good: it saves the code repos the stories work in. A workspace whose
 * root is a repo keeps its repos, and a one-repo project with a repo inside stays one project, as Add project said.
 * Agent runs are fake, and the read stops before anything is run.
 */

const prompts: string[] = [];
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    prompts.push(opts.prompt);
    const repos = ['api', 'web'].map((p) => ({ path: p, summary: `The ${p}`, commands: {} }));
    return { ok: true, sessionId: 's', text: '', structured: { empty: false, summary: 'Read.', map: [], decisions: [], commands: {}, repos, users: 'People', can: ['Work'], worth: [], ideas: [], parts: [], links: [] } };
  },
}));

const { readMeta, writeMeta } = await import('../src/board/store.js');
const { prepareProject } = await import('../src/engine/setup.js');
const { LiveSquad } = await import('../src/engine/live.js');

let tmp: string;
const stops: (() => void)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'ignore' });
const put = (file: string, text = 'x\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const commit = (dir: string, branch = 'main') => sh(`git init -q -b ${branch} && git add -A && git -c user.name=t -c user.email=t@t commit -q -m first`, dir);

async function readProject(root: string) {
  const { bp } = prepareProject(root);
  writeMeta(bp, { ...readMeta(bp), runner: 'direct' });
  stops.push(new LiveSquad(bp).start(25));
  for (let i = 0; i < 400 && readMeta(bp).scan?.status !== 'done'; i += 1) await sleep(20);
  expect(readMeta(bp).scan?.status).toBe('done');
  return readMeta(bp);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-rootrepo-read-')));
  prompts.length = 0;
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await sleep(100);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the first read of a folder that is a repo with repos inside', () => {
  it('a workspace keeps its code repos, each on its own branch', async () => {
    const root = path.join(tmp, 'portal');
    put(path.join(root, 'api', 'Program.cs'));
    put(path.join(root, 'web', 'src', 'app.ts'));
    commit(path.join(root, 'api'), 'development');
    commit(path.join(root, 'web'), 'development');
    put(path.join(root, '.gitignore'), 'api/\nweb/\n');
    put(path.join(root, 'NOTES.md'));
    commit(root);
    const meta = await readProject(root);
    expect(meta.repos?.map((r) => [r.path, r.base, r.summary])).toEqual([
      ['api', 'development', 'The api'],
      ['web', 'development', 'The web'],
    ]);
    expect(prompts[0]).toContain('This folder is a workspace with several code repos inside');
  });

  it('a one-repo project with a repo inside stays one project', async () => {
    const root = path.join(tmp, 'shop');
    put(path.join(root, 'src', 'index.ts'));
    put(path.join(root, '.gitignore'), 'lib/\n');
    commit(root);
    put(path.join(root, 'lib', 'index.js'));
    commit(path.join(root, 'lib'));
    const meta = await readProject(root);
    expect(meta.repos).toBeUndefined();
    expect(prompts[0]).not.toContain('This folder is a workspace');
  });
});

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { forgetGhState } from '../../src/modules/github/sign-in.js';
import { forgetWhere } from '../../src/modules/github/where.js';
import { useMergePace } from '../../src/modules/github/merge.js';
import { useForkPace } from '../../src/modules/github/forks.js';

/**
 * GitHub for a test: a made-up gh first on the PATH (signed in, missing or signed out), and GitHub's REST answered by
 * the test's own routes. Nothing reaches the real GitHub, and no real token is ever read.
 */

export interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

export type Answer = { status?: number; body?: unknown } | undefined;

export interface FakeGitHub {
  calls: Call[];
  /** The calls of one method whose path starts with this. */
  sent(method: string, start: string): Call[];
  done(): void;
}

const ghScript = (state: 'ready' | 'signed-out') => `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "gh version 2.63.0 (2024-11-27)"; exit 0;;
  "auth token") ${state === 'ready' ? 'echo "test-token"; exit 0' : 'echo "no oauth token" >&2; exit 1'};;
esac
exit 0
`;

/** gh as this test wants it: signed in, signed out, or not on this computer at all. */
export function fakeGh(state: 'ready' | 'signed-out' | 'missing'): () => void {
  const before = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-fake-gh-'));
  if (state === 'missing') {
    // git and the system's own programs only: no gh anywhere, not even the test's stand-in.
    fs.symlinkSync(execSync('command -v git', { encoding: 'utf8' }).trim(), path.join(dir, 'git'));
    process.env.PATH = [dir, '/usr/bin', '/bin'].join(path.delimiter);
  } else {
    fs.writeFileSync(path.join(dir, 'gh'), ghScript(state), { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${before ?? ''}`;
  }
  forgetGhState();
  return () => {
    process.env.PATH = before;
    forgetGhState();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

/** GitHub's REST, answered by `answer`; anything it does not answer is a 404. */
export function fakeGitHub(answer: (c: Call) => Answer): FakeGitHub {
  forgetWhere();
  useMergePace({ stepMs: 0, waitMs: 50, graceMs: 0, sleep: async () => undefined });
  useForkPace({ stepMs: 0, waitMs: 50, sleep: async () => undefined });
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = init.headers as Record<string, string>;
    if (u.host !== 'api.github.com' || headers.Authorization !== 'Bearer test-token') throw new Error(`Not a call to the fake GitHub: ${url}`);
    const c: Call = { method: init.method ?? 'GET', path: `${u.pathname}${u.search}`, ...(init.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) };
    calls.push(c);
    const a = answer(c) ?? { status: 404, body: { message: 'Not Found' } };
    const status = a.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(a.body ?? {}), { status });
  });
  return {
    calls,
    sent: (method, start) => calls.filter((c) => c.method === method && c.path.startsWith(start)),
    done: () => {
      vi.unstubAllGlobals();
      useMergePace(null);
      useForkPace(null);
      forgetWhere();
    },
  };
}

/** A repo as GitHub's REST gives it. */
export function repoJson(full: string, o: { fork?: string; push?: boolean; base?: string } = {}) {
  return {
    full_name: full,
    html_url: `https://github.com/${full}`,
    clone_url: `https://github.com/${full}.git`,
    ssh_url: `git@github.com:${full}.git`,
    default_branch: o.base ?? 'main',
    fork: Boolean(o.fork),
    ...(o.fork ? { parent: { full_name: o.fork, default_branch: 'main' } } : {}),
    permissions: { push: o.push ?? true },
  };
}

/** A pull request as GitHub's REST gives it. */
export function pullJson(repo: string, n: number, o: { state?: 'open' | 'closed'; merged?: boolean; mergeable?: boolean | null; mergeableState?: string; head?: string; headRepo?: string; sha?: string } = {}) {
  return {
    number: n,
    html_url: `https://github.com/${repo}/pull/${n}`,
    state: o.state ?? 'open',
    merged: o.merged ?? false,
    merged_at: o.merged ? '2026-11-13T10:00:00Z' : null,
    merge_commit_sha: o.merged ? 'mergedsha' : null,
    mergeable: o.mergeable === undefined ? true : o.mergeable,
    mergeable_state: o.mergeableState ?? 'clean',
    head: { sha: o.sha ?? 'headsha', ref: o.head ?? 'squad/ap-1', repo: { full_name: o.headRepo ?? repo } },
    base: { ref: 'main' },
  };
}

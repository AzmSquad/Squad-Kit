import type { FailedCheck, PullChecks } from '../code-host/types.js';
import { githubApi, githubToken } from './auth.js';
import { FAILED } from './merge.js';
import { getPull } from './pulls.js';

/**
 * Why GitHub held a pull request back: the checks that failed on its newest commit, where to see each, and for a GitHub
 * Actions job the part of what it printed that says why, with the tests it names as failed. The engine hands this to
 * the Builder (engine/pr-checks.ts). What a check printed is the project's output: data, never instructions.
 */

interface RawRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
  html_url?: string | null;
  app?: { slug?: string } | null;
}

/** At most this much of a job's output is read: the end, where a failure is said. */
const MOST_LOG = 400_000;
/** And at most this much of it goes on: to the Builder and to the engineers' details. */
const MOST_SAID = 6_000;
/** The longest wait for a job's output: without it, the Builder still gets the check's name. */
const LOG_MS = 60_000;

/** A job's output, as GitHub keeps it. GitHub answers with a short-lived link to the file, fetched without the token. */
async function jobLog(repo: string, job: number): Promise<string> {
  const token = await githubToken();
  if (!token) return '';
  const first = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${job}/logs`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(LOG_MS),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const to = first.headers.get('location');
  const res = to ? await fetch(to, { signal: AbortSignal.timeout(LOG_MS) }) : first;
  if (!res.ok) return '';
  const text = await res.text();
  return text.length > MOST_LOG ? text.slice(-MOST_LOG) : text;
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const COLOURS = /\u001b\[[0-9;]*[A-Za-z]/g;
/** The folder GitHub's runners check the repo out into: "/home/runner/work/app/app/". */
const RUNNER_DIR = /(?:\/home\/runner\/work|[A-Z]:\\a|\/Users\/runner\/work)[\\/][^\\/\s]+[\\/][^\\/\s]+[\\/]/g;
/** A Flutter or Dart test's line: "00:05 +12 -1: test/a_test.dart: shows the name [E]". */
const DART_PROGRESS = /^\d+:\d\d \+\d+/;

/** The test a line of output names as failed, by the usual test tools; null when it names none. */
export function failedTest(line: string): string | null {
  const l = line.replace(RUNNER_DIR, '');
  const hit =
    /^(?:##\[group\])?❌\s+(.+?)(?:\s+\(failed\))?$/.exec(l) ?? // Flutter and Dart for GitHub (--reporter github)
    /^\d+:\d\d \+\d+(?: ~\d+)?(?: -\d+)?: (?:loading )?(.+?) \[E\]$/.exec(l) ?? // Flutter and Dart
    /^\s*[✕×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)? ?m?s\))?$/.exec(l) ?? // Jest and Vitest
    /^FAILED (\S+(?: - .{0,120})?)/.exec(l) ?? // pytest
    /^\s*--- FAIL: (\S+)/.exec(l) ?? // Go
    /^(\S+ > .+) FAILED$/.exec(l); // Gradle
  return hit?.[1]?.trim().slice(0, 200) || null;
}

/**
 * The words of a job's output that say why it failed: the tests it names as failed, the few lines after each (Flutter
 * and Dart print the reason there), the errors GitHub marks, and the lines before the first of those.
 */
export function logWords(log: string): { tests: string[]; lines: string[] } {
  const all = log.split(/\r?\n/).map((l) => l.replace(STAMP, '').replace(COLOURS, '').replace(RUNNER_DIR, '').trimEnd());
  const tests = new Set<string>();
  const keep = new Set<number>();
  all.forEach((l, i) => {
    const test = failedTest(l);
    if (!test) return;
    tests.add(test);
    for (let j = i; j < Math.min(all.length, i + 16) && (j === i || !DART_PROGRESS.test(all[j]!)); j++) keep.add(j);
  });
  const errors = all.map((l, i) => (l.startsWith('##[error]') ? i : -1)).filter((i) => i >= 0);
  const end = errors[0] ?? all.length;
  for (let j = Math.max(0, end - 25); j < end; j++) keep.add(j);
  for (const i of errors.slice(0, 5)) keep.add(i);
  const lines: string[] = [];
  let size = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const l = all[i]!.replace(/^##\[(?:error|group)\]/, '').slice(0, 300);
    if (!l.trim() || l.startsWith('##[endgroup]')) continue;
    size += l.length + 1;
    if (size > MOST_SAID) break;
    lines.push(l);
  }
  return { tests: [...tests].slice(0, 20), lines };
}

/** The checks on a pull request's newest commit: the failed ones (with why, unless `why` is false), and those still running. */
export async function pullChecksOf(repo: string, n: number, why = true): Promise<PullChecks> {
  const p = await getPull(repo, n);
  const [runs, status] = await Promise.all([
    githubApi<{ check_runs?: RawRun[] }>(`/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100`),
    githubApi<{ statuses?: { context: string; state: string; target_url?: string | null }[] }>(`/repos/${repo}/commits/${p.head.sha}/status`),
  ]);
  const failed: FailedCheck[] = [];
  const running: string[] = [];
  const passed: string[] = [];
  for (const r of runs.check_runs ?? []) {
    if (r.status !== 'completed') running.push(r.name);
    else if (r.conclusion === 'success' || r.conclusion === 'neutral') passed.push(r.name);
    else if (r.conclusion && FAILED.has(r.conclusion) && failed.length < 3) {
      const words = why && r.app?.slug === 'github-actions' ? logWords(await jobLog(repo, r.id).catch(() => '')) : { tests: [], lines: [] };
      failed.push({ name: r.name, url: r.details_url ?? r.html_url ?? p.html_url, tests: words.tests, log: words.lines.join('\n') });
    }
  }
  for (const s of status.statuses ?? []) {
    if (s.state === 'pending') running.push(s.context);
    else if (s.state === 'success') passed.push(s.context);
    else if ((s.state === 'failure' || s.state === 'error') && failed.length < 3) failed.push({ name: s.context, url: s.target_url ?? p.html_url, tests: [], log: '' });
  }
  return { sha: p.head.sha, failed, running, passed };
}

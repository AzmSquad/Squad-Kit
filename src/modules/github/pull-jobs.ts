import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { PullJob } from '../code-host/types.js';
import { githubApi } from './auth.js';

/**
 * The jobs a team's own GitHub workflows run on a pull request when it gets a label, such as one that makes golden
 * pictures on Linux. Read from the story's copy of the repo: a workflow that listens for a label being added and names
 * that label in its condition. squad-kit starts only these, only on the story's own pull request, and only when the
 * Builder named one as the fix (engine/pr-checks.ts).
 */

const MOST_FILES = 50;
const MOST_JOBS = 10;

/** A workflow started by a label: `on: pull_request: types: [labeled]` (or pull_request_target). */
function onLabel(on: unknown): boolean {
  if (!on || typeof on !== 'object') return false;
  return ['pull_request', 'pull_request_target'].some((event) => {
    const types = (on as Record<string, { types?: unknown } | null>)[event]?.types;
    return Array.isArray(types) ? types.includes('labeled') : types === 'labeled';
  });
}

/** The labels a workflow's conditions name: `github.event.label.name == 'update goldens'`, either way round. */
function labelsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/github\.event\.label\.name\s*==\s*['"]([^'"\n]{1,50})['"]/g)) out.add(m[1]!);
  for (const m of text.matchAll(/['"]([^'"\n]{1,50})['"]\s*==\s*github\.event\.label\.name/g)) out.add(m[1]!);
  return [...out];
}

/** The comment at the top of a workflow file, as one line. */
function topComment(text: string): string {
  const lines: string[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim().startsWith('#')) break;
    lines.push(l.trim().replace(/^#+\s?/, ''));
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function labelJobsIn(dir: string): PullJob[] {
  const folder = path.join(dir, '.github', 'workflows');
  let files: string[];
  try {
    files = fs.readdirSync(folder).filter((f) => /\.ya?ml$/i.test(f)).sort().slice(0, MOST_FILES);
  } catch {
    return [];
  }
  const jobs: PullJob[] = [];
  for (const file of files) {
    let text: string;
    let doc: unknown;
    try {
      text = fs.readFileSync(path.join(folder, file), 'utf8');
      if (text.length > 200_000) continue;
      doc = yaml.load(text);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object' || !onLabel((doc as { on?: unknown }).on)) continue;
    const name = String((doc as { name?: unknown }).name ?? file).slice(0, 80);
    for (const label of labelsIn(text).slice(0, 3)) jobs.push({ name, label, file: `.github/workflows/${file}`, about: topComment(text) });
  }
  return jobs.slice(0, MOST_JOBS);
}

/** The label goes on the pull request; one that is on already comes off first, so adding it starts the job again. */
export async function startLabelJob(repo: string, n: number, job: PullJob): Promise<void> {
  const on = await githubApi<{ name: string }[]>(`/repos/${repo}/issues/${n}/labels`);
  if (on.some((l) => l.name.toLowerCase() === job.label.toLowerCase())) {
    await githubApi(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent(job.label)}`, { method: 'DELETE' });
  }
  await githubApi(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: { labels: [job.label] } });
}

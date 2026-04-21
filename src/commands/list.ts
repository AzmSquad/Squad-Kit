import fs from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';
import { buildPaths, requireSquadRoot } from '../core/paths.js';

export interface ListOptions {
  feature?: string;
}

interface Row {
  feature: string;
  id: string;
  hasIntake: boolean;
  planFile?: string;
}

export async function runList(opts: ListOptions): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const rows: Row[] = [];

  if (fs.existsSync(paths.storiesDir)) {
    for (const feature of fs.readdirSync(paths.storiesDir, { withFileTypes: true })) {
      if (!feature.isDirectory()) continue;
      if (opts.feature && feature.name !== opts.feature) continue;
      const featureDir = path.join(paths.storiesDir, feature.name);
      for (const story of fs.readdirSync(featureDir, { withFileTypes: true })) {
        if (!story.isDirectory()) continue;
        const intake = path.join(featureDir, story.name, 'intake.md');
        rows.push({
          feature: feature.name,
          id: story.name,
          hasIntake: fs.existsSync(intake),
          planFile: findPlan(paths.plansDir, feature.name, story.name),
        });
      }
    }
  }

  if (rows.length === 0) {
    console.log(kleur.dim('(no stories yet — try `squad new-story <feature-slug>`)'));
    return;
  }

  const header = ['feature', 'story', 'intake', 'plan'];
  const table = rows.map((r) => [
    r.feature,
    r.id,
    r.hasIntake ? 'yes' : '—',
    r.planFile ?? kleur.dim('—'),
  ]);
  printTable([header, ...table]);
}

function findPlan(plansDir: string, feature: string, storyId: string): string | undefined {
  const featureDir = path.join(plansDir, feature);
  if (!fs.existsSync(featureDir)) return undefined;
  for (const entry of fs.readdirSync(featureDir)) {
    if (entry.includes(storyId) && entry.endsWith('.md')) return entry;
  }
  return undefined;
}

function printTable(rows: string[][]): void {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell, widths[i]!)).join('  '));
  }
}

function pad(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  return s + ' '.repeat(Math.max(0, width - visible));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

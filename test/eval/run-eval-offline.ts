#!/usr/bin/env tsx
/**
 * Zero-API validation sweep over existing plan markdown.
 * Usage: pnpm eval:offline [plansDir] [workspaceRoot]
 * Defaults: <cwd>/../.squad/plans and <cwd>/..
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlan } from '../../src/planner/validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function* walkMarkdownFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkMarkdownFiles(p);
    else if (ent.isFile() && ent.name.endsWith('.md')) {
      if (ent.name === '00-overview.md') continue;
      yield p;
    }
  }
}

function pickSuggestionHint(detail: string): string {
  const did = /did you mean:\s*([^?]+)\?/i.exec(detail);
  return did ? did[1]!.trim().slice(0, 120) : detail.slice(0, 120);
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const workspaceRoot = path.resolve(process.argv[3] ?? path.join(cwd, '..'));
  const plansDir = path.resolve(process.argv[2] ?? path.join(workspaceRoot, '.squad/plans'));
  const reportDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  const rows: { rel: string; count: number; sampleDetail?: string }[] = [];
  const detailSections: string[] = [];
  let total = 0;
  for (const file of walkMarkdownFiles(plansDir)) {
    const text = fs.readFileSync(file, 'utf8');
    const issues = validatePlan({ root: workspaceRoot, planText: text });
    const rel = path.relative(workspaceRoot, file);
    rows.push({
      rel,
      count: issues.length,
      sampleDetail: issues[0]?.detail ? pickSuggestionHint(issues[0].detail) : undefined,
    });
    total += issues.length;

    if (issues.length > 0) {
      detailSections.push(`### \`${rel}\` (${issues.length} issue(s))`, '');
      for (const iss of issues.slice(0, 40)) {
        detailSections.push(`- **[${iss.kind}]** ${iss.path ?? ''} — ${iss.detail}`);
      }
      if (issues.length > 40) detailSections.push(`- _(+${issues.length - 40} more)_`);
      detailSections.push('', '');
    }
  }

  rows.sort((a, b) => b.rel.localeCompare(a.rel));

  const md = [
    '# Offline plan validation',
    '',
    `- Plans directory: \`${plansDir}\``,
    `- Workspace root: \`${workspaceRoot}\``,
    `- Files scanned: ${rows.length}`,
    `- Total issues: ${total}`,
    '',
    '| Plan | Issues | Sample detail |',
    '|------|--------|---------------|',
    ...rows.map((r) => `| \`${r.rel}\` | ${r.count} | ${(r.sampleDetail ?? '').replace(/[\\|]/g, '\\$&')} |`),
    '',
    '## Issue details',
    '',
    ...detailSections,
  ].join('\n');

  const jsonPath = path.join(reportDir, `${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ plansDir, workspaceRoot, rows, total }, null, 2) + '\n', 'utf8');
  const mdPath = path.join(reportDir, `${ts}.md`);
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(md);
  console.error(`\nWrote ${jsonPath}\nWrote ${mdPath}`);

  const over20 = rows.filter((r) => r.count > 20);
  if (over20.length && process.env.SQUAD_EVAL_STRICT === '1') {
    console.error('\nStrict mode: plans with >20 issues:', over20.map((r) => r.rel).join(', '));
    process.exitCode = 1;
  } else if (over20.length) {
    console.error(
      `\nNote: ${over20.length} plan(s) have >20 validation issues (heuristic). Set SQUAD_EVAL_STRICT=1 to fail the script.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

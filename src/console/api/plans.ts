import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import { diffLines, type Change } from 'diff';
import { listPlanFeatureNames, readPlanMetadata } from '../../core/stories.js';
import type { SquadPaths } from '../../core/paths.js';
import { slugify } from '../../core/paths.js';
import { isInside } from '../../utils/path-safety.js';
import { trashOrDelete } from '../../commands/rm/shared.js';
import { removeOverviewRowForPlanFile } from '../../commands/rm/shared.js';

const DiffQuery = z.object({
  feature: z.string().min(1).max(80),
  a: z.string().min(1).max(200),
  b: z.string().min(1).max(200),
});

function safeFeatureParam(feature: string): boolean {
  return feature.length > 0 && !feature.includes('/') && !feature.includes('..') && slugify(feature) === feature;
}

export function mountPlansApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/plans', (c) => {
    const out: { feature: string; planFile: string; metadata: ReturnType<typeof readPlanMetadata> }[] = [];
    for (const feature of listPlanFeatureNames(opts.paths)) {
      const featureDir = path.join(opts.paths.plansDir, feature);
      if (!fs.existsSync(featureDir)) continue;
      for (const entry of fs.readdirSync(featureDir)) {
        if (!entry.endsWith('.md') || entry === '00-index.md') continue;
        const abs = path.join(featureDir, entry);
        out.push({ feature, planFile: entry, metadata: readPlanMetadata(abs) });
      }
    }
    return c.json(out);
  });

  app.get('/api/plans/:feature/:planFile', (c) => {
    const { feature, planFile } = c.req.param();
    if (!safeFeatureParam(feature)) return c.json({ error: 'forbidden' }, 403);
    const abs = path.resolve(path.join(opts.paths.plansDir, feature, planFile));
    if (!isInside(abs, opts.paths.plansDir)) return c.json({ error: 'forbidden' }, 403);
    if (!fs.existsSync(abs)) return c.json({ error: 'not_found' }, 404);
    const content = fs.readFileSync(abs, 'utf8');
    return c.json({
      feature,
      planFile,
      content,
      absPath: abs,
      metadata: readPlanMetadata(abs),
    });
  });

  app.get('/api/plans/diff', (c) => {
    const parse = DiffQuery.safeParse({
      feature: c.req.query('feature'),
      a: c.req.query('a'),
      b: c.req.query('b'),
    });
    if (!parse.success) return c.json({ error: 'invalid_query', issues: parse.error.issues }, 400);
    const { feature, a, b } = parse.data;
    if (!safeFeatureParam(feature)) return c.json({ error: 'forbidden' }, 403);
    const featureDir = path.join(opts.paths.plansDir, feature);
    const aAbs = path.join(featureDir, a);
    const bAbs = path.join(featureDir, b);
    if (!isInside(aAbs, opts.paths.plansDir) || !isInside(bAbs, opts.paths.plansDir)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!fs.existsSync(aAbs) || !fs.existsSync(bAbs)) return c.json({ error: 'not_found' }, 404);
    const aText = fs.readFileSync(aAbs, 'utf8');
    const bText = fs.readFileSync(bAbs, 'utf8');
    const changes: Change[] = diffLines(aText, bText);
    return c.json({ feature, a, b, changes });
  });

  app.delete('/api/plans/:feature/:planFile', (c) => {
    const trash = c.req.query('trash') === '1';
    const { feature, planFile } = c.req.param();
    if (!safeFeatureParam(feature)) return c.json({ error: 'forbidden' }, 403);
    const abs = path.join(opts.paths.plansDir, feature, planFile);
    if (!isInside(abs, opts.paths.plansDir)) return c.json({ error: 'forbidden' }, 403);
    if (!fs.existsSync(abs)) return c.json({ error: 'not_found' }, 404);
    if (trash) {
      const result = trashOrDelete([abs], opts.paths.trashDir, true);
      removeOverviewRowForPlanFile(path.join(opts.paths.plansDir, feature), planFile);
      return c.json({ ok: true, trashed: result.trashed });
    }
    fs.rmSync(abs);
    removeOverviewRowForPlanFile(path.join(opts.paths.plansDir, feature), planFile);
    return c.json({ ok: true });
  });
}

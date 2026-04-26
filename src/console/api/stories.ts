import fs from 'node:fs';
import type { Hono } from 'hono';
import { z } from 'zod';
import { createStoryRecord, deleteStoryRecord } from '../../core/story-mutations.js';
import { loadConfig } from '../../core/config.js';
import { listStories } from '../../core/stories.js';
import { slugify } from '../../core/paths.js';
import type { SquadPaths } from '../../core/paths.js';
import { isInside } from '../../utils/path-safety.js';

const CreateBody = z.object({
  feature: z.string().min(1).max(80),
  title: z.string().max(200).optional(),
  trackerId: z.string().max(80).optional(),
});
const PatchBody = z.object({
  intakeContent: z.string().min(1).max(1_000_000),
});

function safeFeatureParam(feature: string): boolean {
  return feature.length > 0 && !feature.includes('/') && !feature.includes('..') && slugify(feature) === feature;
}

export function mountStoriesApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/stories', (c) => {
    const feature = c.req.query('feature') ?? undefined;
    const stories = listStories(opts.paths, { feature });
    return c.json(
      stories.map((s) => ({
        feature: s.feature,
        id: s.id,
        intakePath: s.intakePath,
        storyDir: s.storyDir,
        planFile: s.planFile ?? null,
        titleHint: s.titleHint ?? null,
      })),
    );
  });

  app.get('/api/stories/:feature/:id', (c) => {
    const { feature, id } = c.req.param();
    if (!safeFeatureParam(feature)) return c.json({ error: 'forbidden' }, 403);
    const stories = listStories(opts.paths, { feature });
    const hit = stories.find((s) => s.id === id);
    if (!hit) return c.json({ error: 'not_found' }, 404);
    if (!isInside(hit.intakePath, opts.paths.storiesDir)) return c.json({ error: 'forbidden' }, 403);
    let intakeContent = '';
    try {
      intakeContent = fs.readFileSync(hit.intakePath, 'utf8');
    } catch {
      // surfaced as empty content; UI handles
    }
    return c.json({
      feature: hit.feature,
      id: hit.id,
      intakePath: hit.intakePath,
      storyDir: hit.storyDir,
      planFile: hit.planFile ?? null,
      titleHint: hit.titleHint ?? null,
      intakeContent,
    });
  });

  app.post('/api/stories', async (c) => {
    const body = CreateBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'invalid_body', issues: body.error.issues }, 400);
    const cfg = loadConfig(opts.paths.configFile);
    let created;
    try {
      created = createStoryRecord({
        paths: opts.paths,
        config: cfg,
        feature: body.data.feature,
        title: body.data.title,
        trackerId: body.data.trackerId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists|Intake already exists/.test(msg)) {
        return c.json({ error: 'conflict', message: msg }, 409);
      }
      return c.json({ error: 'invalid_request', message: msg }, 400);
    }
    return c.json(created, 201);
  });

  app.patch('/api/stories/:feature/:id', async (c) => {
    const body = PatchBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'invalid_body', issues: body.error.issues }, 400);
    const { feature, id } = c.req.param();
    if (!safeFeatureParam(feature)) return c.json({ error: 'forbidden' }, 403);
    const stories = listStories(opts.paths, { feature });
    const hit = stories.find((s) => s.id === id);
    if (!hit) return c.json({ error: 'not_found' }, 404);
    if (!isInside(hit.intakePath, opts.paths.storiesDir)) return c.json({ error: 'forbidden' }, 403);
    fs.writeFileSync(hit.intakePath, body.data.intakeContent, 'utf8');
    return c.json({ ok: true });
  });

  app.delete('/api/stories/:feature/:id', (c) => {
    const trash = c.req.query('trash') === '1';
    const { feature, id } = c.req.param();
    if (!safeFeatureParam(feature)) return c.json({ error: 'forbidden' }, 403);
    const stories = listStories(opts.paths, { feature });
    const hit = stories.find((s) => s.id === id);
    if (!hit) return c.json({ error: 'not_found' }, 404);
    if (!isInside(hit.storyDir, opts.paths.storiesDir)) return c.json({ error: 'forbidden' }, 403);
    const result = deleteStoryRecord({ paths: opts.paths, story: hit, trash });
    return c.json(result);
  });
}

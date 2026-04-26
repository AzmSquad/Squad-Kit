import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { listStories } from '../../core/stories.js';
import { readFile } from '../../utils/fs.js';
import { buildCopyPlanPromptMarkdown } from '../../core/copy-plan-prompt.js';

export function mountCopyPlanPromptApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/copy-plan-prompt', (c) => {
    const feature = (c.req.query('feature') ?? '').trim();
    const storyId = (c.req.query('storyId') ?? '').trim();
    if (!feature || !storyId) {
      return c.json({ error: 'bad_request', detail: 'Query params `feature` and `storyId` are required.' }, 400);
    }
    const stories = listStories(opts.paths, { feature });
    const hit = stories.find((s) => s.feature === feature && s.id === storyId);
    if (!hit) {
      return c.json({ error: 'not_found', detail: `No story intake for feature "${feature}" and id "${storyId}".` }, 404);
    }
    const config = loadConfig(opts.paths.configFile);
    const intakeContent = readFile(hit.intakePath);
    const prompt = buildCopyPlanPromptMarkdown(config, intakeContent);
    const bytes = Buffer.byteLength(prompt, 'utf8');
    return c.json({
      prompt,
      feature: hit.feature,
      storyId: hit.id,
      bytes,
      estTokensApprox: Math.round(bytes / 4),
    });
  });
}

import { streamSSE } from 'hono/streaming';
import type { Hono } from 'hono';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import type { SquadPaths } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { providerFor } from '../../planner/providers/index.js';
import { Budget } from '../../planner/budget.js';
import { runPlanner } from '../../planner/loop.js';
import { PlannerEventBus, type PlannerEvent } from '../../planner/events.js';
import { listStories } from '../../core/stories.js';
import { modelFor, readProviderKeyForPaths, providerEnvVar } from '../../core/planner-models.js';
import { buildRepoMap } from '../../core/repo-map.js';
import { composeSystemPrompt, composeUserPrompt } from '../../planner/system-prompt.js';
import { writePlanFile, buildMetadataHeader } from '../../planner/writer.js';
import { writeLastRun } from '../../core/last-run.js';
import { appendRun, listRuns, newRunId } from '../../core/runs.js';
import type { PlannerRunStats } from '../../planner/types.js';

interface ActiveRun {
  runId: string;
  bus: PlannerEventBus;
  controller: AbortController;
  feature: string;
  storyId: string;
  startedAt: number;
  done: Promise<void>;
  eventBuffer: PlannerEvent[];
}

const active = new Map<string, ActiveRun>();

const EVENT_BUF_CAP = 512;

const StartBody = z.object({
  feature: z.string().min(1),
  storyId: z.string().min(1),
});

function emptyStats(durationMs: number): PlannerRunStats {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheHitRatio: 0,
    durationMs,
  };
}

export function mountRunsApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/runs', async (c) => c.json(await listRuns(opts.paths)));

  app.get('/api/runs/active', (c) => {
    const rows = [...active.values()].map((r) => ({
      runId: r.runId,
      feature: r.feature,
      storyId: r.storyId,
      startedAt: r.startedAt,
    }));
    return c.json(rows);
  });

  app.post('/api/runs', async (c) => {
    const body = StartBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'invalid_body', issues: body.error.issues }, 400);

    const cfg = loadConfig(opts.paths.configFile);
    if (!cfg.planner?.enabled) {
      return c.json({ error: 'planner_disabled', detail: 'Run `squad config set planner` first.' }, 400);
    }
    const apiKey = readProviderKeyForPaths(opts.paths, cfg.planner.provider);
    if (!apiKey) {
      return c.json(
        {
          error: 'missing_credentials',
          detail: `Set ${providerEnvVar(cfg.planner.provider)} or save a key via the Secrets tab.`,
        },
        400,
      );
    }
    const stories = listStories(opts.paths, { feature: body.data.feature });
    const story = stories.find((s) => s.id === body.data.storyId);
    if (!story) return c.json({ error: 'not_found' }, 404);

    const runId = newRunId();
    const eventBuffer: PlannerEvent[] = [];
    const bus = new PlannerEventBus();
    bus.subscribe((e) => {
      eventBuffer.push(e);
      if (eventBuffer.length > EVENT_BUF_CAP) eventBuffer.splice(0, eventBuffer.length - EVENT_BUF_CAP);
    });
    const controller = new AbortController();
    const startedAt = Date.now();

    const done = (async () => {
      const cfgFresh = loadConfig(opts.paths.configFile);
      const planner = cfgFresh.planner!;
      const provider = providerFor(planner.provider);
      const model = modelFor(planner.provider, 'plan', planner.modelOverride);
      const budget = new Budget(planner.budget);
      const cacheEnabled = planner.cache?.enabled ?? true;
      const repoMap = buildRepoMap(opts.paths.root);
      const systemPrompt = composeSystemPrompt({
        projectRoots: cfgFresh.project.projectRoots ?? ['.'],
        primaryLanguage: cfgFresh.project.primaryLanguage ?? '',
        trackerType: cfgFresh.tracker.type,
        repoMap,
      });
      const userPrompt = composeUserPrompt({
        intakeContent: fs.readFileSync(story.intakePath, 'utf8'),
      });

      let result;
      try {
        result = await runPlanner({
          root: opts.paths.root,
          provider,
          model,
          apiKey,
          systemPrompt,
          userPrompt,
          budget,
          maxOutputTokens: planner.maxOutputTokens,
          cacheEnabled,
          events: bus,
          runId,
          abort: controller.signal,
        });
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        bus.emit({ kind: 'error', runId, message: (err as Error).message });
        bus.emit({
          kind: 'done',
          runId,
          success: false,
          planFile: null,
          partial: true,
          stats: emptyStats(durationMs),
          durationMs,
        });
        return;
      }

      const runSuccess = result.finishedNormally && !result.timedOut && !result.userCancelled;
      let planFile: string | null = null;
      if (result.planText.trim()) {
        const snap = budget.snapshot();
        const header = buildMetadataHeader({
          provider: planner.provider,
          model,
          reads: snap.reads,
          bytes: snap.bytes,
          inputTokens: snap.usage.inputTokens,
          outputTokens: snap.usage.outputTokens,
          durationMs: Date.now() - startedAt,
          costUsd: snap.usage.costUsd,
          planStatus: runSuccess ? undefined : 'partial',
        });
        const out = writePlanFile({
          paths: opts.paths,
          config: cfgFresh,
          story,
          planBodyMarkdown: result.planText,
          metadataHeader: header,
          partial: !runSuccess,
        });
        planFile = path.relative(opts.paths.root, out.planFile);
      }

      try {
        await writeLastRun(opts.paths, {
          stats: result.stats,
          completedAt: new Date().toISOString(),
          provider: planner.provider,
          model,
        });
        await appendRun(opts.paths, {
          runId,
          provider: planner.provider,
          model,
          feature: story.feature,
          storyId: story.id,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          success: runSuccess,
          partial: !runSuccess,
          planFile,
          stats: result.stats,
          cacheEnabled,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        /* best-effort */
      }

      bus.emit({
        kind: 'done',
        runId,
        success: runSuccess,
        planFile,
        partial: !runSuccess,
        stats: result.stats,
        durationMs: Date.now() - startedAt,
      });
    })().finally(() => {
      active.delete(runId);
    });

    active.set(runId, { runId, bus, controller, feature: story.feature, storyId: story.id, startedAt, done, eventBuffer });
    return c.json({ runId, eventStream: `/api/runs/${runId}/stream` }, 202);
  });

  app.get('/api/runs/:runId/stream', (c) => {
    const runId = c.req.param('runId');
    const run = active.get(runId);
    return streamSSE(c, async (stream) => {
      if (!run) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'unknown run' }) });
        await stream.writeSSE({ event: 'closed', data: '{}' });
        return;
      }
      let idx = 0;
      let resolveWaiter: (() => void) | null = null;
      const notify = () => resolveWaiter?.();
      const unsubscribe = run.bus.subscribe(() => notify());
      const ka = setInterval(() => stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {}), 15_000);
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        clearInterval(ka);
      });

      try {
        while (!closed) {
          while (idx < run.eventBuffer.length) {
            const e = run.eventBuffer[idx++]!;
            await stream.writeSSE({ event: e.kind, data: JSON.stringify(e) });
            if (e.kind === 'done') {
              await stream.writeSSE({ event: 'closed', data: JSON.stringify({ ok: true }) });
              clearInterval(ka);
              unsubscribe();
              return;
            }
          }
          await new Promise<void>((resolve) => {
            resolveWaiter = resolve;
          });
          resolveWaiter = null;
        }
      } finally {
        clearInterval(ka);
        unsubscribe();
      }
    });
  });

  app.delete('/api/runs/:runId', (c) => {
    const runId = c.req.param('runId');
    const run = active.get(runId);
    if (!run) return c.json({ error: 'not_found' }, 404);
    run.controller.abort();
    return c.json({ ok: true });
  });
}

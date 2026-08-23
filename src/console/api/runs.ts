import { streamSSE } from 'hono/streaming';
import type { Hono } from 'hono';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import type { SquadPaths } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { resolveRuntime, extractAnthropicProviderSpecific } from '../../planner/runtimes/index.js';
import { Budget } from '../../planner/budget.js';
import { runPlanner } from '../../planner/loop.js';
import { PlannerEventBus, type PlannerEvent } from '../../planner/events.js';
import { listStories } from '../../core/stories.js';
import { modelFor, resolvePlannerAuthForPaths } from '../../core/planner-models.js';
import { PlannerAuthUnavailableError, type ResolvedPlannerAuth } from '../../core/planner-auth.js';
import { buildRepoMap } from '../../core/repo-map.js';
import { buildPlansIndex } from '../../core/plans-index.js';
import { summariseIssuesByKind } from '../../planner/validation.js';
import { composeSystemPrompt, composeUserPrompt, composeScoutSystemPrompt } from '../../planner/system-prompt.js';
import { writePlanFile, buildMetadataHeader } from '../../planner/writer.js';
import { writeLastRun } from '../../core/last-run.js';
import { appendRun, listRuns, newRunId } from '../../core/runs.js';
import { openRunEventsReader } from '../../core/run-events-store.js';
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

const EVENT_BUF_CAP = 4096;

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
    // Resolved once, before the run body: scout and draft build their runtimes from this same
    // instance so a rotating token can never make the two stages disagree.
    let auth: ResolvedPlannerAuth;
    try {
      auth = resolvePlannerAuthForPaths(opts.paths, cfg.planner.provider, cfg.planner);
    } catch (err) {
      if (err instanceof PlannerAuthUnavailableError) {
        return c.json(
          {
            error: 'auth_unavailable',
            mode: cfg.planner.auth?.anthropic ?? 'auto',
            detail: err.message,
          },
          400,
        );
      }
      throw err;
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
      const modelId = modelFor(planner.provider, 'plan', planner.modelOverride);
      const anthropicRuntimeChoice = planner.runtime?.anthropic ?? 'agent-sdk';
      const draftRuntime = resolveRuntime({
        provider: planner.provider,
        modelId,
        auth,
        anthropicRuntime: planner.provider === 'anthropic' ? anthropicRuntimeChoice : undefined,
      });
      const anthropicProviderSpecific =
        planner.provider === 'anthropic'
          ? {
              draft: extractAnthropicProviderSpecific(planner, 'draft'),
              scout: extractAnthropicProviderSpecific(planner, 'scout'),
            }
          : undefined;
      const budget = new Budget(planner.budget);
      const cacheEnabled = planner.cache?.enabled ?? true;
      const scoutEnabled = planner.stages?.scout?.enabled !== false;
      const validationEnabled = planner.validation?.enabled !== false;
      const strictValidation = planner.validation?.strict === true;
      const maxScoutFiles = planner.stages?.scout?.maxFiles ?? 12;

      let scoutModelId = '';
      let scoutRuntime: ReturnType<typeof resolveRuntime> | undefined;
      let scoutSystemPrompt: string | undefined;
      if (scoutEnabled) {
        scoutModelId = modelFor(
          planner.provider,
          'scout',
          planner.modelOverride,
          planner.stages?.scout?.modelOverride,
        );
        scoutRuntime = resolveRuntime({
          provider: planner.provider,
          modelId: scoutModelId,
          auth,
          anthropicRuntime: planner.provider === 'anthropic' ? anthropicRuntimeChoice : undefined,
        });
      }

      const repoMap = buildRepoMap(opts.paths.root, { format: 'tree' });
      if (scoutEnabled) {
        scoutSystemPrompt = composeScoutSystemPrompt({
          projectRoots: cfgFresh.project.projectRoots ?? ['.'],
          primaryLanguage: cfgFresh.project.primaryLanguage ?? '',
          trackerType: cfgFresh.tracker.type,
          repoMap,
          plansIndex: buildPlansIndex(opts.paths),
        });
      }

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
        try {
          result = await runPlanner({
            root: opts.paths.root,
            runtime: draftRuntime,
            provider: planner.provider,
            modelId,
            auth,
            anthropicProviderSpecific,
            systemPrompt,
            userPrompt,
            budget,
            maxOutputTokens: planner.maxOutputTokens,
            cacheEnabled,
            events: bus,
            runId,
            paths: opts.paths,
            abort: controller.signal,
            stages: {
              scout: {
                enabled: scoutEnabled,
                runtime: scoutRuntime,
                modelId: scoutModelId,
                maxFiles: maxScoutFiles,
                maxOutputTokens: planner.stages?.scout?.maxOutputTokens ?? 2048,
              },
            },
            validation: { enabled: validationEnabled, strict: strictValidation },
            toolsEnabled: planner.tools,
            scoutSystemPrompt,
          });
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          const last = eventBuffer[eventBuffer.length - 1];
          const isRateLimitAbort = last?.kind === 'rate_limit' && last.phase === 'aborted';
          if (!isRateLimitAbort) {
            bus.emit({ kind: 'error', runId, message: (err as Error).message });
          }
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

        const issueCount = result.validation?.issues.length ?? 0;
        const issuesByKind = summariseIssuesByKind(result.validation?.issues ?? []);
        const validationBlocks = strictValidation && validationEnabled && issueCount > 0;
        const runSuccess =
          result.finishedNormally && !result.timedOut && !result.userCancelled && !validationBlocks;
        let planFile: string | null = null;
        if (result.planText.trim()) {
          const snap = budget.snapshot();
          const header = buildMetadataHeader({
            provider: planner.provider,
            model: modelId,
            reads: snap.reads,
            bytes: snap.bytes,
            inputTokens: snap.usage.inputTokens,
            outputTokens: snap.usage.outputTokens,
            durationMs: Date.now() - startedAt,
            planStatus: runSuccess ? undefined : 'partial',
            scoutEnabled,
            validationEnabled,
            validationIssueCount: issueCount,
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
            model: modelId,
          });
          await appendRun(opts.paths, {
            runId,
            provider: planner.provider,
            model: modelId,
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
            scout: {
              enabled: scoutEnabled,
              selectedCount: result.scout?.selected.length,
              tokensUsed: result.scout?.tokensUsed,
              durationMs: result.scout?.durationMs,
            },
            validation: {
              enabled: validationEnabled,
              issuesCount: issueCount,
              issuesByKind,
              durationMs: result.validation?.durationMs,
            },
            plannerRuntime: { kind: draftRuntime.kind, provider: planner.provider },
            providerOptionsSnapshot: anthropicProviderSpecific
              ? { anthropic: anthropicProviderSpecific }
              : undefined,
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
      } finally {
        await bus.finalizeEventPersistence?.();
      }
    })().finally(() => {
      active.delete(runId);
    });

    active.set(runId, { runId, bus, controller, feature: story.feature, storyId: story.id, startedAt, done, eventBuffer });
    return c.json({ runId, eventStream: `/api/runs/${runId}/stream` }, 202);
  });

  app.get('/api/runs/:runId/events', async (c) => {
    const runId = c.req.param('runId');
    const fromQ = Number(c.req.query('from') ?? 0);
    const fromIndex = Number.isFinite(fromQ) ? Math.max(0, Math.floor(fromQ)) : 0;
    const limQ = Number(c.req.query('limit') ?? 1000);
    const limit = Math.min(
      2000,
      Math.max(1, Number.isFinite(limQ) ? Math.floor(limQ) : 1000),
    );
    const reader = await openRunEventsReader(opts.paths, runId);
    if (!reader) return c.json({ error: 'not_found' }, 404);
    const events: PlannerEvent[] = [];
    for await (const e of reader.iterate({ fromIndex, limit })) events.push(e);
    const total = await reader.count();
    return c.json({ runId, fromIndex, limit, total, events });
  });

  app.get('/api/runs/:runId', async (c) => {
    const runId = c.req.param('runId');
    const all = await listRuns(opts.paths);
    const rec = all.find((r) => r.runId === runId);
    if (!rec) return c.json({ error: 'not_found' }, 404);
    return c.json(rec);
  });

  app.get('/api/runs/:runId/stream', (c) => {
    const runId = c.req.param('runId');
    const run = active.get(runId);
    if (!run) {
      return streamSSE(c, async (stream) => {
        const reader = await openRunEventsReader(opts.paths, runId);
        if (!reader) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'unknown run' }) });
          await stream.writeSSE({ event: 'closed', data: '{}' });
          return;
        }
        try {
          for await (const e of reader.iterate()) {
            await stream.writeSSE({ event: e.kind, data: JSON.stringify(e) });
          }
          await stream.writeSSE({ event: 'closed', data: '{}' });
        } catch {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'replay_failed' }) });
          await stream.writeSSE({ event: 'closed', data: '{}' });
        }
      });
    }
    return streamSSE(c, async (stream) => {
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

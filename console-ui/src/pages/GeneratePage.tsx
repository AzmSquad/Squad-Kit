import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { ActivityFeed } from '~/components/generate/ActivityFeed';
import { BudgetMeters } from '~/components/generate/BudgetMeters';
import { LiveTabs } from '~/components/generate/LiveTabs';
import { MetricsBar } from '~/components/generate/MetricsBar';
import { RateLimitRing } from '~/components/generate/RateLimitRing';
import { RecentRunsDrawer } from '~/components/generate/RecentRunsDrawer';
import { RunIdentityCard } from '~/components/generate/RunIdentityCard';
import { StagePipeline } from '~/components/generate/StagePipeline';
import { api, UnauthorizedError } from '~/api/client';
import type { ApiConfig, ApiStory } from '~/api/types';
import type { ApiCopyPlanPrompt } from '~/api/types';
import { Badge } from '~/components/Badge';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { CommandBlock } from '~/components/CommandBlock';
import { Page } from '~/components/Page';
import { Select } from '~/components/Select';
import { Spinner } from '~/components/Spinner';
import { useToast } from '~/components/Toast';
import { useGenerateRun } from '~/hooks/useGenerateRun';
import type { StageKey } from '~/hooks/useGenerateRun';
import { usePlannerAuth } from '~/hooks/usePlannerAuth';
import type { ApiResolvedAuthMode } from '~/api/types';
import { groupByFeature } from '~/lib/group-by-feature';

function StoryAndModePicker({
  run,
  unplanned,
  featureNames,
  plannerEnabled,
}: {
  run: ReturnType<typeof useGenerateRun>;
  unplanned: ApiStory[];
  featureNames: string[];
  plannerEnabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className="flex min-w-[140px] flex-col gap-1 text-xs text-[var(--color-text-muted)]">
        Feature
        <Select
          value={run.state.feature}
          disabled={featureNames.length === 0}
          onChange={(e) => {
            const f = e.target.value;
            const first = unplanned.find((s) => s.feature === f);
            run.setStory(f, first?.id ?? '');
          }}
        >
          <option value="">—</option>
          {featureNames.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex min-w-[180px] flex-col gap-1 text-xs text-[var(--color-text-muted)]">
        Story
        <Select
          value={run.state.storyId}
          disabled={!run.state.feature}
          onChange={(e) => run.setStory(run.state.feature, e.target.value)}
        >
          <option value="">—</option>
          {unplanned
            .filter((s) => s.feature === run.state.feature)
            .map((s) => (
              <option key={`${s.feature}/${s.id}`} value={s.id}>
                {s.id}
                {s.titleHint ? ` — ${s.titleHint}` : ''}
              </option>
            ))}
        </Select>
      </label>
      <fieldset className="flex gap-4 text-sm text-[var(--color-text)]">
        <legend className="sr-only">Mode</legend>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="mode"
            checked={run.state.mode === 'api'}
            disabled={!plannerEnabled}
            onChange={() => run.setMode('api')}
          />
          API
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" name="mode" checked={run.state.mode === 'copy'} onChange={() => run.setMode('copy')} />
          Copy
        </label>
      </fieldset>
      <Button
        type="button"
        disabled={
          !run.state.feature ||
          !run.state.storyId ||
          run.state.mode !== 'api' ||
          !plannerEnabled ||
          run.state.phase === 'streaming' ||
          run.state.phase === 'starting' ||
          run.state.phase === 'cancelling'
        }
        onClick={() => void run.start()}
      >
        Run
      </Button>
    </div>
  );
}

function CopyModeBlock({
  feature,
  storyId,
  q,
}: {
  feature: string;
  storyId: string;
  q: UseQueryResult<ApiCopyPlanPrompt, Error>;
}) {
  const { toast } = useToast();

  if (!feature || !storyId) {
    return (
      <Callout tone="info" title="Choose a story first">
        Pick a feature and story above before loading the meta-prompt.
      </Callout>
    );
  }

  if (q.isLoading)
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Spinner />
        Building prompt…
      </div>
    );

  if (q.isError)
    return (
      <Callout tone="danger" title="Could not load prompt">
        {q.error instanceof Error ? q.error.message : String(q.error)}
      </Callout>
    );

  const d = q.data!;
  return (
    <div className="mt-6 space-y-4">
      <Callout tone="info" title="Copy-paste planning (no API spend here)">
        <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-sm text-[var(--color-text-muted)]">
          <li>
            Click <strong className="text-[var(--color-text)]">Copy full prompt</strong> (or select the textarea).
          </li>
          <li>Open your agent and paste.</li>
        </ol>
      </Callout>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-text-muted)]">
          ~{d.estTokensApprox.toLocaleString()} tokens (est) · {(d.bytes / 1024).toFixed(1)} KB
        </p>
        <Button
          type="button"
          variant="secondary"
          leftIcon={<Copy size={14} aria-hidden />}
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(d.prompt);
                toast({ tone: 'success', title: 'Full prompt copied' });
              } catch {
                toast({
                  tone: 'warning',
                  title: 'Clipboard blocked',
                  description: 'Select the text manually.',
                });
              }
            })();
          }}
        >
          Copy full prompt
        </Button>
      </div>
      <div>
        <label className="text-xs font-medium text-[var(--color-text-muted)]" htmlFor="copy-prompt-preview">
          Prompt preview
        </label>
        <textarea
          id="copy-prompt-preview"
          readOnly
          spellCheck={false}
          rows={14}
          className="mt-1 w-full max-h-64 min-h-[12rem] resize-y rounded-lg border border-[var(--color-border)] bg-[var(--gray-2)] p-3 font-mono text-[11px]"
          value={d.prompt}
        />
      </div>
    </div>
  );
}

function PlanSavedCallout({
  tone,
  title,
  feature,
  planFile,
}: {
  tone: 'success' | 'warning';
  title: string;
  feature: string;
  planFile: string;
}) {
  return (
    <Callout
      tone={tone === 'success' ? 'success' : 'warning'}
      title={title}
      action={
        <Link
          to="/plans/$feature/$planFile"
          params={{ feature, planFile }}
          className="text-[13px] font-medium text-[var(--color-accent)] hover:underline"
        >
          Open
        </Link>
      }
    >
      <span className="font-mono">{planFile}</span>
    </Callout>
  );
}

function AuthBadge({
  mode,
  credentialHint,
  apiKeySource,
}: {
  mode: ApiResolvedAuthMode | null;
  credentialHint?: string;
  apiKeySource?: string;
}) {
  if (!mode) return null;
  const tooltip = [credentialHint, apiKeySource ? `apiKeySource: ${apiKeySource}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <Badge
      tone={mode === 'subscription' ? 'info' : 'muted'}
      title={tooltip || undefined}
      data-testid="generate-auth-badge"
    >
      {mode === 'subscription' ? 'Subscription' : 'API key'}
    </Badge>
  );
}

/**
 * The cost sentence has to branch: a subscription run has no per-token invoice at all, and telling
 * a Pro/Max user their planning is "billed per token" is simply false. It is never called free
 * either — Agent SDK usage draws on the same window as Claude and Claude Code.
 */
function BillingCallout({ mode }: { mode: ApiResolvedAuthMode | null }) {
  if (mode === 'subscription') {
    return (
      <Callout tone="info" title="Runs on your Claude subscription">
        API runs here draw on your Claude usage limits — there is no per-token API bill. Agent SDK usage counts against
        the same limits as Claude and Claude Code, so a long planning run consumes part of your window. Hitting the
        limit means waiting for the reset, not a larger invoice.
      </Callout>
    );
  }
  return (
    <Callout tone="info" title="Provider keys">
      <p>
        API runs need a provider key in{' '}
        <Link to={'/secrets' as never} className="text-[var(--color-accent)] underline">
          Secrets
        </Link>{' '}
        or <code className="text-xs">ANTHROPIC_API_KEY</code>, etc.
      </p>
      <p className="mt-1">
        Each model round is billed like any other API usage (input tokens, output tokens, and cache-related tokens when
        applicable).
      </p>
    </Callout>
  );
}

export function GeneratePage() {
  const run = useGenerateRun();
  const st = run.state;

  const { feature: urlFeature, storyId: urlStoryId } = useSearch({ from: '/generate' });
  const urlKey = urlFeature && urlStoryId ? `${urlFeature}:${urlStoryId}` : '';
  const lastAppliedUrlKeyRef = useRef<string | null>(null);

  const storiesQ = useQuery({
    queryKey: ['stories'],
    queryFn: () => api<ApiStory[]>('/api/stories'),
  });
  const configQ = useQuery({
    queryKey: ['config'],
    queryFn: () => api<ApiConfig>('/api/config'),
  });

  const plannerAuthQ = usePlannerAuth();
  const plannerEnabled = Boolean(configQ.data?.planner?.enabled);

  // Prefer the run's own `auth_info`: a Config change mid-run must not retro-change the badge on a
  // run that already picked its credential. The config answer is only the pre-run fallback.
  const authMode: ApiResolvedAuthMode | null = st.auth?.mode ?? plannerAuthQ.data?.resolved?.mode ?? null;
  const authHint = st.auth?.credentialHint ?? plannerAuthQ.data?.resolved?.credentialHint;
  const authKeySource = st.auth?.apiKeySource ?? plannerAuthQ.data?.apiKeySource ?? undefined;
  const loginCommand = plannerAuthQ.data?.loginCommand ?? 'squad auth login';

  const copyPromptQ = useQuery({
    queryKey: ['copy-plan-prompt', st.feature, st.storyId],
    queryFn: () =>
      api<ApiCopyPlanPrompt>(
        `/api/copy-plan-prompt?feature=${encodeURIComponent(st.feature)}&storyId=${encodeURIComponent(st.storyId)}`,
      ),
    enabled: st.mode === 'copy' && Boolean(st.feature && st.storyId),
  });

  const unplanned = useMemo(() => (storiesQ.data ?? []).filter((s) => !s.planFile), [storiesQ.data]);
  const featureNames = useMemo(() => groupByFeature(unplanned).map((g) => g.feature), [unplanned]);

  useEffect(() => {
    if (!unplanned.length) return;

    if (urlKey && urlKey !== lastAppliedUrlKeyRef.current) {
      const target = unplanned.find((s) => s.feature === urlFeature && s.id === urlStoryId);
      if (target) {
        run.setStory(target.feature, target.id);
        lastAppliedUrlKeyRef.current = urlKey;
        return;
      }
      lastAppliedUrlKeyRef.current = urlKey;
    }

    if (st.feature) return;

    const last = [...unplanned].sort((a, b) => {
      const fa = `${a.feature}/${a.id}`;
      const fb = `${b.feature}/${b.id}`;
      return fb.localeCompare(fa);
    })[0];
    if (last) run.setStory(last.feature, last.id);
  }, [unplanned, st.feature, urlKey, urlFeature, urlStoryId, run]);

  const [, bumpElapsed] = useState(0);
  useEffect(() => {
    if (
      st.phase !== 'streaming' &&
      st.phase !== 'starting' &&
      st.phase !== 'cancelling' &&
      st.phase !== 'done' &&
      st.phase !== 'failed' &&
      st.phase !== 'cancelled'
    )
      return;
    const id = window.setInterval(() => bumpElapsed((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, [st.phase]);

  const elapsedSec =
    st.startedAtMs != null ? Math.floor((Date.now() - st.startedAtMs) / 1000) : 0;

  const [jumpStage, setJumpStage] = useState<StageKey | null>(null);
  const onJump = useCallback((s: StageKey) => {
    setJumpStage(s);
    window.setTimeout(() => setJumpStage(null), 300);
  }, []);

  const unauthorized =
    storiesQ.error instanceof UnauthorizedError ||
    configQ.error instanceof UnauthorizedError ||
    copyPromptQ.error instanceof UnauthorizedError;

  if (unauthorized) {
    return (
      <Page title="Generate plan" description="Run the planner against an intake; monitor every step live.">
        <Callout tone="warning" title="Session expired or missing token.">
          Reopen <kbd className="kbd">squad console</kbd> from your project.
        </Callout>
      </Page>
    );
  }

  const showApiRun =
    st.mode === 'api' &&
    (st.phase === 'streaming' ||
      st.phase === 'starting' ||
      st.phase === 'cancelling' ||
      st.phase === 'done' ||
      st.phase === 'failed' ||
      st.phase === 'cancelled');


  return (
    <Page title="Generate plan" description="Run the planner against an intake; monitor every step live.">
      <div className="lg:flex lg:items-start lg:gap-8">
        <div className="min-w-0 flex-1">
          {!plannerEnabled && (
            <Callout tone="warning" title="Planner API is not enabled in config.">
              Run <code className="text-xs">squad config set planner</code> or open the{' '}
              <Link to={'/config' as never} className="text-[var(--color-accent)] underline">
                Config
              </Link>{' '}
              tab.
            </Callout>
          )}

          {plannerEnabled && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <AuthBadge mode={authMode} credentialHint={authHint} apiKeySource={authKeySource} />
              </div>
              <BillingCallout mode={authMode} />
            </>
          )}

          <StoryAndModePicker
            run={run}
            unplanned={unplanned}
            featureNames={featureNames}
            plannerEnabled={plannerEnabled}
          />

          {st.mode === 'copy' ? (
            <CopyModeBlock feature={st.feature} storyId={st.storyId} q={copyPromptQ} />
          ) : (
            <>
              {showApiRun ? (
                <>
                  <MetricsBar state={st} elapsedSec={elapsedSec} onCancel={() => void run.cancel()} />

                  <RunIdentityCard
                    runtime={st.runtime}
                    auth={st.auth}
                    telemetryPartial={run.state.telemetryPartialUi}
                  />

                  {st.phase === 'cancelling' ? (
                    <Callout tone="info" title="Cancelling…">
                      Still receiving from provider. Anthropic Agent SDK may take a few seconds to close the upstream
                      HTTP.
                      {run.state.stopWatchingShown ? (
                        <div className="mt-2 flex gap-2">
                          <Button type="button" variant="secondary" onClick={() => run.disconnectStreamOnly()}>
                            Stop watching
                          </Button>
                        </div>
                      ) : null}
                    </Callout>
                  ) : null}

                  <StagePipeline stages={st.stages} onJump={onJump} />
                  <BudgetMeters budget={st.budget} startedAtMs={st.startedAtMs} />

                  {st.rateLimit ? (
                    <RateLimitRing
                      rateLimit={st.rateLimit}
                      subscription={authMode === 'subscription'}
                      onRerun={() => void run.start()}
                      onCancel={() => {
                        void run.cancel();
                        run.resetStreamingUiOnly();
                      }}
                      rerunDisabled={
                        st.phase === 'streaming' ||
                        st.phase === 'starting' ||
                        st.phase === 'cancelling' ||
                        !st.feature ||
                        !st.storyId
                      }
                    />
                  ) : null}

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <ActivityFeed rows={st.activities} jumpStage={jumpStage} />
                    <LiveTabs state={st} />
                  </div>
                </>
              ) : null}

              {st.phase === 'done' && st.planFile ? (
                <PlanSavedCallout tone="success" title="Plan saved" feature={st.feature} planFile={st.planFile} />
              ) : null}

              {st.phase === 'cancelled' && st.planFile ? (
                <PlanSavedCallout tone="warning" title="Saved partial plan" feature={st.feature} planFile={st.planFile} />
              ) : null}

              {st.errorCode === 'auth_unavailable' && st.phase === 'failed' ? (
                <Callout tone="danger" title="No Claude credential available">
                  <p>{st.error}</p>
                  <CommandBlock className="mt-2" command={loginCommand} />
                  <p className="mt-2">
                    <Link to={'/config' as never} className="text-[var(--color-accent)] underline">
                      Configure auth
                    </Link>{' '}
                    to switch between your Claude subscription and an API key.
                  </p>
                </Callout>
              ) : st.error && st.phase === 'failed' && !st.rateLimit ? (
                <Callout tone="danger" title="Run failed">
                  {st.error}
                </Callout>
              ) : null}
            </>
          )}
        </div>
        <RecentRunsDrawer />
      </div>
    </Page>
  );
}

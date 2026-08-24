import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { ActivityFeed } from '~/components/generate/ActivityFeed';
import { BudgetMeters } from '~/components/generate/BudgetMeters';
import { LiveTabs } from '~/components/generate/LiveTabs';
import { MetricsBar } from '~/components/generate/MetricsBar';
import { RunIdentityCard } from '~/components/generate/RunIdentityCard';
import { StagePipeline } from '~/components/generate/StagePipeline';
import type { ApiActiveRun, ApiRunEventsPage, ApiRunRecord, PlannerStreamEventWire } from '~/api/types';
import { api, UnauthorizedError } from '~/api/client';
import { Badge } from '~/components/Badge';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Page } from '~/components/Page';
import { Skeleton } from '~/components/Skeleton';
import { useToast } from '~/components/Toast';
import {
  applyGenerateEvent,
  INITIAL_GENERATE_RUN_STATE,
  resetGenerateFeedSeqForReplay,
  type GenerateRunState,
  type RuntimeInfo,
  type StageKey,
} from '~/hooks/useGenerateRun';

const TOK_CEIL_FLOOR = 8192;

function is404Err(e: unknown): boolean {
  return e instanceof Error && /\b404\b/.test(e.message);
}

function normalizeProvider(raw: string): RuntimeInfo['provider'] {
  const p = raw.toLowerCase();
  return p === 'openai' || p === 'google' || p === 'anthropic' ? p : 'anthropic';
}

function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

function replaySeed(record: ApiRunRecord): GenerateRunState {
  const stats = record.stats;
  const input = stats?.inputTokens ?? 0;
  const output = stats?.outputTokens ?? 0;
  const sum = input + output;
  const ceil = Math.max(Math.ceil(sum * 1.15), TOK_CEIL_FLOOR);
  const caps = {
    maxFileReads: 500,
    maxContextBytes: 4_194_304,
    maxDurationSeconds: 3600,
  };

  const runtime: GenerateRunState['runtime'] =
    record.model ?
      {
        provider: normalizeProvider(record.provider),
        model: record.model,
        runtimeKind: record.plannerRuntime?.kind ?? 'agent-sdk',
        cacheEnabled: record.cacheEnabled ?? true,
        scoutEnabled: true,
        validationEnabled: true,
        budgetCaps: caps,
        providerOptions: record.providerOptionsSnapshot,
      }
    : null;

  const startedMs = Number.isFinite(Date.parse(record.startedAt)) ? Date.parse(record.startedAt) : Date.now();

  // Seeded from the summary so the Auth row survives a run whose events file rotated away; a
  // replayed `auth_info` overwrites it with the richer credentialHint / apiKeySource.
  const auth: GenerateRunState['auth'] = record.authMode ? { mode: record.authMode } : null;

  return {
    ...INITIAL_GENERATE_RUN_STATE,
    phase: 'streaming',
    runId: record.runId,
    feature: record.feature,
    storyId: record.storyId,
    mode: 'api',
    startedAtMs: startedMs,
    runtime,
    auth,
    budget: runtime ? { caps, fileReadsCompleted: 0, contextBytesApprox: 0 } : { caps: null, fileReadsCompleted: 0, contextBytesApprox: 0 },
    tokens: {
      input,
      output,
      sum,
      ceiling: ceil,
      perTurn: [],
    },
    cacheHitPct: stats?.cacheHitRatio != null ? Math.round(stats.cacheHitRatio * 100) : null,
    cacheHitPctPerTurn: [],
    planFile: record.planFile,
    turn: stats?.turns ?? 0,
    activities: [],
    tools: [],
    thinking: { blocks: [] },
    scout: { selected: null, reasoning: null },
    validation: [],
    assistantMd: '',
    error: null,
  };
}

function summaryOnlyState(record: ApiRunRecord): GenerateRunState {
  const seed = replaySeed(record);
  let phase: GenerateRunState['phase'] = 'done';
  if (!record.success && record.partial) phase = 'cancelled';
  else if (!record.success) phase = 'failed';
  return { ...seed, phase };
}

/** Events from JSONL omit some optional SSE fields (`isError`): normalize for the reducer. */
function coerceEvent(ev: PlannerStreamEventWire): PlannerStreamEventWire {
  if (ev.kind === 'tool_call_completed')
    return { ...ev, isError: ev.isError ?? false };
  return ev;
}

export function RunReportHeader({
  record,
  incompleteTimeline,
}: {
  record: ApiRunRecord;
  incompleteTimeline: boolean;
}) {
  const { toast } = useToast();

  async function copyId() {
    try {
      await navigator.clipboard.writeText(record.runId);
      toast({ tone: 'success', title: 'Run ID copied' });
    } catch {
      toast({
        tone: 'warning',
        title: 'Copy failed',
      });
    }
  }

  return (
    <div className="mb-6 flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="default" title="Truncated planner id">
            {shortRunId(record.runId)}
          </Badge>
          {incompleteTimeline ? (
            <Badge tone="warning">Run did not complete cleanly — last seen at {formatWhen(record.completedAt)}</Badge>
          ) : null}
          {!record.planFile ? <Badge tone="default">No plan file written</Badge> : null}
        </div>
        <div className="flex flex-wrap gap-3 text-[13px]">
          <span className="text-[var(--color-text-muted)]">
            {record.feature} / <span className="font-medium text-[var(--color-text)]">{record.storyId}</span>
          </span>
        </div>
      </div>
        <div className="flex flex-wrap items-center gap-2">
          {record.planFile ? (
            <Link
              to="/plans/$feature/$planFile"
              params={{ feature: record.feature, planFile: record.planFile }}
              className="btn-secondary inline-flex items-center rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium"
            >
              Open plan
            </Link>
          ) : null}
          <Link
            to="/stories/$feature/$id"
            params={{ feature: record.feature, id: record.storyId }}
            className="btn-secondary inline-flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium"
          >
            <ExternalLink size={14} aria-hidden />
            Open intake
          </Link>
          <Button
            type="button"
            variant="secondary"
            leftIcon={<Copy size={14} aria-hidden />}
            onClick={() => void copyId()}
          >
            Copy run ID
          </Button>
        </div>
    </div>
  );
}

export function RunReportFooter({ record }: { record: ApiRunRecord }) {
  const path = `.squad/runs/${record.runId}.events.jsonl`;
  return (
    <footer className="mt-8 border-t border-[var(--color-border)] pt-4 text-[12px] text-[var(--color-text-muted)]">
      <details className="rounded-lg border border-[var(--color-border)] bg-[var(--gray-2)] p-3">
        <summary className="cursor-pointer select-none font-medium text-[var(--color-text)]">Summary record (JSON)</summary>
        <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-[var(--gray-3)] p-3 font-mono text-[11px]" spellCheck={false}>
          {JSON.stringify(record, null, 2)}
        </pre>
      </details>
      <p className="mt-3">
        Timeline file on disk (may be gzipped after rotation): <code className="font-mono text-[var(--color-text)]">{path}</code>
      </p>
    </footer>
  );
}

export function RunReportPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { runId } = useParams({ from: '/runs/$runId' });
  const { tab: tabSearch } = useSearch({ from: '/runs/$runId' });

  const liveRedirectDone = useRef(false);
  const [jumpStage, setJumpStage] = useState<StageKey | null>(null);

  const onJump = useCallback((s: StageKey) => {
    setJumpStage(s);
    window.setTimeout(() => setJumpStage(null), 320);
  }, []);

  const activeQ = useQuery({
    queryKey: ['runs', 'active', runId],
    queryFn: () => api<ApiActiveRun[]>('/api/runs/active'),
  });

  const recordQ = useQuery({
    queryKey: ['run-detail', runId],
    enabled: Boolean(runId),
    queryFn: () => api<ApiRunRecord>(`/api/runs/${encodeURIComponent(runId)}`),
    retry: false,
  });

  const [replayState, setReplayState] = useState<GenerateRunState | null>(null);
  const [hydratingEvents, setHydratingEvents] = useState(false);
  const [eventsMissing, setEventsMissing] = useState(false);
  const [incompleteTimeline, setIncompleteTimeline] = useState(false);

  useEffect(() => {
    liveRedirectDone.current = false;
  }, [runId]);

  useEffect(() => {
    if (!runId || !activeQ.data) return;
    if (!activeQ.data.some((r) => r.runId === runId)) return;
    if (liveRedirectDone.current) return;
    liveRedirectDone.current = true;
    toast({
      tone: 'info',
      title: 'Still active run',
      description: 'This run is still active — opened the live view instead.',
    });
    void navigate({ to: '/generate', search: { feature: '', storyId: '' } });
  }, [runId, activeQ.data, navigate, toast]);

  useEffect(() => {
    const rec = recordQ.data;
    if (!rec || !runId || liveRedirectDone.current) return;

    setEventsMissing(false);
    setIncompleteTimeline(false);
    setHydratingEvents(true);
    resetGenerateFeedSeqForReplay();
    let acc = replaySeed(rec);
    setReplayState(acc);

    let cancelled = false;
    void (async () => {
      try {
        let from = 0;
        const limit = 2000;
        let sawDone = false;
        while (!cancelled) {
          const page = await api<ApiRunEventsPage>(
            `/api/runs/${encodeURIComponent(runId)}/events?from=${from}&limit=${limit}`,
          );
          const nowWall = Date.now();
          for (const raw of page.events) {
            const ev = coerceEvent(raw);
            acc = applyGenerateEvent(acc, ev, nowWall);
            if (ev.kind === 'done') sawDone = true;
          }
          if (cancelled) return;
          setReplayState(acc);
          from += page.events.length;
          if (page.events.length < limit) break;
        }
        if (!cancelled && !sawDone) setIncompleteTimeline(true);
      } catch {
        if (cancelled) return;
        setEventsMissing(true);
        setIncompleteTimeline(false);
        setReplayState(summaryOnlyState(rec));
      } finally {
        if (!cancelled) setHydratingEvents(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [recordQ.data, runId]);

  if (!runId) {
    return (
      <Page title="Run" description="Missing run identifier.">
        <Callout tone="warning">No run selected.</Callout>
      </Page>
    );
  }

  if (recordQ.error instanceof UnauthorizedError) {
    return (
      <Page title="Run report" description="Persisted planner run.">
        <Callout tone="warning" title="Session expired">
          Reopen squad console from your project.
        </Callout>
      </Page>
    );
  }

  if (recordQ.isPending || activeQ.isPending) {
    return (
      <Page title="Run" description="Loading…">
        <Skeleton className="h-36 w-full" />
      </Page>
    );
  }

  if (liveRedirectDone.current && activeQ.data?.some((r) => r.runId === runId)) return null;

  if (
    recordQ.error &&
    is404Err(recordQ.error) &&
    !activeQ.isPending &&
    !(activeQ.data ?? []).some((r) => r.runId === runId)
  ) {
    return (
      <Page title="Run not found" description="This planner run id is unknown to the server.">
        <Callout tone="warning">
          Run not found — it may have rotated out (we keep the last 20 summaries on disk).
        </Callout>
      </Page>
    );
  }

  if (recordQ.error) {
    return (
      <Page title="Run report" description="">
        <Callout tone="danger">{recordQ.error instanceof Error ? recordQ.error.message : String(recordQ.error)}</Callout>
      </Page>
    );
  }

  const record = recordQ.data;
  const st = replayState;

  if (!record || !st) {
    return (
      <Page title="Run" description="">
        <Skeleton className="h-36 w-full" />
      </Page>
    );
  }

  const durSec = Math.max(1, Math.round(record.durationMs / 1000));
  const typedTab =
    tabSearch === 'issues' || tabSearch === 'telemetry' || tabSearch === 'plan' ? tabSearch : 'plan';

  const initialTabSafe =
    typedTab === 'issues' && eventsMissing ? 'plan' : typedTab;

  return (
    <>
      {hydratingEvents ? (
        <div
          className="fixed left-0 right-0 top-0 z-[var(--z-overlay)] h-1 overflow-hidden bg-[var(--gray-4)] motion-safe:animate-pulse"
          role="progressbar"
          aria-label="Loading event timeline"
        >
          <div className="h-full w-1/2 bg-[var(--color-info)]" />
        </div>
      ) : null}
      <Page
        title={`Run ${shortRunId(record.runId)}`}
        description={`${record.feature} / ${record.storyId} — ${formatWhen(record.completedAt)}`}
      >
        <RunReportHeader record={record} incompleteTimeline={incompleteTimeline} />
        {eventsMissing ? (
          <Callout tone="warning" title="Event timeline unavailable">
            The events JSONL could not be read (missing or unreadable after rotation). Showing summary statistics only —
            Activity and Issues replay are disabled.
          </Callout>
        ) : null}
        <MetricsBar state={st} elapsedSec={durSec} frozen />
        <RunIdentityCard runtime={st.runtime} auth={st.auth} telemetryPartial={false} />
        <StagePipeline stages={st.stages} onJump={onJump} />
        <BudgetMeters budget={st.budget} startedAtMs={st.startedAtMs} replayWallSec={durSec} />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {eventsMissing ? (
            <Callout tone="info">Activity feed requires a readable events file.</Callout>
          ) : (
            <ActivityFeed rows={st.activities} jumpStage={jumpStage} replayed />
          )}
          <LiveTabs
            state={st}
            replayed
            initialTab={initialTabSafe}
            hideIssuesTab={eventsMissing}
          />
        </div>
        <RunReportFooter record={record} />
      </Page>
    </>
  );
}

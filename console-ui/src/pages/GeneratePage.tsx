import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, X } from 'lucide-react';
import { api, UnauthorizedError } from '~/api/client';
import type { ApiActiveRun, ApiStory, ApiConfig, ApiCopyPlanPrompt } from '~/api/types';
import { Badge } from '~/components/Badge';
import { Callout } from '~/components/Callout';
import { Markdown } from '~/components/Markdown';
import { Button } from '~/components/Button';
import { Page } from '~/components/Page';
import { Select } from '~/components/Select';
import { Spinner } from '~/components/Spinner';
import { groupByFeature } from '~/lib/group-by-feature';
import { useToast } from '~/components/Toast';

type Phase = 'idle' | 'starting' | 'streaming' | 'done' | 'failed' | 'cancelled';

type PlannerSseEvent = {
  kind: string;
  runId?: string;
  turn?: number;
  success?: boolean;
  planFile?: string | null;
  partial?: boolean;
  message?: string;
  waitSec?: number;
  delta?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  cacheHitRatio?: number;
  toolCall?: { input?: Record<string, unknown> };
  bytesLoaded?: number;
};

interface State {
  phase: Phase;
  runId: string | null;
  startedAtMs: number | null;
  tick: number;
  turn: number;
  cacheHitPct: number | null;
  tokenIn: number;
  tokenOut: number;
  tokenCeiling: number;
  fileReads: { id: string; path: string; kb: string }[];
  assistantMd: string;
  planFile: string | null;
  feature: string;
  storyId: string;
  mode: 'api' | 'copy';
  error: string | null;
}

const initial: State = {
  phase: 'idle',
  runId: null,
  startedAtMs: null,
  tick: 0,
  turn: 0,
  cacheHitPct: null,
  tokenIn: 0,
  tokenOut: 0,
  tokenCeiling: 32_000,
  fileReads: [],
  assistantMd: '',
  planFile: null,
  feature: '',
  storyId: '',
  mode: 'api',
  error: null,
};

type Action =
  | { type: 'set_story'; feature: string; storyId: string }
  | { type: 'set_mode'; mode: 'api' | 'copy' }
  | { type: 'start_post' }
  | { type: 'start_stream'; runId: string }
  | { type: 'resume'; runId: string; feature: string; storyId: string }
  | { type: 'sse'; event: PlannerSseEvent }
  | { type: 'fail'; message: string }
  | { type: 'tick' }
  | { type: 'reset_stream_ui' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set_story':
      return { ...state, feature: action.feature, storyId: action.storyId };
    case 'set_mode':
      return { ...state, mode: action.mode };
    case 'start_post':
      return {
        ...state,
        phase: 'starting',
        error: null,
        assistantMd: '',
        fileReads: [],
        cacheHitPct: null,
        tokenIn: 0,
        tokenOut: 0,
        turn: 0,
        planFile: null,
        startedAtMs: Date.now(),
      };
    case 'start_stream':
      return { ...state, phase: 'streaming', runId: action.runId, startedAtMs: state.startedAtMs ?? Date.now() };
    case 'resume':
      return {
        ...state,
        phase: 'streaming',
        runId: action.runId,
        feature: action.feature,
        storyId: action.storyId,
        assistantMd: '',
        fileReads: [],
        cacheHitPct: null,
        tokenIn: 0,
        tokenOut: 0,
        turn: 0,
        planFile: null,
        error: null,
        startedAtMs: Date.now(),
      };
    case 'reset_stream_ui':
      return {
        ...state,
        assistantMd: '',
        fileReads: [],
        cacheHitPct: null,
        tokenIn: 0,
        tokenOut: 0,
        turn: 0,
        planFile: null,
      };
    case 'tick':
      return { ...state, tick: state.tick + 1 };
    case 'fail':
      return { ...state, phase: 'failed', error: action.message, runId: null };
    case 'sse': {
      const e = action.event;
      let next: State = state;
      if (e.kind === 'usage' && e.usage) {
        const inn = e.usage.inputTokens ?? state.tokenIn;
        const out = e.usage.outputTokens ?? state.tokenOut;
        const sum = inn + out;
        const ceil = Math.max(state.tokenCeiling, Math.ceil(sum * 1.15), 1024);
        next = { ...next, tokenIn: inn, tokenOut: out, tokenCeiling: ceil };
      }
      if (e.kind === 'cache_summary' && e.cacheHitRatio !== undefined) {
        next = { ...next, cacheHitPct: Math.round(e.cacheHitRatio * 100) };
      }
      if (e.kind === 'tool_call' && e.toolCall) {
        const p = (e.toolCall.input as { path?: string } | undefined)?.path ?? '<unknown>';
        const kb =
          e.bytesLoaded !== undefined ? `${(e.bytesLoaded / 1024).toFixed(1)} KB` : '—';
        next = {
          ...next,
          fileReads: [
            ...next.fileReads,
            { id: `${next.runId}-${next.fileReads.length}`, path: p, kb },
          ],
        };
      }
      if (e.kind === 'assistant_text' && e.delta) {
        next = { ...next, assistantMd: next.assistantMd + e.delta };
      }
      if (e.turn !== undefined) next = { ...next, turn: e.turn };
      if (e.kind === 'cancelled') {
        next = { ...next, phase: 'cancelled' };
      }
      if (e.kind === 'done') {
        if (next.phase === 'failed' && next.error) {
          return { ...next, planFile: e.planFile ?? next.planFile };
        }
        const wasCancelled = next.phase === 'cancelled';
        next = { ...next, planFile: e.planFile ?? null };
        if (e.success) {
          next = { ...next, phase: 'done', error: null };
        } else if (wasCancelled || e.partial) {
          next = { ...next, phase: 'cancelled' };
        } else {
          next = { ...next, phase: 'failed', error: 'Planning did not finish cleanly.' };
        }
      }
      if (e.kind === 'error' && e.message) {
        next = { ...next, phase: 'failed', error: e.message };
      }
      return next;
    }
    default:
      return state;
  }
}

function useEventSourceBridge(runId: string | null, dispatch: React.Dispatch<Action>) {
  useEffect(() => {
    if (!runId) return;

    const token = sessionStorage.getItem('squad.console.token');
    if (!token) return;

    const url = `/api/runs/${encodeURIComponent(runId)}/stream?t=${encodeURIComponent(token)}`;
    const es = new EventSource(url);

    const on = (name: string, fn: (data: string) => void) => {
      es.addEventListener(name, (ev) => fn((ev as MessageEvent).data as string));
    };

    const handlePayload = (data: string) => {
      try {
        const parsed = JSON.parse(data) as PlannerSseEvent;
        dispatch({ type: 'sse', event: parsed });
      } catch {
        /* ignore */
      }
    };

    on('started', handlePayload);
    on('turn_started', handlePayload);
    on('request_sent', handlePayload);
    on('usage', handlePayload);
    on('cache_summary', handlePayload);
    on('tool_call', handlePayload);
    on('assistant_text', handlePayload);
    on('rate_limit', handlePayload);
    on('turn_complete', handlePayload);
    on('done', handlePayload);
    on('error', handlePayload);
    on('cancelled', handlePayload);
    on('ping', () => {});

    es.addEventListener('closed', () => {
      es.close();
    });

    return () => {
      es.close();
    };
  }, [runId, dispatch]);
}

function StatusRow({
  state,
  elapsedSec,
  tokenPct,
  cancelRun,
}: {
  state: State;
  elapsedSec: number;
  tokenPct: number;
  cancelRun: () => void;
}) {
  const statusPill =
    state.phase === 'idle'
      ? 'idle'
      : state.phase === 'starting'
        ? 'running'
        : state.phase === 'streaming'
          ? 'running'
          : state.phase === 'done'
            ? 'succeeded'
            : state.phase === 'cancelled'
              ? 'cancelled'
              : state.phase === 'failed'
                ? 'failed'
                : '—';

  const tone =
    statusPill === 'running'
      ? 'info'
      : statusPill === 'succeeded'
        ? 'success'
        : statusPill === 'failed'
          ? 'danger'
          : statusPill === 'cancelled'
            ? 'warning'
            : 'default';

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <div className="inline-flex items-center gap-1.5">
          {statusPill === 'running' ? <Spinner size="sm" aria-hidden /> : null}
          <Badge tone={tone} dot={statusPill === 'running'}>
            {statusPill}
          </Badge>
        </div>
        <span className="text-[var(--color-text-muted)]">
          turn {state.turn}
          {(state.phase === 'streaming' || state.phase === 'starting') && ` · ${elapsedSec}s`}
          {state.cacheHitPct != null && ` · cache hit ${state.cacheHitPct}%`}
        </span>
      </div>
      <div className="mb-3">
        <div className="mb-1 flex justify-between text-xs text-[var(--color-text-muted)]">
          <span>
            tokens {state.tokenIn} in · {state.tokenOut} out
          </span>
          <span className="tabular">{tokenPct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--gray-3)]">
          <div
            className="h-full bg-[var(--color-text)] transition-[width] duration-300"
            style={{ width: `${tokenPct}%` }}
          />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">File reads</h2>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
            {state.fileReads.map((r) => (
              <li key={r.id} className="flex justify-between gap-2 border-b border-[var(--color-border)]/50 py-1">
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-[var(--color-text)]">
                  <Check size={12} className="shrink-0 text-[var(--color-ok)]" aria-hidden />
                  <span className="truncate">{r.path}</span>
                </span>
                <span className="shrink-0 tabular text-[var(--color-text-muted)]">{r.kb}</span>
              </li>
            ))}
            {(state.phase === 'streaming' || state.phase === 'starting') && (
              <li className="text-xs text-[var(--color-text-muted)]">◓ working…</li>
            )}
          </ul>
        </div>
        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Assistant</h2>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--gray-2)] p-3 text-sm">
            {state.assistantMd ? (
              <Markdown source={state.assistantMd} />
            ) : (
              <span className="text-[var(--color-text-muted)]">Waiting for model…</span>
            )}
          </div>
        </div>
      </div>
      {(state.phase === 'streaming' || state.phase === 'starting') && (
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="danger" leftIcon={<X size={14} />} onClick={cancelRun}>
            Cancel run
          </Button>
        </div>
      )}
    </div>
  );
}

export function GeneratePage() {
  const [state, dispatch] = useReducer(reducer, initial);
  const { toast } = useToast();
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

  const copyPromptQ = useQuery({
    queryKey: ['copy-plan-prompt', state.feature, state.storyId],
    queryFn: () =>
      api<ApiCopyPlanPrompt>(
        `/api/copy-plan-prompt?feature=${encodeURIComponent(state.feature)}&storyId=${encodeURIComponent(state.storyId)}`,
      ),
    enabled: state.mode === 'copy' && Boolean(state.feature && state.storyId),
  });

  const plannerEnabled = Boolean(configQ.data?.planner?.enabled);

  const unplanned = useMemo(() => {
    const all = storiesQ.data ?? [];
    return all.filter((s) => !s.planFile);
  }, [storiesQ.data]);

  const featureNames = useMemo(() => groupByFeature(unplanned).map((g) => g.feature), [unplanned]);

  useEffect(() => {
    if (!unplanned.length) return;

    if (urlKey && urlKey !== lastAppliedUrlKeyRef.current) {
      const target = unplanned.find((s) => s.feature === urlFeature && s.id === urlStoryId);
      if (target) {
        dispatch({ type: 'set_story', feature: target.feature, storyId: target.id });
        lastAppliedUrlKeyRef.current = urlKey;
        return;
      }
      lastAppliedUrlKeyRef.current = urlKey;
    }

    if (state.feature) return;

    const last = [...unplanned].sort((a, b) => {
      const fa = `${a.feature}/${a.id}`;
      const fb = `${b.feature}/${b.id}`;
      return fb.localeCompare(fa);
    })[0];
    if (last) dispatch({ type: 'set_story', feature: last.feature, storyId: last.id });
  }, [unplanned, state.feature, urlKey, urlFeature, urlStoryId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (state.phase !== 'idle' || !storiesQ.data) return;
      try {
        const active = await api<ApiActiveRun[]>('/api/runs/active');
        if (cancelled || active.length !== 1) return;
        const a = active[0]!;
        dispatch({ type: 'resume', runId: a.runId, feature: a.feature, storyId: a.storyId });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.phase, storiesQ.data]);

  useEffect(() => {
    if (state.phase !== 'streaming' && state.phase !== 'starting') return;
    const t = window.setInterval(() => dispatch({ type: 'tick' }), 500);
    return () => clearInterval(t);
  }, [state.phase]);

  const dispatchStable = useCallback((a: Action) => dispatch(a), []);
  useEventSourceBridge(state.runId, dispatchStable);

  const elapsedSec =
    state.startedAtMs != null && (state.phase === 'streaming' || state.phase === 'starting')
      ? Math.floor((Date.now() - state.startedAtMs) / 1000)
      : state.startedAtMs != null
        ? Math.floor((Date.now() - state.startedAtMs) / 1000)
        : 0;

  const tokenPct = Math.min(
    100,
    Math.round(((state.tokenIn + state.tokenOut) / state.tokenCeiling) * 100),
  );

  const runPlanner = async () => {
    if (state.mode === 'copy') return;
    if (!state.feature || !state.storyId) return;
    dispatch({ type: 'start_post' });
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionStorage.getItem('squad.console.token') ?? ''}`,
        },
        body: JSON.stringify({ feature: state.feature, storyId: state.storyId }),
      });
      if (res.status === 401) throw new UnauthorizedError();
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(j.detail ?? j.error ?? `${res.status}`);
      }
      const body = (await res.json()) as { runId: string };
      dispatch({ type: 'start_stream', runId: body.runId });
    } catch (e) {
      dispatch({ type: 'fail', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const cancelRun = async () => {
    if (!state.runId) return;
    try {
      await fetch(`/api/runs/${encodeURIComponent(state.runId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${sessionStorage.getItem('squad.console.token') ?? ''}` },
      });
    } catch {
      /* ignore */
    }
  };

  const unauthorized =
    storiesQ.error instanceof UnauthorizedError ||
    configQ.error instanceof UnauthorizedError ||
    copyPromptQ.error instanceof UnauthorizedError;

  if (unauthorized) {
    return (
      <Page title="Generate plan" description="Run the planner against an intake; stream file reads and draft text live.">
        <Callout tone="warning" title="Session expired or missing token.">
          Reopen <kbd className="kbd">squad console</kbd> from your project.
        </Callout>
      </Page>
    );
  }

  return (
    <Page title="Generate plan" description="Run the planner against an intake; stream file reads and draft text live.">
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
        <Callout tone="info" title="Provider keys">
          API runs need a provider key in{' '}
          <Link to={'/secrets' as never} className="text-[var(--color-accent)] underline">
            Secrets
          </Link>{' '}
          or in your shell (<code className="text-xs">ANTHROPIC_API_KEY</code>, etc.).
        </Callout>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-w-[140px] flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Feature
          <Select
            value={state.feature}
            disabled={featureNames.length === 0}
            onChange={(e) => {
              const f = e.target.value;
              const first = unplanned.find((s) => s.feature === f);
              dispatch({
                type: 'set_story',
                feature: f,
                storyId: first?.id ?? '',
              });
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
            value={state.storyId}
            disabled={!state.feature}
            onChange={(e) => dispatch({ type: 'set_story', feature: state.feature, storyId: e.target.value })}
          >
            <option value="">—</option>
            {unplanned
              .filter((s) => s.feature === state.feature)
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
              checked={state.mode === 'api'}
              disabled={!plannerEnabled}
              onChange={() => dispatch({ type: 'set_mode', mode: 'api' })}
            />
            API
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="mode"
              checked={state.mode === 'copy'}
              onChange={() => dispatch({ type: 'set_mode', mode: 'copy' })}
            />
            Copy
          </label>
        </fieldset>
        <Button
          type="button"
          disabled={
            !state.feature ||
            !state.storyId ||
            state.mode !== 'api' ||
            !plannerEnabled ||
            state.phase === 'streaming' ||
            state.phase === 'starting'
          }
          onClick={() => void runPlanner()}
        >
          Run
        </Button>
      </div>

      {state.mode === 'copy' && (
        <div className="mt-6 space-y-4">
          {!state.feature || !state.storyId ? (
            <Callout tone="info" title="Choose a story first">
              Pick a feature and story above. The console loads the same meta-prompt as{' '}
              <code className="text-xs">squad new-plan &lt;intake&gt; --copy</code> — no provider keys needed in the
              browser.
            </Callout>
          ) : copyPromptQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
              <Spinner />
              Building prompt…
            </div>
          ) : copyPromptQ.isError ? (
            <Callout tone="danger" title="Could not load prompt">
              {copyPromptQ.error instanceof Error ? copyPromptQ.error.message : String(copyPromptQ.error)}
            </Callout>
          ) : copyPromptQ.data ? (
            <>
              <Callout tone="info" title="Copy-paste planning (no API spend here)">
                <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-sm text-[var(--color-text-muted)]">
                  <li>
                    Click <strong className="text-[var(--color-text)]">Copy full prompt</strong> (or select the box
                    and ⌘C / Ctrl+C).
                  </li>
                  <li>Open your agent (Cursor, Claude Code, Copilot, Gemini) and paste into a new chat.</li>
                  <li>Switch to a strong planning model, then let the agent read the repo and write the plan file.</li>
                  <li>
                    The agent saves under{' '}
                    <code className="text-xs">.squad/plans/{copyPromptQ.data.feature}/</code>. For a CLI-only refresh,
                    you can still run{' '}
                    <code className="text-xs">squad new-plan --copy</code> in a terminal — same bytes.
                  </li>
                </ol>
              </Callout>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-[var(--color-text-muted)]">
                  ~{copyPromptQ.data.estTokensApprox.toLocaleString()} tokens (est) ·{' '}
                  {(copyPromptQ.data.bytes / 1024).toFixed(1)} KB
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  leftIcon={<Copy size={14} aria-hidden />}
                  onClick={() => {
                    void (async () => {
                      try {
                        await navigator.clipboard.writeText(copyPromptQ.data!.prompt);
                        toast({ tone: 'success', title: 'Full prompt copied' });
                      } catch {
                        toast({
                          tone: 'warning',
                          title: 'Clipboard blocked',
                          description: 'Select the text in the box and copy manually (⌘C / Ctrl+C).',
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
                  Prompt preview (scroll — button copies the entire prompt, not just this view)
                </label>
                <textarea
                  id="copy-prompt-preview"
                  readOnly
                  spellCheck={false}
                  rows={14}
                  className="mt-1 w-full max-h-64 min-h-[12rem] resize-y rounded-lg border border-[var(--color-border)] bg-[var(--gray-2)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text)]"
                  value={copyPromptQ.data.prompt}
                />
              </div>
            </>
          ) : null}
        </div>
      )}

      {(state.phase === 'streaming' || state.phase === 'starting' || state.phase === 'done' || state.phase === 'failed' || state.phase === 'cancelled') && (
        <StatusRow state={state} elapsedSec={elapsedSec} tokenPct={tokenPct} cancelRun={() => void cancelRun()} />
      )}

      {state.phase === 'done' && state.planFile && (
        <Callout
          tone="success"
          title="Plan saved"
          action={
            <Link
              to="/plans/$feature/$planFile"
              params={{ feature: state.feature, planFile: state.planFile }}
              className="text-[13px] font-medium text-[var(--color-accent)] hover:underline"
            >
              Open
            </Link>
          }
        >
          <span className="font-mono">{state.planFile}</span>
        </Callout>
      )}

      {state.phase === 'cancelled' && state.planFile && (
        <Callout
          tone="warning"
          title="Saved partial plan"
          action={
            <Link
              to="/plans/$feature/$planFile"
              params={{ feature: state.feature, planFile: state.planFile }}
              className="text-[13px] font-medium text-[var(--color-accent)] hover:underline"
            >
              Open
            </Link>
          }
        >
          <span className="font-mono">{state.planFile}</span>
        </Callout>
      )}

      {state.error && state.phase === 'failed' && <Callout tone="danger" title="Run failed">{state.error}</Callout>}
    </Page>
  );
}

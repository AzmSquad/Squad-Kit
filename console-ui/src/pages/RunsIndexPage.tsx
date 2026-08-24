import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { api } from '~/api/client';
import type { ApiRunRecord } from '~/api/types';
import { Badge } from '~/components/Badge';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Page } from '~/components/Page';
import { Skeleton } from '~/components/Skeleton';

function runtimeLabel(r: ApiRunRecord): string {
  const k = r.plannerRuntime?.kind;
  return k === 'agent-sdk' ? 'Agent SDK' : k === 'vercel' ? 'Vercel' : '—';
}

/** Runs recorded before 0.12.0 carry no `authMode`; show `—` rather than inventing one. */
function AuthChip({ mode }: { mode: ApiRunRecord['authMode'] }) {
  if (!mode) return <span className="text-[var(--color-text-muted)]">—</span>;
  return (
    <Badge tone={mode === 'subscription' ? 'info' : 'muted'} title={mode}>
      {mode === 'subscription' ? 'sub' : 'key'}
    </Badge>
  );
}

export function RunsIndexPage() {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['runs'],
    queryFn: () => api<ApiRunRecord[]>('/api/runs'),
  });

  if (q.isPending) {
    return (
      <Page title="Runs" description="The last 20 planner runs on this project.">
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </Page>
    );
  }

  if (q.isError) {
    return (
      <Page title="Runs" description="The last 20 planner runs on this project.">
        <Callout tone="danger">{(q.error as Error).message}</Callout>
      </Page>
    );
  }

  const rows = q.data ?? [];

  return (
    <Page title="Runs" description="The last 20 planner runs on this project.">
      {rows.length === 0 ? (
        <Callout tone="info" title="No runs yet">
          <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">Go to Generate to start one.</p>
          <Link to={'/generate' as never}>
            <Button type="button" variant="primary">
              Open Generate
            </Button>
          </Link>
        </Callout>
      ) : (
        <div className="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full min-w-[940px] table-fixed border-collapse text-left text-[13px]">
            <thead className="bg-[var(--gray-2)] text-[var(--color-text-muted)]">
              <tr>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium w-[10rem]">
                  Started
                </th>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium w-[220px]">
                  Feature / story
                </th>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium">Model</th>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium w-[6rem]">Runtime</th>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium w-[5rem]">Auth</th>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium tabular text-right w-[5rem]">
                  Duration
                </th>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium tabular text-right w-[6rem]">
                  Tokens
                </th>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium tabular text-right w-[5rem]">
                  Cache
                </th>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium w-[7rem]">
                  Validation
                </th>
                <th className="border-b border-[var(--color-border)] px-3 py-2 font-medium w-[6rem]">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const inTok = r.stats?.inputTokens ?? 0;
                const outTok = r.stats?.outputTokens ?? 0;
                const sumTok = inTok + outTok;
                const pct =
                  r.stats?.cacheHitRatio != null ? Math.round(r.stats.cacheHitRatio * 100) : null;
                const secs = Math.max(1, Math.round(r.durationMs / 1000));
                const issues = r.validation?.issuesCount ?? 0;
                const tone =
                  r.success ?
                    ('success' as const)
                  : r.partial ?
                    ('warning' as const)
                  : ('danger' as const);
                return (
                  <tr
                    key={r.runId}
                    aria-label={`Run ${r.runId}`}
                    tabIndex={0}
                    role="link"
                    onClick={() =>
                      void navigate({
                        to: '/runs/$runId',
                        params: { runId: r.runId },
                        search: { tab: 'plan' },
                      })}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ')
                        void navigate({
                          to: '/runs/$runId',
                          params: { runId: r.runId },
                          search: { tab: 'plan' },
                        });
                    }}
                    className={
                      `${i > 0 ? 'border-t border-[var(--color-border)] ' : ''}` +
                      'cursor-pointer transition-colors hover:bg-[var(--gray-3)]'
                    }
                  >
                    <td className="truncate px-3 py-[var(--space-row-y)] text-[var(--color-text-muted)] tabular whitespace-nowrap">
                      {formatStarted(r.startedAt)}
                    </td>
                    <td className="truncate px-3 py-[var(--space-row-y)] font-mono text-[12px]">
                      <span title={`${r.feature}/${r.storyId}`}>{r.feature}</span>{' '}
                      <span className="text-[var(--color-text-muted)]">/</span> <span>{r.storyId}</span>
                    </td>
                    <td className="truncate px-3 py-[var(--space-row-y)] font-mono text-[12px] text-[var(--color-text-muted)]">
                      {r.model}
                    </td>
                    <td className="px-3 py-[var(--space-row-y)]">{runtimeLabel(r)}</td>
                    <td className="px-3 py-[var(--space-row-y)]">
                      <AuthChip mode={r.authMode} />
                    </td>
                    <td className="px-3 py-[var(--space-row-y)] tabular text-right">{secs}s</td>
                    <td className="px-3 py-[var(--space-row-y)] tabular text-right">{sumTok}</td>
                    <td className="px-3 py-[var(--space-row-y)] tabular text-right">{pct != null ? `${pct}%` : '—'}</td>
                    <td className="px-3 py-[var(--space-row-y)]">
                      <Link
                        to="/runs/$runId"
                        params={{ runId: r.runId }}
                        search={{ tab: 'issues' }}
                        onClick={(ev) => ev.stopPropagation()}
                        className={`${issues ? 'font-medium text-[var(--color-accent)] hover:underline' : 'text-[var(--color-text-muted)] hover:underline'}`}
                      >
                        {issues} {issues === 1 ? 'issue' : 'issues'}
                      </Link>
                    </td>
                    <td className="px-3 py-[var(--space-row-y)]">
                      <Badge tone={tone}>{r.success ? 'success' : r.partial ? 'partial' : 'failed'}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

function formatStarted(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return iso;
  return new Date(d).toLocaleString();
}

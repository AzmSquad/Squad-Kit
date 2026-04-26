import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, UnauthorizedError } from '~/api/client';
import type { ApiDashboard, ApiStory } from '~/api/types';
import { Badge } from '~/components/Badge';
import { Callout } from '~/components/Callout';
import { Card } from '~/components/Card';
import { Kbd } from '~/components/Kbd';
import { Page } from '~/components/Page';
import { Skeleton } from '~/components/Skeleton';
import { CacheHitRing } from '~/components/charts/CacheHitRing';
import { DurationBars } from '~/components/charts/DurationBars';
import { TokenSparkline } from '~/components/charts/TokenSparkline';

function groupByFeature(stories: ApiStory[]): Map<string, ApiStory[]> {
  const m = new Map<string, ApiStory[]>();
  for (const s of stories) {
    const list = m.get(s.feature) ?? [];
    list.push(s);
    m.set(s.feature, list);
  }
  for (const list of m.values()) {
    list.sort((a, b) => a.id.localeCompare(b.id));
  }
  return m;
}

export function Dashboard() {
  const qc = useQueryClient();

  useEffect(() => {
    void api<{ ok: boolean }>('/api/projects/touch', { method: 'POST' }).then(() =>
      qc.invalidateQueries({ queryKey: ['recent-projects'] }),
    );
  }, [qc]);

  const dashQ = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<ApiDashboard>('/api/dashboard'),
  });

  const err = dashQ.error;
  const unauthorized = err instanceof UnauthorizedError;

  if (unauthorized) {
    return (
      <Page title="Dashboard" description="Overview of this workspace and recent planner telemetry.">
        <Callout tone="warning" title={err instanceof UnauthorizedError ? err.message : new UnauthorizedError().message}>
          Reopen <Kbd>squad console</Kbd> from your project and use the new URL.
        </Callout>
      </Page>
    );
  }

  const loadErr = !unauthorized && err ? String(err) : null;
  const d = dashQ.data;
  const lastRun = d?.lastRun ?? null;
  const cacheRatio = lastRun?.stats.cacheHitRatio ?? 0;
  const cachePct = lastRun != null ? `${Math.round(cacheRatio * 100)}%` : '—';
  const runs = d?.runs ?? [];
  const grouped = d?.stories ? groupByFeature(d.stories) : null;

  return (
    <Page title="Dashboard" description="Overview of this workspace and recent planner telemetry.">
      {loadErr ? <Callout tone="danger">{loadErr}</Callout> : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card variant="default">
          <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">Project</div>
          {dashQ.isPending ? (
            <Skeleton className="mt-2 h-8 w-3/4" />
          ) : (
            <>
              <div className="mt-2 text-lg font-semibold text-[var(--color-text)]">{d?.project.name ?? '—'}</div>
              {d?.project.primaryLanguage ? (
                <div className="mt-1 text-sm text-[var(--color-text-muted)]">{d.project.primaryLanguage}</div>
              ) : null}
              {d?.root ? (
                <div className="mt-3 truncate font-mono text-[11px] text-[var(--color-text-dim)]">{d.root}</div>
              ) : null}
            </>
          )}
        </Card>

        <Card variant="default">
          <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">Planner</div>
          {dashQ.isPending ? (
            <Skeleton className="mt-2 h-8 w-2/3" />
          ) : d?.planner ? (
            <div className="mt-2 flex items-center gap-2 text-lg font-semibold">
              {d.planner.enabled ? (
                <span className="h-2 w-2 rounded-full bg-[var(--color-accent)] shadow-[0_0_10px_var(--color-accent)]" />
              ) : null}
              <span>{d.planner.provider}</span>
            </div>
          ) : (
            <div className="mt-2 text-lg font-semibold text-[var(--color-text-muted)]">not configured</div>
          )}
        </Card>

        <Card variant="default">
          <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">Last cache hit</div>
          {dashQ.isPending ? (
            <Skeleton className="mt-2 h-8 w-20" />
          ) : (
            <div className="mt-2 text-2xl font-semibold tabular-nums text-[var(--color-text)]">{cachePct}</div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {runs.length === 0 ? (
          <Card variant="default" className="lg:col-span-3">
            <h2 className="mb-2 text-lg font-semibold text-[var(--color-text)]">Run history</h2>
            <p className="text-sm text-[var(--color-text-muted)]">
              No runs yet — kick one off in{' '}
              <Link to={'/generate' as never} className="text-[var(--color-accent)] hover:underline">
                Generate
              </Link>
              .
            </p>
          </Card>
        ) : (
          <>
            <Card variant="default">
              <h2 className="mb-4 text-sm font-semibold text-[var(--color-text)]">Cache hit ratio</h2>
              <div className="flex justify-center">
                <CacheHitRing ratio={cacheRatio} />
              </div>
            </Card>
            <Card variant="default">
              <h2 className="mb-4 text-sm font-semibold text-[var(--color-text)]">Token spend (last {Math.min(20, runs.length)} runs)</h2>
              <TokenSparkline runs={runs} />
            </Card>
            <Card variant="default">
              <h2 className="mb-4 text-sm font-semibold text-[var(--color-text)]">Run duration (last {Math.min(20, runs.length)} runs)</h2>
              <DurationBars runs={runs} />
            </Card>
          </>
        )}
      </div>

      <Card variant="default">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">Stories</h2>
        </div>
        {dashQ.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : grouped && grouped.size > 0 ? (
          <div className="space-y-6">
            {[...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([feature, rows]) => (
              <div key={feature}>
                <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
                  {feature}
                </div>
                <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                  {rows.map((s, i) => (
                    <li key={`${s.feature}/${s.id}`}>
                      <Link
                        to="/stories/$feature/$id"
                        params={{ feature: s.feature, id: s.id }}
                        className={
                          `flex items-center gap-3 px-3 py-[var(--space-row-y)] text-[13px] ` +
                          `hover:bg-[var(--gray-4)] transition-colors ` +
                          (i > 0 ? 'border-t border-[var(--color-border)]' : '')
                        }
                      >
                        <span className="w-20 shrink-0 font-mono text-[12px] text-[var(--color-text-muted)]">{s.id}</span>
                        <span className="min-w-0 flex-1 truncate">
                          {s.titleHint || <span className="text-[var(--color-text-dim)]">no title</span>}
                        </span>
                        {s.planFile ? (
                          <Badge tone="success" dot>
                            planned
                          </Badge>
                        ) : (
                          <Badge tone="default">unplanned</Badge>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">No stories yet.</p>
        )}
      </Card>
    </Page>
  );
}

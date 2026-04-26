import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { GitCompare, Trash2 } from 'lucide-react';
import { api } from '~/api/client';
import type { ApiPlan } from '~/api/types';
import { Badge } from '~/components/Badge';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Dialog } from '~/components/Dialog';
import { IconButton } from '~/components/IconButton';
import { Page } from '~/components/Page';
import { Skeleton } from '~/components/Skeleton';
import { useConfirm } from '~/components/Confirm';
import { useToast } from '~/components/Toast';

function groupByFeature(plans: ApiPlan[]): { feature: string; plans: ApiPlan[] }[] {
  const m = new Map<string, ApiPlan[]>();
  for (const p of plans) {
    const g = m.get(p.feature) ?? [];
    g.push(p);
    m.set(p.feature, g);
  }
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([feature, list]) => ({
      feature,
      plans: list.sort((x, y) => x.planFile.localeCompare(y.planFile)),
    }));
}

export function PlansPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [compareFor, setCompareFor] = useState<ApiPlan | null>(null);

  const q = useQuery({ queryKey: ['plans'], queryFn: () => api<ApiPlan[]>('/api/plans') });

  const delM = useMutation({
    mutationFn: ({ feature, planFile }: { feature: string; planFile: string }) =>
      api(`/api/plans/${encodeURIComponent(feature)}/${encodeURIComponent(planFile)}?trash=1`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });

  async function onDeletePlan(p: ApiPlan) {
    const ok = await confirm({
      title: `Delete ${p.planFile}?`,
      description: 'The plan file will be moved to trash.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await delM.mutateAsync({ feature: p.feature, planFile: p.planFile });
    toast({ tone: 'success', title: 'Plan deleted' });
  }

  if (q.isLoading) {
    return (
      <Page title="Plans" description="Generated plan files. Compare versions and clean up old drafts.">
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      </Page>
    );
  }

  if (q.isError) {
    return (
      <Page title="Plans" description="Generated plan files. Compare versions and clean up old drafts.">
        <Callout tone="danger">{(q.error as Error).message}</Callout>
      </Page>
    );
  }

  const grouped = groupByFeature(q.data ?? []);

  const plansData = q.data ?? [];

  return (
    <Page title="Plans" description="Generated plan files. Compare versions and clean up old drafts.">
      {grouped.length === 0 ? (
        <Callout tone="info">No plan files found.</Callout>
      ) : (
        <div className="space-y-8">
          {grouped.map(({ feature, plans }) => (
            <div key={feature}>
              <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
                {feature}
              </div>
              <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                {plans.map((p, i) => {
                  const partial = p.planFile.endsWith('.partial.md');
                  const by = p.metadata?.generatedBy ?? p.metadata?.model ?? '—';
                  const canCompare = plansData.some(
                    (x) => x.feature === p.feature && x.planFile !== p.planFile,
                  );
                  return (
                    <li
                      key={p.planFile}
                      className={
                        `flex flex-wrap items-center gap-3 border-[var(--color-border)] px-3 py-[var(--space-row-y)] ` +
                        (i > 0 ? 'border-t' : '')
                      }
                    >
                      <Link
                        to="/plans/$feature/$planFile"
                        params={{ feature: p.feature, planFile: p.planFile }}
                        className="min-w-0 flex-1 break-all font-mono text-[13px] text-[var(--color-text)] hover:underline"
                      >
                        {p.planFile}
                      </Link>
                      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                        {partial ? <Badge tone="warning">partial</Badge> : null}
                        <span className="chip max-w-[200px] truncate" title={by}>
                          {by}
                        </span>
                        {canCompare ? (
                          <IconButton
                            icon={<GitCompare size={14} />}
                            label="Compare with…"
                            onClick={() => setCompareFor(p)}
                          />
                        ) : null}
                        <IconButton
                          icon={<Trash2 size={14} />}
                          label="Delete plan"
                          onClick={() => void onDeletePlan(p)}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={compareFor !== null}
        onClose={() => setCompareFor(null)}
        title="Compare with"
        footer={
          <Button type="button" variant="secondary" onClick={() => setCompareFor(null)}>
            Close
          </Button>
        }
      >
        {compareFor ? (
          (() => {
            const others = plansData.filter(
              (x) => x.feature === compareFor.feature && x.planFile !== compareFor.planFile,
            );
            if (others.length === 0) {
              return <p className="text-sm text-[var(--color-text-muted)]">No other plans in this feature to compare.</p>;
            }
            return (
              <ul className="space-y-1">
                {others.map((p) => (
                  <li key={p.planFile}>
                    <button
                      type="button"
                      className="w-full text-left font-mono text-sm text-[var(--color-accent)] hover:underline"
                      onClick={() => {
                        const a = compareFor.planFile;
                        const b = p.planFile;
                        const feat = compareFor.feature;
                        setCompareFor(null);
                        void navigate({
                          to: '/plans/$feature/diff',
                          params: { feature: feat },
                          search: { a, b },
                        });
                      }}
                    >
                      {p.planFile}
                    </button>
                  </li>
                ))}
              </ul>
            );
          })()
        ) : null}
      </Dialog>
    </Page>
  );
}

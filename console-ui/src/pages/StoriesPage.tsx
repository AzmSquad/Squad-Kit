import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '~/api/client';
import type { ApiStory } from '~/api/types';
import { Badge } from '~/components/Badge';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { NewStoryDialog } from '~/components/NewStoryDialog';
import { Page } from '~/components/Page';
import { Skeleton } from '~/components/Skeleton';
import { groupByFeature } from '~/lib/group-by-feature';

export function StoriesPage() {
  const q = useQuery({ queryKey: ['stories'], queryFn: () => api<ApiStory[]>('/api/stories') });
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    const fn = () => setCreating(true);
    window.addEventListener('squad:dialog:new-story', fn);
    return () => window.removeEventListener('squad:dialog:new-story', fn);
  }, []);

  if (q.isLoading) {
    return (
      <Page title="Stories" description="Intake files grouped by feature. Open a story to edit or run the planner.">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      </Page>
    );
  }

  if (q.isError) {
    return (
      <Page title="Stories" description="Intake files grouped by feature. Open a story to edit or run the planner.">
        <Callout tone="danger">{(q.error as Error).message}</Callout>
      </Page>
    );
  }

  const grouped = groupByFeature(q.data ?? []);
  return (
    <Page
      title="Stories"
      description="Intake files grouped by feature. Open a story to edit or run the planner."
      actions={
        <Button type="button" leftIcon={<Plus size={14} />} onClick={() => setCreating(true)}>
          New story
        </Button>
      }
    >
      {grouped.length === 0 ? (
        <Callout tone="info">
          No stories yet.{' '}
          <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
            Create one
          </Button>{' '}
          to get started.
        </Callout>
      ) : (
        <div className="space-y-8">
          {grouped.map(({ feature, stories }) => (
            <div key={feature}>
              <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
                {feature}
              </div>
              <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                {stories.map((s, i) => (
                  <li
                    key={s.id}
                    className={
                      `flex items-center gap-3 border-[var(--color-border)] px-3 py-[var(--space-row-y)] text-[13px] ` +
                      (i > 0 ? 'border-t' : '')
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
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void nav({
                            to: '/generate',
                            search: { feature: s.feature, storyId: s.id },
                          } as never)
                        }
                      >
                        Generate
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          void nav({
                            to: '/stories/$feature/$id',
                            params: { feature: s.feature, id: s.id },
                          })
                        }
                      >
                        Open
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <NewStoryDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}

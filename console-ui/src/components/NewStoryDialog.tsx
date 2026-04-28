import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { api } from '~/api/client';
import type { ApiCreatedStory, ApiMeta, ApiStory } from '~/api/types';
import { Button } from '~/components/Button';
import { Dialog } from '~/components/Dialog';
import { Input } from '~/components/Input';
import { Select } from '~/components/Select';
import { slugifyClient } from '~/lib/slugify';

const NEW_FEATURE = '__new__';

function trackerFieldLabel(tracker: string): string {
  switch (tracker) {
    case 'jira':
      return 'Jira issue id';
    case 'azure':
      return 'Azure work item id';
    case 'github':
      return 'GitHub issue id';
    default:
      return 'Work item id';
  }
}

export function NewStoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const metaQ = useQuery({ queryKey: ['meta'], queryFn: () => api<ApiMeta>('/api/meta') });
  const storiesQ = useQuery({ queryKey: ['stories'], queryFn: () => api<ApiStory[]>('/api/stories') });

  const [featureChoice, setFeatureChoice] = useState(NEW_FEATURE);
  const [newFeature, setNewFeature] = useState('');
  const [title, setTitle] = useState('');
  const [trackerId, setTrackerId] = useState('');

  const features = useMemo(() => {
    const u = new Set<string>();
    for (const s of storiesQ.data ?? []) u.add(s.feature);
    return [...u].sort();
  }, [storiesQ.data]);

  const createM = useMutation({
    mutationFn: () => {
      const feature =
        featureChoice === NEW_FEATURE
          ? slugifyClient(newFeature.trim()) || 'feature'
          : featureChoice;
      const body: { feature: string; title?: string; trackerId?: string } = { feature, title: title.trim() || undefined };
      if (trackerId.trim()) body.trackerId = trackerId.trim();
      return api<ApiCreatedStory>('/api/stories', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['stories'] });
      onOpenChange(false);
      setTitle('');
      setTrackerId('');
      setNewFeature('');
      setFeatureChoice(NEW_FEATURE);
      void navigate({
        to: '/stories/$feature/$id',
        params: { feature: created.feature, id: created.id },
      });
    },
  });

  const tracker = metaQ.data?.tracker.type ?? 'none';
  const showTracker = tracker !== 'none';

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="New story"
      footer={
        <div className="flex w-full justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <Button
            type="button"
            disabled={createM.isPending}
            onClick={() => {
              createM.mutate();
            }}
          >
            Create
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1 text-xs text-[var(--color-text-dim)]">Feature</div>
          <Select
            value={featureChoice}
            onChange={(e) => setFeatureChoice(e.target.value)}
            disabled={!storiesQ.data && storiesQ.isLoading}
          >
            {features.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            <option value={NEW_FEATURE}>New feature…</option>
          </Select>
          {featureChoice === NEW_FEATURE && (
            <div className="mt-2">
              <Input
                placeholder="kebab-case feature slug"
                value={newFeature}
                onChange={(e) => setNewFeature(e.target.value)}
                onBlur={() => setNewFeature((v) => slugifyClient(v))}
              />
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 text-xs text-[var(--color-text-dim)]">Title (optional if tracker id set)</div>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" />
        </div>
        {showTracker && (
          <div>
            <div className="mb-1 text-xs text-[var(--color-text-dim)]">{trackerFieldLabel(tracker)} (optional)</div>
            <Input
              value={trackerId}
              onChange={(e) => setTrackerId(e.target.value)}
              placeholder="Leave empty to create without a tracker link"
            />
          </div>
        )}
        {createM.isError && (
          <p className="text-sm text-[var(--color-fail)]">{(createM.error as Error).message}</p>
        )}
      </div>
    </Dialog>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '~/api/client';
import type { ApiStoryDetail } from '~/api/types';
import { useConfirm } from '~/components/Confirm';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Card } from '~/components/Card';
import { Markdown } from '~/components/Markdown';
import { Page } from '~/components/Page';
import { Tabs } from '~/components/Tabs';
import { useToast } from '~/components/Toast';

function FieldTextarea({
  value,
  onChange,
  rows = 20,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <textarea
      className="w-full min-h-[320px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] outline-none focus:border-[var(--color-border-strong)] font-mono"
      value={value}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function StoryDetail() {
  const { feature, id } = useParams({ from: '/stories/$feature/$id' });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [editBody, setEditBody] = useState<string | null>(null);
  const [trash, setTrash] = useState(true);

  const q = useQuery({
    queryKey: ['story', feature, id],
    queryFn: () =>
      api<ApiStoryDetail>(`/api/stories/${encodeURIComponent(feature)}/${encodeURIComponent(id)}`),
  });

  useEffect(() => {
    setEditBody(null);
  }, [feature, id]);

  const content = q.data?.intakeContent ?? '';
  const draft = editBody !== null ? editBody : content;

  const saveM = useMutation({
    mutationFn: (body: string) =>
      api('/api/stories/' + encodeURIComponent(feature) + '/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify({ intakeContent: body }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stories'] });
      void qc.invalidateQueries({ queryKey: ['story', feature, id] });
    },
  });

  const delM = useMutation({
    mutationFn: () =>
      api(`/api/stories/${encodeURIComponent(feature)}/${encodeURIComponent(id)}?trash=${trash ? '1' : '0'}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stories'] });
      toast({ tone: 'success', title: 'Story deleted' });
      void navigate({ to: '/stories' } as never);
    },
  });

  async function onDelete() {
    const ok = await confirm({
      title: `Delete ${id}?`,
      description: `This removes the story folder from .squad/stories/${feature}/${id}/.`,
      tone: 'danger',
      confirmLabel: 'Delete story',
    });
    if (!ok) return;
    delM.mutate();
  }

  if (q.isLoading) {
    return (
      <Page title={id} description="…">
        <p className="text-[var(--color-text-muted)]">Loading…</p>
      </Page>
    );
  }
  if (q.isError) {
    return (
      <Page title={id} description="…">
        <Callout tone="danger">{(q.error as Error).message}</Callout>
      </Page>
    );
  }
  if (!q.data) return null;

  const d = q.data;
  const title = d.titleHint ?? id;

  return (
    <Page
      title={title}
      description={
        <span>
          <span className="font-mono text-[13px] text-[var(--color-text-muted)]">{d.id}</span>
          {d.planFile ? (
            <span className="text-[var(--color-text-muted)]">
              {' '}
              · plan <span className="font-mono">{d.planFile}</span>
            </span>
          ) : null}
        </span>
      }
      actions={
        <Button type="button" variant="danger" leftIcon={<Trash2 size={14} />} onClick={() => void onDelete()}>
          Delete story
        </Button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <div className="mb-4 flex items-center gap-2 text-sm">
            <Link to={'/stories' as never} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              ← Stories
            </Link>
          </div>
          <Tabs
            defaultIndex={0}
            tabs={[
              {
                id: 'preview',
                label: 'Preview',
                panel: <Markdown source={d.intakeContent} />,
              },
              {
                id: 'edit',
                label: 'Edit',
                panel: (
                  <div className="space-y-3">
                    <FieldTextarea value={draft} onChange={(v) => setEditBody(v)} />
                    <Button
                      type="button"
                      onClick={() => {
                        saveM.mutate(draft);
                      }}
                      disabled={saveM.isPending}
                    >
                      Save
                    </Button>
                  </div>
                ),
              },
            ]}
          />
          <div className="mt-6 border-t border-[var(--color-border)] pt-4">
            <label className="mb-3 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
              <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} className="rounded" />
              Move to trash (instead of permanent delete)
            </label>
          </div>
        </div>
        <Card className="h-fit" variant="default">
          <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-dim)]">Metadata</h3>
          <dl className="space-2 text-sm">
            <div>
              <dt className="text-[var(--color-text-dim)]">Feature</dt>
              <dd className="font-mono">{d.feature}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-text-dim)]">Id</dt>
              <dd className="font-mono break-all">{d.id}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-text-dim)]">intake.md</dt>
              <dd className="font-mono text-xs break-all text-[var(--color-text-muted)]">{d.intakePath}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-text-dim)]">Plan</dt>
              <dd>
                {d.planFile ? (
                  <Link
                    to="/plans/$feature/$planFile"
                    params={{ feature: d.feature, planFile: d.planFile }}
                    className="text-[var(--color-accent)] underline"
                  >
                    {d.planFile}
                  </Link>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </Page>
  );
}

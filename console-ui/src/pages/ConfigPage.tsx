import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import yaml from 'js-yaml';
import CodeMirror from '@uiw/react-codemirror';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { api } from '~/api/client';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Card } from '~/components/Card';
import { Field } from '~/components/Field';
import { Input } from '~/components/Input';
import { Page } from '~/components/Page';
import { Select } from '~/components/Select';
import { Tabs } from '~/components/Tabs';
import { Skeleton } from '~/components/Skeleton';
import { useToast } from '~/components/Toast';

type TrackerType = 'none' | 'github' | 'jira' | 'azure';
type ProviderName = 'anthropic' | 'openai' | 'google';

type SquadConfig = {
  version: number;
  project: { name: string; primaryLanguage?: string; projectRoots?: string[] };
  tracker: { type: TrackerType; workspace?: string; project?: string };
  naming: { includeTrackerId: boolean; globalSequence: boolean };
  agents: string[];
  planner?: {
    enabled: boolean;
    provider: ProviderName;
    mode?: 'auto' | 'copy';
    budget: {
      maxFileReads: number;
      maxContextBytes: number;
      maxDurationSeconds: number;
      maxCostUsd?: number;
    };
    modelOverride?: { anthropic?: string; openai?: string; google?: string };
    cache?: { enabled: boolean };
    maxOutputTokens?: number;
  };
};

const DEFAULT_PLANNER: NonNullable<SquadConfig['planner']> = {
  enabled: false,
  provider: 'anthropic',
  mode: 'auto',
  budget: {
    maxFileReads: 25,
    maxContextBytes: 50_000,
    maxDurationSeconds: 180,
  },
  cache: { enabled: true },
  maxOutputTokens: 16_384,
};

export function ConfigPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['config'], queryFn: () => api<SquadConfig>('/api/config') });
  const [draft, setDraft] = useState<SquadConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setDraft(structuredClone(q.data) as SquadConfig);
  }, [q.data]);

  const mut = useMutation({
    mutationFn: (body: SquadConfig) =>
      api<{ ok: true }>('/api/config', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setErr(null);
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['meta'] });
      toast({ tone: 'success', title: 'Config saved' });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const yamlView = useMemo(() => (draft ? yaml.dump(draft, { lineWidth: 100, noRefs: true, sortKeys: false }) : ''), [draft]);

  if (q.isPending || !draft) {
    return (
      <Page title="Config" description="Visual editor for .squad/config.yaml.">
        <Skeleton className="h-96 w-full" />
      </Page>
    );
  }

  const p: NonNullable<SquadConfig['planner']> = draft.planner
    ? { ...DEFAULT_PLANNER, ...draft.planner, budget: { ...DEFAULT_PLANNER.budget, ...draft.planner.budget } }
    : { ...DEFAULT_PLANNER, enabled: false };

  function setPlanner(next: NonNullable<SquadConfig['planner']>) {
    setDraft((d) => (d ? { ...d, planner: next } : d));
  }

  return (
    <Page
      title="Config"
      description="Edit workspace settings. Saving runs the same validation as the CLI. YAML tab is read-only — use your editor for raw edits."
    >
      {err ? <Callout tone="danger" title="Could not save">{err}</Callout> : null}

      <Tabs
        tabs={[
          {
            id: 'form',
            label: 'Form',
            panel: (
              <div className="space-y-4">
                <Card variant="default">
                  <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Project</h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Name">
                      {({ id, helperId }) => (
                        <Input
                          id={id}
                          aria-describedby={helperId}
                          value={draft.project.name}
                          onChange={(e) => setDraft({ ...draft, project: { ...draft.project, name: e.target.value } })}
                        />
                      )}
                    </Field>
                    <Field label="Primary language">
                      {({ id, helperId }) => (
                        <Input
                          id={id}
                          aria-describedby={helperId}
                          value={draft.project.primaryLanguage ?? ''}
                          onChange={(e) =>
                            setDraft({ ...draft, project: { ...draft.project, primaryLanguage: e.target.value } })
                          }
                        />
                      )}
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label="Project roots (comma-separated)" helper="Paths relative to the workspace root.">
                        {({ id, helperId }) => (
                          <Input
                            id={id}
                            aria-describedby={helperId}
                            className="font-mono"
                            value={(draft.project.projectRoots ?? ['.']).join(', ')}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                project: {
                                  ...draft.project,
                                  projectRoots: e.target.value
                                    .split(',')
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                },
                              })
                            }
                          />
                        )}
                      </Field>
                    </div>
                  </div>
                </Card>

                <Card variant="default">
                  <h2 className="mb-3 text-sm font-semibold">Tracker</h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <Field label="Type">
                        {({ id, helperId }) => (
                          <Select
                            id={id}
                            aria-describedby={helperId}
                            className="mt-0 w-full"
                            value={draft.tracker.type}
                            onChange={(e) =>
                              setDraft({ ...draft, tracker: { ...draft.tracker, type: e.target.value as TrackerType } })
                            }
                          >
                            <option value="none">none</option>
                            <option value="github">github</option>
                            <option value="jira">jira</option>
                            <option value="azure">azure</option>
                          </Select>
                        )}
                      </Field>
                    </div>
                    <Field label="Workspace" helper="Jira host or Azure org.">
                      {({ id, helperId }) => (
                        <Input
                          id={id}
                          aria-describedby={helperId}
                          placeholder="host (Jira) or org (Azure)"
                          value={draft.tracker.workspace ?? ''}
                          onChange={(e) =>
                            setDraft({ ...draft, tracker: { ...draft.tracker, workspace: e.target.value || undefined } })
                          }
                        />
                      )}
                    </Field>
                    <Field label="Project" helper="Azure project name if applicable.">
                      {({ id, helperId }) => (
                        <Input
                          id={id}
                          aria-describedby={helperId}
                          placeholder="Azure project name if applicable"
                          value={draft.tracker.project ?? ''}
                          onChange={(e) =>
                            setDraft({ ...draft, tracker: { ...draft.tracker, project: e.target.value || undefined } })
                          }
                        />
                      )}
                    </Field>
                  </div>
                </Card>

                <Card variant="default">
                  <h2 className="mb-3 text-sm font-semibold">Naming</h2>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.naming.includeTrackerId}
                      onChange={(e) => setDraft({ ...draft, naming: { ...draft.naming, includeTrackerId: e.target.checked } })}
                    />
                    includeTrackerId
                  </label>
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.naming.globalSequence}
                      onChange={(e) => setDraft({ ...draft, naming: { ...draft.naming, globalSequence: e.target.checked } })}
                    />
                    globalSequence
                  </label>
                </Card>

                <Card variant="default">
                  <h2 className="mb-3 text-sm font-semibold">Agents</h2>
                  <Field label="Agent ids" helper="One id per line.">
                    {({ id, helperId }) => (
                      <textarea
                        id={id}
                        aria-describedby={helperId}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono text-sm text-[var(--color-text)]"
                        rows={4}
                        placeholder="One agent id per line"
                        value={draft.agents.join('\n')}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            agents: e.target.value
                              .split('\n')
                              .map((l) => l.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    )}
                  </Field>
                </Card>

                <Card variant="default">
                  <h2 className="mb-3 text-sm font-semibold">Planner</h2>
                  <label className="mb-2 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setPlanner({
                            ...DEFAULT_PLANNER,
                            ...draft.planner,
                            enabled: true,
                            budget: {
                              ...DEFAULT_PLANNER.budget,
                              ...draft.planner?.budget,
                            },
                          });
                        } else {
                          setPlanner({ ...p, enabled: false });
                        }
                      }}
                    />
                    Enabled
                  </label>
                  {p.enabled && (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Provider">
                        {({ id, helperId }) => (
                          <Select
                            id={id}
                            aria-describedby={helperId}
                            className="w-full"
                            value={p.provider}
                            onChange={(e) => setPlanner({ ...p, provider: e.target.value as ProviderName })}
                          >
                            <option value="anthropic">anthropic</option>
                            <option value="openai">openai</option>
                            <option value="google">google</option>
                          </Select>
                        )}
                      </Field>
                      <Field label="Max output tokens">
                        {({ id, helperId }) => (
                          <Input
                            id={id}
                            aria-describedby={helperId}
                            type="number"
                            value={p.maxOutputTokens ?? 16_384}
                            onChange={(e) => setPlanner({ ...p, maxOutputTokens: Number(e.target.value) || 16_384 })}
                          />
                        )}
                      </Field>
                      <div className="sm:col-span-2">
                        <Field label="Model overrides (optional)" helper="Provider → model id.">
                          {({ id, helperId }) => (
                            <div id={id} aria-describedby={helperId} className="mt-0 grid gap-2 sm:grid-cols-3">
                              <Input
                                placeholder="anthropic"
                                className="font-mono text-xs"
                                value={p.modelOverride?.anthropic ?? ''}
                                onChange={(e) =>
                                  setPlanner({
                                    ...p,
                                    modelOverride: { ...p.modelOverride, anthropic: e.target.value || undefined },
                                  })
                                }
                              />
                              <Input
                                placeholder="openai"
                                className="font-mono text-xs"
                                value={p.modelOverride?.openai ?? ''}
                                onChange={(e) =>
                                  setPlanner({
                                    ...p,
                                    modelOverride: { ...p.modelOverride, openai: e.target.value || undefined },
                                  })
                                }
                              />
                              <Input
                                placeholder="google"
                                className="font-mono text-xs"
                                value={p.modelOverride?.google ?? ''}
                                onChange={(e) =>
                                  setPlanner({
                                    ...p,
                                    modelOverride: { ...p.modelOverride, google: e.target.value || undefined },
                                  })
                                }
                              />
                            </div>
                          )}
                        </Field>
                      </div>
                      <Field label="Budget: max file reads">
                        {({ id, helperId }) => (
                          <Input
                            id={id}
                            aria-describedby={helperId}
                            type="number"
                            value={p.budget.maxFileReads}
                            onChange={(e) =>
                              setPlanner({ ...p, budget: { ...p.budget, maxFileReads: Number(e.target.value) || 1 } })
                            }
                          />
                        )}
                      </Field>
                      <Field label="Max context bytes">
                        {({ id, helperId }) => (
                          <Input
                            id={id}
                            aria-describedby={helperId}
                            type="number"
                            value={p.budget.maxContextBytes}
                            onChange={(e) =>
                              setPlanner({ ...p, budget: { ...p.budget, maxContextBytes: Number(e.target.value) || 1 } })
                            }
                          />
                        )}
                      </Field>
                      <Field label="Max duration (sec)">
                        {({ id, helperId }) => (
                          <Input
                            id={id}
                            aria-describedby={helperId}
                            type="number"
                            value={p.budget.maxDurationSeconds}
                            onChange={(e) =>
                              setPlanner({ ...p, budget: { ...p.budget, maxDurationSeconds: Number(e.target.value) || 1 } })
                            }
                          />
                        )}
                      </Field>
                      <div className="sm:col-span-2">
                        <Field label="Max cost USD (optional)">
                          {({ id, helperId }) => (
                            <Input
                              id={id}
                              aria-describedby={helperId}
                              type="number"
                              step="0.01"
                              value={p.budget.maxCostUsd ?? ''}
                              onChange={(e) => {
                                const v = e.target.value;
                                setPlanner({
                                  ...p,
                                  budget: { ...p.budget, maxCostUsd: v === '' ? undefined : Number(v) },
                                });
                              }}
                            />
                          )}
                        </Field>
                      </div>
                      <label className="flex items-center gap-2 text-sm sm:col-span-2">
                        <input
                          type="checkbox"
                          checked={p.cache?.enabled !== false}
                          onChange={(e) => setPlanner({ ...p, cache: { enabled: e.target.checked } })}
                        />
                        Prompt cache enabled
                      </label>
                    </div>
                  )}
                </Card>

                <div className="flex justify-end">
                  <Button type="button" onClick={() => mut.mutate({ ...draft, planner: p })} loading={mut.isPending}>
                    Save changes
                  </Button>
                </div>
              </div>
            ),
          },
          {
            id: 'yaml',
            label: 'YAML',
            panel: (
              <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
                <CodeMirror
                  value={yamlView}
                  height="min(60vh, 480px)"
                  theme="dark"
                  extensions={[yamlLang()]}
                  editable={false}
                />
              </div>
            ),
          },
        ]}
      />
    </Page>
  );
}

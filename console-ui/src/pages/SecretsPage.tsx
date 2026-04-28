import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, UnauthorizedError } from '~/api/client';
import { Badge } from '~/components/Badge';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Card } from '~/components/Card';
import { Field } from '~/components/Field';
import { Input } from '~/components/Input';
import { Page } from '~/components/Page';
import { useToast } from '~/components/Toast';

type MaskedSecrets = {
  planner: { anthropic: string | null; openai: string | null; google: string | null };
  tracker: {
    jira: { host: string | null; email: string | null; token: string | null };
    azure: { organization: string | null; project: string | null; pat: string | null };
    github: { host: string | null; pat: string | null };
  };
};

async function postSecretsTest(path: string) {
  const token = sessionStorage.getItem('squad.console.token');
  if (!token) throw new UnauthorizedError();
  const res = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  if (res.status === 401) throw new UnauthorizedError();
  return (await res.json()) as Record<string, unknown>;
}

type TestState = { ok: boolean; message: string } | null;

function TokenRow({
  label,
  helper,
  display,
  onSave,
}: {
  label: string;
  helper: string;
  display: string | null;
  onSave: (plain: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [plain, setPlain] = useState('');

  if (!editing) {
    return (
      <div>
        <div className="text-[12px] font-medium text-[var(--color-text)]">{label}</div>
        <p className="text-[12px] text-[var(--color-text-muted)]">{helper}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="max-w-full break-all rounded bg-[var(--color-surface)] px-2 py-1 text-sm">{display ?? '—'}</code>
          <Button type="button" variant="secondary" onClick={() => { setPlain(''); setEditing(true); }}>
            Edit
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Field label={label} helper={helper}>
      {({ id, helperId }) => (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Input
            id={id}
            aria-describedby={helperId}
            type="password"
            className="flex-1"
            value={plain}
            onChange={(e) => setPlain(e.target.value)}
            autoComplete="off"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => {
                onSave(plain);
                setEditing(false);
                setPlain('');
              }}
            >
              Save
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setEditing(false);
                setPlain('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Field>
  );
}

export function SecretsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [globalErr, setGlobalErr] = useState<string | null>(null);
  const [jiraHost, setJiraHost] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [azOrg, setAzOrg] = useState('');
  const [azProj, setAzProj] = useState('');
  const [ghHost, setGhHost] = useState('');

  const [tAnth, setTAnth] = useState<TestState>(null);
  const [tOpen, setTOpen] = useState<TestState>(null);
  const [tGoo, setTGoo] = useState<TestState>(null);
  const [tJira, setTJira] = useState<TestState>(null);
  const [tAz, setTAz] = useState<TestState>(null);
  const [tGh, setTGh] = useState<TestState>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['secrets'], queryFn: () => api<MaskedSecrets>('/api/secrets') });
  const inited = useRef(false);
  const mut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ ok: true }>('/api/secrets', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setGlobalErr(null);
      void qc.invalidateQueries({ queryKey: ['secrets'] });
      toast({ tone: 'success', title: 'Secrets saved' });
    },
    onError: (e: Error) => setGlobalErr(e.message),
  });

  useEffect(() => {
    if (!q.data || inited.current) return;
    inited.current = true;
    setJiraHost(q.data.tracker.jira.host ?? '');
    setJiraEmail(q.data.tracker.jira.email ?? '');
    setAzOrg(q.data.tracker.azure.organization ?? '');
    setAzProj(q.data.tracker.azure.project ?? '');
    setGhHost(q.data.tracker.github.host ?? '');
  }, [q.data]);

  async function testProvider(
    p: 'anthropic' | 'openai' | 'google',
    set: (t: TestState) => void,
  ) {
    setBusy(p);
    set(null);
    try {
      const j = (await postSecretsTest(`/api/secrets/test/${p}`)) as
        | { ok: true; modelCount: number }
        | { ok: false; detail?: string; status?: number };
      if (j && 'ok' in j && j.ok) set({ ok: true, message: `${j.modelCount} models accessible` });
      else {
        const d = (j as { detail?: string }).detail ?? 'failed';
        const st = (j as { status?: number }).status;
        set({ ok: false, message: st ? `HTTP ${st} — ${d}` : String(d) });
      }
    } catch (e) {
      set({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function testJira() {
    setBusy('jira');
    setTJira(null);
    try {
      const j = (await postSecretsTest('/api/secrets/test/jira')) as { ok: boolean; detail?: string; status?: number };
      if (j.ok) setTJira({ ok: true, message: 'Jira reachable' });
      else setTJira({ ok: false, message: j.detail ? `Jira: ${j.detail}` : 'unreachable' });
    } catch (e) {
      setTJira({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function testAzure() {
    setBusy('azure');
    setTAz(null);
    try {
      const j = (await postSecretsTest('/api/secrets/test/azure')) as { ok: boolean; detail?: string; status?: number };
      if (j.ok) setTAz({ ok: true, message: 'Azure DevOps reachable' });
      else setTAz({ ok: false, message: j.detail ? `Azure: ${j.detail}` : 'unreachable' });
    } catch (e) {
      setTAz({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function testGitHub() {
    setBusy('github');
    setTGh(null);
    try {
      const j = (await postSecretsTest('/api/secrets/test/github')) as { ok: boolean; detail?: string; status?: number };
      if (j.ok) setTGh({ ok: true, message: 'GitHub reachable' });
      else setTGh({ ok: false, message: j.detail ? `GitHub: ${j.detail}` : 'unreachable' });
    } catch (e) {
      setTGh({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (q.isPending || !q.data) {
    return (
      <Page title="Secrets" description="Stored in .squad/secrets.yaml. Never committed.">
        <p className="text-[var(--color-text-muted)]">Loading…</p>
      </Page>
    );
  }

  const s = q.data;

  return (
    <Page title="Secrets" description="Stored in .squad/secrets.yaml. Never committed.">
      <p className="text-sm text-[var(--color-text-muted)]">
        Values are masked on read. For provider tests, save the key first, then test (the server only uses stored secrets).
      </p>
      {globalErr ? <Callout tone="danger">{globalErr}</Callout> : null}

      <div className="space-y-4">
        <Card variant="default">
          <h2 className="mb-3 text-sm font-semibold">Planner</h2>
          <div className="space-y-4">
            <TokenRow
              label="Anthropic API key"
              helper="Stored in .squad/secrets.yaml; never committed."
              display={s.planner.anthropic}
              onSave={(plain) => mut.mutate({ planner: { anthropic: plain } })}
            />
            {tAnth ? <Badge tone={tAnth.ok ? 'success' : 'danger'}>{tAnth.ok ? 'reachable' : 'failed'}</Badge> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={busy === 'anthropic'}
                onClick={async () => {
                  setTAnth(null);
                  await testProvider('anthropic', setTAnth);
                }}
              >
                Test connection
              </Button>
            </div>
            <TokenRow
              label="OpenAI API key"
              helper="Stored in .squad/secrets.yaml; never committed."
              display={s.planner.openai}
              onSave={(plain) => mut.mutate({ planner: { openai: plain } })}
            />
            {tOpen ? <Badge tone={tOpen.ok ? 'success' : 'danger'}>{tOpen.ok ? 'reachable' : 'failed'}</Badge> : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={busy === 'openai'}
              onClick={async () => { setTOpen(null); await testProvider('openai', setTOpen); }}
            >
              Test connection
            </Button>
            <TokenRow
              label="Google API key"
              helper="Stored in .squad/secrets.yaml; never committed."
              display={s.planner.google}
              onSave={(plain) => mut.mutate({ planner: { google: plain } })}
            />
            {tGoo ? <Badge tone={tGoo.ok ? 'success' : 'danger'}>{tGoo.ok ? 'reachable' : 'failed'}</Badge> : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={busy === 'google'}
              onClick={async () => { setTGoo(null); await testProvider('google', setTGoo); }}
            >
              Test connection
            </Button>
          </div>
        </Card>

        <Card variant="default">
          <h2 className="mb-3 text-sm font-semibold">Jira</h2>
          <div className="grid max-w-lg gap-3">
            <Field label="Host">
              {({ id, helperId }) => <Input id={id} aria-describedby={helperId} className="mt-0" value={jiraHost} onChange={(e) => setJiraHost(e.target.value)} />}
            </Field>
            <Field label="Email">
              {({ id, helperId }) => <Input id={id} aria-describedby={helperId} className="mt-0" value={jiraEmail} onChange={(e) => setJiraEmail(e.target.value)} />}
            </Field>
            <TokenRow
              label="Token"
              helper="Jira API token; stored in secrets."
              display={s.tracker.jira.token}
              onSave={(plain) => mut.mutate({ tracker: { jira: { token: plain } } })}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => mut.mutate({ tracker: { jira: { host: jiraHost, email: jiraEmail } } })}
                loading={mut.isPending}
              >
                Save Jira fields
              </Button>
              <Button
                type="button"
                variant="secondary"
                loading={busy === 'jira' || mut.isPending}
                onClick={async () => {
                  setTJira(null);
                  try {
                    await mut.mutateAsync({ tracker: { jira: { host: jiraHost, email: jiraEmail } } });
                    await testJira();
                  } catch {
                    /* mutation surfaced globalErr */
                  }
                }}
              >
                Save and test
              </Button>
            </div>
            {tJira ? <Badge tone={tJira.ok ? 'success' : 'danger'}>{tJira.message}</Badge> : null}
          </div>
        </Card>

        <Card variant="default">
          <h2 className="mb-3 text-sm font-semibold">Azure</h2>
          <div className="grid max-w-lg gap-3">
            <Field label="Organization">
              {({ id, helperId }) => <Input id={id} aria-describedby={helperId} className="mt-0" value={azOrg} onChange={(e) => setAzOrg(e.target.value)} />}
            </Field>
            <Field label="Project">
              {({ id, helperId }) => <Input id={id} aria-describedby={helperId} className="mt-0" value={azProj} onChange={(e) => setAzProj(e.target.value)} />}
            </Field>
            <TokenRow
              label="PAT"
              helper="Azure DevOps personal access token."
              display={s.tracker.azure.pat}
              onSave={(plain) => mut.mutate({ tracker: { azure: { pat: plain } } })}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => mut.mutate({ tracker: { azure: { organization: azOrg, project: azProj } } })}
                loading={mut.isPending}
              >
                Save Azure fields
              </Button>
              <Button
                type="button"
                variant="secondary"
                loading={busy === 'azure' || mut.isPending}
                onClick={async () => {
                  setTAz(null);
                  try {
                    await mut.mutateAsync({ tracker: { azure: { organization: azOrg, project: azProj } } });
                    await testAzure();
                  } catch {
                    /* globalErr */
                  }
                }}
              >
                Save and test
              </Button>
            </div>
            {tAz ? <Badge tone={tAz.ok ? 'success' : 'danger'}>{tAz.message}</Badge> : null}
          </div>
        </Card>

        <Card variant="default">
          <h2 className="mb-3 text-sm font-semibold">GitHub</h2>
          <p className="mb-3 text-[12px] text-[var(--color-text-muted)]">
            Owner and repo come from <code>tracker.workspace</code> and <code>tracker.project</code> on the Config page.
          </p>
          <div className="grid max-w-lg gap-3">
            <Field label="Host" helper="Leave blank for github.com; set for GitHub Enterprise Server (e.g. ghes.example.com).">
              {({ id, helperId }) => (
                <Input
                  id={id}
                  aria-describedby={helperId}
                  className="mt-0"
                  placeholder="api.github.com"
                  value={ghHost}
                  onChange={(e) => setGhHost(e.target.value)}
                />
              )}
            </Field>
            <TokenRow
              label="Personal access token"
              helper="GitHub PAT with repo (or fine-grained Issues: read) scope."
              display={s.tracker.github.pat}
              onSave={(plain) => mut.mutate({ tracker: { github: { pat: plain } } })}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => mut.mutate({ tracker: { github: { host: ghHost } } })}
                loading={mut.isPending}
              >
                Save GitHub fields
              </Button>
              <Button
                type="button"
                variant="secondary"
                loading={busy === 'github' || mut.isPending}
                onClick={async () => {
                  setTGh(null);
                  try {
                    await mut.mutateAsync({ tracker: { github: { host: ghHost } } });
                    await testGitHub();
                  } catch {
                    /* globalErr */
                  }
                }}
              >
                Save and test
              </Button>
            </div>
            {tGh ? <Badge tone={tGh.ok ? 'success' : 'danger'}>{tGh.message}</Badge> : null}
          </div>
        </Card>
      </div>
    </Page>
  );
}

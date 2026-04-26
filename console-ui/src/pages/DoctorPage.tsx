import { useState } from 'react';
import { RotateCw, Wrench } from 'lucide-react';
import { api } from '~/api/client';
import { Badge } from '~/components/Badge';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Card } from '~/components/Card';
import { Page } from '~/components/Page';
import { Skeleton } from '~/components/Skeleton';

type Check = {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail?: string;
  fixHint?: string;
  fixable?: boolean;
};

type DoctorRes = {
  root: string;
  checks: Check[];
  summary: { ok: number; warn: number; fail: number; skip: number };
};

function tokenForStatus(s: 'ok' | 'warn' | 'fail' | 'skip'): string {
  return {
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
    fail: 'var(--color-fail)',
    skip: 'var(--color-text-dim)',
  }[s];
}

function badgeToneForStatus(s: 'ok' | 'warn' | 'fail' | 'skip'): 'success' | 'warning' | 'danger' | 'default' {
  return {
    ok: 'success',
    warn: 'warning',
    fail: 'danger',
    skip: 'default',
  }[s] as 'success' | 'warning' | 'danger' | 'default';
}

export function DoctorPage() {
  const [data, setData] = useState<DoctorRes | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [fixPending, setFixPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(getFix: boolean) {
    setErr(null);
    if (getFix) setFixPending(true);
    else setPending(true);
    try {
      const res = await api<DoctorRes>(getFix ? '/api/doctor/fix' : '/api/doctor', { method: getFix ? 'POST' : 'GET' });
      setData(res);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPending(false);
      setFixPending(false);
    }
  }

  return (
    <Page
      title="Doctor"
      description="Graphical view of the same checks as `squad doctor`."
      actions={
        <Button type="button" onClick={() => void run(false)} loading={pending} leftIcon={<RotateCw size={14} />}>
          Run checks
        </Button>
      }
    >
      {err ? <Callout tone="danger">{err}</Callout> : null}

      {pending && !data && (
        <div className="space-y-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="flex flex-wrap gap-3 text-[13px]">
            <Badge tone="success">{data.summary.ok} ok</Badge>
            <Badge tone="warning">{data.summary.warn} warn</Badge>
            <Badge tone="danger">{data.summary.fail} fail</Badge>
            <Badge tone="default">{data.summary.skip} skip</Badge>
          </div>
          <Card variant="flat" className="p-0 overflow-hidden">
            <ul>
              {data.checks.map((c) => (
                <li key={c.id + c.name} className="border-t border-[var(--color-border)] first:border-t-0">
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--gray-4)]"
                    onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}
                  >
                    <span
                      aria-hidden
                      style={{ background: tokenForStatus(c.status) }}
                      className="mt-1 h-2 w-2 shrink-0 rounded-full"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge tone={badgeToneForStatus(c.status)}>{c.status}</Badge>
                        <span className="text-[13px] font-medium">{c.name}</span>
                      </div>
                      {open[c.id] && c.detail ? (
                        <pre className="mt-2 whitespace-pre-wrap break-words text-[12px] text-[var(--color-text-muted)]">
                          {c.detail}
                        </pre>
                      ) : null}
                    </div>
                  </button>
                  {c.fixable && c.status === 'warn' ? (
                    <div className="px-3 pb-3">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void run(true)}
                        loading={fixPending}
                        leftIcon={<Wrench size={14} />}
                      >
                        Apply repair
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </Page>
  );
}

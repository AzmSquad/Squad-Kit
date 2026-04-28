import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { api, UnauthorizedError } from '~/api/client';
import { Badge } from '~/components/Badge';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Dialog } from '~/components/Dialog';
import { Input } from '~/components/Input';
import { Page } from '~/components/Page';
import { Skeleton } from '~/components/Skeleton';
import { useToast } from '~/components/Toast';

type SearchRow = { id: string; title: string; type?: string; status?: string; url: string };

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function TrackerPage() {
  const nav = useNavigate();
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<SearchRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [load, setLoad] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pick, setPick] = useState<SearchRow | null>(null);
  const [feature, setFeature] = useState('');
  const [withAtt, setWithAtt] = useState(true);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (debounced === undefined) return;
      setLoad(true);
      setErr(null);
      try {
        const token = sessionStorage.getItem('squad.console.token');
        if (!token) throw new UnauthorizedError();
        const res = await fetch(`/api/tracker/search?q=${encodeURIComponent(debounced)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.status === 400) {
          const j = (await res.json()) as { error?: string; detail?: string };
          setErr(j.detail || j.error || 'Search unavailable');
          setRows(null);
          return;
        }
        if (!res.ok) {
          setErr(`HTTP ${res.status}`);
          setRows(null);
          return;
        }
        const j = (await res.json()) as { ok: boolean; results?: SearchRow[]; detail?: string };
        if (cancelled) return;
        if (j.ok && j.results) setRows(j.results);
        else {
          setRows([]);
          // TrackerError comes through as ok=false with detail
          if (j.detail) setErr(j.detail);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setLoad(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  function openImport(r: SearchRow) {
    setPick(r);
    setFeature(slugify(r.type ?? 'imported') || 'imported');
    setWithAtt(true);
    setImportOpen(true);
  }

  async function doImport() {
    if (!pick) return;
    setImporting(true);
    try {
      const created = await api<{ feature: string; id: string }>('/api/tracker/import', {
        method: 'POST',
        body: JSON.stringify({
          issueId: pick.id,
          feature,
          withAttachments: withAtt,
        }),
      });
      setImportOpen(false);
      const path = `${created.feature}/${created.id}`;
      toast({
        tone: 'success',
        title: 'Imported as story',
        description: path,
      });
      void nav({ to: '/stories/$feature/$id', params: { feature: created.feature, id: created.id } });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Page
      title="Tracker"
      description="Search Jira, Azure, or GitHub issues and import as stories. Configure the tracker in Config and credentials in Secrets."
    >
      <div className="max-w-2xl">
        <Input
          leftSlot={<Search size={14} />}
          placeholder="Search issues…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {err && !load && (
        <Callout tone="warning" title="Search">
          {err}
        </Callout>
      )}
      {load && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      )}
      {!load && rows && rows.length === 0 && !err && (
        <Callout tone="info">No results. Try a different query or check tracker configuration.</Callout>
      )}
      {!load && rows && rows.length > 0 && (
        <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {rows.map((r, i) => (
            <li
              key={r.id}
              className={`flex items-center gap-3 border-[var(--color-border)] px-3 py-[var(--space-row-y)] text-[13px] ${
                i > 0 ? 'border-t' : ''
              }`}
            >
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="w-24 shrink-0 font-mono text-[12px] text-[var(--color-accent)] hover:underline"
              >
                {r.id}
              </a>
              <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">{r.title}</span>
              <Badge tone="default">
                {r.type ?? '—'} · {r.status ?? '—'}
              </Badge>
              <Button type="button" size="sm" onClick={() => openImport(r)}>
                Import
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[12px] text-[var(--color-text-dim)]">
        Configure the tracker in{' '}
        <Link to={'/config' as never} className="text-[var(--color-accent)] underline">
          Config
        </Link>{' '}
        and credentials in{' '}
        <Link to={'/secrets' as never} className="text-[var(--color-accent)] underline">
          Secrets
        </Link>
        .
      </p>

      <Dialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import as story"
        footer={
          <div className="flex w-full flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={doImport} disabled={importing || !feature.trim()} loading={importing}>
              Import
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            Issue: {pick?.id} — {pick?.title}
          </p>
          <label className="block text-[var(--color-text-muted)]">
            Feature slug
            <Input className="mt-1" value={feature} onChange={(e) => setFeature(e.target.value)} />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={withAtt} onChange={(e) => setWithAtt(e.target.checked)} />
            Download attachments
          </label>
        </div>
      </Dialog>
    </Page>
  );
}

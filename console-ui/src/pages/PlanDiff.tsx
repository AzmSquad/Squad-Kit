import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState, type CSSProperties } from 'react';
import { api } from '~/api/client';
import type { PlanDiffChange } from '~/api/types';
import { Button } from '~/components/Button';
import { Callout } from '~/components/Callout';
import { Card } from '~/components/Card';
import { Page } from '~/components/Page';

const TRUNC = 5;

function splitBody(ch: PlanDiffChange): string[] {
  return ch.value.replace(/\n$/, '').split('\n');
}

const ctxStyle: CSSProperties = { color: 'var(--color-text)' };
const removedStyle: CSSProperties = {
  background: 'var(--color-fail-bg)',
  color: 'var(--color-fail)',
  borderLeft: '3px solid var(--color-fail)',
};
const addedStyle: CSSProperties = {
  background: 'var(--color-ok-bg)',
  color: 'var(--color-ok)',
  borderLeft: '3px solid var(--color-ok)',
};

export function PlanDiff() {
  const { feature } = useParams({ from: '/plans/$feature/diff' });
  const { a, b } = useSearch({ from: '/plans/$feature/diff' });
  const navigate = useNavigate();
  const [openIdx, setOpenIdx] = useState<Set<number>>(() => new Set());

  const q = useQuery({
    queryKey: ['planDiff', feature, a, b],
    enabled: Boolean(a && b),
    queryFn: () =>
      api<{
        feature: string;
        a: string;
        b: string;
        changes: PlanDiffChange[];
      }>(
        `/api/plans/diff?feature=${encodeURIComponent(feature)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
      ),
  });

  if (!a || !b) {
    return (
      <Page title="Plan diff" description="Compare two plan files.">
        <Callout tone="warning">Select two plan files to compare (missing a or b).</Callout>
      </Page>
    );
  }

  if (q.isLoading) {
    return (
      <Page title="Plan diff" description={`${a} ↔ ${b}`}>
        <p className="text-[var(--color-text-muted)]">Computing diff…</p>
      </Page>
    );
  }
  if (q.isError) {
    return (
      <Page title="Plan diff" description={`${a} ↔ ${b}`}>
        <Callout tone="danger">{(q.error as Error).message}</Callout>
      </Page>
    );
  }
  if (!q.data) return null;

  const swap = () => {
    void navigate({ to: '/plans/$feature/diff', params: { feature }, search: { a: b, b: a } });
  };

  return (
    <Page title="Plan diff" description={`${a} ↔ ${b}`}>
      <div className="mb-4 text-sm">
        <Link to={'/plans' as never} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          ← Plans
        </Link>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="secondary" onClick={swap}>
          Swap A ↔ B
        </Button>
      </div>
      <div className="mb-2 grid grid-cols-2 gap-2 text-xs text-[var(--color-text-dim)]">
        <div className="truncate pr-1 font-mono">A: {a}</div>
        <div className="truncate pl-1 font-mono">B: {b}</div>
      </div>
      <Card variant="inset">
        <div className="space-y-2">
          {q.data.changes.map((ch, i) => {
            const isUn = !ch.added && !ch.removed;
            if (isUn) {
              const lines = splitBody(ch);
              const needCollapse = lines.length > TRUNC && !openIdx.has(i);
              const show = needCollapse
                ? `${lines.slice(0, 2).join('\n')}\n… ${lines.length - 4} unchanged lines hidden …\n${lines.slice(-2).join('\n')}`
                : lines.join('\n');
              return (
                <div key={i} className="grid grid-cols-2 gap-2">
                  <div
                    className="min-w-0 rounded border border-[var(--color-border)] p-2 font-mono text-xs whitespace-pre-wrap break-words"
                    style={ctxStyle}
                  >
                    {show}
                    {needCollapse && (
                      <div className="mt-1">
                        <Button type="button" variant="ghost" onClick={() => setOpenIdx((s) => new Set(s).add(i))}>
                          Expand {lines.length - 4} lines
                        </Button>
                      </div>
                    )}
                  </div>
                  <div
                    className="min-w-0 rounded border border-[var(--color-border)] p-2 font-mono text-xs whitespace-pre-wrap break-words"
                    style={ctxStyle}
                  >
                    {show}
                    {needCollapse && (
                      <div className="mt-1">
                        <Button type="button" variant="ghost" onClick={() => setOpenIdx((s) => new Set(s).add(i))}>
                          Expand {lines.length - 4} lines
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            const left = ch.added
              ? ''
              : ch.value.endsWith('\n')
                ? ch.value.slice(0, -1)
                : ch.value;
            const right = ch.removed
              ? ''
              : ch.value.endsWith('\n')
                ? ch.value.slice(0, -1)
                : ch.value;
            return (
              <div key={i} className="grid grid-cols-2 gap-2">
                <div
                  className="min-w-0 rounded border border-[var(--color-border)] p-2 font-mono text-xs whitespace-pre-wrap break-words"
                  style={ch.removed ? removedStyle : ctxStyle}
                >
                  {left}
                </div>
                <div
                  className="min-w-0 rounded border border-[var(--color-border)] p-2 font-mono text-xs whitespace-pre-wrap break-words"
                  style={ch.added ? addedStyle : ctxStyle}
                >
                  {right}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </Page>
  );
}

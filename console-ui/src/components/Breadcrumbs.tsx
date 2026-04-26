import { Link, useMatches } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

interface Crumb {
  label: ReactNode;
  to: string;
}

const labelByPath: Record<string, string> = {
  '/':         'Dashboard',
  '/stories':  'Stories',
  '/plans':    'Plans',
  '/generate': 'Generate plan',
  '/config':   'Config',
  '/secrets':  'Secrets',
  '/tracker':  'Tracker',
  '/doctor':   'Doctor',
};

interface ParamShape {
  feature?: string;
  id?: string;
  planFile?: string;
}

export function Breadcrumbs() {
  const matches = useMatches();
  // Build crumbs from route matches; drop the root match.
  const crumbs: Crumb[] = [];
  for (const m of matches) {
    const params = (m.params ?? {}) as ParamShape;
    if (m.routeId === '__root__') continue;

    // The TanStack Router `routeId` is e.g. "/stories/$feature/$id".
    // We synthesize a stable href from `m.pathname` (or route path resolution).
    const path = m.pathname;
    if (labelByPath[path]) {
      crumbs.push({ label: labelByPath[path], to: path });
      continue;
    }
    if (path.startsWith('/stories/') && params.feature && params.id) {
      crumbs.push({ label: 'Stories', to: '/stories' });
      crumbs.push({ label: params.feature, to: '/stories' });
      crumbs.push({ label: params.id, to: path });
      continue;
    }
    if (path.startsWith('/plans/') && path.endsWith('/diff') && params.feature) {
      crumbs.push({ label: 'Plans', to: '/plans' });
      crumbs.push({ label: params.feature, to: '/plans' });
      crumbs.push({ label: 'diff', to: path });
      continue;
    }
    if (path.startsWith('/plans/') && params.feature && params.planFile) {
      crumbs.push({ label: 'Plans', to: '/plans' });
      crumbs.push({ label: params.feature, to: '/plans' });
      crumbs.push({ label: params.planFile, to: path });
      continue;
    }
  }

  // Deduplicate consecutive identical entries (e.g. /stories renders both as
  // a parent and child match in some router versions).
  const seen = new Set<string>();
  const unique = crumbs.filter((c) => {
    const k = `${c.label}|${c.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (unique.length === 0) return null;

  return (
    <nav aria-label="Breadcrumbs" className="flex min-w-0 items-center gap-1 text-[13px]">
      {unique.map((c, i) => {
        const last = i === unique.length - 1;
        return (
          <span key={`${c.to}-${i}`} className="flex min-w-0 items-center gap-1">
            {i > 0 ? (
              <ChevronRight size={12} className="text-[var(--color-text-dim)]" aria-hidden />
            ) : null}
            {last ? (
              <span className="truncate font-medium text-[var(--color-text)]">{c.label}</span>
            ) : (
              <Link
                to={c.to as never}
                className="truncate text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
              >
                {c.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

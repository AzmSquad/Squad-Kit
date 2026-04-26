import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard,
  ListChecks,
  FileText,
  Sparkles,
  Settings,
  Lock,
  KanbanSquare,
  Stethoscope,
  ChevronDown,
  Folder,
} from 'lucide-react';
import { api } from '~/api/client';
import type { ApiMeta, ApiRecentProject } from '~/api/types';
import { Skeleton } from './Skeleton';
import { Badge } from './Badge';
import { useToast } from './Toast';
import { Kbd } from './Kbd';

interface NavItem {
  to: string;
  label: string;
  Icon: typeof LayoutDashboard;
  exact?: boolean;
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

const sections: NavSection[] = [
  {
    heading: 'Workspace',
    items: [
      { to: '/',        label: 'Dashboard', Icon: LayoutDashboard, exact: true },
      { to: '/stories', label: 'Stories',   Icon: ListChecks },
      { to: '/plans',   label: 'Plans',     Icon: FileText },
    ],
  },
  {
    heading: 'Run',
    items: [
      { to: '/generate', label: 'Generate plan', Icon: Sparkles },
    ],
  },
  {
    heading: 'Settings',
    items: [
      { to: '/config',  label: 'Config',  Icon: Settings },
      { to: '/secrets', label: 'Secrets', Icon: Lock },
      { to: '/tracker', label: 'Tracker', Icon: KanbanSquare },
      { to: '/doctor',  label: 'Doctor',  Icon: Stethoscope },
    ],
  },
];

const linkBase =
  'group flex items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--gray-3)] hover:text-[var(--color-text)]';
const linkActive =
  'bg-[var(--gray-3)] text-[var(--color-text)]';

function basenamePath(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : root;
}

function quotePath(p: string): string {
  if (/^[\w./:@+-]+$/.test(p) && !p.includes("'")) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function Sidebar() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const metaQ = useQuery({ queryKey: ['meta'], queryFn: () => api<ApiMeta>('/api/meta') });
  const recentQ = useQuery({
    queryKey: ['recent-projects'],
    queryFn: () => api<ApiRecentProject[]>('/api/projects/recent'),
  });

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const meta = metaQ.data;
  const projectName = meta?.project.name ?? null;
  const root = meta?.root ?? '';

  async function handoffOtherProject(targetRoot: string) {
    if (!targetRoot || targetRoot === root) {
      setOpen(false);
      return;
    }
    const cmd = `cd ${quotePath(targetRoot)} && squad console`;
    try {
      await navigator.clipboard.writeText(cmd);
      toast({
        tone: 'info',
        title: 'Command copied',
        description: 'Run it in another terminal to open this project.',
      });
    } catch {
      toast({ tone: 'warning', title: 'Copy failed', description: cmd });
    }
    setOpen(false);
    void qc.invalidateQueries({ queryKey: ['recent-projects'] });
  }

  return (
    <aside
      className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--gray-2)] px-3 py-4"
      aria-label="Primary navigation"
    >
      {/* Brand header */}
      <div className="mb-3 flex items-center gap-2 px-1.5">
        <img src="/logo.svg" alt="" className="h-6 w-6" />
        <div className="text-sm font-semibold tracking-tight text-[var(--color-text)]">
          squad <span className="text-[var(--color-text-muted)]">console</span>
        </div>
      </div>

      {/* Project switcher (was in the topbar) */}
      <div className="relative mb-4 px-0.5" ref={wrapRef}>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--gray-3)] px-2.5 py-2 text-left text-[13px] text-[var(--color-text)] transition-colors hover:bg-[var(--gray-4)]"
        >
          <Folder size={14} className="text-[var(--color-text-dim)]" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {metaQ.isPending ? <Skeleton className="h-4 w-32" /> : projectName ?? '—'}
          </span>
          <ChevronDown size={14} className="text-[var(--color-text-dim)]" aria-hidden />
        </button>
        {open && !recentQ.isPending ? (
          <div
            role="listbox"
            className="absolute left-0 top-full z-[var(--z-overlay)] mt-1 max-h-72 w-full overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--gray-3)] py-1 shadow-2xl"
          >
            {recentQ.data && recentQ.data.length > 0 ? (
              recentQ.data.map((p) => (
                <button
                  key={p.root}
                  type="button"
                  role="option"
                  aria-selected={p.root === root}
                  onClick={() => handoffOtherProject(p.root)}
                  className="flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--gray-4)]"
                >
                  <span className="font-medium text-[var(--color-text)]">{basenamePath(p.root)}</span>
                  <span className="w-full truncate font-mono text-[10px] text-[var(--color-text-dim)]">{p.root}</span>
                </button>
              ))
            ) : (
              <div className="px-2.5 py-1.5 text-[12px] text-[var(--color-text-muted)]">No recent projects yet.</div>
            )}
          </div>
        ) : null}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-4 overflow-auto">
        {sections.map((section) => (
          <div key={section.heading}>
            <div className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
              {section.heading}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((it) => (
                <li key={it.to}>
                  <Link
                    to={it.to as never}
                    className={linkBase}
                    activeProps={{ className: `${linkBase} ${linkActive}` }}
                    activeOptions={{ exact: it.exact ?? false }}
                  >
                    <it.Icon size={14} className="text-[var(--color-text-dim)] group-hover:text-[var(--color-text)] group-aria-[current=page]:text-[var(--color-text)]" aria-hidden />
                    <span>{it.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3 px-1.5">
        <div className="flex items-center justify-between text-[11px] text-[var(--color-text-dim)]">
          <span>v{meta?.version ?? '—'}</span>
          {meta?.planner ? (
            <Badge tone={meta.planner.enabled ? 'success' : 'default'} dot={meta.planner.enabled}>
              {meta.planner.provider}
            </Badge>
          ) : (
            <Badge tone="default">planner off</Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-dim)]">
          <span>Search</span>
          <Kbd>⌘K</Kbd>
        </div>
      </div>
    </aside>
  );
}

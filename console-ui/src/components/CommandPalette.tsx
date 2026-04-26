import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Command } from 'cmdk';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  ListChecks,
  FileText,
  Sparkles,
  Settings,
  Lock,
  KanbanSquare,
  Stethoscope,
  Plus,
  PlayCircle,
  Activity,
  Search,
} from 'lucide-react';
import { api } from '~/api/client';
import type { ApiPlan, ApiStory } from '~/api/types';
import { useDensity } from '~/hooks/useDensity';

const pageItems = [
  { id: 'pg-dashboard', label: 'Dashboard', to: '/', Icon: LayoutDashboard, hint: 'g d' },
  { id: 'pg-stories', label: 'Stories', to: '/stories', Icon: ListChecks, hint: 'g s' },
  { id: 'pg-plans', label: 'Plans', to: '/plans', Icon: FileText, hint: 'g p' },
  { id: 'pg-generate', label: 'Generate plan', to: '/generate', Icon: Sparkles, hint: 'g r' },
  { id: 'pg-config', label: 'Config', to: '/config', Icon: Settings, hint: 'g c' },
  { id: 'pg-secrets', label: 'Secrets', to: '/secrets', Icon: Lock, hint: 'g k' },
  { id: 'pg-tracker', label: 'Tracker', to: '/tracker', Icon: KanbanSquare, hint: 'g t' },
  { id: 'pg-doctor', label: 'Doctor', to: '/doctor', Icon: Stethoscope, hint: 'g h' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const navigate = useNavigate();
  const { toggle: toggleDensity } = useDensity();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onCustom = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('squad:cmdk:open', onCustom);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('squad:cmdk:open', onCustom);
    };
  }, []);

  const storiesQ = useQuery({
    queryKey: ['stories'],
    queryFn: () => api<ApiStory[]>('/api/stories'),
    enabled: open,
  });
  const plansQ = useQuery({
    queryKey: ['plans'],
    queryFn: () => api<ApiPlan[]>('/api/plans'),
    enabled: open,
  });

  const recentStories = (storiesQ.data ?? []).slice(0, 5);
  const recentPlans = (plansQ.data ?? []).slice(0, 5);

  const close = () => {
    setOpen(false);
    setValue('');
  };

  if (!open) return null;

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center p-4 pt-[12vh] animate-fade-in"
      style={{ background: 'rgba(0,0,0,0.6)' }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-2xl animate-fade-up">
        <Command label="Command palette" value={value} onValueChange={setValue} loop>
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
            <Search size={14} className="text-[var(--color-text-dim)]" aria-hidden />
            <Command.Input
              placeholder="Type a command or search…"
              className="flex-1 bg-transparent py-1.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] outline-none"
              autoFocus
            />
          </div>
          <Command.List className="max-h-[60vh] overflow-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-sm text-[var(--color-text-muted)]">
              No matches.
            </Command.Empty>

            <Command.Group heading="Pages" className="mb-2">
              {pageItems.map((it) => (
                <Command.Item
                  key={it.id}
                  value={`page ${it.label}`}
                  onSelect={() => {
                    navigate({ to: it.to as never });
                    close();
                  }}
                  className="cmdk-row"
                >
                  <it.Icon size={14} className="text-[var(--color-text-dim)]" aria-hidden />
                  <span className="flex-1">{it.label}</span>
                  <span className="kbd">{it.hint}</span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Actions" className="mb-2">
              <Command.Item
                value="action new story"
                onSelect={() => {
                  navigate({ to: '/stories' as never });
                  window.dispatchEvent(new CustomEvent('squad:dialog:new-story'));
                  close();
                }}
                className="cmdk-row"
              >
                <Plus size={14} className="text-[var(--color-text-dim)]" aria-hidden />
                <span className="flex-1">New story</span>
                <span className="kbd">n s</span>
              </Command.Item>
              <Command.Item
                value="action generate plan from latest unplanned story"
                onSelect={() => {
                  navigate({ to: '/generate' as never });
                  close();
                }}
                className="cmdk-row"
              >
                <PlayCircle size={14} className="text-[var(--color-text-dim)]" aria-hidden />
                <span className="flex-1">Generate plan from latest unplanned story</span>
              </Command.Item>
              <Command.Item
                value="action run doctor"
                onSelect={() => {
                  navigate({ to: '/doctor' as never });
                  close();
                }}
                className="cmdk-row"
              >
                <Activity size={14} className="text-[var(--color-text-dim)]" aria-hidden />
                <span className="flex-1">Run doctor</span>
              </Command.Item>
              <Command.Item
                value="action open config"
                onSelect={() => {
                  navigate({ to: '/config' as never });
                  close();
                }}
                className="cmdk-row"
              >
                <Settings size={14} className="text-[var(--color-text-dim)]" aria-hidden />
                <span className="flex-1">Open config</span>
              </Command.Item>
              <Command.Item
                value="action switch density"
                onSelect={() => {
                  toggleDensity();
                  close();
                }}
                className="cmdk-row"
              >
                <Settings size={14} className="text-[var(--color-text-dim)]" aria-hidden />
                <span className="flex-1">Switch density</span>
              </Command.Item>
              <Command.Item
                value="action keyboard shortcuts"
                onSelect={() => {
                  close();
                  window.dispatchEvent(new CustomEvent('squad:dialog:shortcuts'));
                }}
                className="cmdk-row"
              >
                <Settings size={14} className="text-[var(--color-text-dim)]" aria-hidden />
                <span className="flex-1">Open keyboard shortcuts</span>
                <span className="kbd">?</span>
              </Command.Item>
            </Command.Group>

            {recentStories.length > 0 ? (
              <Command.Group heading="Recent stories" className="mb-2">
                {recentStories.map((s) => (
                  <Command.Item
                    key={`s-${s.feature}-${s.id}`}
                    value={`story ${s.feature} ${s.id} ${s.titleHint ?? ''}`}
                    onSelect={() => {
                      navigate({
                        to: '/stories/$feature/$id',
                        params: { feature: s.feature, id: s.id },
                      } as never);
                      close();
                    }}
                    className="cmdk-row"
                  >
                    <ListChecks size={14} className="text-[var(--color-text-dim)]" aria-hidden />
                    <span className="font-mono text-[12px] text-[var(--color-text-muted)]">{s.feature}/</span>
                    <span className="flex-1 truncate">{s.titleHint || s.id}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}

            {recentPlans.length > 0 ? (
              <Command.Group heading="Recent plans">
                {recentPlans.map((p) => (
                  <Command.Item
                    key={`p-${p.feature}-${p.planFile}`}
                    value={`plan ${p.feature} ${p.planFile}`}
                    onSelect={() => {
                      navigate({
                        to: '/plans/$feature/$planFile',
                        params: { feature: p.feature, planFile: p.planFile },
                      } as never);
                      close();
                    }}
                    className="cmdk-row"
                  >
                    <FileText size={14} className="text-[var(--color-text-dim)]" aria-hidden />
                    <span className="font-mono text-[12px] text-[var(--color-text-muted)]">{p.feature}/</span>
                    <span className="flex-1 truncate">{p.planFile}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
        </Command>
      </div>
    </div>,
    document.body,
  );
}

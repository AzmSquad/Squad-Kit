import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, send } from '../api/client';
import type { AppSettings, ArchitectureResponse, BoardResponse, ReleaseWithItems, Ticket, ProjectApp } from '../api/types';
import { usePrefs } from './prefs';

/** The squad writes to .squad/ on its own, so screens poll to stay live. */
const LIVE_MS = 900;

export function useBoard() {
  return useQuery({ queryKey: ['board'], queryFn: () => api<BoardResponse>('/api/v1/board'), refetchInterval: LIVE_MS });
}

export function useTicket(id: string | undefined) {
  return useQuery({
    queryKey: ['ticket', id],
    queryFn: () => api<Ticket>(`/api/v1/tickets/${id}`),
    enabled: Boolean(id),
    refetchInterval: LIVE_MS,
  });
}

export function useReleases() {
  return useQuery({ queryKey: ['releases'], queryFn: () => api<ReleaseWithItems[]>('/api/v1/releases'), refetchInterval: 2000 });
}

export function useApps() {
  return useQuery({ queryKey: ['apps'], queryFn: () => api<{ apps: ProjectApp[] }>('/api/v1/apps'), refetchInterval: 5000 });
}

/** How many tickets run at once: one number for every project in the app, because they share the AI accounts. */
export function useAppSettings() {
  return useQuery({ queryKey: ['app', 'settings'], queryFn: () => api<AppSettings>('/api/v1/app/settings'), refetchInterval: 5000 });
}

export function useArchitecture() {
  return useQuery({ queryKey: ['architecture'], queryFn: () => api<ArchitectureResponse>('/api/v1/architecture'), refetchInterval: 2000 });
}

/** A person action: POST it, refresh everything, and show the result or the error in plain words. */
export function useAct<T = unknown>() {
  const qc = useQueryClient();
  const { toast } = usePrefs();
  return useMutation({
    mutationFn: ({ path, body, method = 'POST' }: { path: string; body?: unknown; method?: 'POST' | 'PUT'; done?: string }) =>
      send<T>(path, method, body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries();
      if (vars.done) toast(vars.done);
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), 'err'),
  });
}

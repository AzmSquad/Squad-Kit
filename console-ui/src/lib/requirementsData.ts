import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, PROJECT, api, apiPath, send, worthRetrying } from '../api/client';
import type { BreakdownRow, BreakdownView, SendPreview } from '../api/requirements-types';
import { jobBusy, type SendPlanned } from './requirements';
import { usePrefs } from './prefs';

/**
 * The Requirements page's data: the list, one breakdown and the send preview, each one REST call. A breakdown polls
 * fast while something moves on it (the Analyst, the build, a send) and slowly when it waits for the person.
 */

const TOKEN_KEY = 'squad.console.token';

export function useBreakdowns(poll = 3000) {
  return useQuery({ queryKey: ['requirements'], queryFn: () => api<{ breakdowns: BreakdownRow[] }>('/api/v1/requirements'), refetchInterval: poll });
}

/** True while something on the breakdown moves by itself, so the page should look again soon. */
export function moving(v: BreakdownView | undefined): boolean {
  if (!v) return false;
  return jobBusy(v.state.job) || Boolean(v.state.build?.on) || v.state.sync?.status === 'running' || v.state.sync?.status === 'pending' || v.counts.building > 0 || v.questions.some((q) => q.thinking);
}

export function useBreakdown(id: string) {
  return useQuery({
    queryKey: ['requirement', id],
    queryFn: () => api<BreakdownView>(`/api/v1/requirements/${encodeURIComponent(id)}`),
    refetchInterval: (q) => (q.state.status === 'error' ? 10_000 : moving(q.state.data) ? 1000 : 4000),
    retry: false,
  });
}

/** What Send would do. Nothing is sent by it. */
export function useSendPreview(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['requirement-send', id],
    queryFn: () => api<SendPreview>(`/api/v1/requirements/${encodeURIComponent(id)}/send`),
    enabled,
    retry: false,
    staleTime: 0,
  });
}

/** Most changes answer with the breakdown; adding a part and starting a story answer with it beside what they made. */
function viewOf(data: unknown): BreakdownView | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { breakdown?: unknown; epics?: unknown; id?: unknown };
  if (Array.isArray(d.epics) && typeof d.id === 'string') return d as BreakdownView;
  if (d.breakdown) return viewOf(d.breakdown);
  return null;
}

export interface ReqAction {
  path: string;
  body?: unknown;
  method?: 'POST' | 'PATCH' | 'DELETE';
  /** The note to show when it worked. */
  done?: string;
  /** The caller shows the error where it happened (a dialog), so no error note. */
  quiet?: boolean;
}

/**
 * A button on the Requirements page: one REST call. The breakdown it answers with goes straight onto the page, so
 * nothing jumps while the next poll comes; errors show in plain words with Try again when that may help.
 */
export function useReqAct<T = unknown>() {
  const qc = useQueryClient();
  const { toast } = usePrefs();
  const m = useMutation({
    mutationFn: ({ path, body, method = 'POST' }: ReqAction) => send<T>(path, method, body ?? {}),
    onSuccess: (data, vars) => {
      const v = viewOf(data);
      if (v) qc.setQueryData(['requirement', v.id], v);
      void qc.invalidateQueries({ queryKey: ['requirements'] });
      void qc.invalidateQueries({ queryKey: ['board'] });
      if (vars.done) toast(vars.done);
    },
    onError: (err, vars) => {
      if (!vars.quiet) toast(actionError(err), 'err', worthRetrying(err) ? () => m.mutate(vars) : undefined);
    },
  });
  return m;
}

/** An action's error in plain words. A route this squad-kit does not have yet says so, instead of "404 Not Found". */
export function actionError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404 && /^404\b/.test(err.message)) return 'This squad-kit cannot do that yet. Update squad-kit, then try again.';
  return err instanceof Error ? err.message : String(err);
}

/** A file of the breakdown (the document, its text, its pictures) as a link: links cannot send a header. */
export function reqFileUrl(id: string, file: string): string {
  const token = sessionStorage.getItem(TOKEN_KEY) ?? '';
  return `${apiPath(`/api/v1/requirements/${encodeURIComponent(id)}/file`)}?path=${encodeURIComponent(file)}&t=${encodeURIComponent(token)}`;
}

/* ── What a send promised ───────────────────────────────── */

const planKey = (id: string) => `squad.send-plan.${PROJECT ?? ''}.${id}`;

/** Keeps what the Send dialog said it sends, so its progress uses the same numbers after the dialog closes. */
export function rememberSendPlan(id: string, plan: SendPlanned): void {
  try {
    sessionStorage.setItem(planKey(id), JSON.stringify(plan));
  } catch {
    // No storage: the progress shows the bar alone.
  }
}

/** What the Send dialog said, for this breakdown's send, if this tab knows it. */
export function sendPlanOf(id: string): SendPlanned | null {
  try {
    const raw = sessionStorage.getItem(planKey(id));
    const p = raw ? (JSON.parse(raw) as SendPlanned) : null;
    return p && typeof p.items === 'number' && typeof p.links === 'number' ? p : null;
  } catch {
    return null;
  }
}

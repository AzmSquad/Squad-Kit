import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/api/client';
import type { ApiPlannerAuth } from '~/api/types';

/**
 * Anthropic credential state. Shared by Config, Secrets and Generate so a single fetch backs all
 * three, and so a Config save or a Secrets mutation can invalidate one key and refresh everything.
 *
 * Note the name: this is the *planner's* Anthropic auth, not the console's own loopback URL token
 * (that lives in `~/api/client`). Never conflate the two in a query key or in UI copy.
 */
export const PLANNER_AUTH_QUERY_KEY = ['planner-auth'] as const;

export function usePlannerAuth() {
  return useQuery({
    queryKey: PLANNER_AUTH_QUERY_KEY,
    // No `probe=1`: a page load must never spawn an Agent SDK subprocess.
    queryFn: () => api<ApiPlannerAuth>('/api/planner-auth'),
  });
}

/**
 * The explicit "Check again" action. This is the only caller that asks for `probe=1`; the result is
 * written straight into the shared cache so the account card and the Generate badge agree.
 */
export function usePlannerAuthProbe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<ApiPlannerAuth>('/api/planner-auth?probe=1'),
    onSuccess: (data) => qc.setQueryData(PLANNER_AUTH_QUERY_KEY, data),
  });
}

/**
 * A failed probe means "we could not check", never "you are signed out" — sending a logged-in user
 * to fix a login they already have is worse than saying nothing.
 */
export function isSignedIn(d: ApiPlannerAuth | undefined): boolean {
  if (!d) return false;
  if (d.probe?.ran && !d.probe.ok) return d.login.present;
  return d.loggedIn;
}

export function probeFailureNote(d: ApiPlannerAuth | undefined): string | null {
  if (!d?.probe?.ran || d.probe.ok) return null;
  return d.probe.kind === 'timeout' ? 'Could not verify (timed out)' : 'Could not verify';
}

export function accountLine(d: ApiPlannerAuth | undefined): string | null {
  const a = d?.account;
  if (!a) return null;
  const parts = [a.email, a.organization, a.subscriptionType].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { LeadCan, LeadConversation, LeadRulesView, LeadView } from '../api/types';

/** The Squad lead page and the sidebar: conversations, Needs you, the squad now. No AI runs for any of it. */
export function useLead(every = 4000) {
  return useQuery({ queryKey: ['lead'], queryFn: () => api<LeadView>('/api/v1/lead'), refetchInterval: every });
}

/** One conversation: every second while the lead answers, so its steps show as they come. */
export function useLeadConversation(id: string | null | undefined) {
  return useQuery({
    queryKey: ['lead', 'conversation', id],
    queryFn: () => api<LeadConversation>(`/api/v1/lead/conversations/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.thinking ? 1000 : false),
  });
}

/** "Always allow", the morning brief, the never list and the limits. */
export function useLeadRules() {
  return useQuery({ queryKey: ['lead', 'rules'], queryFn: () => api<LeadRulesView>('/api/v1/lead/rules') });
}

/** The three levels in words, for "What it can do". They change only with squad-kit itself. */
export function useLeadCan() {
  return useQuery({ queryKey: ['lead', 'can'], queryFn: () => api<LeadCan>('/api/v1/lead/can'), staleTime: Infinity });
}

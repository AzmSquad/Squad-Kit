import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AgentName, ChatSummary } from '../api/types';

/** The talks with the agents: the list every page polls, what is unread in each, and the two letters on a head. */

/** Every talk with an agent, for the heads, the Conversations page and the side menu count. */
export function useChats(q = '') {
  return useQuery({
    queryKey: ['conversations', q],
    queryFn: () => api<ChatSummary[]>(`/api/v1/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    refetchInterval: 1500,
  });
}

/** Answers in an open talk you have not read yet: the agent's messages since you last wrote, and not seen here. */
export function unreadOf(s: ChatSummary, seen: Record<string, number>): number {
  if (!s.open) return 0;
  const had = seen[s.id];
  return had === undefined ? s.fresh : Math.min(s.fresh, Math.max(0, s.count - had));
}

/** The two letters on a head and a popup, in the agent's colour. */
export const INITIALS: Record<AgentName, string> = { analyst: 'An', architect: 'Ar', builder: 'Bu', reviewer: 'Re', tester: 'Te' };

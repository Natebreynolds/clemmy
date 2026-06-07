import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { SessionFilters, SessionListResponse } from '../types';
import { sessionKeys, buildSessionsQuery } from './keys';

/** The unified conversations list. Filters live in the query key so each
 *  combination is cached; search-as-you-type keeps the previous page. */
export function useSessions(filters: SessionFilters) {
  return useQuery({
    queryKey: sessionKeys.list(filters),
    queryFn: () => apiGet<SessionListResponse>(`/api/console/sessions${buildSessionsQuery(filters)}`),
    placeholderData: keepPreviousData,
    staleTime: 5_000,
    // Surface new chats from any channel (desktop + Discord) without a manual refresh.
    refetchInterval: 10_000,
    // The conversation list is for real conversations only — keep just
    // chat sessions (any channel) and drop workflow / execution / agent
    // runs, which have their own home in Automate / Inbox.
    select: (data) => ({ ...data, sessions: (data.sessions ?? []).filter((s) => s.kind === 'chat') }),
  });
}

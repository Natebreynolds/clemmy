import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { filterSessionsByKind, type ConversationKindFilter } from '@/lib/run-presentation';
import type { SessionFilters, SessionListResponse } from '../types';
import { sessionKeys, buildSessionsQuery } from './keys';

/** The unified conversations list. Server-side filters live in the query key so
 *  each combination is cached; search-as-you-type keeps the previous page. The
 *  kind segment is deliberately NOT in the key — it is a view of one fetched
 *  page, so switching All/Chats/Runs is instant instead of a round trip. */
export function useSessions(filters: SessionFilters, kind: ConversationKindFilter = 'all') {
  return useQuery({
    queryKey: sessionKeys.list(filters),
    queryFn: () => apiGet<SessionListResponse>(`/api/console/sessions${buildSessionsQuery(filters)}`),
    placeholderData: keepPreviousData,
    staleTime: 5_000,
    // Surface new chats from any channel (desktop + Discord) without a manual refresh.
    refetchInterval: 10_000,
    // Runs used to be dropped here — every workflow, background task and agent
    // run the server returned was filtered out client-side, so the one durable
    // page each of them already had was reachable only by typing its URL. They
    // stay in the list now; which of them a person wants to SEE is the rail's
    // segmented filter, not this hook's decision.
    select: (data) => ({
      ...data,
      sessions: filterSessionsByKind(data.sessions ?? [], kind),
    }),
  });
}

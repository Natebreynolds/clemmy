import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { SessionDetail } from '../types';
import { sessionKeys } from './keys';
import { shouldRetrySessionLoad } from './session-load';

export { isMissingConversation } from './session-load';

/** A single conversation's header + full history. Always fetched fresh on open. */
export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: id ? sessionKeys.detail(id) : sessionKeys.detail('none'),
    queryFn: () => apiGet<SessionDetail>(`/api/console/sessions/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    staleTime: 0,
    // A brand-new desktop chat 404s until its first turn persists; don't
    // retry that, so the empty-new-conversation fallback renders immediately.
    // An unreachable or restarting daemon is retried: it is not a missing chat.
    retry: shouldRetrySessionLoad,
  });
}

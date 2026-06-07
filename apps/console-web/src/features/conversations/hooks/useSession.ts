import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { SessionDetail } from '../types';
import { sessionKeys } from './keys';

/** A single conversation's header + full history. Always fetched fresh on open. */
export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: id ? sessionKeys.detail(id) : sessionKeys.detail('none'),
    queryFn: () => apiGet<SessionDetail>(`/api/console/sessions/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    staleTime: 0,
    // A brand-new desktop chat 404s until its first turn persists; don't
    // retry so the empty-new-conversation fallback renders immediately.
    retry: false,
  });
}
